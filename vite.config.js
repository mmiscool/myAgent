const path = require("path");
const { defineConfig } = require("vite");

const FRONTEND_HOST = process.env.FRONTEND_HOST || "127.0.0.1";
const FRONTEND_PORT = parsePort(process.env.FRONTEND_PORT, 3220);
const BACKEND_HOST = process.env.BACKEND_HOST || "127.0.0.1";
const BACKEND_PORT = parsePort(process.env.BACKEND_PORT, 3221);
const BACKEND_HTTP_TARGET = `http://${BACKEND_HOST}:${BACKEND_PORT}`;
const BACKEND_WS_TARGET = `ws://${BACKEND_HOST}:${BACKEND_PORT}`;

function parsePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

module.exports = defineConfig({
  build: {
    rollupOptions: {
      input: {
        newApp: path.resolve(__dirname, "new-app/index.html"),
        newAppChat: path.resolve(__dirname, "new-app/chat.html"),
      },
    },
  },
  server: {
    host: FRONTEND_HOST,
    port: FRONTEND_PORT,
    proxy: {
      "/new-api": BACKEND_HTTP_TARGET,
      "/new-ws": {
        target: BACKEND_WS_TARGET,
        ws: true,
      },
    },
  },
  preview: {
    host: FRONTEND_HOST,
    port: FRONTEND_PORT,
  },
});
