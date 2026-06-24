import { describe, expect, test } from "vitest";
import viteConfig from "../../vite.config.js";

describe("vite config", () => {
  test("proxies new app websocket endpoints to the backend in dev", () => {
    expect(viteConfig.server?.proxy?.["/new-ws"]).toEqual({
      target: "ws://127.0.0.1:3221",
      ws: true,
    });
  });

  test("builds only new app html entries", () => {
    expect(viteConfig.build?.rollupOptions?.input).toEqual({
      newApp: expect.stringMatching(/new-app[/\\]index\.html$/),
      newAppChat: expect.stringMatching(/new-app[/\\]chat\.html$/),
    });
  });
});
