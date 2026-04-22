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

const eventSocketClients = new Set();
const terminalSocketClientsByProjectId = new Map();
const terminalManager = new TerminalManager();
let modelCapabilitiesModulePromise = null;

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

  broadcast({ timestamp: Date.now(), ...payload });
});

terminalManager.on("output", (payload) => {
  broadcastProjectTerminal(payload.projectId, {
    type: "output",
    timestamp: Date.now(),
    ...payload,
  });
});

terminalManager.on("exit", (payload) => {
  broadcastProjectTerminal(payload.projectId, {
    type: "exit",
    timestamp: Date.now(),
    ...payload,
  });
});

terminalManager.on("error", (payload) => {
  broadcastProjectTerminal(payload.projectId, {
    type: "error",
    timestamp: Date.now(),
    ...payload,
  });
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

async function getBootState({ includeModels = true } = {}) {
  const [projects, models] = await Promise.all([
    listProjects(),
    includeModels ? getModels() : Promise.resolve({ ok: true, data: [] }),
  ]);

  return {
    ok: true,
    projects,
    models,
    pendingRequests: bridge.listPendingServerRequests(),
    app: {
      port: PORT,
      codexBin: CODEX_BIN,
      rootDir: ROOT_DIR,
    },
  };
}

async function getAccountState() {
  try {
    const [accountRead, authStatus] = await Promise.all([
      bridge.request("account/read", { refreshToken: false }),
      bridge.request("getAuthStatus", { includeToken: false, refreshToken: false }),
    ]);

    return {
      ok: true,
      account: accountRead.account,
      requiresOpenaiAuth: accountRead.requiresOpenaiAuth,
      authStatus,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
    };
  }
}

async function getConfigState() {
  try {
    return { ok: true, data: await bridge.request("config/read", {}) };
  } catch (error) {
    return { ok: false, error: error.message, data: null };
  }
}

async function getModels() {
  try {
    const [result, configState, modelCapabilities] = await Promise.all([
      bridge.request("model/list", { includeHidden: false }),
      getConfigState(),
      loadModelCapabilitiesModule(),
    ]);
    const data = result.data || result.models || [];
    const defaultServiceTier = cleanString(configState.data?.config?.service_tier);

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

function broadcast(payload) {
  const message = JSON.stringify(payload);

  for (const socket of eventSocketClients) {
    if (socket.readyState === socket.OPEN) {
      socket.send(message);
    }
  }
}

function sendSocketJson(socket, payload) {
  if (socket.readyState !== socket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
}

function getProjectTerminalSockets(projectId) {
  const normalizedProjectId = cleanString(projectId);
  if (!normalizedProjectId) {
    return null;
  }

  let sockets = terminalSocketClientsByProjectId.get(normalizedProjectId);
  if (!sockets) {
    sockets = new Set();
    terminalSocketClientsByProjectId.set(normalizedProjectId, sockets);
  }

  return sockets;
}

function removeProjectTerminalSocket(projectId, socket) {
  const sockets = terminalSocketClientsByProjectId.get(cleanString(projectId));
  if (!sockets) {
    return;
  }

  sockets.delete(socket);
  if (sockets.size === 0) {
    terminalSocketClientsByProjectId.delete(cleanString(projectId));
  }
}

function broadcastProjectTerminal(projectId, payload) {
  const sockets = terminalSocketClientsByProjectId.get(cleanString(projectId));
  if (!sockets) {
    return;
  }

  for (const socket of sockets) {
    sendSocketJson(socket, payload);
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body is too large");
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const body = Buffer.concat(chunks).toString("utf8");

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON request body");
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendError(response, statusCode, error) {
  sendJson(response, statusCode, {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function buildInlineFileUrl(filePath, version) {
  const url = new URL("/api/file/content", "http://localhost");
  url.searchParams.set("path", filePath);
  if (version) {
    url.searchParams.set("v", String(version));
  }
  return `${url.pathname}${url.search}`;
}

async function listAllowedFileRoots() {
  const projects = await listProjects();
  return Array.from(new Set(projects.map((project) => path.resolve(project.cwd))));
}

async function resolveAllowedFilePath(requestedPath) {
  const rawPath = cleanString(requestedPath);

  if (!rawPath) {
    throw createHttpError(400, "path is required");
  }

  if (!path.isAbsolute(rawPath)) {
    throw createHttpError(400, "path must be absolute");
  }

  const resolvedPath = path.resolve(rawPath);
  const realPath = await fsp.realpath(resolvedPath).catch((error) => {
    if (error.code === "ENOENT") {
      throw createHttpError(404, "File not found");
    }

    throw error;
  });
  const stats = await fsp.stat(realPath);

  if (!stats.isFile()) {
    throw createHttpError(400, "Path must point to a file");
  }

  const allowedRoots = await listAllowedFileRoots();
  if (!allowedRoots.some((root) => isPathInsideRoot(realPath, root))) {
    throw createHttpError(403, "File is outside the available project roots");
  }

  return { filePath: realPath, stats };
}

async function readFileResource(filePath, stats) {
  const fileStats = stats || await fsp.stat(filePath);
  const mimeType = guessMimeType(filePath);
  const writable = await canWriteFile(filePath);
  const viewUrl = buildInlineFileUrl(filePath, Math.round(fileStats.mtimeMs));

  if (isImageFilePath(filePath)) {
    return {
      path: filePath,
      name: path.basename(filePath),
      kind: "image",
      mimeType,
      size: fileStats.size,
      mtimeMs: fileStats.mtimeMs,
      writable,
      viewUrl,
    };
  }

  const buffer = await fsp.readFile(filePath);
  const text = isBinaryBuffer(buffer) ? null : buffer.toString("utf8");

  return {
    path: filePath,
    name: path.basename(filePath),
    kind: text === null ? "binary" : "text",
    mimeType,
    size: fileStats.size,
    mtimeMs: fileStats.mtimeMs,
    writable,
    text,
    viewUrl,
  };
}

function handleEventSocketConnection(socket) {
  eventSocketClients.add(socket);
  socket.send(JSON.stringify({ type: "connected", timestamp: Date.now() }));

  socket.on("close", () => {
    eventSocketClients.delete(socket);
  });

  socket.on("error", () => {
    eventSocketClients.delete(socket);
  });
}

function normalizeTerminalColumns(value) {
  return clamp(toInteger(value, 120), 40, 240);
}

function normalizeTerminalRows(value) {
  return clamp(toInteger(value, 32), 12, 80);
}

async function ensureProjectTerminalSession(projectId, options = {}) {
  const project = await requireProject(cleanString(projectId));
  return terminalManager.ensureProjectSession(project, {
    columns: normalizeTerminalColumns(options.columns),
    rows: normalizeTerminalRows(options.rows),
    term: cleanString(options.term) || "xterm-256color",
  });
}

function handleTerminalSocketConnection(socket, projectId) {
  const normalizedProjectId = cleanString(projectId);
  const sockets = getProjectTerminalSockets(normalizedProjectId);
  sockets?.add(socket);

  sendSocketJson(socket, {
    type: "connected",
    timestamp: Date.now(),
    projectId: normalizedProjectId,
  });

  const session = terminalManager.getProjectSession(normalizedProjectId);
  if (session) {
    sendSocketJson(socket, {
      type: "session",
      timestamp: Date.now(),
      data: session,
    });
  }

  socket.on("message", (raw) => {
    try {
      const payload = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || ""));

      if (payload.type === "input") {
        terminalManager.writeProjectInput(normalizedProjectId, String(payload.data || ""));
        return;
      }

      if (payload.type === "control") {
        terminalManager.sendProjectControl(normalizedProjectId, payload.action);
        return;
      }

      if (payload.type === "resize") {
        terminalManager.resizeProjectSession(normalizedProjectId, {
          columns: payload.columns,
          rows: payload.rows,
        });
        return;
      }

      throw new Error(`Unsupported terminal message type: ${cleanString(payload.type) || "unknown"}`);
    } catch (error) {
      sendSocketJson(socket, {
        type: "error",
        timestamp: Date.now(),
        projectId: normalizedProjectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on("close", () => {
    removeProjectTerminalSocket(normalizedProjectId, socket);
  });

  socket.on("error", () => {
    removeProjectTerminalSocket(normalizedProjectId, socket);
  });
}

async function serveStatic(pathname, response) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const distExists = fs.existsSync(DIST_DIR);
  let filePath;

  if (distExists) {
    filePath = path.join(DIST_DIR, safePath);

    if (!filePath.startsWith(DIST_DIR)) {
      sendError(response, 403, "Forbidden");
      return;
    }
  } else if (safePath === "/index.html") {
    filePath = path.join(ROOT_DIR, "index.html");
  } else if (safePath.startsWith("/src/")) {
    filePath = path.join(ROOT_DIR, safePath);

    if (!filePath.startsWith(path.join(ROOT_DIR, "src"))) {
      sendError(response, 403, "Forbidden");
      return;
    }
  } else if (safePath.startsWith("/packages/")) {
    filePath = path.join(ROOT_DIR, safePath);

    if (!filePath.startsWith(path.join(ROOT_DIR, "packages"))) {
      sendError(response, 403, "Forbidden");
      return;
    }
  } else if (safePath.startsWith("/public/")) {
    filePath = path.join(ROOT_DIR, safePath);

    if (!filePath.startsWith(path.join(ROOT_DIR, "public"))) {
      sendError(response, 403, "Forbidden");
      return;
    }
  } else if (safePath.startsWith("/panes/")) {
    filePath = path.join(ROOT_DIR, safePath);

    if (!filePath.startsWith(path.join(ROOT_DIR, "panes"))) {
      sendError(response, 403, "Forbidden");
      return;
    }
  } else {
    sendError(response, 404, "Not found");
    return;
  }

  try {
    const contents = await fsp.readFile(filePath);
    const contentType = CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream";
    response.writeHead(200, { "Content-Type": contentType });
    response.end(contents);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendError(response, 404, "Not found");
      return;
    }

    throw error;
  }
}

function parseReviewTarget(body) {
  if (body.targetType === "baseBranch") {
    return { type: "baseBranch", branch: cleanString(body.branch) || "main" };
  }

  if (body.targetType === "commit") {
    return { type: "commit", sha: cleanString(body.sha), title: cleanString(body.title) || null };
  }

  if (body.targetType === "custom") {
    return { type: "custom", instructions: cleanString(body.instructions) };
  }

  return { type: "uncommittedChanges" };
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toInteger(value, fallback = 0) {
  return Math.round(toNumber(value, fallback));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

async function handleApi(request, response, url) {
  const { pathname, searchParams } = url;
  const parts = pathname.split("/").filter(Boolean);

  if (request.method === "GET" && pathname === "/api/boot") {
    sendJson(response, 200, await getBootState({
      includeModels: searchParams.get("includeModels") !== "false",
    }));
    return;
  }

  if (request.method === "GET" && pathname === "/api/models") {
    sendJson(response, 200, await getModels());
    return;
  }

  if (request.method === "GET" && pathname === "/api/account") {
    sendJson(response, 200, await getAccountState());
    return;
  }

  if (request.method === "GET" && pathname === "/api/pending-requests") {
    sendJson(response, 200, { ok: true, data: bridge.listPendingServerRequests() });
    return;
  }

  if (request.method === "POST" && pathname === "/api/auth/login") {
    const body = await readJsonBody(request);
    const loginType = body.type === "apiKey" ? "apiKey" : "chatgpt";
    const params = loginType === "apiKey"
      ? { type: "apiKey", apiKey: cleanString(body.apiKey) }
      : { type: "chatgpt" };

    sendJson(response, 200, { ok: true, data: await bridge.request("account/login/start", params) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/auth/logout") {
    sendJson(response, 200, { ok: true, data: await bridge.request("account/logout") });
    return;
  }

  if (request.method === "POST" && pathname === "/api/rpc") {
    const body = await readJsonBody(request);

    if (!cleanString(body.method) || body.method === "initialize") {
      throw new Error("method is required");
    }

    sendJson(response, 200, {
      ok: true,
      data: await bridge.request(body.method, body.params),
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/command") {
    const body = await readJsonBody(request);
    const project = await requireProject(cleanString(body.projectId));
    const command = cleanString(body.command);

    if (!command) {
      throw new Error("command is required");
    }

    sendJson(response, 200, {
      ok: true,
      data: await bridge.request("command/exec", {
        command: ["bash", "-lc", command],
        cwd: project.cwd,
        timeoutMs: Number.isFinite(body.timeoutMs) ? Number(body.timeoutMs) : 120000,
        sandboxPolicy: buildSandboxPolicy(project, body),
      }),
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/file") {
    const { filePath, stats } = await resolveAllowedFilePath(searchParams.get("path"));
    sendJson(response, 200, { ok: true, data: await readFileResource(filePath, stats) });
    return;
  }

  if (request.method === "PUT" && pathname === "/api/file") {
    const body = await readJsonBody(request);
    const { filePath, stats } = await resolveAllowedFilePath(body.path);
    const expectedMtimeMs = Number(body.expectedMtimeMs);

    if (isImageFilePath(filePath)) {
      throw createHttpError(400, "Image files are preview-only in this pane");
    }

    const currentBuffer = await fsp.readFile(filePath);
    if (isBinaryBuffer(currentBuffer)) {
      throw createHttpError(400, "Binary files cannot be edited in the text editor");
    }

    if (Number.isFinite(expectedMtimeMs) && Math.round(stats.mtimeMs) !== Math.round(expectedMtimeMs)) {
      throw createHttpError(409, "File changed on disk. Reload it before saving.");
    }

    if (!(await canWriteFile(filePath))) {
      throw createHttpError(403, "File is not writable");
    }

    await fsp.writeFile(filePath, typeof body.text === "string" ? body.text : "", "utf8");
    const nextStats = await fsp.stat(filePath);
    sendJson(response, 200, {
      ok: true,
      data: {
        path: filePath,
        mtimeMs: nextStats.mtimeMs,
        size: nextStats.size,
      },
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/file/content") {
    const { filePath } = await resolveAllowedFilePath(searchParams.get("path"));
    const contents = await fsp.readFile(filePath);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Disposition": `inline; filename="${path.basename(filePath).replaceAll('"', "")}"`,
      "Content-Type": guessMimeType(filePath),
    });
    response.end(contents);
    return;
  }

  if (request.method === "GET" && parts[1] === "projects" && parts.length === 2) {
    sendJson(response, 200, { ok: true, data: await listProjects() });
    return;
  }

  if (request.method === "POST" && parts[1] === "projects" && parts.length === 2) {
    const body = await readJsonBody(request);
    sendJson(response, 200, { ok: true, data: await saveProject(body) });
    return;
  }

  if (request.method === "DELETE" && parts[1] === "projects" && parts.length === 3) {
    await terminalManager.closeProjectSession(decodeURIComponent(parts[2])).catch(() => {});
    await removeProject(decodeURIComponent(parts[2]));
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && parts[1] === "projects" && parts[3] === "threads") {
    const project = await requireProject(decodeURIComponent(parts[2]));
    const archived = searchParams.get("archived") === "true";

    sendJson(response, 200, {
      ok: true,
      data: await bridge.request("thread/list", {
        archived,
        cwd: project.cwd,
        limit: 100,
        sortKey: "updated_at",
        sourceKinds: THREAD_SOURCE_KINDS,
      }),
    });
    return;
  }

  if (request.method === "GET" && parts[1] === "projects" && parts[3] === "skills") {
    const project = await requireProject(decodeURIComponent(parts[2]));
    sendJson(response, 200, {
      ok: true,
      data: await bridge.request("skills/list", {
        cwds: [project.cwd],
        forceReload: searchParams.get("reload") === "true",
      }),
    });
    return;
  }

  if (request.method === "GET" && parts[1] === "projects" && parts[3] === "terminal" && parts.length === 4) {
    sendJson(response, 200, {
      ok: true,
      data: terminalManager.getProjectSession(decodeURIComponent(parts[2])),
    });
    return;
  }

  if (request.method === "POST" && parts[1] === "projects" && parts[3] === "terminal" && parts.length === 4) {
    const body = await readJsonBody(request);
    const session = await ensureProjectTerminalSession(decodeURIComponent(parts[2]), body);
    sendJson(response, 200, { ok: true, data: session });
    return;
  }

  if (request.method === "DELETE" && parts[1] === "projects" && parts[3] === "terminal" && parts.length === 4) {
    const projectId = decodeURIComponent(parts[2]);
    await terminalManager.closeProjectSession(projectId);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && pathname === "/api/threads") {
    const body = await readJsonBody(request);
    const project = await requireProject(cleanString(body.projectId));
    const selection = await resolveComposerSelection(project, body);
    const threadConfig = buildThreadConfig(project, body, selection);

    const threadResult = await bridge.request("thread/start", {
      ...threadConfig,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      serviceName: "custom-codex-web",
    });

    if (cleanString(body.name)) {
      await bridge.request("thread/name/set", {
        threadId: threadResult.thread.id,
        name: cleanString(body.name),
      });
    }

    if (cleanString(body.prompt) || (Array.isArray(body.images) && body.images.length > 0)) {
      await bridge.request("turn/start", {
        threadId: threadResult.thread.id,
        input: buildTurnInput(body, "prompt"),
        ...buildTurnConfig(project, body, selection),
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
        // Thread selection should be observational. Resuming here can perturb an in-flight thread.
        data: await bridge.request("thread/read", {
          threadId,
          includeTurns: true,
        }),
      });
    } catch {
      sendJson(response, 200, {
        ok: true,
        data: await bridge.request("thread/read", {
          threadId,
          includeTurns: false,
        }),
      });
    }

    return;
  }

  if (request.method === "POST" && parts[1] === "threads" && parts[3] === "message") {
    const body = await readJsonBody(request);
    const threadId = decodeURIComponent(parts[2]);
    const project = await requireProject(cleanString(body.projectId));
    const selection = await resolveComposerSelection(project, body);
    await bridge.request("thread/resume", {
      threadId,
      ...buildThreadConfig(project, body, selection),
      persistExtendedHistory: true,
    });

    sendJson(response, 200, {
      ok: true,
      data: await bridge.request("turn/start", {
        threadId,
        input: buildTurnInput(body, "text"),
        ...buildTurnConfig(project, body, selection),
      }),
    });
    return;
  }

  if (request.method === "POST" && parts[1] === "threads" && parts[3] === "name") {
    const body = await readJsonBody(request);
    sendJson(response, 200, {
      ok: true,
      data: await bridge.request("thread/name/set", {
        threadId: decodeURIComponent(parts[2]),
        name: cleanString(body.name),
      }),
    });
    return;
  }

  if (request.method === "POST" && parts[1] === "threads" && parts[3] === "fork") {
    sendJson(response, 200, {
      ok: true,
      data: await bridge.request("thread/fork", {
        threadId: decodeURIComponent(parts[2]),
      }),
    });
    return;
  }

  if (request.method === "POST" && parts[1] === "threads" && parts[3] === "archive") {
    sendJson(response, 200, {
      ok: true,
      data: await bridge.request("thread/archive", {
        threadId: decodeURIComponent(parts[2]),
      }),
    });
    return;
  }

  if (request.method === "POST" && parts[1] === "threads" && parts[3] === "unarchive") {
    sendJson(response, 200, {
      ok: true,
      data: await bridge.request("thread/unarchive", {
        threadId: decodeURIComponent(parts[2]),
      }),
    });
    return;
  }

  if (request.method === "POST" && parts[1] === "threads" && parts[3] === "compact") {
    sendJson(response, 200, {
      ok: true,
      data: await threadActionHelpers.requestThreadActionWithResumeRetry("thread/compact/start", {
        threadId: decodeURIComponent(parts[2]),
      }),
    });
    return;
  }

  if (request.method === "POST" && parts[1] === "threads" && parts[3] === "interrupt") {
    const body = await readJsonBody(request);
    sendJson(response, 200, {
      ok: true,
      data: await bridge.request("turn/interrupt", {
        threadId: decodeURIComponent(parts[2]),
        turnId: cleanString(body.turnId),
      }),
    });
    return;
  }

  if (request.method === "POST" && parts[1] === "threads" && parts[3] === "review") {
    const body = await readJsonBody(request);
    sendJson(response, 200, {
      ok: true,
      data: await threadActionHelpers.requestThreadActionWithResumeRetry("review/start", {
        threadId: decodeURIComponent(parts[2]),
        target: parseReviewTarget(body),
        delivery: body.delivery === "detached" ? "detached" : "inline",
      }),
    });
    return;
  }

  if (request.method === "POST" && parts[1] === "server-requests" && parts[3] === "respond") {
    const body = await readJsonBody(request);
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
