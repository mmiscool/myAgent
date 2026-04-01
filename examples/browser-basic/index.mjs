import { RemoteXBrowserClient } from "../../packages/browser-client/index.mjs";

const canvas = document.querySelector("#screen");
const status = document.querySelector("#status");
const form = document.querySelector("#connectForm");

let client = null;

function setStatus(value) {
  status.textContent = value;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = document.querySelector("#url").value;
  const token = document.querySelector("#token").value;

  if (client) {
    await client.disconnect();
  }

  client = new RemoteXBrowserClient({
    url,
    preferredEncoding: "jpeg",
    autoScale: true,
  });

  client.on("connected", () => setStatus("connected"));
  client.on("authenticated", () => setStatus("authenticated"));
  client.on("screen-info", (screen) => setStatus(`screen ${screen.width}x${screen.height}`));
  client.on("error", (error) => setStatus(`error: ${error.message}`));
  client.on("disconnected", () => setStatus("disconnected"));

  client.attachCanvas(canvas);
  await client.connect();
  await client.authenticate(token);
});
