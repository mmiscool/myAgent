import { describe, expect, test } from "vitest";
import viteConfig from "../../vite.config.js";

describe("vite config", () => {
  test("proxies websocket endpoints to the backend in dev", () => {
    expect(viteConfig.server?.proxy?.["/ws"]).toEqual({
      target: "ws://127.0.0.1:3211",
      ws: true,
    });
  });
});
