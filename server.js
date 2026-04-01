const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");
const { XSessionManager } = require("./x-session-manager");

const ROOT_DIR = __dirname;
const DIST_DIR = path.join(ROOT_DIR, "dist");
const DATA_DIR = path.join(ROOT_DIR, "data");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
const PORT = Number(process.env.PORT || 3210);
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const MAX_BODY_BYTES = 15 * 1024 * 1024;

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

const MOD_SHIFT = 1 << 0;
const MOD_CONTROL = 1 << 1;
const MOD_ALT = 1 << 2;
const MOD_META = 1 << 3;

const DESKTOP_TOOL_SPECS = [
  {
    name: "virtual_desktop_snapshot",
    description: "Capture the current virtual desktop screenshot for this conversation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        delayMs: {
          type: "integer",
          minimum: 0,
          maximum: 5000,
          description: "Optional delay before taking the screenshot.",
        },
      },
    },
  },
  {
    name: "virtual_desktop_click",
    description: "Click at a screen position on the virtual desktop and return an updated screenshot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y"],
      properties: {
        x: { type: "integer", minimum: 0, description: "Horizontal screen coordinate in desktop pixels." },
        y: { type: "integer", minimum: 0, description: "Vertical screen coordinate in desktop pixels." },
        button: {
          type: "string",
          enum: ["left", "middle", "right"],
          description: "Mouse button to click. Defaults to left.",
        },
        clicks: {
          type: "integer",
          minimum: 1,
          maximum: 3,
          description: "Number of clicks to perform. Defaults to 1.",
        },
        delayMs: {
          type: "integer",
          minimum: 0,
          maximum: 5000,
          description: "Optional delay after the click before capturing the next screenshot.",
        },
      },
    },
  },
  {
    name: "virtual_desktop_scroll",
    description: "Scroll at a screen position on the virtual desktop and return an updated screenshot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y"],
      properties: {
        x: { type: "integer", minimum: 0, description: "Horizontal screen coordinate in desktop pixels." },
        y: { type: "integer", minimum: 0, description: "Vertical screen coordinate in desktop pixels." },
        deltaX: { type: "integer", description: "Horizontal wheel delta. Positive scrolls right." },
        deltaY: { type: "integer", description: "Vertical wheel delta. Positive scrolls down." },
        delayMs: {
          type: "integer",
          minimum: 0,
          maximum: 5000,
          description: "Optional delay after scrolling before capturing the next screenshot.",
        },
      },
    },
  },
  {
    name: "virtual_desktop_key",
    description: "Send a key press with optional modifiers to the virtual desktop and return an updated screenshot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["key"],
      properties: {
        key: {
          type: "string",
          minLength: 1,
          description: "Key name such as Enter, Tab, Escape, ArrowLeft, a, A, or space.",
        },
        modifiers: {
          type: "array",
          description: "Optional modifier keys held during the key press.",
          items: {
            type: "string",
            enum: ["Shift", "Control", "Alt", "Meta"],
          },
        },
        delayMs: {
          type: "integer",
          minimum: 0,
          maximum: 5000,
          description: "Optional delay after the key press before capturing the next screenshot.",
        },
      },
    },
  },
  {
    name: "virtual_desktop_type",
    description: "Type text into the virtual desktop and return an updated screenshot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: {
          type: "string",
          minLength: 1,
          description: "Text to type. Supports letters, numbers, punctuation, spaces, newlines, and tabs.",
        },
        submit: {
          type: "boolean",
          description: "If true, press Enter after typing.",
        },
        delayMs: {
          type: "integer",
          minimum: 0,
          maximum: 5000,
          description: "Optional delay after typing before capturing the next screenshot.",
        },
      },
    },
  },
];

const eventSocketClients = new Set();
const xSessionManager = new XSessionManager();

class CodexBridge extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.ready = false;
    this.startPromise = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.pendingServerRequests = new Map();
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

    this.child = spawn(CODEX_BIN, ["app-server", "--listen", "stdio://", "--session-source", "appServer"], {
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

      console.error(`[codex] ${line}`);
      this.emit("event", { type: "bridge-log", line });
    }
  }

  handleMessage(message) {
    if (message && typeof message === "object" && "method" in message && "id" in message) {
      this.pendingServerRequests.set(String(message.id), { ...message, receivedAt: Date.now() });
      this.emit("event", { type: "server-request", request: message });
      return;
    }

    if (message && typeof message === "object" && "method" in message) {
      if (message.method === "serverRequest/resolved" && message.params?.requestId != null) {
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

bridge.on("event", (payload) => {
  if (payload?.type === "notification") {
    writeRealtimeLlmDelta(payload.message);
  }

  if (payload?.type === "server-request" && payload.request?.method === "item/tool/call") {
    handleDynamicToolCallRequest(payload.request).catch((error) => {
      console.error("Failed to handle dynamic tool call", error);
    });
  }

  broadcast({ timestamp: Date.now(), ...payload });
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

  const projects = Array.isArray(parsed) && parsed.length > 0
    ? parsed.map(normalizeStoredProject)
    : [buildDefaultProject()];

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
  const existing = projects.find((project) => project.id === input.id);
  const cwd = path.resolve(cleanString(input.cwd) || ROOT_DIR);
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

  await writeProjects(nextProjects);
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
  const target = path.resolve(cleanString(cwd) || ROOT_DIR);
  const projects = await listProjects();
  return projects.find((project) => path.resolve(project.cwd) === target) || null;
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

function buildThreadConfig(project, overrides = {}) {
  const dynamicTools = DESKTOP_TOOL_SPECS.map((tool) => ({ ...tool }));

  return compactObject({
    model: cleanString(overrides.model) || cleanString(project.defaultModel) || undefined,
    cwd: project.cwd,
    approvalPolicy: pickApprovalPolicy(overrides.approvalPolicy, project.approvalPolicy),
    sandbox: pickEnum(overrides.sandboxMode || project.sandboxMode, ["read-only", "workspace-write", "danger-full-access"], project.sandboxMode),
    personality: pickEnum(overrides.personality || project.defaultPersonality, ["none", "friendly", "pragmatic"], project.defaultPersonality),
    dynamicTools,
    config: {
      dynamicTools,
    },
  });
}

function buildTurnConfig(project, overrides = {}) {
  return compactObject({
    cwd: project.cwd,
    approvalPolicy: pickApprovalPolicy(overrides.approvalPolicy, project.approvalPolicy),
    sandboxPolicy: buildSandboxPolicy(project, overrides),
    model: cleanString(overrides.model) || cleanString(project.defaultModel) || undefined,
    effort: pickEnum(overrides.effort || project.defaultEffort, ["none", "minimal", "low", "medium", "high", "xhigh"], project.defaultEffort),
    serviceTier: pickEnum(overrides.serviceTier, ["flex", "fast"], undefined),
    collaborationMode: normalizeCollaborationMode(overrides),
    summary: pickEnum(overrides.summary || project.defaultSummary, ["auto", "concise", "detailed", "none"], project.defaultSummary),
    personality: pickEnum(overrides.personality || project.defaultPersonality, ["none", "friendly", "pragmatic"], project.defaultPersonality),
  });
}

function normalizeCollaborationMode(overrides = {}) {
  const mode = cleanString(overrides?.collaborationMode?.mode);
  if (!["default", "plan"].includes(mode)) {
    return undefined;
  }

  const settings = overrides?.collaborationMode?.settings && typeof overrides.collaborationMode.settings === "object"
    ? overrides.collaborationMode.settings
    : {};
  const model = cleanString(settings.model) || cleanString(overrides.model);

  if (!model) {
    return undefined;
  }

  return {
    mode,
    settings: compactObject({
      model,
      reasoning_effort: pickEnum(
        settings.reasoning_effort || overrides.effort,
        ["none", "minimal", "low", "medium", "high", "xhigh"],
        undefined,
      ),
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

async function getBootState() {
  const projects = await listProjects();
  const models = await getModels();

  return {
    ok: true,
    projects,
    models,
    xSessions: xSessionManager.listSessions(""),
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

async function getModels() {
  try {
    const result = await bridge.request("model/list", { includeHidden: false });
    return { ok: true, data: result.data || result.models || [] };
  } catch (error) {
    return { ok: false, error: error.message, data: [] };
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
  } else if (safePath === "/index.html" || safePath === "/x-session.html") {
    filePath = path.join(ROOT_DIR, "index.html");
    if (safePath === "/x-session.html") {
      filePath = path.join(ROOT_DIR, "x-session.html");
    }
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeToolArguments(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeDelayMs(value, fallback = 250) {
  return clamp(toInteger(value, fallback), 0, 5000);
}

function buttonNameToIndex(button) {
  const normalized = cleanString(button).toLowerCase();
  if (normalized === "middle") return 1;
  if (normalized === "right") return 2;
  return 0;
}

function modifierNameToEvent(name) {
  const normalized = cleanString(name).toLowerCase();

  if (normalized === "shift") {
    return { key: "Shift", code: "ShiftLeft", bit: MOD_SHIFT };
  }
  if (normalized === "control" || normalized === "ctrl") {
    return { key: "Control", code: "ControlLeft", bit: MOD_CONTROL };
  }
  if (normalized === "alt" || normalized === "option") {
    return { key: "Alt", code: "AltLeft", bit: MOD_ALT };
  }
  if (normalized === "meta" || normalized === "cmd" || normalized === "command") {
    return { key: "Meta", code: "MetaLeft", bit: MOD_META };
  }

  return null;
}

function normalizeKeyDescriptor(value) {
  const raw = String(value ?? "");
  const trimmed = raw.trim();
  const token = trimmed || raw;

  if (!token) {
    throw new Error("key is required");
  }

  const lower = token.toLowerCase();

  if (lower === "enter" || lower === "return") return { key: "Enter", code: "Enter" };
  if (lower === "tab") return { key: "Tab", code: "Tab" };
  if (lower === "escape" || lower === "esc") return { key: "Escape", code: "Escape" };
  if (lower === "backspace") return { key: "Backspace", code: "Backspace" };
  if (lower === "delete" || lower === "del") return { key: "Delete", code: "Delete" };
  if (lower === "space" || raw === " ") return { key: " ", code: "Space" };
  if (lower === "arrowup") return { key: "ArrowUp", code: "ArrowUp" };
  if (lower === "arrowdown") return { key: "ArrowDown", code: "ArrowDown" };
  if (lower === "arrowleft") return { key: "ArrowLeft", code: "ArrowLeft" };
  if (lower === "arrowright") return { key: "ArrowRight", code: "ArrowRight" };

  if (token.length === 1) {
    if (/[a-z]/i.test(token)) {
      return { key: token, code: `Key${token.toUpperCase()}` };
    }

    if (/[0-9]/.test(token)) {
      return { key: token, code: `Digit${token}` };
    }

    return { key: token, code: token === " " ? "Space" : "" };
  }

  return { key: token, code: token };
}

function createKeyStrokeEvents(keyDescriptor, modifiers = []) {
  const modifierEvents = modifiers
    .map((value) => modifierNameToEvent(value))
    .filter(Boolean);
  let modifierMask = 0;
  const events = [];

  for (const modifier of modifierEvents) {
    modifierMask |= modifier.bit;
    events.push({
      kind: "keyDown",
      key: modifier.key,
      code: modifier.code,
      modifiers: modifierMask,
    });
  }

  events.push({
    kind: "keyDown",
    key: keyDescriptor.key,
    code: keyDescriptor.code,
    modifiers: modifierMask,
  });
  events.push({
    kind: "keyUp",
    key: keyDescriptor.key,
    code: keyDescriptor.code,
    modifiers: modifierMask,
  });

  for (let index = modifierEvents.length - 1; index >= 0; index -= 1) {
    const modifier = modifierEvents[index];
    events.push({
      kind: "keyUp",
      key: modifier.key,
      code: modifier.code,
      modifiers: modifierMask,
    });
    modifierMask &= ~modifier.bit;
  }

  return events;
}

function createTypeEvents(text, submit = false) {
  const events = [];

  for (const char of String(text || "")) {
    if (char === "\r") {
      continue;
    }

    if (char === "\n") {
      events.push(...createKeyStrokeEvents({ key: "Enter", code: "Enter" }));
      continue;
    }

    if (char === "\t") {
      events.push(...createKeyStrokeEvents({ key: "Tab", code: "Tab" }));
      continue;
    }

    if (char === "\b") {
      events.push(...createKeyStrokeEvents({ key: "Backspace", code: "Backspace" }));
      continue;
    }

    events.push(...createKeyStrokeEvents(normalizeKeyDescriptor(char)));
  }

  if (submit) {
    events.push(...createKeyStrokeEvents({ key: "Enter", code: "Enter" }));
  }

  return events;
}

async function resolveThreadProject(threadId) {
  const threadPayload = await bridge.request("thread/read", {
    threadId,
    includeTurns: false,
  });
  const thread = threadPayload.data?.thread || threadPayload.thread || threadPayload;
  const project = await findProjectByCwd(thread?.cwd);

  return { thread, project };
}

async function ensureThreadDesktopSession(threadId, requestHost = "", options = {}) {
  const existing = xSessionManager.getSessionByThreadId(threadId, requestHost);
  if (existing) {
    return existing;
  }

  const { project } = await resolveThreadProject(threadId);
  if (!project) {
    throw new Error("Unable to resolve project for thread desktop");
  }

  return xSessionManager.createSession({
    threadId,
    command: cleanString(options.command) || "xterm",
    windowManagerCommand: cleanString(options.windowManagerCommand) || "openbox",
    xServerBackend: cleanString(options.xServerBackend) || "xvfb",
    useBubblewrap: options.useBubblewrap !== false,
    workingDirectory: project.cwd,
    writableMounts: [
      { hostPath: project.cwd, guestPath: project.cwd },
    ],
  }, requestHost);
}

async function captureThreadDesktop(threadId, requestHost = "", delayMs = 0) {
  await ensureThreadDesktopSession(threadId, requestHost);
  if (delayMs > 0) {
    await sleep(delayMs);
  }
  return xSessionManager.captureThreadScreenshot(threadId);
}

function buildDesktopToolResponse(threadId, toolName, screenshot, note) {
  const lines = [
    `Tool: ${toolName}`,
    `Thread: ${threadId}`,
    `Screen: ${screenshot.width}x${screenshot.height}`,
  ];

  if (note) {
    lines.push(note);
  }

  return {
    success: true,
    contentItems: [
      { type: "inputText", text: lines.join("\n") },
      { type: "inputImage", imageUrl: screenshot.dataUrl },
    ],
  };
}

function buildDesktopToolErrorResponse(error) {
  return {
    success: false,
    contentItems: [
      {
        type: "inputText",
        text: `Virtual desktop tool failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
  };
}

async function executeDesktopToolCall(params, requestHost = "") {
  const threadId = cleanString(params.threadId);
  const toolName = cleanString(params.tool);
  const args = normalizeToolArguments(params.arguments);

  if (!threadId) {
    throw new Error("threadId is required for desktop tool calls");
  }

  if (toolName === "virtual_desktop_snapshot") {
    const screenshot = await captureThreadDesktop(threadId, requestHost, normalizeDelayMs(args.delayMs, 0));
    return buildDesktopToolResponse(threadId, toolName, screenshot, "Captured the current desktop.");
  }

  await ensureThreadDesktopSession(threadId, requestHost);

  if (toolName === "virtual_desktop_click") {
    const x = clamp(toInteger(args.x, 0), 0, 100000);
    const y = clamp(toInteger(args.y, 0), 0, 100000);
    const buttonName = cleanString(args.button) || "left";
    const button = buttonNameToIndex(buttonName);
    const clicks = clamp(toInteger(args.clicks, 1), 1, 3);
    const events = [];

    for (let index = 0; index < clicks; index += 1) {
      events.push({ kind: "pointerDown", x, y, button, buttons: 0, modifiers: 0 });
      events.push({ kind: "pointerUp", x, y, button, buttons: 0, modifiers: 0 });
    }

    await xSessionManager.injectThreadEvents(threadId, events, {
      delayMs: normalizeDelayMs(args.delayMs),
    });
    const screenshot = await xSessionManager.captureThreadScreenshot(threadId);
    return buildDesktopToolResponse(threadId, toolName, screenshot, `Clicked ${buttonName} at (${x}, ${y}).`);
  }

  if (toolName === "virtual_desktop_scroll") {
    const x = clamp(toInteger(args.x, 0), 0, 100000);
    const y = clamp(toInteger(args.y, 0), 0, 100000);
    const deltaX = toInteger(args.deltaX, 0);
    const deltaY = toInteger(args.deltaY, 0);

    if (deltaX === 0 && deltaY === 0) {
      throw new Error("deltaX or deltaY is required");
    }

    await xSessionManager.injectThreadEvents(threadId, [{
      kind: "wheel",
      x,
      y,
      deltaX,
      deltaY,
      modifiers: 0,
    }], {
      delayMs: normalizeDelayMs(args.delayMs),
    });
    const screenshot = await xSessionManager.captureThreadScreenshot(threadId);
    return buildDesktopToolResponse(threadId, toolName, screenshot, `Scrolled at (${x}, ${y}) with delta (${deltaX}, ${deltaY}).`);
  }

  if (toolName === "virtual_desktop_key") {
    const keyDescriptor = normalizeKeyDescriptor(args.key);
    const modifiers = Array.isArray(args.modifiers) ? args.modifiers : [];
    const events = createKeyStrokeEvents(keyDescriptor, modifiers);

    await xSessionManager.injectThreadEvents(threadId, events, {
      delayMs: normalizeDelayMs(args.delayMs),
    });
    const screenshot = await xSessionManager.captureThreadScreenshot(threadId);
    return buildDesktopToolResponse(threadId, toolName, screenshot, `Pressed ${[...modifiers, keyDescriptor.key].join("+")}.`);
  }

  if (toolName === "virtual_desktop_type") {
    const text = String(args.text || "");
    if (!text) {
      throw new Error("text is required");
    }

    const events = createTypeEvents(text, Boolean(args.submit));
    await xSessionManager.injectThreadEvents(threadId, events, {
      delayMs: normalizeDelayMs(args.delayMs),
    });
    const screenshot = await xSessionManager.captureThreadScreenshot(threadId);
    const preview = text.length > 80 ? `${text.slice(0, 77)}...` : text;
    return buildDesktopToolResponse(
      threadId,
      toolName,
      screenshot,
      `Typed ${JSON.stringify(preview)}${args.submit ? " and pressed Enter" : ""}.`,
    );
  }

  throw new Error(`Unsupported dynamic tool: ${toolName}`);
}

async function handleDynamicToolCallRequest(request) {
  try {
    const result = await executeDesktopToolCall(request.params);
    await bridge.respondToServerRequest(request.id, result);
    broadcast({
      timestamp: Date.now(),
      type: "dynamic-tool-response",
      requestId: request.id,
      threadId: request.params?.threadId || null,
      tool: request.params?.tool || null,
      success: true,
    });
  } catch (error) {
    await bridge.respondToServerRequest(request.id, buildDesktopToolErrorResponse(error));
    broadcast({
      timestamp: Date.now(),
      type: "dynamic-tool-response",
      requestId: request.id,
      threadId: request.params?.threadId || null,
      tool: request.params?.tool || null,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

let activeConsoleResponseKey = "";

function closeConsoleResponseStream() {
  if (!activeConsoleResponseKey) {
    return;
  }

  process.stdout.write("\n");
  activeConsoleResponseKey = "";
}

function formatConsoleResponseLabel(threadId, turnId, itemId) {
  return `[llm ${String(threadId || "").slice(0, 8)} ${String(turnId || "").slice(0, 8)} ${String(itemId || "").slice(0, 8)}] `;
}

function writeRealtimeLlmDelta(message) {
  const method = typeof message?.method === "string" ? message.method : "";
  const params = message?.params || {};

  if (method === "item/agentMessage/delta") {
    const key = `${params.threadId || ""}:${params.turnId || ""}:${params.itemId || ""}`;
    if (key !== activeConsoleResponseKey) {
      closeConsoleResponseStream();
      activeConsoleResponseKey = key;
      process.stdout.write(formatConsoleResponseLabel(params.threadId, params.turnId, params.itemId));
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
  const requestHost = request.headers["x-forwarded-host"] || request.headers.host || "";

  if (request.method === "GET" && pathname === "/api/boot") {
    sendJson(response, 200, await getBootState());
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

  if (request.method === "GET" && pathname === "/api/x-sessions") {
    sendJson(response, 200, { ok: true, data: xSessionManager.listSessions(requestHost) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/x-sessions") {
    const body = await readJsonBody(request);
    sendJson(response, 200, {
      ok: true,
      data: await xSessionManager.createSession(body, requestHost),
    });
    return;
  }

  if (request.method === "GET" && parts[1] === "x-sessions" && parts.length === 3) {
    const session = xSessionManager.getSession(decodeURIComponent(parts[2]), requestHost);
    if (!session) {
      sendError(response, 404, "Session not found");
      return;
    }
    sendJson(response, 200, { ok: true, data: session });
    return;
  }

  if (request.method === "DELETE" && parts[1] === "x-sessions" && parts.length === 3) {
    await xSessionManager.stopSession(decodeURIComponent(parts[2]));
    sendJson(response, 200, { ok: true });
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

  if (request.method === "POST" && pathname === "/api/threads") {
    const body = await readJsonBody(request);
    const project = await requireProject(cleanString(body.projectId));
    const threadConfig = buildThreadConfig(project, body);

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
        ...buildTurnConfig(project, body),
      });
    }

    sendJson(response, 200, { ok: true, data: threadResult });
    return;
  }

  if (request.method === "GET" && parts[1] === "threads" && parts.length === 3) {
    const threadId = decodeURIComponent(parts[2]);
    let project = null;

    try {
      project = (await resolveThreadProject(threadId)).project;
    } catch {
      project = null;
    }

    try {
      sendJson(response, 200, {
        ok: true,
        data: await bridge.request("thread/resume", {
          threadId,
          ...(project ? buildThreadConfig(project) : {}),
          persistExtendedHistory: true,
        }),
      });
    } catch {
      try {
        sendJson(response, 200, {
          ok: true,
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
    }

    return;
  }

  if (request.method === "POST" && parts[1] === "threads" && parts[3] === "message") {
    const body = await readJsonBody(request);
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

  if (request.method === "GET" && parts[1] === "threads" && parts[3] === "desktop" && parts.length === 4) {
    const threadId = decodeURIComponent(parts[2]);
    const session = xSessionManager.getSessionByThreadId(threadId, requestHost);
    sendJson(response, 200, { ok: true, data: session });
    return;
  }

  if (request.method === "POST" && parts[1] === "threads" && parts[3] === "desktop" && parts.length === 4) {
    const body = await readJsonBody(request);
    const threadId = decodeURIComponent(parts[2]);
    const projectId = cleanString(body.projectId);
    let session;

    if (projectId) {
      const project = await requireProject(projectId);
      session = await xSessionManager.createSession({
        threadId,
        command: cleanString(body.command) || "xterm",
        windowManagerCommand: cleanString(body.windowManagerCommand) || "openbox",
        xServerBackend: cleanString(body.xServerBackend) || "xvfb",
        useBubblewrap: body.useBubblewrap !== false,
        workingDirectory: project.cwd,
        writableMounts: [
          {
            hostPath: project.cwd,
            guestPath: project.cwd,
          },
        ],
      }, requestHost);
    } else {
      session = await ensureThreadDesktopSession(threadId, requestHost, {
        command: body.command,
        windowManagerCommand: body.windowManagerCommand,
        xServerBackend: body.xServerBackend,
        useBubblewrap: body.useBubblewrap,
      });
    }

    sendJson(response, 200, { ok: true, data: session });
    return;
  }

  if (request.method === "DELETE" && parts[1] === "threads" && parts[3] === "desktop" && parts.length === 4) {
    const threadId = decodeURIComponent(parts[2]);
    const session = xSessionManager.getSessionByThreadId(threadId, requestHost);
    if (session) {
      await xSessionManager.stopSession(session.id);
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && parts[1] === "threads" && parts[3] === "desktop" && parts[4] === "frame-rate" && parts.length === 5) {
    const threadId = decodeURIComponent(parts[2]);
    const body = await readJsonBody(request);
    const session = xSessionManager.getSessionByThreadId(threadId, requestHost);
    if (!session) {
      throw new Error("Session not found");
    }
    const updated = await xSessionManager.updateSessionFrameRate(session.id, body.frameRate);
    sendJson(response, 200, { ok: true, data: xSessionManager.serializeSession(updated, requestHost) });
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
      data: await bridge.request("thread/compact/start", {
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
      data: await bridge.request("review/start", {
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
    sendError(response, 500, error);
  }
});

const eventSocketServer = new WebSocketServer({ noServer: true });

eventSocketServer.on("connection", (socket) => {
  handleEventSocketConnection(socket);
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);

  if (url.pathname !== "/ws/events") {
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

server.listen(PORT, async () => {
  await ensureProjectStore();
  console.log(`Custom Codex web client listening on http://localhost:${PORT}`);
});

async function shutdownAndExit(code) {
  await xSessionManager.stopAll().catch(() => {});
  process.exit(code);
}

process.on("SIGINT", () => {
  void shutdownAndExit(0);
});

process.on("SIGTERM", () => {
  void shutdownAndExit(0);
});
