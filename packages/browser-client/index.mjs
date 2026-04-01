import {
  parseControlMessage,
  parseFramePacket,
  serializeControlMessage,
} from "../protocol/index.mjs";
import { createDebugLogger } from "../protocol/debug.mjs";
import { CanvasRenderer } from "../canvas-renderer/index.mjs";
import { InputNormalizer } from "../input-normalizer/index.mjs";

class BrowserEventEmitter {
  constructor() {
    this.listeners = new Map();
  }

  on(name, handler) {
    if (!this.listeners.has(name)) {
      this.listeners.set(name, new Set());
    }
    this.listeners.get(name).add(handler);
  }

  off(name, handler) {
    this.listeners.get(name)?.delete(handler);
  }

  emit(name, payload) {
    for (const handler of this.listeners.get(name) || []) {
      handler(payload);
    }
  }
}

export class RemoteXBrowserClient {
  constructor(options = {}) {
    this.options = {
      url: "ws://localhost:8080",
      preferredEncoding: "jpeg",
      enableInput: true,
      autoScale: true,
      ...options,
    };
    this.events = new BrowserEventEmitter();
    this.log = createDebugLogger("browser", this.options.debug);
    this.state = {
      connected: false,
      authenticated: false,
      screen: null,
      encoding: this.options.preferredEncoding,
    };
    this.socket = null;
    this.renderer = new CanvasRenderer({ autoScale: this.options.autoScale });
    this.input = new InputNormalizer({
      renderer: this.renderer,
      enableInput: this.options.enableInput,
      send: (events) => this.sendInput(events),
    });
  }

  on(eventName, handler) {
    this.events.on(eventName, handler);
  }

  off(eventName, handler) {
    this.events.off(eventName, handler);
  }

  getState() {
    return { ...this.state };
  }

  attachCanvas(canvas) {
    this.renderer.attachCanvas(canvas);
    this.input.attach(canvas);
  }

  attachInput(canvas = this.renderer.canvas) {
    if (!canvas) {
      return;
    }

    this.input.attach(canvas);
  }

  detachInput() {
    this.input.detach();
    if (this.renderer.canvas && document.activeElement === this.renderer.canvas) {
      this.renderer.canvas.blur();
    }
  }

  detachCanvas() {
    this.detachInput();
    this.renderer.detachCanvas();
  }

  async connect() {
    if (this.socket && this.state.connected) {
      return;
    }

    this.events.emit("connecting");

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.options.url);
      socket.binaryType = "arraybuffer";

      socket.addEventListener("open", () => {
        this.socket = socket;
        this.state.connected = true;
        this.log("connected", this.options.url);
        this.sendControl({
          type: "hello",
          clientType: "browser",
          supportedEncodings: ["jpeg", "png", "raw"],
          canvasWidth: this.renderer.canvas?.clientWidth || 0,
          canvasHeight: this.renderer.canvas?.clientHeight || 0,
          devicePixelRatio: window.devicePixelRatio || 1,
        });
        this.events.emit("connected");
        resolve();
      });

      socket.addEventListener("message", (event) => this.onMessage(event.data));
      socket.addEventListener("close", () => {
        this.state.connected = false;
        this.state.authenticated = false;
        this.log("disconnected");
        this.events.emit("disconnected");
      });
      socket.addEventListener("error", () => {
        const error = new Error("browser-connection-error");
        this.events.emit("error", error);
        reject(error);
      });
    });
  }

  async disconnect() {
    this.socket?.close();
    this.socket = null;
    this.state.connected = false;
    this.state.authenticated = false;
  }

  async authenticate(token) {
    this.sendControl({
      type: "auth",
      token,
    });
  }

  async requestResize(width, height, scale = 1) {
    if (!this.state.authenticated) {
      return;
    }

    this.sendControl({
      type: "resize",
      width,
      height,
      scale,
    });
  }

  sendControl(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("socket-not-open");
    }
    this.socket.send(serializeControlMessage(message));
  }

  sendInput(events) {
    if (!this.state.authenticated || !events.length || !this.socket) {
      return;
    }

    this.sendControl({
      type: "input",
      events,
    });
  }

  async onMessage(data) {
    if (typeof data === "string") {
      const message = parseControlMessage(data);
      this.handleControl(message);
      return;
    }

    try {
      const packet = parseFramePacket(new Uint8Array(data));
      await this.renderer.renderPacket(packet);
      this.log("frame", packet.sequence, packet.encoding, packet.rects.length);
      this.events.emit("frame", packet);
    } catch (error) {
      this.events.emit("error", new Error("browser-decode-failure"));
    }
  }

  handleControl(message) {
    switch (message.type) {
      case "hello":
        break;
      case "auth-ok":
        this.state.authenticated = true;
        this.log("authenticated");
        this.events.emit("authenticated");
        break;
      case "screen-info":
        this.state.screen = message;
        this.renderer.setScreenInfo(message.width, message.height);
        this.log("screen-info", message.width, message.height);
        this.events.emit("screen-info", message);
        break;
      case "stream-config":
        this.state.encoding = message.encoding;
        break;
      case "pong":
        break;
      case "error":
        this.events.emit("error", new Error(message.code || message.message));
        break;
      case "auth-failed":
        this.events.emit("error", new Error(message.reason || "invalid-token"));
        break;
      default:
        break;
    }
  }
}
