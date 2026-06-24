const path = require("path");
const { spawn } = require("child_process");

const ROOT_DIR = __dirname;
const BIN_DIR = path.join(ROOT_DIR, "node_modules", ".bin");
const VITE_BIN = path.join(BIN_DIR, process.platform === "win32" ? "vite.cmd" : "vite");
const FRONTEND_HOST = process.env.FRONTEND_HOST || "127.0.0.1";

const children = [];

function parsePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function start(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: ROOT_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  child.on("exit", (code, signal) => {
    if (signal || code === 0) {
      return;
    }

    console.error(`${name} exited with code ${code}`);
    shutdown(code);
  });

  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGINT");
    }
  }

  process.exit(code);
}

function main() {
  const backendPort = parsePort(process.env.BACKEND_PORT, 3221);
  const frontendPort = parsePort(process.env.FRONTEND_PORT, 3220);
  const appEnv = {
    BACKEND_PORT: String(backendPort),
    FRONTEND_HOST,
    FRONTEND_PORT: String(frontendPort),
  };

  start("backend", process.execPath, ["new-app/server.js"], { PORT: String(backendPort), ...appEnv });
  start("vite", VITE_BIN, ["--host", FRONTEND_HOST, "--port", String(frontendPort)], appEnv);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

main();
