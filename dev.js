const path = require("path");
const { spawn } = require("child_process");

const ROOT_DIR = __dirname;
const BIN_DIR = path.join(ROOT_DIR, "node_modules", ".bin");
const VITE_BIN = path.join(BIN_DIR, process.platform === "win32" ? "vite.cmd" : "vite");

const children = [];

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

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start("backend", process.execPath, ["--watch", "server.js"], { PORT: "3211" });
start("vite", VITE_BIN, ["--host", "127.0.0.1", "--port", "3210"]);
