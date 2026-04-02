import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { HeadlessXSessionHost } from "../../packages/host-session/index.mjs";
import { protocolVersion } from "../../packages/protocol/index.mjs";

class FakeX11Adapter {
  constructor() {
    this.pointerMoves = [];
    this.keys = [];
  }

  async connect() {}
  async disconnect() {}
  async getScreenInfo() {
    return { width: 64, height: 48, depth: 24, bitsPerPixel: 32, byteOrder: "LSBFirst" };
  }
  async isShmAvailable() {
    return false;
  }
  async captureFrame() {
    return {
      width: 64,
      height: 48,
      stride: 256,
      pixelFormat: "bgra8888",
      data: new Uint8Array(64 * 48 * 4),
    };
  }
  async captureTile(x, y, width, height) {
    return {
      width,
      height,
      stride: width * 4,
      pixelFormat: "bgra8888",
      data: new Uint8Array(width * height * 4),
    };
  }
  async injectPointerMove(x, y) {
    this.pointerMoves.push({ x, y });
  }
  async injectPointerButton() {}
  async injectWheel() {}
  async injectKey(keySpec, isDown) {
    this.keys.push({ keySpec, isDown });
  }
}

class FakeChildProcess extends EventEmitter {
  constructor(pid = 4242) {
    super();
    this.pid = pid;
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
  }

  kill(signal = "SIGTERM") {
    this.killed = true;
    this.signalCode = signal;
    this.emit("exit", null, signal);
    return true;
  }
}

const hosts = [];
let nextDisplayNumber = 220;
let nextWsPort = 18220;

function allocateDisplayNumber() {
  nextDisplayNumber += 1;
  return nextDisplayNumber;
}

function allocateWsPort() {
  nextWsPort += 1;
  return nextWsPort;
}

afterEach(async () => {
  while (hosts.length) {
    const host = hosts.pop();
    await host.stop().catch(() => {});
  }
});

describe("host session", () => {
  test("starts and stops against Xvfb", async () => {
    const host = new HeadlessXSessionHost({
      displayNumber: allocateDisplayNumber(),
      wsPort: allocateWsPort(),
      width: 160,
      height: 120,
      frameRate: 1,
    });
    hosts.push(host);

    await host.start();
    expect(host.getState().running).toBe(true);
  }, 20000);

  test("completes hello/auth handshake and accepts input", async () => {
    const adapter = new FakeX11Adapter();
    const wsPort = allocateWsPort();
    const host = new HeadlessXSessionHost({
      displayNumber: allocateDisplayNumber(),
      wsPort,
      authToken: "dev-token",
      x11Adapter: adapter,
      preferredEncoding: "raw",
      frameRate: 1,
    });
    hosts.push(host);

    await host.start();

    const messages = [];
    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}`);

    await new Promise((resolve) => socket.once("open", resolve));
    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        messages.push(JSON.parse(data.toString("utf8")));
      }
    });

    socket.send(JSON.stringify({
      type: "hello",
      protocolVersion,
      clientType: "browser",
      supportedEncodings: ["raw"],
      canvasWidth: 100,
      canvasHeight: 100,
      devicePixelRatio: 1,
    }));

    socket.send(JSON.stringify({
      type: "auth",
      protocolVersion,
      token: "dev-token",
    }));

    await new Promise((resolve) => setTimeout(resolve, 100));

    socket.send(JSON.stringify({
      type: "input",
      protocolVersion,
      events: [
        { kind: "pointerMove", x: 10, y: 12, buttons: 0, modifiers: 0 },
        { kind: "keyDown", code: "KeyA", key: "a", modifiers: 0 },
      ],
    }));

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(messages.some((message) => message.type === "auth-ok")).toBe(true);
    expect(messages.some((message) => message.type === "screen-info")).toBe(true);
    expect(adapter.pointerMoves).toContainEqual({ x: 10, y: 12 });
    expect(adapter.keys).toContainEqual({ keySpec: { kind: "keyDown", code: "KeyA", key: "a", modifiers: 0 }, isDown: true });

    socket.close();
  }, 20000);

  test("launches additional commands into an existing session", async () => {
    const host = new HeadlessXSessionHost({
      displayNumber: allocateDisplayNumber(),
      wsPort: allocateWsPort(),
      x11Adapter: new FakeX11Adapter(),
    });
    host.state.running = true;

    const child = new FakeChildProcess(5050);
    host.spawnSessionCommand = vi.fn(async () => child);

    const launched = await host.launchCommands([{
      command: "bash",
      args: ["-lc", "brave-browser"],
      source: "brave-browser",
    }], { maximize: true });

    expect(host.spawnSessionCommand).toHaveBeenCalledTimes(1);
    const [command] = host.spawnSessionCommand.mock.calls[0];
    expect(command.command).toBe("bash");
    expect(command.args).toHaveLength(2);
    expect(command.args[0]).toBe("-lc");
    expect(command.args[1]).toContain("brave-browser");
    expect(command.args[1]).toContain("wmctrl_bin='wmctrl'");
    expect(command.args[1]).toContain("\"$wmctrl_bin\" -lp");
    expect(command.args[1]).toContain("maximized_vert,maximized_horz");
    expect(launched).toEqual([{
      pid: 5050,
      command: "brave-browser",
      maximize: true,
    }]);
    expect(host.childApps).toContain(child);

    child.emit("exit", 0, null);
    expect(host.childApps).not.toContain(child);
  });

  test("lists current desktop windows with active and maximized state", async () => {
    const host = new HeadlessXSessionHost({
      displayNumber: allocateDisplayNumber(),
      wsPort: allocateWsPort(),
      x11Adapter: new FakeX11Adapter(),
    });
    host.state.running = true;

    host.runDisplayCommand = vi.fn(async (command, args) => {
      if (command === "wmctrl") {
        return {
          stdout: [
            "0xa00007 0 318 2 23 911 540 konsole.konsole host myAgent : bash — Konsole",
            "0x600012 0 261 0 22 983 798 xterm.XTerm host user@user: ~/projects/myAgent",
          ].join("\n"),
          stderr: "",
        };
      }

      if (command === "xprop" && args[0] === "-root") {
        return {
          stdout: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0xa00007\n",
          stderr: "",
        };
      }

      if (command === "xprop" && args[1] === "0xa00007") {
        return {
          stdout: "_NET_WM_STATE(ATOM) = _NET_WM_STATE_MAXIMIZED_VERT, _NET_WM_STATE_MAXIMIZED_HORZ\n",
          stderr: "",
        };
      }

      if (command === "xprop" && args[1] === "0x600012") {
        return {
          stdout: "_NET_WM_STATE(ATOM) = \n",
          stderr: "",
        };
      }

      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    const windows = await host.listWindows();

    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      id: "0xa00007",
      pid: 318,
      x: 2,
      y: 23,
      width: 911,
      height: 540,
      wmClass: "konsole.konsole",
      instanceName: "konsole",
      className: "konsole",
      title: "myAgent : bash — Konsole",
      active: true,
      maximized: true,
    });
    expect(windows[1]).toMatchObject({
      id: "0x600012",
      pid: 261,
      wmClass: "xterm.XTerm",
      active: false,
      maximized: false,
    });
  });

  test("focuses and optionally maximizes a window", async () => {
    const host = new HeadlessXSessionHost({
      displayNumber: allocateDisplayNumber(),
      wsPort: allocateWsPort(),
      x11Adapter: new FakeX11Adapter(),
    });
    host.state.running = true;

    host.listWindows = vi
      .fn()
      .mockResolvedValueOnce([{
        id: "0xa00007",
        title: "myAgent : bash — Konsole",
        wmClass: "konsole.konsole",
        active: false,
        maximized: false,
        x: 2,
        y: 23,
        width: 911,
        height: 540,
      }])
      .mockResolvedValueOnce([{
        id: "0xa00007",
        title: "myAgent : bash — Konsole",
        wmClass: "konsole.konsole",
        active: true,
        maximized: true,
        x: 2,
        y: 23,
        width: 911,
        height: 540,
      }]);
    host.runDisplayCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    const window = await host.focusWindow("0xa00007", { maximize: true });

    expect(host.runDisplayCommand.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["wmctrl", ["-i", "-r", "0xa00007", "-b", "add,maximized_vert,maximized_horz"]],
      ["wmctrl", ["-i", "-a", "0xa00007"]],
    ]);
    expect(window).toMatchObject({
      id: "0xa00007",
      active: true,
      maximized: true,
    });
  });

  test("falls back to adapter-backed window listing when wmctrl is missing", async () => {
    const adapter = new FakeX11Adapter();
    adapter.listWindows = vi.fn(async () => ([{
      id: "0xa00007",
      title: "myAgent : bash — Konsole",
      wmClass: "konsole.konsole",
      active: true,
      maximized: false,
      x: 2,
      y: 23,
      width: 911,
      height: 540,
    }]));

    const host = new HeadlessXSessionHost({
      displayNumber: allocateDisplayNumber(),
      wsPort: allocateWsPort(),
      x11Adapter: adapter,
    });
    host.state.running = true;
    host.runDisplayCommand = vi.fn(async (command) => {
      if (command === "wmctrl") {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const windows = await host.listWindows();

    expect(adapter.listWindows).toHaveBeenCalledTimes(1);
    expect(windows).toHaveLength(1);
    expect(windows[0].id).toBe("0xa00007");
  });

  test("falls back to adapter-backed focus when wmctrl is missing", async () => {
    const adapter = new FakeX11Adapter();
    adapter.focusWindow = vi.fn(async () => {});

    const host = new HeadlessXSessionHost({
      displayNumber: allocateDisplayNumber(),
      wsPort: allocateWsPort(),
      x11Adapter: adapter,
    });
    host.state.running = true;
    host.listWindows = vi
      .fn()
      .mockResolvedValueOnce([{
        id: "0xa00007",
        title: "myAgent : bash — Konsole",
        wmClass: "konsole.konsole",
        active: false,
        maximized: false,
        x: 2,
        y: 23,
        width: 911,
        height: 540,
      }])
      .mockResolvedValueOnce([{
        id: "0xa00007",
        title: "myAgent : bash — Konsole",
        wmClass: "konsole.konsole",
        active: true,
        maximized: true,
        x: 2,
        y: 23,
        width: 911,
        height: 540,
      }]);
    host.runDisplayCommand = vi.fn(async (command) => {
      if (command === "wmctrl") {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const window = await host.focusWindow("0xa00007", { maximize: true });

    expect(adapter.focusWindow).toHaveBeenCalledWith("0xa00007", { maximize: true });
    expect(window).toMatchObject({
      id: "0xa00007",
      active: true,
      maximized: true,
    });
  });
});
