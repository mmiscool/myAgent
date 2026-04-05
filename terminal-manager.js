const crypto = require("crypto");
const path = require("path");
const { EventEmitter } = require("events");
const { spawn } = require("child_process");

const ROOT_DIR = __dirname;
const DEFAULT_SHELL_PROGRAM = process.env.SHELL || "bash";
const DEFAULT_SHELL_ARGS = ["-li"];
const MAX_BUFFER_CHARS = 250000;
const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 32;
const MIN_COLUMNS = 40;
const MAX_COLUMNS = 240;
const MIN_ROWS = 12;
const MAX_ROWS = 80;

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function bufferText(existing, chunk) {
  const next = `${existing || ""}${chunk || ""}`;
  if (next.length <= MAX_BUFFER_CHARS) {
    return next;
  }

  return next.slice(next.length - MAX_BUFFER_CHARS);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeDimension(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return clamp(Math.round(number), min, max);
}

function resolveScriptExecutable() {
  const candidates = [process.env.SCRIPT_BIN, "/usr/bin/script", "/bin/script"].filter(Boolean);
  return candidates[0];
}

class TerminalManager extends EventEmitter {
  constructor() {
    super();
    this.sessionsByProjectId = new Map();
  }

  getProjectSession(projectId) {
    return this.sessionsByProjectId.get(cleanString(projectId)) || null;
  }

  async ensureProjectSession(project, options = {}) {
    const projectId = cleanString(project?.id);
    if (!projectId) {
      throw new Error("project id is required");
    }

    const existing = this.getProjectSession(projectId);
    if (existing && existing.state === "running" && existing.process && existing.process.exitCode == null) {
      return this.serializeSession(existing);
    }

    if (existing) {
      await this.closeProjectSession(projectId).catch(() => {});
    }

    return this.createProjectSession(project, options);
  }

  async createProjectSession(project, options = {}) {
    const projectId = cleanString(project?.id);
    if (!projectId) {
      throw new Error("project id is required");
    }

    const scriptExecutable = resolveScriptExecutable();
    if (!scriptExecutable) {
      throw new Error("The 'script' executable is required to start terminal sessions.");
    }

    const columns = normalizeDimension(options.columns, DEFAULT_COLUMNS, MIN_COLUMNS, MAX_COLUMNS);
    const rows = normalizeDimension(options.rows, DEFAULT_ROWS, MIN_ROWS, MAX_ROWS);
    const term = cleanString(options.term) || "xterm-256color";
    const cwd = cleanString(project?.cwd) || ROOT_DIR;
    const shellProgram = cleanString(options.shellProgram) || DEFAULT_SHELL_PROGRAM;
    const shellArgs = Array.isArray(options.shellArgs) && options.shellArgs.length
      ? options.shellArgs.map((entry) => String(entry))
      : DEFAULT_SHELL_ARGS;

    const shellCommand = [
      "export TERM=" + quoteShell(term),
      "export COLORTERM='truecolor'",
      "export COLUMNS=" + quoteShell(String(columns)),
      "export LINES=" + quoteShell(String(rows)),
      "stty cols \"$COLUMNS\" rows \"$LINES\" 2>/dev/null || true",
      `exec ${quoteShell(shellProgram)} ${shellArgs.map((entry) => quoteShell(entry)).join(" ")}`,
    ].join("; ");

    const child = spawn(scriptExecutable, [
      "-qf",
      "/dev/null",
      "-c",
      shellCommand,
    ], {
      cwd,
      env: {
        ...process.env,
        TERM: term,
        COLORTERM: "truecolor",
        COLUMNS: String(columns),
        LINES: String(rows),
      },
      stdio: "pipe",
    });

    const session = {
      id: crypto.randomUUID(),
      projectId,
      projectName: cleanString(project?.name) || cwd,
      workingDirectory: cwd,
      locationLabel: "host",
      createdAt: Date.now(),
      state: "running",
      buffer: "",
      process: child,
      columns,
      rows,
    };

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      session.buffer = bufferText(session.buffer, text);
      this.emit("output", {
        projectId,
        sessionId: session.id,
        data: text,
      });
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      session.buffer = bufferText(session.buffer, text);
      this.emit("output", {
        projectId,
        sessionId: session.id,
        data: text,
      });
    });
    child.once("error", (error) => {
      session.state = "error";
      session.error = error.message;
      this.emit("error", {
        projectId,
        sessionId: session.id,
        error: error.message,
      });
    });
    child.once("exit", (code, signal) => {
      session.state = "stopped";
      session.exitCode = Number.isInteger(code) ? code : null;
      session.signal = signal || null;
      this.emit("exit", {
        projectId,
        sessionId: session.id,
        exitCode: session.exitCode,
        signal: session.signal,
      });
    });

    this.sessionsByProjectId.set(projectId, session);
    return this.serializeSession(session);
  }

  writeProjectInput(projectId, text) {
    const session = this.getProjectSession(projectId);
    if (!session || session.state !== "running" || !session.process?.stdin?.writable) {
      throw new Error("Terminal session is not running");
    }

    session.process.stdin.write(String(text || ""));
    return this.serializeSession(session);
  }

  resizeProjectSession(projectId, dimensions = {}) {
    const session = this.getProjectSession(projectId);
    if (!session) {
      throw new Error("Terminal session not found");
    }

    session.columns = normalizeDimension(dimensions.columns, session.columns || DEFAULT_COLUMNS, MIN_COLUMNS, MAX_COLUMNS);
    session.rows = normalizeDimension(dimensions.rows, session.rows || DEFAULT_ROWS, MIN_ROWS, MAX_ROWS);
    return this.serializeSession(session);
  }

  sendProjectControl(projectId, action) {
    const normalized = cleanString(action);
    if (!normalized) {
      throw new Error("action is required");
    }

    if (normalized === "interrupt") {
      return this.writeProjectInput(projectId, "\u0003");
    }

    if (normalized === "eof") {
      return this.writeProjectInput(projectId, "\u0004");
    }

    throw new Error(`Unsupported terminal action: ${normalized}`);
  }

  async closeProjectSession(projectId) {
    const session = this.getProjectSession(projectId);
    if (!session) {
      return { ok: true };
    }

    this.sessionsByProjectId.delete(cleanString(projectId));
    session.state = "stopped";

    if (session.process?.stdin?.writable) {
      session.process.stdin.end();
    }

    if (session.process && session.process.exitCode == null && session.process.signalCode == null) {
      session.process.kill("SIGHUP");
    }

    return { ok: true };
  }

  async stopAll() {
    await Promise.allSettled(Array.from(this.sessionsByProjectId.keys()).map((projectId) => this.closeProjectSession(projectId)));
  }

  serializeSession(session) {
    return {
      id: session.id,
      projectId: session.projectId,
      projectName: session.projectName,
      workingDirectory: session.workingDirectory,
      locationLabel: session.locationLabel,
      createdAt: session.createdAt,
      state: session.state,
      buffer: session.buffer,
      columns: session.columns,
      rows: session.rows,
      exitCode: session.exitCode ?? null,
      signal: session.signal ?? null,
      error: session.error || null,
    };
  }
}

module.exports = {
  TerminalManager,
};
