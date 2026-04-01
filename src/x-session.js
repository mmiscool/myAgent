import "./x-session.css";
import { RemoteXBrowserClient } from "../packages/browser-client/index.mjs";

const state = {
  sessions: [],
  selectedSessionId: "",
  client: null,
  connectInFlight: false,
};

const elements = {
  form: document.getElementById("sessionForm"),
  command: document.getElementById("command"),
  windowManagerCommand: document.getElementById("windowManagerCommand"),
  resolutionScale: document.getElementById("resolutionScale"),
  sessionList: document.getElementById("sessionList"),
  clientMeta: document.getElementById("clientMeta"),
  refreshSessions: document.getElementById("refreshSessions"),
  stopSelected: document.getElementById("stopSelected"),
  screenCanvas: document.getElementById("screenCanvas"),
};

let resizeObserver = null;
let resizeTimer = null;

boot().catch((error) => {
  elements.clientMeta.textContent = `Failed to load: ${error.message}`;
});

async function boot() {
  bindEvents();
  await refreshSessions();
  setInterval(() => {
    void refreshSessions(false);
  }, 3000);
}

function bindEvents() {
  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void createSession();
  });

  elements.refreshSessions.addEventListener("click", () => {
    void refreshSessions();
  });

  elements.stopSelected.addEventListener("click", () => {
    void stopSelectedSession();
  });

  elements.resolutionScale.addEventListener("change", () => {
    scheduleRemoteResize();
  });

  const reconnectEvents = ["pointerdown", "mousemove", "keydown", "focus"];
  for (const eventName of reconnectEvents) {
    window.addEventListener(eventName, () => {
      void reconnectOnInteraction();
    }, { passive: true });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void reconnectOnInteraction();
    }
  });

  resizeObserver = new ResizeObserver(() => {
    scheduleRemoteResize();
  });
  resizeObserver.observe(elements.screenCanvas);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload.data;
}

async function createSession() {
  elements.clientMeta.textContent = "Starting session...";
  const session = await api("/api/x-sessions", {
    method: "POST",
    body: {
      command: elements.command.value,
      windowManagerCommand: elements.windowManagerCommand.value,
    },
  });

  state.selectedSessionId = session.id;
  await refreshSessions(false);
  await connectToSession(session.id);
}

async function refreshSessions(updateClient = true) {
  state.sessions = await api("/api/x-sessions");
  if (!state.selectedSessionId && state.sessions[0]) {
    state.selectedSessionId = state.sessions[0].id;
  }

  if (state.selectedSessionId && !state.sessions.some((session) => session.id === state.selectedSessionId)) {
    state.selectedSessionId = "";
    await disconnectClient();
  }

  renderSessionList();
  renderSelectedSession();

  if (updateClient && state.client && state.selectedSessionId) {
    const session = findSelectedSession();
    if (session) {
      renderSelectedSession();
    }
  }
}

function renderSessionList() {
  if (!state.sessions.length) {
    elements.sessionList.innerHTML = `<div class="xsession-session"><button type="button">No sessions running.</button></div>`;
    return;
  }

  elements.sessionList.innerHTML = state.sessions.map((session) => `
    <div class="xsession-session ${session.id === state.selectedSessionId ? "active" : ""}">
      <button type="button" data-session-id="${session.id}">
        <div class="xsession-session-title">${escapeHtml(session.command || "empty session")}</div>
        <div class="xsession-session-meta">${escapeHtml(session.state.displayName)} · ws ${escapeHtml(String(session.state.wsPort))} · ${session.state.running ? "running" : "stopped"}</div>
      </button>
    </div>
  `).join("");

  for (const button of elements.sessionList.querySelectorAll("[data-session-id]")) {
    button.addEventListener("click", async () => {
      state.selectedSessionId = button.dataset.sessionId;
      renderSessionList();
      renderSelectedSession();
      await connectToSession(state.selectedSessionId);
    });
  }
}

function renderSelectedSession() {
  const session = findSelectedSession();
  if (!session) {
    elements.clientMeta.textContent = "Start a session or select an existing one.";
    return;
  }

  if (!state.client) {
    elements.clientMeta.textContent = `${session.state.displayName} · ${session.state.width}x${session.state.height} · ${session.state.encoding}`;
  }
}

async function connectToSession(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session || state.connectInFlight) {
    return;
  }

  state.connectInFlight = true;

  await disconnectClient();

  const client = new RemoteXBrowserClient({
    url: session.wsUrl,
    preferredEncoding: session.state.encoding,
    autoScale: true,
  });

  client.attachCanvas(elements.screenCanvas);
  client.on("connected", () => {
    elements.clientMeta.textContent = `${session.command || "session"} · connected`;
  });
  client.on("authenticated", () => {
    elements.clientMeta.textContent = `${session.state.displayName} · authenticated`;
    scheduleRemoteResize();
  });
  client.on("screen-info", (screen) => {
    elements.clientMeta.textContent = `${screen.width}x${screen.height} · live`;
  });
  client.on("disconnected", () => {
    if (state.client === client) {
      state.client = null;
    }
    elements.clientMeta.textContent = "Browser client disconnected";
  });
  client.on("error", (error) => {
    elements.clientMeta.textContent = `Client error: ${error.message}`;
  });

  state.client = client;
  state.selectedSessionId = sessionId;

  try {
    await client.connect();
    await client.authenticate(session.authToken);
  } finally {
    state.connectInFlight = false;
  }
}

async function stopSelectedSession() {
  const session = findSelectedSession();
  if (!session) {
    return;
  }

  await disconnectClient();
  await api(`/api/x-sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
  if (state.selectedSessionId === session.id) {
    state.selectedSessionId = "";
  }
  await refreshSessions(false);
  elements.clientMeta.textContent = "Session stopped";
}

async function disconnectClient() {
  if (!state.client) {
    return;
  }
  const client = state.client;
  await client.disconnect();
  client.detachCanvas();
  state.client = null;
}

async function reconnectOnInteraction() {
  if (document.visibilityState === "hidden" || state.connectInFlight) {
    return;
  }

  const session = findSelectedSession();
  if (!session) {
    return;
  }

  if (!state.client) {
    await connectToSession(session.id);
    return;
  }

  const clientState = state.client.getState();
  if (!clientState.connected || !clientState.authenticated) {
    await connectToSession(session.id);
  }
}

function scheduleRemoteResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    void applyRemoteResize();
  }, 120);
}

async function applyRemoteResize() {
  if (!state.client) {
    return;
  }

  const clientState = state.client.getState();
  if (!clientState.connected || !clientState.authenticated) {
    return;
  }

  const rect = elements.screenCanvas.getBoundingClientRect();
  const scale = Number(elements.resolutionScale.value) || 1;
  const width = Math.max(64, Math.round(rect.width * (window.devicePixelRatio || 1) * scale));
  const height = Math.max(64, Math.round(rect.height * (window.devicePixelRatio || 1) * scale));
  await state.client.requestResize(width, height, scale);
}

function findSelectedSession() {
  return state.sessions.find((session) => session.id === state.selectedSessionId) || null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
