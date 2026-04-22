const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");
const { TerminalManager } = require("./terminal-manager");
const { ServerRequestTracker } = require("./server-request-tracker");
const {
  canWriteFile,
  guessMimeType,
  isBinaryBuffer,
  isImageFilePath,
  isPathInsideRoot,
} = require("./file-resource-utils");
const { dedupeProjectsByPath, projectPathKey } = require("./project-store-utils");
const { createThreadActionHelpers } = require("./thread-action-utils");
const { createApiHandler } = require("./server/api-handler");
const { createFileResourceHandlers } = require("./server/file-resources");
const { createStaticAssetHandler } = require("./server/static-assets");
const { createHttpError, readJsonBody, sendError, sendJson } = require("./server/http-utils");
const { createSocketHub } = require("./server/socket-hub");

const ROOT_DIR = __dirname;
const DIST_DIR = path.join(ROOT_DIR, "dist");
const DATA_DIR = path.join(ROOT_DIR, "data");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
const PORT = Number(process.env.PORT || 3210);
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const MAX_BODY_BYTES = 15 * 1024 * 1024;
const RAW_BRIDGE_LOG_ENABLED = process.env.CODEX_LOG_JSON === "true";

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

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

const terminalManager = new TerminalManager();
let modelCapabilitiesModulePromise = null;

const serveStatic = createStaticAssetHandler({
  contentTypes: CONTENT_TYPES,
  distDir: DIST_DIR,
  fs,
  fsp,
  path,
  rootDir: ROOT_DIR,
  sendError,
});

const parseJsonBody = (request) => readJsonBody(request, { maxBodyBytes: MAX_BODY_BYTES });

const { readFileResource, resolveAllowedFilePath } = createFileResourceHandlers({
  fsp,
  path,
  cleanString,
  listProjects,
  createHttpError,
  canWriteFile,
  guessMimeType,
  isBinaryBuffer,
  isImageFilePath,
  isPathInsideRoot,
});

const {
  broadcastEvent,
  ensureProjectTerminalSession,
  handleEventSocketConnection,
  handleTerminalSocketConnection,
} = createSocketHub({
  cleanString,
  requireProject,
  terminalManager,
});

function formatBridgePayload(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({
      unserializable: true,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function logBridgeTraffic(direction, payload) {
  if (!RAW_BRIDGE_LOG_ENABLED) {
    return;
  }

  closeConsoleResponseStream();
  const label = direction === "out" ? "-> codex" : "<- codex";
  console.log(`[sdk ${label}] ${formatBridgePayload(payload)}`);
}

function formatConsoleSectionBar() {
  const width = Math.max(48, Math.min(process.stdout.columns || 80, 72));
  return "-".repeat(width);
}

function truncateConsoleText(text, maxLength = 280) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function writeConsoleSection(title, lines = []) {
  closeConsoleResponseStream();
  const visibleLines = [formatConsoleSectionBar(), title];
  for (const line of lines) {
    const text = String(line || "").trim();
    if (text) {
      visibleLines.push(text);
    }
  }
  visibleLines.push(formatConsoleSectionBar());
  process.stdout.write(`${visibleLines.join("\n")}\n`);
}

function summarizeTurnInput(input) {
  const items = Array.isArray(input) ? input : [];
  const text = items
    .filter((item) => item?.type === "text")
    .map((item) => String(item.text || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const imageCount = items.filter((item) => /image/i.test(String(item?.type || ""))).length;
  const lines = [];

  if (text) {
    lines.push(text);
  }

  if (imageCount > 0) {
    lines.push(`[${imageCount} image${imageCount === 1 ? "" : "s"} attached]`);
  }

  return lines;
}

function logTurnStart(params) {
  const threadId = cleanString(params?.threadId);
  const lines = [];

  if (threadId) {
    lines.push(`thread: ${threadId}`);
  }

  lines.push(...summarizeTurnInput(params?.input));
  writeConsoleSection("User Message", lines);
}

function loadModelCapabilitiesModule() {
  if (!modelCapabilitiesModulePromise) {
    modelCapabilitiesModulePromise = import("./src/model-capabilities.mjs");
  }

  return modelCapabilitiesModulePromise;
}
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

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.start();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
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
        name: "custom-codex-web",
        title: "Custom Codex Web",
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

      let message;

      try {
        message = JSON.parse(line);
      } catch (error) {
        this.emit("event", { type: "bridge-parse-error", source: "stdout", line });
        continue;
      }

      this.handleMessage(message);
    }
  }

  onStderr(chunk) {
    this.stderrBuffer += chunk;
    const lines = this.stderrBuffer.split(/\r?\n/);
    this.stderrBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      closeConsoleResponseStream();
      console.error(`[codex] ${line}`);
      this.emit("event", { type: "bridge-log", line });
    }
  }

  handleMessage(message) {
    logBridgeTraffic("in", message);

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
        return;
      }

      pending.resolve(message.result);
    }
  }

  send(message) {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error("Codex app-server is not running");
    }

    if (!RAW_BRIDGE_LOG_ENABLED && message?.method === "turn/start") {
      logTurnStart(message.params);
    }

    logBridgeTraffic("out", message);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  rawRequest(method, params) {
    const id = this.nextRequestId++;
    const key = String(id);
    const payload = params === undefined ? { id, method } : { id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
      this.send(payload);
    });
  }

  async request(method, params) {
    return this.requestWithRetry(method, params, true);
  }

  async respondToServerRequest(id, result) {
    await this.ensureStarted();
    this.send({ id, result });
  }

  async requestWithRetry(method, params, allowRetry) {
    await this.ensureStarted();

    try {
      return await this.rawRequest(method, params);
    } catch (error) {
      if (allowRetry && /Codex app-server exited/.test(error.message)) {
        this.ready = false;
        this.child = null;
        return this.requestWithRetry(method, params, false);
      }

      throw error;
    }
  }

  listPendingServerRequests() {
    return Array.from(this.pendingServerRequests.values()).sort((a, b) => a.receivedAt - b.receivedAt);
  }
}

const bridge = new CodexBridge();
const threadActionHelpers = createThreadActionHelpers({
  bridge,
  findProjectByCwd,
  buildThreadConfig,
  cleanString,
  compactObject,
});

bridge.on("event", (payload) => {
  if (payload?.type === "notification") {
    writeRealtimeLlmDelta(payload.message);
  }

  broadcastEvent({ timestamp: Date.now(), ...payload });
});

const handleApi = createApiHandler({
  PORT,
  CODEX_BIN,
  ROOT_DIR,
  THREAD_SOURCE_KINDS,
  bridge,
  terminalManager,
  threadActionHelpers,
  parseJsonBody,
  sendJson,
  sendError,
  createHttpError,
  cleanString,
  listProjects,
  saveProject,
  removeProject,
  requireProject,
  buildSandboxPolicy,
  buildThreadConfig,
  buildTurnConfig,
  buildTurnInput,
  resolveComposerSelection,
  resolveAllowedFilePath,
  readFileResource,
  ensureProjectTerminalSession,
  canWriteFile,
  guessMimeType,
  isBinaryBuffer,
  isImageFilePath,
  fsp,
  path,
  loadModelCapabilitiesModule,
});

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
        return;
      }

      reject(new Error(`'${CODEX_BIN} --version' exited with status ${code}`));
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
    sandboxMode: "workspace-write",
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
    if (error.code === "ENOENT") {
      const defaults = [buildDefaultProject()];
      await writeProjects(defaults);
      return defaults;
    }

    throw error;
  }

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = [buildDefaultProject()];
  }

  const normalizedProjects = Array.isArray(parsed) && parsed.length > 0
    ? parsed.map(normalizeStoredProject)
    : [buildDefaultProject()];
  const projects = dedupeProjectsByPath(await Promise.all(
    normalizedProjects.map(async (project) => ({
      ...project,
      cwd: await canonicalizeProjectCwd(project.cwd),
    })),
  ));

  const normalized = JSON.stringify(projects, null, 2) + "\n";

  if (normalized !== raw) {
    await fsp.writeFile(PROJECTS_FILE, normalized, "utf8");
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

async function saveProject(input) {
  const projects = await listProjects();
  const cwd = await canonicalizeProjectCwd(input.cwd);
  const existing = projects.find((project) => project.id === input.id)
    || projects.find((project) => projectPathKey(project.cwd) === projectPathKey(cwd));
  const stats = await fsp.stat(cwd).catch(() => null);

  if (!stats || !stats.isDirectory()) {
    throw new Error("Project cwd must point to an existing directory");
  }

  const now = Date.now();
  const record = normalizeStoredProject({
    ...existing,
    ...input,
    cwd,
    id: cleanString(input.id) || existing?.id || crypto.randomUUID(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  });

  const nextProjects = existing
    ? projects.map((project) => (project.id === existing.id ? record : project))
    : [record, ...projects];

  await writeProjects(dedupeProjectsByPath(nextProjects));
  return record;
}

async function removeProject(projectId) {
  const projects = await listProjects();
  const nextProjects = projects.filter((project) => project.id !== projectId);
  await writeProjects(nextProjects.length > 0 ? nextProjects : [buildDefaultProject()]);
}

async function requireProject(projectId) {
  const projects = await listProjects();
  const project = projects.find((item) => item.id === projectId);

  if (!project) {
    throw new Error("Project not found");
  }

  return project;
}

async function findProjectByCwd(cwd) {
  const target = await canonicalizeProjectCwd(cwd);
  const projects = await listProjects();
  return projects.find((project) => projectPathKey(project.cwd) === projectPathKey(target)) || null;
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function pickEnum(value, options, fallback) {
  return options.includes(value) ? value : fallback;
}

function pickApprovalPolicy(value, fallback) {
  if (value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never") {
    return value;
  }

  return fallback;
}

function compactObject(input) {
  const output = {};

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    output[key] = value;
  }

  return output;
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

function buildThreadConfig(project, overrides = {}, selection = {}) {
  const modelId = cleanString(selection.modelId) || cleanString(project.defaultModel);

  return compactObject({
    model: modelId || undefined,
    cwd: project.cwd,
    approvalPolicy: pickApprovalPolicy(overrides.approvalPolicy, project.approvalPolicy),
    sandbox: pickEnum(overrides.sandboxMode || project.sandboxMode, ["read-only", "workspace-write", "danger-full-access"], project.sandboxMode),
    personality: pickEnum(overrides.personality || project.defaultPersonality, ["none", "friendly", "pragmatic"], project.defaultPersonality),
  });
}

function buildTurnConfig(project, overrides = {}, selection = {}) {
  const modelId = cleanString(selection.modelId) || cleanString(project.defaultModel);

  return compactObject({
    cwd: project.cwd,
    approvalPolicy: pickApprovalPolicy(overrides.approvalPolicy, project.approvalPolicy),
    sandboxPolicy: buildSandboxPolicy(project, overrides),
    model: modelId || undefined,
    effort: cleanString(selection.effort) || undefined,
    serviceTier: cleanString(selection.serviceTier) || undefined,
    collaborationMode: normalizeCollaborationMode(overrides, { ...selection, modelId }),
    summary: pickEnum(overrides.summary || project.defaultSummary, ["auto", "concise", "detailed", "none"], project.defaultSummary),
    personality: pickEnum(overrides.personality || project.defaultPersonality, ["none", "friendly", "pragmatic"], project.defaultPersonality),
  });
}

function normalizeCollaborationMode(overrides = {}, selection = {}) {
  const mode = cleanString(overrides?.collaborationMode?.mode);
  if (!["default", "plan"].includes(mode)) {
    return undefined;
  }

  if (!cleanString(selection.modelId)) {
    return undefined;
  }

  return {
    mode,
    settings: compactObject({
      model: cleanString(selection.modelId),
      reasoning_effort: cleanString(selection.effort) || undefined,
    }),
  };
}

async function resolveComposerSelection(project, overrides = {}) {
  const [models, modelCapabilities] = await Promise.all([
    getModels(),
    loadModelCapabilitiesModule(),
  ]);

  return modelCapabilities.resolveComposerSelection({
    models: models.data || [],
    requestedModelId: cleanString(overrides.model),
    fallbackModelId: cleanString(project.defaultModel),
    requestedEffort: cleanString(overrides.effort) || cleanString(project.defaultEffort),
    requestedServiceTier: cleanString(overrides.serviceTier),
    capabilities: models.capabilities || { serviceTiers: [], defaultServiceTier: "" },
  });
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

let activeConsoleResponseKey = "";

function closeConsoleResponseStream() {
  if (!activeConsoleResponseKey) {
    return;
  }

  process.stdout.write("\n");
  activeConsoleResponseKey = "";
}

function openConsoleResponseStream(threadId, turnId, itemId) {
  const lines = [];

  if (threadId) {
    lines.push(`thread: ${threadId}`);
  }
  if (turnId) {
    lines.push(`turn: ${turnId}`);
  }
  if (itemId) {
    lines.push(`item: ${itemId}`);
  }

  writeConsoleSection("Assistant Message", lines);
  activeConsoleResponseKey = `${threadId || ""}:${turnId || ""}:${itemId || ""}`;
}

function writeRealtimeLlmDelta(message) {
  const method = typeof message?.method === "string" ? message.method : "";
  const params = message?.params || {};

  if (method === "item/agentMessage/delta") {
    const key = `${params.threadId || ""}:${params.turnId || ""}:${params.itemId || ""}`;
    if (key !== activeConsoleResponseKey) {
      openConsoleResponseStream(params.threadId, params.turnId, params.itemId);
    }

    process.stdout.write(params.delta || "");
    return;
  }

  if (
    method === "turn/completed"
    || method === "turn/aborted"
    || method === "thread/closed"
    || method === "error"
  ) {
    closeConsoleResponseStream();
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);

    if (url.pathname.startsWith("/api/")) {
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
const terminalSocketServer = new WebSocketServer({ noServer: true });

eventSocketServer.on("connection", (socket) => {
  handleEventSocketConnection(socket);
});

terminalSocketServer.on("connection", (socket) => {
  handleTerminalSocketConnection(socket, socket.projectId);
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);

  if (url.pathname === "/ws/events") {
    eventSocketServer.handleUpgrade(request, socket, head, (ws) => {
      eventSocketServer.emit("connection", ws, request);
    });
    return;
  }

  const terminalMatch = url.pathname.match(/^\/ws\/projects\/([^/]+)\/terminal$/);
  if (!terminalMatch) {
    socket.destroy();
    return;
  }

  void ensureProjectTerminalSession(decodeURIComponent(terminalMatch[1]), {
    columns: url.searchParams.get("columns"),
    rows: url.searchParams.get("rows"),
    term: url.searchParams.get("term"),
  }).then(() => {
    terminalSocketServer.handleUpgrade(request, socket, head, (ws) => {
      ws.projectId = decodeURIComponent(terminalMatch[1]);
      terminalSocketServer.emit("connection", ws, request);
    });
  }).catch((error) => {
    console.error(error);
    socket.destroy();
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

server.listen(PORT, async () => {
  await ensureProjectStore();
  console.log(`Custom Codex web client listening on http://localhost:${PORT}`);
});

async function shutdownAndExit(code) {
  await terminalManager.stopAll().catch(() => {});
  process.exit(code);
}

process.on("SIGINT", () => {
  void shutdownAndExit(0);
});

process.on("SIGTERM", () => {
  void shutdownAndExit(0);
});
