import { HeadlessXSessionHost } from "../../packages/host-session/index.mjs";

const host = new HeadlessXSessionHost({
  displayNumber: 99,
  width: 1280,
  height: 800,
  depth: 24,
  wsPort: 8080,
  authToken: "dev-token",
  windowManagerCommand: { command: "openbox", args: [] },
  appCommands: [
    { command: "tint2", args: [] },
    { command: "xterm", args: [] },
  ],
  preferredEncoding: "jpeg",
  frameRate: 10,
});

host.on("error", console.error);
host.on("started", () => {
  console.log(host.getState());
});

await host.start();
