const http = require("http");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");
const { ServerRequestTracker } = require("../server-request-tracker");
const { dedupeProjectsByPath } = require("../project-store-utils");
const { readJsonBody, sendError, sendJson } = require("../server/http-utils");

const ROOT_DIR = path.resolve(__dirname, "..");
const APP_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const PORT = parsePort(resolveOption("PORT"), 3221);
const MAX_BODY_BYTES = 15 * 1024 * 1024;

const THREAD_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const eventSockets = new Set();
let bridge;
let modelCapabilitiesModulePromise = null;

class CodexBridge extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.ready = false;
    this.startPromise = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.pendingServerRequests = new Map();
    this.serverRequestTracker = new ServerRequestTracker();
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
  }

  async ensureStarted() {
    if (this.ready && this.child && !this.child.killed) {
      return;
    }

    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null;
      });
    }

    return this.startPromise;
  }

  async start() {
    await assertCodexInstalled();

    this.child = spawn(CODEX_BIN, ["app-server", "--listen", "stdio://"], {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => this.onStderr(chunk));
    this.child.on("error", (error) => this.handleExit(error));
    this.child.on("exit", (code, signal) => {
      this.handleExit(new Error(`Codex app-server exited (${code ?? "null"}${signal ? `, ${signal}` : ""})`));
    });

    const init = await this.rawRequest("initialize", {
      clientInfo: {
        name: "myagent-new-app",
        title: "MyAgent New App",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    this.send({ method: "initialized" });
    this.ready = true;
    this.emit("event", { type: "bridge-ready", payload: init });
  }

  handleExit(error) {
    const err = error instanceof Error ? error : new Error(String(error));

    for (const pending of this.pending.values()) {
      pending.reject(err);
    }

    this.pending.clear();
    this.pendingServerRequests.clear();
    this.serverRequestTracker.reset();
    this.ready = false;
    this.child = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.emit("event", { type: "bridge-exit", error: err.message });
  }

  onStdout(chunk) {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      try {
        this.handleMessage(JSON.parse(line));
      } catch {
        this.emit("event", { type: "bridge-parse-error", source: "stdout", line });
      }
    }
  }

  onStderr(chunk) {
    this.stderrBuffer += chunk;
    const lines = this.stderrBuffer.split(/\r?\n/);
    this.stderrBuffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) {
        console.error(`[new-app codex] ${line}`);
        this.emit("event", { type: "bridge-log", line });
      }
    }
  }

  handleMessage(message) {
    if (message && typeof message === "object" && "method" in message && "id" in message) {
      const normalizedRequest = this.serverRequestTracker.normalizeRequest(message);
      const requestObservation = this.serverRequestTracker.observeRequest(normalizedRequest);
      const requestId = String(message.id);
      const existingRequest = this.pendingServerRequests.get(requestId);

      this.pendingServerRequests.set(requestId, {
        ...normalizedRequest,
        receivedAt: existingRequest?.receivedAt || requestObservation.receivedAt,
      });
      this.emit("event", { type: "server-request", request: normalizedRequest, requestObservation });
      return;
    }

    if (message && typeof message === "object" && "method" in message) {
      this.serverRequestTracker.observeNotification(message);

      if (message.method === "serverRequest/resolved" && message.params?.requestId != null) {
        this.serverRequestTracker.resolveRequest(message.params.requestId);
        this.pendingServerRequests.delete(String(message.params.requestId));
      }

      this.emit("event", { type: "notification", message });
      return;
    }

    if (message && typeof message === "object" && "id" in message) {
      const key = String(message.id);
      const pending = this.pending.get(key);

      if (!pending) {
        return;
      }

      this.pending.delete(key);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  send(message) {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error("Codex app-server is not running");
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  rawRequest(method, params) {
    const id = this.nextRequestId++;
    const payload = params === undefined ? { id, method } : { id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
      this.send(payload);
    });
  }

  async request(method, params) {
    await this.ensureStarted();
    return this.rawRequest(method, params);
  }

  async respondToServerRequest(id, result) {
    await this.ensureStarted();
    this.send({ id, result });
  }

  listPendingServerRequests() {
    return Array.from(this.pendingServerRequests.values()).sort((a, b) => a.receivedAt - b.receivedAt);
  }
}

bridge = new CodexBridge();
bridge.on("event", (payload) => {
  broadcastEvent({ timestamp: Date.now(), ...payload });
});

function parsePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function resolveOption(name) {
  const prefix = `${name}=`;
  const arg = process.argv.slice(2).find((item) => String(item || "").startsWith(prefix));
  return arg ? arg.slice(prefix.length) : process.env[name];
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function pickEnum(value, options, fallback) {
  return options.includes(value) ? value : fallback;
}

function pickApprovalPolicy(value, fallback) {
  return ["untrusted", "on-failure", "on-request", "never"].includes(value) ? value : fallback;
}

function compactObject(input) {
  const output = {};

  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null && value !== "") {
      output[key] = value;
    }
  }

  return output;
}

async function assertCodexInstalled() {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, ["--version"], {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: ["ignore", "ignore", "ignore"],
    });

    child.on("error", () => reject(new Error(`Unable to launch '${CODEX_BIN}'. Install Codex or set CODEX_BIN.`)));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`'${CODEX_BIN} --version' exited with status ${code}`));
      }
    });
  });
}

function buildDefaultProject() {
  const now = Date.now();

  return {
    id: "workspace",
    name: "Current Workspace",
    description: "Default project rooted at this repository.",
    cwd: ROOT_DIR,
    defaultModel: "",
    defaultEffort: "medium",
    defaultSummary: "auto",
    defaultPersonality: "pragmatic",
    approvalPolicy: "on-request",
    sandboxMode: "danger-full-access",
    networkAccess: true,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeStoredProject(project) {
  const fallback = buildDefaultProject();

  return {
    id: cleanString(project?.id) || crypto.randomUUID(),
    name: cleanString(project?.name) || fallback.name,
    description: cleanString(project?.description),
    cwd: path.resolve(cleanString(project?.cwd) || ROOT_DIR),
    defaultModel: cleanString(project?.defaultModel),
    defaultEffort: pickEnum(project?.defaultEffort, ["none", "minimal", "low", "medium", "high", "xhigh"], fallback.defaultEffort),
    defaultSummary: pickEnum(project?.defaultSummary, ["auto", "concise", "detailed", "none"], fallback.defaultSummary),
    defaultPersonality: pickEnum(project?.defaultPersonality, ["none", "friendly", "pragmatic"], fallback.defaultPersonality),
    approvalPolicy: pickApprovalPolicy(project?.approvalPolicy, fallback.approvalPolicy),
    sandboxMode: pickEnum(project?.sandboxMode, ["read-only", "workspace-write", "danger-full-access"], fallback.sandboxMode),
    networkAccess: typeof project?.networkAccess === "boolean" ? project.networkAccess : fallback.networkAccess,
    createdAt: Number.isFinite(project?.createdAt) ? Number(project.createdAt) : fallback.createdAt,
    updatedAt: Number.isFinite(project?.updatedAt) ? Number(project.updatedAt) : fallback.updatedAt,
  };
}

async function canonicalizeProjectCwd(cwd) {
  const resolved = path.resolve(cleanString(cwd) || ROOT_DIR);
  return fsp.realpath(resolved).catch(() => resolved);
}

async function ensureProjectStore() {
  await fsp.mkdir(DATA_DIR, { recursive: true });

  let raw = "";
  try {
    raw = await fsp.readFile(PROJECTS_FILE, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    const defaults = [buildDefaultProject()];
    await writeProjects(defaults);
    return defaults;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = [buildDefaultProject()];
  }

  const normalized = Array.isArray(parsed) && parsed.length > 0
    ? parsed.map(normalizeStoredProject)
    : [buildDefaultProject()];
  const projects = dedupeProjectsByPath(await Promise.all(normalized.map(async (project) => ({
    ...project,
    cwd: await canonicalizeProjectCwd(project.cwd),
  }))));

  const nextRaw = JSON.stringify(projects, null, 2) + "\n";
  if (nextRaw !== raw) {
    await fsp.writeFile(PROJECTS_FILE, nextRaw, "utf8");
  }

  return projects;
}

async function writeProjects(projects) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(PROJECTS_FILE, JSON.stringify(projects, null, 2) + "\n", "utf8");
}

async function listProjects() {
  return ensureProjectStore();
}

async function requireProject(projectId) {
  const projects = await listProjects();
  const project = projects.find((item) => item.id === projectId);

  if (!project) {
    throw new Error("Project not found");
  }

  return project;
}

function buildSandboxPolicy(project, overrides = {}) {
  const sandboxMode = pickEnum(overrides.sandboxMode || project.sandboxMode, ["read-only", "workspace-write", "danger-full-access"], project.sandboxMode);
  const networkAccess = typeof overrides.networkAccess === "boolean" ? overrides.networkAccess : project.networkAccess;

  if (sandboxMode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }

  if (sandboxMode === "read-only") {
    return {
      type: "readOnly",
      access: { type: "fullAccess" },
      networkAccess,
    };
  }

  return {
    type: "workspaceWrite",
    writableRoots: [project.cwd],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function buildThreadConfig(project, overrides = {}) {
  return compactObject({
    model: cleanString(overrides.model) || cleanString(project.defaultModel) || undefined,
    cwd: project.cwd,
    approvalPolicy: pickApprovalPolicy(overrides.approvalPolicy, project.approvalPolicy),
    sandbox: pickEnum(overrides.sandboxMode || project.sandboxMode, ["read-only", "workspace-write", "danger-full-access"], project.sandboxMode),
    personality: pickEnum(overrides.personality || project.defaultPersonality, ["none", "friendly", "pragmatic"], project.defaultPersonality),
  });
}

function buildTurnConfig(project, overrides = {}) {
  return compactObject({
    cwd: project.cwd,
    approvalPolicy: pickApprovalPolicy(overrides.approvalPolicy, project.approvalPolicy),
    sandboxPolicy: buildSandboxPolicy(project, overrides),
    model: cleanString(overrides.model) || cleanString(project.defaultModel) || undefined,
    effort: cleanString(overrides.effort) || cleanString(project.defaultEffort) || undefined,
    serviceTier: cleanString(overrides.serviceTier) || undefined,
    collaborationMode: normalizeCollaborationMode(overrides),
    summary: pickEnum(overrides.summary || project.defaultSummary, ["auto", "concise", "detailed", "none"], project.defaultSummary),
    personality: pickEnum(overrides.personality || project.defaultPersonality, ["none", "friendly", "pragmatic"], project.defaultPersonality),
  });
}

function normalizeCollaborationMode(overrides = {}) {
  const mode = cleanString(overrides?.collaborationMode?.mode || overrides.mode);
  const model = cleanString(overrides?.collaborationMode?.settings?.model || overrides.model);

  if (!["default", "plan"].includes(mode) || !model) {
    return undefined;
  }

  return {
    mode,
    settings: compactObject({
      model,
      reasoning_effort: cleanString(overrides?.collaborationMode?.settings?.reasoning_effort || overrides.effort) || undefined,
    }),
  };
}

function normalizeImageInput(image) {
  if (!image || typeof image !== "object") {
    return null;
  }

  const url = cleanString(image.url);
  const pathValue = cleanString(image.path);

  if (url) {
    return compactObject({
      type: "image",
      url,
      name: cleanString(image.name) || undefined,
    });
  }

  if (pathValue) {
    return compactObject({
      type: "localImage",
      path: pathValue,
      name: cleanString(image.name) || undefined,
    });
  }

  return null;
}

function buildTurnInput(body, textFieldName) {
  const items = [];
  const text = cleanString(body[textFieldName]);

  if (text) {
    items.push({ type: "text", text, text_elements: [] });
  }

  if (Array.isArray(body.images)) {
    for (const image of body.images) {
      const normalized = normalizeImageInput(image);

      if (normalized) {
        items.push(normalized);
      }
    }
  }

  if (items.length === 0) {
    throw new Error("A text prompt or image is required");
  }

  return items;
}

function loadModelCapabilitiesModule() {
  if (!modelCapabilitiesModulePromise) {
    modelCapabilitiesModulePromise = import("./src/model-capabilities.mjs");
  }

  return modelCapabilitiesModulePromise;
}

async function getModels() {
  try {
    const [result, configState, modelCapabilities] = await Promise.all([
      bridge.request("model/list", { includeHidden: false }),
      bridge.request("config/read", {}).catch(() => null),
      loadModelCapabilitiesModule(),
    ]);
    const data = result.data || result.models || [];
    const defaultServiceTier = cleanString(configState?.config?.service_tier || configState?.data?.config?.service_tier);

    return {
      ok: true,
      data,
      capabilities: {
        defaultServiceTier,
        serviceTiers: modelCapabilities.collectSupportedServiceTiers(data, { defaultServiceTier }),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      data: [],
      capabilities: { defaultServiceTier: "", serviceTiers: [] },
    };
  }
}

async function handleApi(request, response, url) {
  const { pathname, searchParams } = url;
  const parts = pathname.split("/").filter(Boolean);

  if (request.method === "GET" && pathname === "/new-api/boot") {
    sendJson(response, 200, {
      ok: true,
      projects: await listProjects(),
      pendingRequests: bridge.listPendingServerRequests(),
      app: {
        version: "new",
        port: PORT,
        rootDir: ROOT_DIR,
        codexBin: CODEX_BIN,
      },
    });
    return;
  }

  if (request.method === "GET" && pathname === "/new-api/models") {
    sendJson(response, 200, await getModels());
    return;
  }

  if (request.method === "GET" && parts[1] === "projects" && parts[3] === "threads") {
    const project = await requireProject(decodeURIComponent(parts[2]));
    sendJson(response, 200, {
      ok: true,
      data: await bridge.request("thread/list", {
        archived: searchParams.get("archived") === "true",
        cwd: project.cwd,
        limit: 100,
        sortKey: "updated_at",
        sourceKinds: THREAD_SOURCE_KINDS,
      }),
    });
    return;
  }

  if (request.method === "POST" && pathname === "/new-api/threads") {
    const body = await readJsonBody(request, { maxBodyBytes: MAX_BODY_BYTES });
    const project = await requireProject(cleanString(body.projectId));
    const threadResult = await bridge.request("thread/start", {
      ...buildThreadConfig(project, body),
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      serviceName: "myagent-new-app",
    });

    if (cleanString(body.prompt)) {
      await bridge.request("turn/start", {
        threadId: threadResult.thread.id,
        input: buildTurnInput(body, "prompt"),
        ...buildTurnConfig(project, body),
      });
    }

    sendJson(response, 200, { ok: true, data: threadResult });
    return;
  }

  if (request.method === "GET" && parts[1] === "threads" && parts.length === 3) {
    const threadId = decodeURIComponent(parts[2]);

    try {
      sendJson(response, 200, {
        ok: true,
        data: await bridge.request("thread/read", { threadId, includeTurns: true }),
      });
    } catch {
      sendJson(response, 200, {
        ok: true,
        data: await bridge.request("thread/read", { threadId, includeTurns: false }),
      });
    }
    return;
  }

  if (request.method === "POST" && parts[1] === "threads" && parts[3] === "message") {
    const body = await readJsonBody(request, { maxBodyBytes: MAX_BODY_BYTES });
    const threadId = decodeURIComponent(parts[2]);
    const project = await requireProject(cleanString(body.projectId));

    await bridge.request("thread/resume", {
      threadId,
      ...buildThreadConfig(project, body),
      persistExtendedHistory: true,
    });

    sendJson(response, 200, {
      ok: true,
      data: await bridge.request("turn/start", {
        threadId,
        input: buildTurnInput(body, "text"),
        ...buildTurnConfig(project, body),
      }),
    });
    return;
  }

  if (request.method === "POST" && parts[1] === "threads" && parts[3] === "interrupt") {
    const body = await readJsonBody(request, { maxBodyBytes: MAX_BODY_BYTES });
    const turnId = cleanString(body.turnId);

    if (!turnId) {
      sendError(response, 400, "turnId is required");
      return;
    }

    sendJson(response, 200, {
      ok: true,
      data: await bridge.request("turn/interrupt", {
        threadId: decodeURIComponent(parts[2]),
        turnId,
      }),
    });
    return;
  }

  if (request.method === "POST" && parts[1] === "server-requests" && parts[3] === "respond") {
    const body = await readJsonBody(request, { maxBodyBytes: MAX_BODY_BYTES });
    const requestId = decodeURIComponent(parts[2]);
    const pendingRequest = bridge.listPendingServerRequests().find((item) => String(item.id) === requestId);

    if (!pendingRequest) {
      throw new Error("Pending request not found");
    }

    await bridge.respondToServerRequest(pendingRequest.id, body.result);
    sendJson(response, 200, { ok: true });
    return;
  }

  sendError(response, 404, "Not found");
}

function broadcastEvent(payload) {
  const message = JSON.stringify(payload);

  for (const socket of eventSockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(message);
    }
  }
}

function handleEventSocket(socket) {
  eventSockets.add(socket);
  socket.send(JSON.stringify({ type: "connected", timestamp: Date.now() }));

  socket.on("close", () => {
    eventSockets.delete(socket);
  });
  socket.on("error", () => {
    eventSockets.delete(socket);
  });
}

async function serveStatic(pathname, response) {
  const requestedPath = pathname === "/" || pathname === "/index.html" ? "/new-app/index.html" : pathname;
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = "";

  if (safePath.startsWith("/new-app/")) {
    filePath = path.join(ROOT_DIR, safePath);
    if (!filePath.startsWith(APP_DIR)) {
      sendError(response, 403, "Forbidden");
      return;
    }
  } else {
    sendError(response, 404, "Not found");
    return;
  }

  try {
    const contents = await fsp.readFile(filePath);
    response.writeHead(200, { "Content-Type": CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream" });
    response.end(contents);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendError(response, 404, "Not found");
      return;
    }

    throw error;
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);

    if (url.pathname.startsWith("/new-api/")) {
      await handleApi(request, response, url);
      return;
    }

    await serveStatic(url.pathname, response);
  } catch (error) {
    console.error(error);
    sendError(response, error?.statusCode || 500, error);
  }
});

const eventSocketServer = new WebSocketServer({ noServer: true });

eventSocketServer.on("connection", (socket) => {
  handleEventSocket(socket);
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);

  if (url.pathname !== "/new-ws/events") {
    socket.destroy();
    return;
  }

  eventSocketServer.handleUpgrade(request, socket, head, (ws) => {
    eventSocketServer.emit("connection", ws, request);
  });
});

server.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other process or start with PORT=<port>.`);
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});

async function shutdownAndExit(code) {
  if (bridge.child && !bridge.child.killed) {
    bridge.child.kill("SIGINT");
  }
  process.exit(code);
}

process.on("SIGINT", () => {
  void shutdownAndExit(0);
});
process.on("SIGTERM", () => {
  void shutdownAndExit(0);
});

ensureProjectStore().then(() => {
  server.listen(PORT, () => {
    console.log(`New MyAgent backend listening on http://localhost:${PORT}`);
  });
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
