function createSocketHub({ cleanString, requireProject, terminalManager }) {
  const eventSocketClients = new Set();
  const terminalSocketClientsByProjectId = new Map();

  function broadcastEvent(payload) {
    const message = JSON.stringify(payload);

    for (const socket of eventSocketClients) {
      if (socket.readyState === socket.OPEN) {
        socket.send(message);
      }
    }
  }

  function sendSocketJson(socket, payload) {
    if (socket.readyState !== socket.OPEN) {
      return;
    }

    socket.send(JSON.stringify(payload));
  }

  function getProjectTerminalSockets(projectId) {
    const normalizedProjectId = cleanString(projectId);
    if (!normalizedProjectId) {
      return null;
    }

    let sockets = terminalSocketClientsByProjectId.get(normalizedProjectId);
    if (!sockets) {
      sockets = new Set();
      terminalSocketClientsByProjectId.set(normalizedProjectId, sockets);
    }

    return sockets;
  }

  function removeProjectTerminalSocket(projectId, socket) {
    const sockets = terminalSocketClientsByProjectId.get(cleanString(projectId));
    if (!sockets) {
      return;
    }

    sockets.delete(socket);
    if (sockets.size === 0) {
      terminalSocketClientsByProjectId.delete(cleanString(projectId));
    }
  }

  function broadcastProjectTerminal(projectId, payload) {
    const sockets = terminalSocketClientsByProjectId.get(cleanString(projectId));
    if (!sockets) {
      return;
    }

    for (const socket of sockets) {
      sendSocketJson(socket, payload);
    }
  }

  function handleEventSocketConnection(socket) {
    eventSocketClients.add(socket);
    socket.send(JSON.stringify({ type: "connected", timestamp: Date.now() }));

    socket.on("close", () => {
      eventSocketClients.delete(socket);
    });

    socket.on("error", () => {
      eventSocketClients.delete(socket);
    });
  }

  function normalizeTerminalColumns(value) {
    return clamp(toInteger(value, 120), 40, 240);
  }

  function normalizeTerminalRows(value) {
    return clamp(toInteger(value, 32), 12, 80);
  }

  async function ensureProjectTerminalSession(projectId, options = {}) {
    const project = await requireProject(cleanString(projectId));
    return terminalManager.ensureProjectSession(project, {
      columns: normalizeTerminalColumns(options.columns),
      rows: normalizeTerminalRows(options.rows),
      term: cleanString(options.term) || "xterm-256color",
    });
  }

  function handleTerminalSocketConnection(socket, projectId) {
    const normalizedProjectId = cleanString(projectId);
    const sockets = getProjectTerminalSockets(normalizedProjectId);
    sockets?.add(socket);

    sendSocketJson(socket, {
      type: "connected",
      timestamp: Date.now(),
      projectId: normalizedProjectId,
    });

    const session = terminalManager.getProjectSession(normalizedProjectId);
    if (session) {
      sendSocketJson(socket, {
        type: "session",
        timestamp: Date.now(),
        data: session,
      });
    }

    socket.on("message", (raw) => {
      try {
        const payload = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || ""));

        if (payload.type === "input") {
          terminalManager.writeProjectInput(normalizedProjectId, String(payload.data || ""));
          return;
        }

        if (payload.type === "control") {
          terminalManager.sendProjectControl(normalizedProjectId, payload.action);
          return;
        }

        if (payload.type === "resize") {
          terminalManager.resizeProjectSession(normalizedProjectId, {
            columns: payload.columns,
            rows: payload.rows,
          });
          return;
        }

        throw new Error(`Unsupported terminal message type: ${cleanString(payload.type) || "unknown"}`);
      } catch (error) {
        sendSocketJson(socket, {
          type: "error",
          timestamp: Date.now(),
          projectId: normalizedProjectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    socket.on("close", () => {
      removeProjectTerminalSocket(normalizedProjectId, socket);
    });

    socket.on("error", () => {
      removeProjectTerminalSocket(normalizedProjectId, socket);
    });
  }

  terminalManager.on("output", (payload) => {
    broadcastProjectTerminal(payload.projectId, {
      type: "output",
      timestamp: Date.now(),
      ...payload,
    });
  });

  terminalManager.on("exit", (payload) => {
    broadcastProjectTerminal(payload.projectId, {
      type: "exit",
      timestamp: Date.now(),
      ...payload,
    });
  });

  terminalManager.on("error", (payload) => {
    broadcastProjectTerminal(payload.projectId, {
      type: "error",
      timestamp: Date.now(),
      ...payload,
    });
  });

  return {
    broadcastEvent,
    ensureProjectTerminalSession,
    handleEventSocketConnection,
    handleTerminalSocketConnection,
  };
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toInteger(value, fallback = 0) {
  return Math.round(toNumber(value, fallback));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = {
  createSocketHub,
};
