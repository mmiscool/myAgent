import "./styles.css";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { api, cleanString, createPaneBridge, websocketUrl } from "./pane-bridge.mjs";

const state = {
  active: false,
  projectId: "",
  terminalClient: null,
  terminalEmulator: null,
  connectInFlight: false,
  sessionByProjectId: {},
  fitTimer: null,
};

const elements = {
  status: document.getElementById("threadTerminalStatus"),
  reconnect: document.getElementById("threadTerminalReconnect"),
  interrupt: document.getElementById("threadTerminalInterrupt"),
  clear: document.getElementById("threadTerminalClear"),
  stop: document.getElementById("threadTerminalStop"),
  viewport: document.getElementById("threadTerminalViewport"),
};

const bridge = createPaneBridge("terminal", {
  onState: (payload) => {
    void applyHostState(payload);
  },
  onFocus: () => {
    state.terminalEmulator?.terminal.focus();
  },
});

elements.reconnect.addEventListener("click", () => {
  void reconnectProjectTerminal();
});

elements.interrupt.addEventListener("click", () => {
  void sendTerminalControl("interrupt");
});

elements.clear.addEventListener("click", () => {
  clearProjectTerminal();
});

elements.stop.addEventListener("click", () => {
  void stopProjectTerminal();
});

window.addEventListener("beforeunload", () => {
  void disconnectTerminalClient();
});

async function applyHostState(payload = {}) {
  const nextProjectId = cleanString(payload.projectId);
  const projectChanged = nextProjectId !== state.projectId;
  state.active = payload.active === true;

  if (!nextProjectId) {
    state.projectId = "";
    await disconnectTerminalClient();
    renderTerminalPane();
    return;
  }

  state.projectId = nextProjectId;

  if (projectChanged) {
    await disconnectTerminalClient();
  }

  renderTerminalPane();

  if (state.active) {
    await ensureProjectTerminal();
  }
}

function renderTerminalPane() {
  const session = state.projectId ? state.sessionByProjectId[state.projectId] : null;
  const connected = state.terminalClient?.projectId === state.projectId
    && state.terminalClient.socket.readyState === WebSocket.OPEN;

  if (!state.projectId) {
    elements.status.textContent = "Select a project first.";
    return;
  }

  if (state.connectInFlight) {
    elements.status.textContent = "Starting terminal...";
    return;
  }

  if (!session) {
    elements.status.textContent = "Terminal is not running.";
    return;
  }

  if (session.state === "running") {
    elements.status.textContent = `${session.locationLabel || "host"} · ${connected ? "connected" : "disconnected"}`;
    return;
  }

  if (session.state === "error") {
    elements.status.textContent = `${session.locationLabel || "host"} · error`;
    return;
  }

  const exitDetails = session.exitCode != null
    ? `stopped (exit ${session.exitCode})`
    : session.signal
    ? `stopped (${session.signal})`
    : "stopped";
  elements.status.textContent = `${session.locationLabel || "host"} · ${exitDetails}`;
}

function ensureTerminalEmulator() {
  if (state.terminalEmulator) {
    return state.terminalEmulator;
  }

  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: "\"SFMono-Regular\", Menlo, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.35,
    scrollback: 5000,
    theme: {
      background: "#0d0f12",
      foreground: "#eceef0",
      cursor: "#4aa3ff",
      selectionBackground: "rgba(74, 163, 255, 0.24)",
    },
  });
  const fitAddon = new FitAddon();

  terminal.loadAddon(fitAddon);
  terminal.open(elements.viewport);
  elements.viewport.addEventListener("click", () => {
    terminal.focus();
  });
  terminal.onData((data) => {
    const socket = state.terminalClient?.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", data }));
    }
  });
  terminal.onResize(({ cols, rows }) => {
    const socket = state.terminalClient?.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "resize", columns: cols, rows }));
    }
  });

  state.terminalEmulator = { terminal, fitAddon };
  return state.terminalEmulator;
}

function scheduleTerminalFit() {
  clearTimeout(state.fitTimer);
  state.fitTimer = setTimeout(() => {
    if (!state.active || !state.terminalEmulator) {
      return;
    }

    try {
      state.terminalEmulator.fitAddon.fit();
    } catch {}
  }, 80);
}

function resolveTerminalGeometry() {
  const { terminal, fitAddon } = ensureTerminalEmulator();
  if (state.active) {
    try {
      fitAddon.fit();
    } catch {}
  }

  return {
    columns: Math.max(40, terminal.cols || 120),
    rows: Math.max(12, terminal.rows || 32),
  };
}

async function ensureProjectTerminal() {
  if (!state.projectId || state.connectInFlight) {
    return;
  }

  const current = state.terminalClient;
  if (current?.projectId === state.projectId && (
    current.socket.readyState === WebSocket.OPEN
    || current.socket.readyState === WebSocket.CONNECTING
  )) {
    scheduleTerminalFit();
    return;
  }

  state.connectInFlight = true;
  renderTerminalPane();

  try {
    const geometry = resolveTerminalGeometry();
    const payload = await api(`/api/projects/${encodeURIComponent(state.projectId)}/terminal`, {
      method: "POST",
      body: {
        columns: geometry.columns,
        rows: geometry.rows,
        term: "xterm-256color",
      },
    });
    state.sessionByProjectId[state.projectId] = payload.data || payload;
    await connectTerminalClient(state.projectId, geometry);
  } finally {
    state.connectInFlight = false;
    renderTerminalPane();
  }
}

function terminalSocketUrl(projectId, size = {}) {
  const url = new URL(`/ws/projects/${encodeURIComponent(projectId)}/terminal`, websocketUrl("/"));

  if (Number.isInteger(size.columns) && size.columns > 0) {
    url.searchParams.set("columns", String(size.columns));
  }
  if (Number.isInteger(size.rows) && size.rows > 0) {
    url.searchParams.set("rows", String(size.rows));
  }

  url.searchParams.set("term", "xterm-256color");
  return url.toString();
}

async function connectTerminalClient(projectId, geometry = resolveTerminalGeometry()) {
  const current = state.terminalClient;
  const emulator = ensureTerminalEmulator();

  if (current?.projectId === projectId && (
    current.socket.readyState === WebSocket.OPEN
    || current.socket.readyState === WebSocket.CONNECTING
  )) {
    scheduleTerminalFit();
    emulator.terminal.focus();
    return;
  }

  await disconnectTerminalClient();
  const socket = new WebSocket(terminalSocketUrl(projectId, geometry));
  state.terminalClient = { projectId, socket };

  socket.addEventListener("open", () => {
    if (state.terminalClient?.socket !== socket) {
      return;
    }

    scheduleTerminalFit();
    emulator.terminal.focus();
    renderTerminalPane();
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      return;
    }

    let payload;

    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      console.error("Failed to parse terminal payload", error);
      return;
    }

    if (payload.type === "session") {
      state.sessionByProjectId[projectId] = payload.data || payload;
      if (state.terminalClient?.projectId === projectId) {
        emulator.terminal.reset();
        if (payload.data?.buffer) {
          emulator.terminal.write(String(payload.data.buffer));
        }
        scheduleTerminalFit();
        emulator.terminal.focus();
      }
      renderTerminalPane();
      return;
    }

    if (payload.type === "output") {
      if (state.terminalClient?.projectId === projectId) {
        emulator.terminal.write(String(payload.data || ""));
      }
      return;
    }

    if (payload.type === "exit") {
      state.sessionByProjectId[projectId] = {
        ...(state.sessionByProjectId[projectId] || {}),
        state: "stopped",
        exitCode: payload.exitCode ?? null,
        signal: payload.signal ?? null,
      };
      renderTerminalPane();
      return;
    }

    if (payload.type === "error") {
      if (state.terminalClient?.projectId === projectId) {
        emulator.terminal.writeln(`\r\n[terminal error] ${String(payload.error || "unknown error")}`);
      }
      state.sessionByProjectId[projectId] = {
        ...(state.sessionByProjectId[projectId] || {}),
        state: "error",
        error: String(payload.error || "unknown error"),
      };
      renderTerminalPane();
    }
  });

  socket.addEventListener("close", () => {
    if (state.terminalClient?.socket === socket) {
      state.terminalClient = null;
      renderTerminalPane();
    }
  });

  socket.addEventListener("error", () => {
    if (state.terminalClient?.socket === socket) {
      elements.status.textContent = "Terminal connection error";
    }
  });
}

async function disconnectTerminalClient() {
  if (!state.terminalClient) {
    return;
  }

  const { socket } = state.terminalClient;
  state.terminalClient = null;
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close();
  }
}

function requireActiveTerminalSocket() {
  const socket = state.terminalClient?.socket;
  if (!state.projectId || state.terminalClient?.projectId !== state.projectId || socket?.readyState !== WebSocket.OPEN) {
    throw new Error("Terminal is not connected");
  }

  return socket;
}

async function reconnectProjectTerminal() {
  await disconnectTerminalClient();
  await ensureProjectTerminal();
}

function sendTerminalControl(action) {
  const socket = requireActiveTerminalSocket();
  socket.send(JSON.stringify({ type: "control", action }));
}

function clearProjectTerminal() {
  const { terminal } = ensureTerminalEmulator();
  terminal.clear();
}

async function stopProjectTerminal() {
  if (!state.projectId) {
    return;
  }

  await disconnectTerminalClient();
  await api(`/api/projects/${encodeURIComponent(state.projectId)}/terminal`, {
    method: "DELETE",
  });
  delete state.sessionByProjectId[state.projectId];
  ensureTerminalEmulator().terminal.reset();
  renderTerminalPane();
  elements.status.textContent = "Terminal stopped";
}

window.addEventListener("resize", () => {
  scheduleTerminalFit();
});
