const { defineConfig } = require("vite");

module.exports = defineConfig({
  server: {
    host: "127.0.0.1",
    port: 3210,
    proxy: {
      "/api": "http://127.0.0.1:3211",
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 3210,
  },
});
