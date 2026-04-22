const path = require("path");
const { defineConfig } = require("vite");

const BACKEND_HTTP_TARGET = "http://127.0.0.1:3211";
const BACKEND_WS_TARGET = "ws://127.0.0.1:3211";

module.exports = defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        chatPane: path.resolve(__dirname, "panes/chat.html"),
        terminalPane: path.resolve(__dirname, "panes/terminal.html"),
        resourcePane: path.resolve(__dirname, "panes/resource.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 3210,
    proxy: {
      "/api": BACKEND_HTTP_TARGET,
      "/ws": {
        target: BACKEND_WS_TARGET,
        ws: true,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 3210,
  },
});
