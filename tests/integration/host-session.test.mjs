import { afterEach, describe, expect, test } from "vitest";
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
});
