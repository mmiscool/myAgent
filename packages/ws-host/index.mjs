import { EventEmitter } from "node:events";
import { WebSocketServer } from "ws";
import {
  parseControlMessage,
  serializeControlMessage,
} from "../protocol/index.mjs";
import { createDebugLogger } from "../protocol/debug.mjs";

function now() {
  return Date.now();
}

export class WebSocketHost extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      port: 8080,
      authToken: "dev-token",
      keepAliveIntervalMs: 10000,
      idleTimeoutMs: 30000,
      ...options,
    };
    this.log = createDebugLogger("transport", options.debug);
    this.server = null;
    this.clients = new Set();
    this.keepAliveTimer = null;
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server = new WebSocketServer({ port: this.options.port }, resolve);
      this.server.once("error", reject);
      this.server.on("connection", (socket) => this.onConnection(socket));
    }).catch((error) => {
      throw new Error(`WebSocket bind failure: ${error.message}`);
    });

    this.keepAliveTimer = setInterval(() => this.keepAlive(), this.options.keepAliveIntervalMs);
    this.log("listening", this.options.port);
  }

  async stop() {
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;

    for (const client of this.clients) {
      client.socket.close();
    }
    this.clients.clear();

    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    this.log("stopped");
  }

  getAuthenticatedClient() {
    for (const client of this.clients) {
      if (client.authenticated) {
        return client;
      }
    }
    return null;
  }

  sendControl(client, payload) {
    client.socket.send(serializeControlMessage(payload));
  }

  sendBinary(client, payload) {
    if (client.socket.readyState === client.socket.OPEN) {
      client.socket.send(payload);
    }
  }

  onConnection(socket) {
    const client = {
      socket,
      authenticated: false,
      helloReceived: false,
      lastSeenAt: now(),
    };
    this.clients.add(client);
    this.log("client-connected");

    socket.on("message", (raw, isBinary) => {
      client.lastSeenAt = now();
      if (isBinary) {
        this.emit("binary-message", client, raw);
        return;
      }

      try {
        const message = parseControlMessage(raw.toString("utf8"));
        this.handleControlMessage(client, message);
      } catch (error) {
        this.log("malformed-json", error.message);
        this.sendControl(client, {
          type: "error",
          code: error.message === "unsupported-protocol-version" ? error.message : "malformed-json-packet",
          message: error.message,
        });
      }
    });

    socket.on("close", () => {
      this.clients.delete(client);
      this.log("client-disconnected");
      this.emit("client-disconnected", client);
    });

    socket.on("error", (error) => {
      this.emit("error", error);
    });

    this.emit("client-connected", client);
  }

  handleControlMessage(client, message) {
    switch (message.type) {
      case "hello":
        client.helloReceived = true;
        this.emit("hello", client, message);
        this.log("hello");
        break;
      case "auth":
        if (this.getAuthenticatedClient() && !client.authenticated) {
          this.sendControl(client, {
            type: "error",
            code: "single-client-only",
            message: "exactly one authenticated active browser client is supported",
          });
          client.socket.close();
          return;
        }

        if (message.token !== this.options.authToken) {
          this.sendControl(client, {
            type: "auth-failed",
            reason: "invalid-token",
          });
          this.emit("auth-failed", client);
          this.log("auth-failed");
          return;
        }

        client.authenticated = true;
        this.sendControl(client, { type: "auth-ok" });
        this.log("auth-ok");
        this.emit("client-authenticated", client);
        break;
      case "ping":
        this.sendControl(client, { type: "pong", t: message.t });
        break;
      case "input":
        this.emit("input", client, message);
        break;
      case "resize":
        this.emit("resize", client, message);
        break;
      case "pong":
        break;
      default:
        this.emit("control-message", client, message);
        break;
    }
  }

  keepAlive() {
    const cutoff = now() - this.options.idleTimeoutMs;
    for (const client of this.clients) {
      if (client.lastSeenAt < cutoff) {
        client.socket.terminate();
        continue;
      }

      if (client.socket.readyState === client.socket.OPEN) {
        this.sendControl(client, { type: "ping", t: now() });
      }
    }
  }
}
