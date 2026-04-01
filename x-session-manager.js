const crypto = require("crypto");
const net = require("net");
const path = require("path");
const { EventEmitter } = require("events");
const { pathToFileURL } = require("url");

const ROOT_DIR = __dirname;
const HOST_MODULE_URL = pathToFileURL(path.join(ROOT_DIR, "packages/host-session/index.mjs")).href;
const MAX_LOG_ENTRIES = 200;
const DISPLAY_START = 110;
const PORT_START = 19080;

let hostModulePromise = null;

async function loadHostModule() {
  if (!hostModulePromise) {
    hostModulePromise = import(HOST_MODULE_URL);
  }
  return hostModulePromise;
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function normalizeCommandLine(text) {
  return cleanString(text);
}

function defaultWindowManagerWithPanel(commandText, panelCommand = "tint2") {
  const command = cleanString(commandText);

  if (!command) {
    return "";
  }

  if (command === "openbox") {
    return `openbox --startup "${panelCommand}"`;
  }

  return command;
}

function parseShellCommands(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({
      command: "bash",
      args: ["-lc", line],
      source: line,
    }));
}

function hasCommand(commands, commandName) {
  return commands.some((entry) => {
    const command = cleanString(entry?.command).toLowerCase();
    const source = cleanString(entry?.source).toLowerCase();
    return command === commandName || source === commandName || source.startsWith(`${commandName} `);
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1" }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(start = PORT_START) {
  for (let port = start; port < start + 1000; port += 1) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error("Unable to find a free WebSocket port");
}

async function findFreeDisplayNumber(start = DISPLAY_START, excluded = new Set()) {
  for (let displayNumber = start; displayNumber < start + 100; displayNumber += 1) {
    if (excluded.has(displayNumber)) {
      continue;
    }
    const tcpPort = 6000 + displayNumber;
    if (await isPortFree(tcpPort)) {
      return displayNumber;
    }
  }
  throw new Error("Unable to find a free display number");
}

function makeWsUrl(hostHeader, port) {
  const forwardedHost = cleanString(hostHeader) || "127.0.0.1";
  const hostname = forwardedHost.replace(/:\d+$/, "") || "127.0.0.1";
  return `ws://${hostname}:${port}`;
}

class XSessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.threadSessions = new Map();
  }

  listSessions(hostHeader) {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((session) => this.serializeSession(session, hostHeader));
  }

  getSession(id, hostHeader) {
    const session = this.sessions.get(id);
    return session ? this.serializeSession(session, hostHeader) : null;
  }

  getSessionRecord(id) {
    return this.sessions.get(id) || null;
  }

  getSessionByThreadId(threadId, hostHeader) {
    const sessionId = this.threadSessions.get(cleanString(threadId));
    if (!sessionId) {
      return null;
    }
    return this.getSession(sessionId, hostHeader);
  }

  getSessionRecordByThreadId(threadId) {
    const sessionId = this.threadSessions.get(cleanString(threadId));
    if (!sessionId) {
      return null;
    }

    return this.getSessionRecord(sessionId);
  }

  async createSession(input = {}, hostHeader = "") {
    const threadId = cleanString(input.threadId);
    if (threadId) {
      const existing = this.getSessionByThreadId(threadId, hostHeader);
      if (existing) {
        return existing;
      }
    }

    const { HeadlessXSessionHost } = await loadHostModule();
    const activeDisplays = new Set(Array.from(this.sessions.values()).map((session) => session.host?.options?.displayNumber));
    const displayNumber = Number.isInteger(input.displayNumber)
      ? input.displayNumber
      : await findFreeDisplayNumber(DISPLAY_START, activeDisplays);
    const wsPort = Number.isInteger(input.wsPort) ? input.wsPort : await findFreePort();
    const authToken = cleanString(input.authToken) || crypto.randomBytes(16).toString("hex");
    const appCommands = parseShellCommands(input.command);
    const workingDirectory = cleanString(input.workingDirectory);
    const writableMounts = Array.isArray(input.writableMounts)
      ? input.writableMounts
        .map((entry) => ({
          hostPath: cleanString(entry?.hostPath),
          guestPath: cleanString(entry?.guestPath) || cleanString(entry?.hostPath),
        }))
        .filter((entry) => entry.hostPath && entry.guestPath)
      : [];
    const requestedWindowManager = normalizeCommandLine(input.windowManagerCommand) || "openbox";
    const hasTint2AppCommand = hasCommand(appCommands, "tint2");
    const defaultWindowManager = hasTint2AppCommand
      ? requestedWindowManager
      : defaultWindowManagerWithPanel(requestedWindowManager, "tint2");
    const windowManagerCommand = defaultWindowManager
      ? { command: "bash", args: ["-lc", defaultWindowManager] }
      : null;
    if (!hasTint2AppCommand && requestedWindowManager !== "openbox") {
      appCommands.unshift({
        command: "bash",
        args: ["-lc", "tint2"],
        source: "tint2",
      });
    }

    const host = new HeadlessXSessionHost({
      xServerBackend: cleanString(input.xServerBackend) || "xvfb",
      displayNumber,
      width: toInteger(input.width, 1280),
      height: toInteger(input.height, 800),
      depth: toInteger(input.depth, 24),
      wsPort,
      authToken,
      frameRate: toInteger(input.frameRate, 30),
      tileSize: toInteger(input.tileSize, 64),
      enableDirtyTiles: Boolean(input.enableDirtyTiles),
      preferredEncoding: cleanString(input.preferredEncoding) || "jpeg",
      virtualWidth: toInteger(input.virtualWidth, 4096),
      virtualHeight: toInteger(input.virtualHeight, 4096),
      jpegQuality: typeof input.jpegQuality === "number" ? input.jpegQuality : 0.7,
      pngCompressionLevel: toInteger(input.pngCompressionLevel, 6),
      useBubblewrap: input.useBubblewrap !== false,
      sessionDirectory: cleanString(input.sessionDirectory) || undefined,
      workingDirectory: workingDirectory || undefined,
      writableMounts,
      windowManagerCommand,
      appCommands,
    });

    const session = {
      id: crypto.randomUUID(),
      host,
      createdAt: Date.now(),
      input: {
        threadId,
        command: cleanString(input.command),
        windowManagerCommand: requestedWindowManager,
        useBubblewrap: input.useBubblewrap !== false,
        xServerBackend: cleanString(input.xServerBackend) || "xvfb",
        workingDirectory,
      },
      authToken,
      wsPort,
      logs: [],
    };

    this.bindHostEvents(session);
    this.sessions.set(session.id, session);
    if (threadId) {
      this.threadSessions.set(threadId, session.id);
    }

    try {
      await host.start();
    } catch (error) {
      this.sessions.delete(session.id);
      if (threadId) {
        this.threadSessions.delete(threadId);
      }
      throw error;
    }

    return this.serializeSession(session, hostHeader);
  }

  async stopSession(id) {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error("Session not found");
    }

    this.sessions.delete(id);
    if (session.input.threadId) {
      this.threadSessions.delete(session.input.threadId);
    }
    await session.host.stop();
    return { ok: true };
  }

  async updateSessionFrameRate(id, frameRate) {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error("Session not found");
    }

    session.host.setFrameRate(frameRate);
    return session;
  }

  async captureSessionScreenshot(id) {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error("Session not found");
    }

    return session.host.captureScreenshot();
  }

  async captureThreadScreenshot(threadId) {
    const session = this.getSessionRecordByThreadId(threadId);
    if (!session) {
      throw new Error("Session not found");
    }

    return session.host.captureScreenshot();
  }

  async injectSessionEvents(id, events, options = {}) {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error("Session not found");
    }

    await session.host.injectEvents(events, options);
    return session;
  }

  async injectThreadEvents(threadId, events, options = {}) {
    const session = this.getSessionRecordByThreadId(threadId);
    if (!session) {
      throw new Error("Session not found");
    }

    await session.host.injectEvents(events, options);
    return session;
  }

  async stopAll() {
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    this.threadSessions.clear();
    await Promise.allSettled(sessions.map((session) => session.host.stop()));
  }

  bindHostEvents(session) {
    const eventNames = [
      "starting",
      "started",
      "client-connected",
      "client-authenticated",
      "client-disconnected",
      "frame-sent",
      "stopping",
      "stopped",
      "error",
    ];

    for (const name of eventNames) {
      session.host.on(name, (payload) => {
        const entry = {
          at: Date.now(),
          event: name,
          payload: payload && payload.message ? payload.message : payload || null,
        };
        session.logs.push(entry);
        if (session.logs.length > MAX_LOG_ENTRIES) {
          session.logs.splice(0, session.logs.length - MAX_LOG_ENTRIES);
        }
        this.emit("session-event", { sessionId: session.id, ...entry });
      });
    }
  }

  serializeSession(session, hostHeader) {
    return {
      id: session.id,
      createdAt: session.createdAt,
      command: session.input.command,
      threadId: session.input.threadId || null,
      windowManagerCommand: session.input.windowManagerCommand,
      useBubblewrap: session.input.useBubblewrap,
      xServerBackend: session.input.xServerBackend,
      workingDirectory: session.input.workingDirectory || null,
      frameRate: session.host.options.frameRate,
      authToken: session.authToken,
      wsUrl: makeWsUrl(hostHeader, session.wsPort),
      state: session.host.getState(),
      logs: session.logs.slice(-50),
    };
  }
}

module.exports = {
  XSessionManager,
};
