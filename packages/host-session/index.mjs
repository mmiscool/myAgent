import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFramePacket, frameFlags } from "../protocol/index.mjs";
import { createDebugLogger } from "../protocol/debug.mjs";
import { X11Adapter } from "../x11-adapter/index.mjs";
import { detectDirtyTiles, coalesceDirtyRects } from "../frame-diff/index.mjs";
import { encodeFrame, encodePngFrame, encodeRawRect } from "../encoder/index.mjs";
import { WebSocketHost } from "../ws-host/index.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnChild(command, args, options = {}) {
  return spawn(command, args, {
    stdio: "pipe",
    ...options,
  });
}

function collectChildOutput(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `exit ${code}`));
    });
  });
}

function waitForExit(child, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let exited = false;
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      exited = true;
      clearTimeout(timer);
      resolve(exited);
    });
  });
}

async function killChild(child) {
  if (!child || child.killed) {
    return;
  }

  child.kill("SIGTERM");
  const exited = await waitForExit(child);
  if (!exited && child.exitCode == null && child.signalCode == null) {
    child.kill("SIGKILL");
    await waitForExit(child, 1000);
  }
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fsp.chmod(dirPath, 0o700).catch(() => {});
}

async function removeDir(dirPath) {
  if (!dirPath) {
    return;
  }
  await fsp.rm(dirPath, { recursive: true, force: true }).catch(() => {});
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function pathExists(targetPath) {
  return fsp.access(targetPath).then(() => true).catch(() => false);
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function commandToShellSource(command) {
  const source = cleanString(command?.source);
  if (source) {
    return source;
  }

  const commandName = cleanString(command?.command);
  if (!commandName) {
    return "";
  }

  const args = Array.isArray(command?.args)
    ? command.args.map((value) => quoteShell(String(value)))
    : [];
  return [quoteShell(commandName), ...args].join(" ");
}

function normalizeWindowId(value) {
  const normalized = cleanString(value).toLowerCase();
  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("0x")) {
    return normalized;
  }

  return `0x${normalized}`;
}

function parseWmctrlWindowList(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(\S+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
      if (!match) {
        return null;
      }

      const [, id, desktop, pid, x, y, width, height, wmClass, host, title] = match;
      const [instanceName, className] = wmClass.includes(".")
        ? wmClass.split(".", 2)
        : [wmClass, wmClass];

      return {
        id: normalizeWindowId(id),
        desktop: Number.parseInt(desktop, 10),
        pid: Number.parseInt(pid, 10) >= 0 ? Number.parseInt(pid, 10) : null,
        x: Number.parseInt(x, 10),
        y: Number.parseInt(y, 10),
        width: Number.parseInt(width, 10),
        height: Number.parseInt(height, 10),
        wmClass,
        instanceName,
        className,
        host: cleanString(host),
        title,
      };
    })
    .filter(Boolean);
}

function parseActiveWindowId(stdout) {
  const match = String(stdout || "").match(/window id # (0x[0-9a-fA-F]+)/);
  return match ? normalizeWindowId(match[1]) : "";
}

function parseStateAtoms(stdout) {
  const match = String(stdout || "").match(/_NET_WM_STATE\(ATOM\)\s*=\s*(.*)/);
  if (!match) {
    return [];
  }

  return match[1]
    .split(/\s*,\s*/)
    .map((value) => cleanString(value))
    .filter(Boolean);
}

function buildMissingWindowManagementDependencyMessage(executable) {
  const command = cleanString(executable) || "command";
  if (command === "wmctrl") {
    return `${command} is required for virtual desktop window management. Run "pnpm setupVirtualDesktops" to install the missing desktop dependencies.`;
  }
  return `${command} is required for virtual desktop window management.`;
}

function wrapCommandForMaximize(command, wmctrlExecutable = "wmctrl") {
  const shellSource = commandToShellSource(command);
  if (!shellSource) {
    return command;
  }

  const wmctrlCommand = cleanString(wmctrlExecutable) || "wmctrl";

  return {
    command: "bash",
    args: [
      "-lc",
      [
        `wmctrl_bin=${quoteShell(wmctrlCommand)}`,
        `(${shellSource}) &`,
        "app_pid=$!",
        "if command -v \"$wmctrl_bin\" >/dev/null 2>&1; then",
        "  for _ in $(seq 1 100); do",
        "    window_id=$(\"$wmctrl_bin\" -lp 2>/dev/null | awk -v pid=\"$app_pid\" '$3 == pid { print $1; exit }')",
        "    if [ -n \"$window_id\" ]; then",
        "      \"$wmctrl_bin\" -i -r \"$window_id\" -b add,maximized_vert,maximized_horz >/dev/null 2>&1 || true",
        "      \"$wmctrl_bin\" -i -a \"$window_id\" >/dev/null 2>&1 || true",
        "      break",
        "    fi",
        "    sleep 0.1",
        "  done",
        "fi",
        "wait \"$app_pid\"",
      ].join("\n"),
    ],
    source: shellSource,
  };
}

function pushBind(args, seen, hostPath, guestPath) {
  const source = cleanString(hostPath);
  const target = cleanString(guestPath);
  if (!source || !target) {
    return;
  }

  const key = `${source}=>${target}`;
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  args.push("--bind", source, target);
}

async function buildBubblewrapArgs(sessionDirs, envOverrides = {}, options = {}) {
  const guestHomePath = cleanString(options.guestHomePath) || sessionDirs.home;
  const guestRuntimePath = cleanString(options.guestRuntimePath) || sessionDirs.runtime;
  const bindPairs = new Set();
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--share-net",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--setenv",
    "HOME",
    guestHomePath,
    "--setenv",
    "XDG_RUNTIME_DIR",
    guestRuntimePath,
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "DISPLAY",
    envOverrides.DISPLAY,
    "--setenv",
    "PATH",
    envOverrides.PATH || process.env.PATH || "/usr/bin:/bin",
  ];

  pushBind(args, bindPairs, sessionDirs.home, sessionDirs.home);
  pushBind(args, bindPairs, sessionDirs.runtime, sessionDirs.runtime);
  pushBind(args, bindPairs, sessionDirs.tmp, "/tmp");
  pushBind(args, bindPairs, "/tmp/.X11-unix", "/tmp/.X11-unix");
  pushBind(args, bindPairs, sessionDirs.runtime, guestRuntimePath);

  if (envOverrides.XAUTHORITY) {
    args.push("--setenv", "XAUTHORITY", envOverrides.XAUTHORITY);
  }

  args.push("--unsetenv", "DBUS_SESSION_BUS_ADDRESS");

  const optionalPaths = [
    "/opt",
    "/snap",
    "/var/lib/snapd",
  ];

  for (const optionalPath of optionalPaths) {
    if (await pathExists(optionalPath)) {
      args.push("--ro-bind", optionalPath, optionalPath);
    }
  }

  for (const mount of options.writableMounts || []) {
    if (!mount?.hostPath || !mount?.guestPath) {
      continue;
    }
    pushBind(args, bindPairs, mount.hostPath, mount.guestPath);
  }

  return args;
}

export class HeadlessXSessionHost {
  constructor(options = {}) {
    this.options = {
      displayNumber: 99,
      width: 1280,
      height: 800,
      depth: 24,
      wsPort: 8080,
      authToken: "dev-token",
      xAuthorityPath: null,
      xServerHost: "127.0.0.1",
      xServerBackend: "xvfb",
      xvfbExecutable: "Xvfb",
      xorgExecutable: "Xorg",
      xrandrExecutable: "xrandr",
      cvtExecutable: "cvt",
      xpropExecutable: "xprop",
      wmctrlExecutable: "wmctrl",
      windowManagerCommand: null,
      appCommands: [],
      virtualWidth: 4096,
      virtualHeight: 4096,
      frameRate: 30,
      tileSize: 64,
      enableDirtyTiles: false,
      preferredEncoding: "jpeg",
      jpegQuality: 0.7,
      pngCompressionLevel: 6,
      useBubblewrap: false,
      bubblewrapExecutable: "bwrap",
      dbusRunSessionExecutable: "dbus-run-session",
      sessionDirectory: null,
      workingDirectory: null,
      guestHomePath: null,
      guestRuntimePath: null,
      writableMounts: [],
      x11Adapter: null,
      debug: false,
      ...options,
    };
    this.events = new EventEmitter();
    this.log = createDebugLogger("session", this.options.debug);
    this.adapter = this.options.x11Adapter || new X11Adapter({ debug: this.options.debug });
    this.wsHost = new WebSocketHost({
      port: this.options.wsPort,
      authToken: this.options.authToken,
      debug: this.options.debug,
    });
    this.displayName = `:${this.options.displayNumber}`;
    this.connectionDisplayName = `${this.options.xServerHost}:${this.options.displayNumber}`;
    this.state = {
      running: false,
      authenticatedClient: false,
      displayName: this.displayName,
      width: this.options.width,
      height: this.options.height,
      depth: this.options.depth,
      wsPort: this.options.wsPort,
      encoding: this.options.preferredEncoding,
      dirtyTilesEnabled: this.options.enableDirtyTiles,
      backend: this.options.xServerBackend,
      liveResizeSupported: this.options.xServerBackend === "xorg-dummy" || this.options.xServerBackend === "xvfb",
    };
    this.xServerProcess = null;
    this.childApps = [];
    this.sequence = 0;
    this.frameTimer = null;
    this.captureInFlight = false;
    this.frameRequested = false;
    this.lastHashes = null;
    this.hasKeyframe = false;
    this.pendingLatestFrame = false;
    this.sessionDirs = null;
    this.resizeInFlight = null;
    this.xrandrOutputName = null;
    this.createdModeNames = new Map();
  }

  on(eventName, handler) {
    this.events.on(eventName, handler);
  }

  off(eventName, handler) {
    this.events.off(eventName, handler);
  }

  emit(eventName, payload) {
    if (eventName === "error" && this.events.listenerCount("error") === 0) {
      this.log("error", payload?.message || payload);
      return;
    }
    this.events.emit(eventName, payload);
  }

  trackChildProcess(child, command) {
    const removeChild = () => {
      const index = this.childApps.indexOf(child);
      if (index !== -1) {
        this.childApps.splice(index, 1);
      }
    };

    child.once("error", (error) => {
      removeChild();
      this.emit("error", error);
    });
    child.once("exit", (code, signal) => {
      removeChild();
      this.log("child-exited", cleanString(command?.source) || command?.command, code, signal);
    });

    this.log("child-launched", cleanString(command?.source) || command?.command, command?.args || []);
    this.childApps.push(child);
  }

  getState() {
    return { ...this.state };
  }

  async captureScreenshot() {
    const frame = await this.adapter.captureFrame();
    const png = encodePngFrame(frame, this.options.pngCompressionLevel);

    return {
      width: frame.width,
      height: frame.height,
      png,
      dataUrl: `data:image/png;base64,${png.toString("base64")}`,
    };
  }

  async readClipboard() {
    return this.adapter.readClipboard();
  }

  assertSessionRunning() {
    if (!this.state.running) {
      throw new Error("Session is not running");
    }
  }

  async runWindowCommand(command, args, options = {}) {
    try {
      return await this.runDisplayCommand(command, args, options);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(buildMissingWindowManagementDependencyMessage(command));
      }
      throw error;
    }
  }

  async getActiveWindowId() {
    const { stdout } = await this.runWindowCommand(this.options.xpropExecutable, ["-root", "_NET_ACTIVE_WINDOW"]);
    return parseActiveWindowId(stdout);
  }

  async getWindowStateAtoms(windowId) {
    const normalizedWindowId = normalizeWindowId(windowId);
    if (!normalizedWindowId) {
      return [];
    }

    const { stdout } = await this.runWindowCommand(this.options.xpropExecutable, [
      "-id",
      normalizedWindowId,
      "_NET_WM_STATE",
    ]);
    return parseStateAtoms(stdout);
  }

  async listWindows() {
    this.assertSessionRunning();

    let stdout = "";
    let activeWindowId = "";

    try {
      [{ stdout }, activeWindowId] = await Promise.all([
        this.runWindowCommand(this.options.wmctrlExecutable, ["-l", "-p", "-x", "-G"]),
        this.getActiveWindowId().catch(() => ""),
      ]);
    } catch (error) {
      if (error?.message === buildMissingWindowManagementDependencyMessage(this.options.wmctrlExecutable)) {
        return this.adapter.listWindows();
      }
      throw error;
    }

    const windows = parseWmctrlWindowList(stdout);
    const stateEntries = await Promise.all(windows.map(async (window) => {
      try {
        return [window.id, await this.getWindowStateAtoms(window.id)];
      } catch {
        return [window.id, []];
      }
    }));
    const statesByWindowId = new Map(stateEntries);

    return windows.map((window) => {
      const stateAtoms = statesByWindowId.get(window.id) || [];
      return {
        ...window,
        active: window.id === activeWindowId,
        stateAtoms,
        maximized: stateAtoms.includes("_NET_WM_STATE_MAXIMIZED_VERT")
          && stateAtoms.includes("_NET_WM_STATE_MAXIMIZED_HORZ"),
      };
    });
  }

  async focusWindow(windowId, options = {}) {
    this.assertSessionRunning();

    const normalizedWindowId = normalizeWindowId(windowId);
    if (!normalizedWindowId) {
      throw new Error("windowId is required");
    }

    const windows = await this.listWindows();
    const existingWindow = windows.find((window) => window.id === normalizedWindowId);
    if (!existingWindow) {
      throw new Error(`Window not found: ${normalizedWindowId}`);
    }

    try {
      if (options.maximize) {
        await this.runWindowCommand(this.options.wmctrlExecutable, [
          "-i",
          "-r",
          normalizedWindowId,
          "-b",
          "add,maximized_vert,maximized_horz",
        ]);
      }

      await this.runWindowCommand(this.options.wmctrlExecutable, [
        "-i",
        "-a",
        normalizedWindowId,
      ]);
    } catch (error) {
      if (error?.message === buildMissingWindowManagementDependencyMessage(this.options.wmctrlExecutable)) {
        await this.adapter.focusWindow(normalizedWindowId, options);
        await sleep(150);
      } else {
        throw error;
      }
    }

    const updatedWindows = await this.listWindows();
    return updatedWindows.find((window) => window.id === normalizedWindowId)
      || {
        ...existingWindow,
        active: true,
        maximized: Boolean(options.maximize) || existingWindow.maximized,
      };
  }

  async injectEvents(events = [], options = {}) {
    if (!Array.isArray(events) || events.length === 0) {
      return;
    }

    await this.handleInput(events);

    const delayMs = Math.max(0, Math.round(Number(options.delayMs) || 0));
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    this.requestFrame();
  }

  setFrameRate(frameRate) {
    const nextFrameRate = Math.max(1, Math.min(60, Math.round(Number(frameRate) || this.options.frameRate)));
    this.options.frameRate = nextFrameRate;

    const client = this.wsHost.getAuthenticatedClient();
    if (client) {
      this.wsHost.sendControl(client, {
        type: "stream-config",
        encoding: this.options.preferredEncoding,
        tileSize: this.options.tileSize,
        dirtyTiles: this.options.enableDirtyTiles,
        frameRate: this.options.frameRate,
      });
    }

    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
      if (this.state.authenticatedClient) {
        this.startFrameLoop();
      }
    }

    return this.options.frameRate;
  }

  async start() {
    if (this.state.running) {
      return;
    }

    this.emit("starting");
    this.log("starting", this.displayName);

    await this.prepareSessionDirs();
    await this.startDisplayServer();
    await this.adapter.connect(this.connectionDisplayName);
    if (this.state.liveResizeSupported) {
      await this.configureDisplaySize(this.options.width, this.options.height).catch((error) => {
        this.emit("error", error);
      });
    }
    const screenInfo = await this.adapter.getScreenInfo();

    this.state.running = true;
    this.state.width = screenInfo.width;
    this.state.height = screenInfo.height;
    this.state.depth = screenInfo.depth;

    await this.wsHost.start();
    this.bindTransport(screenInfo);
    await this.launchChildren();

    this.emit("started", this.getState());
    this.log("started", this.getState());
  }

  async stop() {
    this.emit("stopping");
    this.log("stopping");
    clearInterval(this.frameTimer);
    this.frameTimer = null;
    this.state.running = false;
    this.state.authenticatedClient = false;

    await this.wsHost.stop().catch((error) => this.emit("error", error));
    await this.adapter.disconnect().catch((error) => this.emit("error", error));

    for (const child of [...this.childApps].reverse()) {
      await killChild(child);
    }
    this.childApps = [];

    await killChild(this.xServerProcess);
    this.xServerProcess = null;
    await removeDir(this.sessionDirs?.root);
    this.sessionDirs = null;

    this.emit("stopped");
    this.log("stopped");
  }

  async prepareSessionDirs() {
    const root = this.options.sessionDirectory
      ? path.resolve(this.options.sessionDirectory)
      : path.join(os.tmpdir(), "remote-x-sessions", `display-${this.options.displayNumber}-${Date.now()}`);
    const home = path.join(root, "home");
    const runtime = path.join(root, "runtime");
    const tmp = path.join(root, "tmp");

    await ensureDir(root);
    await ensureDir(home);
    await ensureDir(runtime);
    await ensureDir(tmp);

    this.sessionDirs = { root, home, runtime, tmp };
    this.log("session-dirs", this.sessionDirs);
  }

  async startDisplayServer() {
    if (this.options.xServerBackend === "xorg-dummy") {
      await this.startXorgDummy();
      return;
    }
    await this.startXvfb();
  }

  async startXvfb() {
    this.xServerProcess = spawnChild(
      this.options.xvfbExecutable,
      [
        this.displayName,
        "-screen",
        "0",
        `${this.options.virtualWidth}x${this.options.virtualHeight}x${this.options.depth}`,
        "-extension",
        "GLX",
        "-listen",
        "tcp",
        "-nolisten",
        "unix",
        "-ac",
      ],
      {
        env: {
          ...process.env,
          ...(this.options.xAuthorityPath ? { XAUTHORITY: this.options.xAuthorityPath } : {}),
        },
      },
    );

    this.xServerProcess.once("error", (error) => {
      this.emit("error", new Error(`Xvfb spawn failure: ${error.message}`));
    });
    this.log("xvfb-spawned", this.displayName);

    await this.waitForDisplayReady();
  }

  async startXorgDummy() {
    const configPath = path.join(this.sessionDirs.root, "xorg-dummy.conf");
    const logPath = path.join(this.sessionDirs.root, `Xorg.${this.options.displayNumber}.log`);
    await fsp.writeFile(configPath, this.buildXorgDummyConfig(), "utf8");

    this.xServerProcess = spawnChild(
      this.options.xorgExecutable,
      [
        this.displayName,
        "-noreset",
        "-config",
        configPath,
        "-logfile",
        logPath,
        "+extension",
        "RANDR",
        "-extension",
        "GLX",
        "-listen",
        "tcp",
        "-nolisten",
        "unix",
        "-ac",
      ],
      {
        env: {
          ...process.env,
          XDG_RUNTIME_DIR: this.sessionDirs.runtime,
          HOME: this.sessionDirs.home,
          ...(this.options.xAuthorityPath ? { XAUTHORITY: this.options.xAuthorityPath } : {}),
        },
      },
    );

    this.xServerProcess.once("error", (error) => {
      this.emit("error", new Error(`Xorg spawn failure: ${error.message}`));
    });
    this.log("xorg-dummy-spawned", this.displayName, configPath);

    await this.waitForDisplayReady();
    this.xrandrOutputName = await this.detectXrandrOutputName();
  }

  buildXorgDummyConfig() {
    return `
Section "Monitor"
    Identifier "Monitor0"
    HorizSync 28.0-80.0
    VertRefresh 48.0-75.0
EndSection

Section "Device"
    Identifier "Card0"
    Driver "dummy"
    VideoRam 256000
EndSection

Section "Screen"
    Identifier "Screen0"
    Device "Card0"
    Monitor "Monitor0"
    DefaultDepth 24
    SubSection "Display"
        Depth 24
        Virtual ${this.options.virtualWidth} ${this.options.virtualHeight}
    EndSubSection
EndSection
`.trimStart();
  }

  async waitForDisplayReady() {
    const maxAttempts = 50;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await new Promise((resolve, reject) => {
          const child = spawnChild("xdpyinfo", ["-display", this.connectionDisplayName], {
            env: {
              ...process.env,
              DISPLAY: this.connectionDisplayName,
              ...(this.options.xAuthorityPath ? { XAUTHORITY: this.options.xAuthorityPath } : {}),
            },
          });
          child.once("exit", (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error("display-not-ready"));
            }
          });
          child.once("error", reject);
        });
        return;
      } catch {
        await sleep(100);
      }
    }

    throw new Error("X display connection failure");
  }

  async runDisplayCommand(command, args, options = {}) {
    const child = spawnChild(command, args, {
      env: {
        ...process.env,
        DISPLAY: this.connectionDisplayName,
        XDG_RUNTIME_DIR: this.sessionDirs?.runtime || process.env.XDG_RUNTIME_DIR,
        HOME: this.sessionDirs?.home || process.env.HOME,
        ...(this.options.xAuthorityPath ? { XAUTHORITY: this.options.xAuthorityPath } : {}),
      },
    });

    try {
      return await collectChildOutput(child);
    } catch (error) {
      if (options.allowFailure) {
        return { stdout: "", stderr: error.message };
      }
      throw error;
    }
  }

  async detectXrandrOutputName() {
    const { stdout } = await this.runDisplayCommand(this.options.xrandrExecutable, ["--query"]);
    const match = stdout.match(/^(\S+)\s+connected/m);
    return match?.[1] || "DUMMY0";
  }

  bindTransport(screenInfo) {
    this.wsHost.on("client-connected", (client) => {
      this.emit("client-connected");
      this.log("client-connected");
      this.wsHost.sendControl(client, {
        type: "hello",
        serverType: "headless-x11-host",
        sessionWidth: screenInfo.width,
        sessionHeight: screenInfo.height,
        supportedEncodings: ["jpeg", "png", "raw"],
        requiresAuth: true,
        dirtyTilesSupported: true,
      });
    });

    this.wsHost.on("client-authenticated", (client) => {
      this.state.authenticatedClient = true;
      this.emit("client-authenticated");
      this.log("client-authenticated");
      this.wsHost.sendControl(client, {
        type: "screen-info",
        width: screenInfo.width,
        height: screenInfo.height,
        depth: screenInfo.depth,
        pixelFormat: "bgra8888",
      });
      this.wsHost.sendControl(client, {
        type: "stream-config",
        encoding: this.options.preferredEncoding,
        tileSize: this.options.tileSize,
        dirtyTiles: this.options.enableDirtyTiles,
        frameRate: this.options.frameRate,
      });
      this.startFrameLoop();
    });

    this.wsHost.on("client-disconnected", (client) => {
      if (client.authenticated) {
        this.state.authenticatedClient = false;
      }
      this.emit("client-disconnected");
      this.log("client-disconnected");
    });

    this.wsHost.on("input", async (client, message) => {
      if (!client.authenticated) {
        return;
      }

      try {
        await this.handleInput(message.events);
      } catch (error) {
        this.emit("error", error);
      }
    });

    this.wsHost.on("resize", async (client, message) => {
      if (!client.authenticated) {
        return;
      }

      try {
        await this.configureDisplaySize(message.width, message.height, client);
      } catch (error) {
        this.emit("error", error);
      }
    });

    this.wsHost.on("error", (error) => this.emit("error", error));
  }

  startFrameLoop() {
    if (this.frameTimer) {
      return;
    }

    const interval = Math.max(1, Math.floor(1000 / Math.max(1, this.options.frameRate)));
    this.frameTimer = setInterval(() => this.requestFrame(), interval);
    this.requestFrame();
  }

  requestFrame() {
    if (!this.state.authenticatedClient) {
      return;
    }

    if (this.captureInFlight) {
      this.pendingLatestFrame = true;
      return;
    }

    void this.captureAndSendLatestFrame();
  }

  async captureAndSendLatestFrame() {
    const client = this.wsHost.getAuthenticatedClient();
    if (!client) {
      return;
    }

    this.captureInFlight = true;

    try {
      const frame = await this.adapter.captureFrame();
      const packet = await this.buildPacket(frame);
      if (packet) {
        this.wsHost.sendBinary(client, packet);
        this.log("frame-sent", this.sequence);
        this.emit("frame-sent", { sequence: this.sequence });
      }
    } catch (error) {
      this.emit("error", new Error(`framebuffer capture failure: ${error.message}`));
    } finally {
      this.captureInFlight = false;
      if (this.pendingLatestFrame) {
        this.pendingLatestFrame = false;
        void this.captureAndSendLatestFrame();
      }
    }
  }

  async buildPacket(frame) {
    let rects;
    let flags = frameFlags.END_OF_FRAME;

    if (this.options.enableDirtyTiles && this.hasKeyframe) {
      const diff = detectDirtyTiles(this.lastHashes, frame, this.options.tileSize);
      this.lastHashes = diff.hashes;
      const dirtyRects = coalesceDirtyRects(diff.dirtyTiles);

      if (!dirtyRects.length) {
        return null;
      }

      rects = await Promise.all(dirtyRects.map(async (rect) => ({
        ...rect,
        payload: this.options.preferredEncoding === "raw"
          ? encodeRawRect(await this.adapter.captureTile(rect.x, rect.y, rect.width, rect.height))
          : encodeFrame(await this.adapter.captureTile(rect.x, rect.y, rect.width, rect.height), this.options),
      })));
      flags |= frameFlags.DIRTY_TILES;
    } else {
      const dirty = detectDirtyTiles(this.lastHashes, frame, this.options.tileSize);
      this.lastHashes = dirty.hashes;
      rects = [{
        x: 0,
        y: 0,
        width: frame.width,
        height: frame.height,
        payload: encodeFrame(frame, {
          encoding: this.options.preferredEncoding,
          jpegQuality: this.options.jpegQuality,
          pngCompressionLevel: this.options.pngCompressionLevel,
        }),
      }];
      flags |= frameFlags.FULL_FRAME | frameFlags.KEYFRAME;
      this.hasKeyframe = true;
    }

    this.sequence += 1;

    return createFramePacket({
      sequence: this.sequence,
      sessionWidth: frame.width,
      sessionHeight: frame.height,
      encoding: this.options.preferredEncoding,
      rects,
      flags,
    });
  }

  async launchChildren() {
    const commands = [];
    if (this.options.windowManagerCommand) {
      commands.push(this.options.windowManagerCommand);
    }
    commands.push(...this.options.appCommands);
    await this.launchCommands(commands);
  }

  async launchCommands(commands = [], options = {}) {
    if (!this.state.running) {
      throw new Error("Session is not running");
    }

    const launched = [];
    const normalizedCommands = commands
      .map((item) => (typeof item === "string" ? { command: item, args: [] } : item))
      .filter((item) => cleanString(item?.command));

    for (const item of normalizedCommands) {
      const command = options.maximize ? wrapCommandForMaximize(item, this.options.wmctrlExecutable) : item;
      const child = await this.spawnSessionCommand(command);
      this.trackChildProcess(child, command);
      launched.push({
        pid: Number.isInteger(child.pid) ? child.pid : null,
        command: cleanString(item?.source) || cleanString(command?.source) || cleanString(item?.command),
        maximize: Boolean(options.maximize),
      });
    }

    return launched;
  }

  async spawnSessionCommand(command) {
    if (!this.options.useBubblewrap) {
      return spawnChild(command.command, command.args || [], {
        cwd: this.options.workingDirectory || this.options.guestHomePath || this.sessionDirs?.home || process.cwd(),
        env: {
          ...process.env,
          DISPLAY: this.connectionDisplayName,
          HOME: this.options.guestHomePath || process.env.HOME,
          XDG_RUNTIME_DIR: this.options.guestRuntimePath || process.env.XDG_RUNTIME_DIR,
          TMPDIR: this.sessionDirs?.tmp || process.env.TMPDIR,
          ...(this.options.xAuthorityPath ? { XAUTHORITY: this.options.xAuthorityPath } : {}),
        },
      });
    }

    const env = {
      DISPLAY: this.connectionDisplayName,
      HOME: this.options.guestHomePath || this.sessionDirs.home,
      XDG_RUNTIME_DIR: this.options.guestRuntimePath || this.sessionDirs.runtime,
      PATH: process.env.PATH || "/usr/bin:/bin",
      ...(this.options.xAuthorityPath ? { XAUTHORITY: this.options.xAuthorityPath } : {}),
    };
    const args = await buildBubblewrapArgs(this.sessionDirs, env, {
      guestHomePath: this.options.guestHomePath,
      guestRuntimePath: this.options.guestRuntimePath,
      writableMounts: this.options.writableMounts,
    });
    args.push(
      this.options.dbusRunSessionExecutable,
      "--",
      command.command,
      ...(command.args || []),
    );

    this.log("bubblewrap-launch", command.command, command.args || []);

    return spawnChild(this.options.bubblewrapExecutable, args, {
      cwd: this.options.workingDirectory || this.options.guestHomePath || this.sessionDirs.home,
      env: {
        ...process.env,
      },
    });
  }

  async handleInput(events) {
    for (const event of events) {
      if (event.kind === "pointerMove") {
        await this.adapter.injectPointerMove(event.x, event.y);
      } else if (event.kind === "pointerDown") {
        await this.adapter.injectPointerMove(event.x, event.y);
        await this.adapter.injectPointerButton(event.button, true);
      } else if (event.kind === "pointerUp") {
        await this.adapter.injectPointerMove(event.x, event.y);
        await this.adapter.injectPointerButton(event.button, false);
      } else if (event.kind === "wheel") {
        await this.adapter.injectPointerMove(event.x, event.y);
        await this.adapter.injectWheel(event.deltaX, event.deltaY);
      } else if (event.kind === "keyDown") {
        await this.adapter.injectKey(event, true);
      } else if (event.kind === "keyUp") {
        await this.adapter.injectKey(event, false);
      }
    }
  }

  async configureDisplaySize(width, height, client = null) {
    const nextWidth = Math.max(64, Math.min(this.options.virtualWidth, Math.round(width)));
    const nextHeight = Math.max(64, Math.min(this.options.virtualHeight, Math.round(height)));

    if (!this.state.liveResizeSupported) {
      this.log("display-resize-ignored", nextWidth, nextHeight, this.options.xServerBackend);
      return;
    }

    if (this.resizeInFlight) {
      await this.resizeInFlight;
    }

    this.resizeInFlight = this.options.xServerBackend === "xvfb"
      ? this.configureXvfbSize(nextWidth, nextHeight)
      : this.configureXorgDummyMode(nextWidth, nextHeight);

    try {
      await this.resizeInFlight;
      const screenInfo = await this.adapter.getScreenInfo();
      this.state.width = screenInfo.width;
      this.state.height = screenInfo.height;
      this.hasKeyframe = false;
      this.lastHashes = null;
      this.log("display-resized", screenInfo.width, screenInfo.height);

      const targetClient = client || this.wsHost.getAuthenticatedClient();
      if (targetClient) {
        this.wsHost.sendControl(targetClient, {
          type: "screen-info",
          width: screenInfo.width,
          height: screenInfo.height,
          depth: screenInfo.depth,
          pixelFormat: "bgra8888",
        });
      }

      this.requestFrame();
    } finally {
      this.resizeInFlight = null;
    }
  }

  async configureXorgDummyMode(width, height) {
    const modeName = await this.ensureMode(width, height);
    await this.runDisplayCommand(this.options.xrandrExecutable, [
      "--output",
      this.xrandrOutputName || "DUMMY0",
      "--mode",
      modeName,
      "--fb",
      `${width}x${height}`,
    ]);
  }

  async configureXvfbSize(width, height) {
    await this.runDisplayCommand(this.options.xrandrExecutable, [
      "--fb",
      `${width}x${height}`,
    ], { allowFailure: true });
  }

  async ensureMode(width, height) {
    const modeKey = `${width}x${height}`;
    if (this.createdModeNames.has(modeKey)) {
      return this.createdModeNames.get(modeKey);
    }

    const { stdout } = await this.runDisplayCommand(this.options.cvtExecutable, [String(width), String(height), "60"]);
    const modelineMatch = stdout.match(/Modeline\s+"([^"]+)"\s+(.+)/);
    if (!modelineMatch) {
      throw new Error(`display resize failure: unable to build modeline for ${width}x${height}`);
    }

    const [, modelineName, modelineArgs] = modelineMatch;
    await this.runDisplayCommand(this.options.xrandrExecutable, [
      "--newmode",
      modelineName,
      ...modelineArgs.trim().split(/\s+/),
    ], { allowFailure: true });
    await this.runDisplayCommand(this.options.xrandrExecutable, [
      "--addmode",
      this.xrandrOutputName || "DUMMY0",
      modelineName,
    ], { allowFailure: true });
    this.createdModeNames.set(modeKey, modelineName);
    return modelineName;
  }
}
