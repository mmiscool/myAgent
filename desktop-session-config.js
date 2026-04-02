const os = require("os");
const path = require("path");

const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function pickSandboxMode(value, fallback = "workspace-write") {
  return SANDBOX_MODES.includes(value) ? value : fallback;
}

function resolveRuntimeDirectory(env = process.env, getuid = process.getuid) {
  const explicit = cleanString(env?.XDG_RUNTIME_DIR);
  if (explicit) {
    return explicit;
  }

  if (typeof getuid === "function") {
    const uid = Number(getuid());
    if (Number.isInteger(uid) && uid >= 0) {
      return `/run/user/${uid}`;
    }
  }

  return "";
}

function dedupeWritableMounts(mounts = []) {
  const seen = new Set();
  const unique = [];

  for (const mount of mounts) {
    const hostPath = cleanString(mount?.hostPath);
    const guestPath = cleanString(mount?.guestPath) || hostPath;
    if (!hostPath || !guestPath) {
      continue;
    }

    const key = `${hostPath}=>${guestPath}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push({ hostPath, guestPath });
  }

  return unique;
}

function buildDesktopSessionConfig(project, options = {}, context = {}) {
  const cwd = path.resolve(cleanString(project?.cwd) || cleanString(context.cwd) || process.cwd());
  const sandboxMode = pickSandboxMode(options.sandboxMode || project?.sandboxMode, project?.sandboxMode || "workspace-write");
  const homeDirectory = path.resolve(cleanString(context.homeDirectory) || os.homedir() || process.env.HOME || cwd);
  const runtimeDirectory = cleanString(context.runtimeDirectory) || resolveRuntimeDirectory(context.env, context.getuid);
  const useBubblewrap = typeof options.useBubblewrap === "boolean"
    ? options.useBubblewrap
    : sandboxMode !== "danger-full-access";
  const writableMounts = useBubblewrap
    ? dedupeWritableMounts([
      { hostPath: homeDirectory, guestPath: homeDirectory },
      { hostPath: cwd, guestPath: cwd },
      ...(Array.isArray(options.writableMounts) ? options.writableMounts : []),
    ])
    : [];

  return {
    threadId: cleanString(options.threadId),
    command: cleanString(options.command) || "xterm",
    windowManagerCommand: cleanString(options.windowManagerCommand) || "openbox",
    xServerBackend: cleanString(options.xServerBackend) || "xvfb",
    useBubblewrap,
    workingDirectory: cwd,
    guestHomePath: homeDirectory,
    guestRuntimePath: runtimeDirectory || undefined,
    writableMounts,
  };
}

module.exports = {
  buildDesktopSessionConfig,
  dedupeWritableMounts,
  resolveRuntimeDirectory,
};
