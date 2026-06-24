import {
  STORAGE_KEYS,
  api,
  applyTheme,
  chatUrl,
  cleanString,
  currentTheme,
  escapeHtml,
  formatRelativeTime,
  latestThreadText,
  nextTheme,
  normalizeThreadList,
  oneLine,
  saveTheme,
  threadStatusLabel,
  threadTimestamp,
  threadTitle,
  updateThemeToggle,
  websocketUrl,
} from "./shared.js";

const state = {
  app: null,
  projects: [],
  selectedProjectId: localStorage.getItem(STORAGE_KEYS.projectId) || "",
  selectedThreadId: localStorage.getItem(STORAGE_KEYS.threadId) || "",
  sidebarCollapsed: localStorage.getItem(STORAGE_KEYS.shellSidebarCollapsed) === "true",
  conversationListMode: localStorage.getItem(STORAGE_KEYS.shellConversationListMode) === "compact" ? "compact" : "comfortable",
  threads: [],
  threadsLoading: false,
  socket: null,
  socketRetryTimer: null,
  threadsReloadTimer: null,
};

const elements = {
  projectSelect: document.getElementById("projectSelect"),
  conversationCount: document.getElementById("conversationCount"),
  conversationDensityButton: document.getElementById("conversationDensityButton"),
  conversationList: document.getElementById("conversationList"),
  refreshButton: document.getElementById("refreshButton"),
  newThreadButton: document.getElementById("newThreadButton"),
  sidebarExpandButton: document.getElementById("sidebarExpandButton"),
  sidebarToggleButton: document.getElementById("sidebarToggleButton"),
  themeToggle: document.getElementById("themeToggle"),
  connectionDot: document.getElementById("connectionDot"),
  connectionStatus: document.getElementById("connectionStatus"),
  chatFrame: document.getElementById("chatFrame"),
};

function selectedProject() {
  return state.projects.find((project) => project.id === state.selectedProjectId) || state.projects[0] || null;
}

function selectedThread() {
  return state.threads.find((thread) => String(thread?.id || "") === state.selectedThreadId) || null;
}

function setConnectionStatus(status, tone = "idle") {
  elements.connectionStatus.textContent = status;
  elements.connectionDot.dataset.tone = tone;
}

function currentChatUrl() {
  return chatUrl({
    projectId: state.selectedProjectId,
    threadId: state.selectedThreadId,
  });
}

function syncChatFrame() {
  const nextUrl = currentChatUrl();
  if (elements.chatFrame.getAttribute("src") !== nextUrl) {
    elements.chatFrame.src = nextUrl;
  }
}

function syncTheme(theme = currentTheme()) {
  const normalizedTheme = applyTheme(theme);
  updateThemeToggle(elements.themeToggle, normalizedTheme);
  elements.chatFrame.contentWindow?.postMessage({
    source: "new-app-shell",
    type: "theme-changed",
    theme: normalizedTheme,
  }, window.location.origin);
}

function syncShellLayout() {
  const shell = document.querySelector(".new-shell");
  shell?.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  elements.sidebarToggleButton.textContent = "◂";
  elements.sidebarToggleButton.title = "Collapse side panel";
  elements.sidebarToggleButton.setAttribute("aria-label", "Collapse side panel");
  elements.sidebarToggleButton.setAttribute("aria-pressed", state.sidebarCollapsed ? "true" : "false");
  elements.sidebarExpandButton.setAttribute("aria-hidden", state.sidebarCollapsed ? "false" : "true");
}

function syncConversationDensity() {
  const compact = state.conversationListMode === "compact";
  elements.conversationList.classList.toggle("is-compact", compact);
  elements.conversationDensityButton.textContent = compact ? "▤" : "≡";
  elements.conversationDensityButton.title = compact ? "Use comfortable conversation list" : "Use compact conversation list";
  elements.conversationDensityButton.setAttribute("aria-label", compact ? "Use comfortable conversation list" : "Use compact conversation list");
  elements.conversationDensityButton.setAttribute("aria-pressed", compact ? "true" : "false");
}

function renderConversationList() {
  elements.conversationCount.textContent = String(state.threads.length);
  syncConversationDensity();

  if (state.threadsLoading) {
    elements.conversationList.innerHTML = "<div class=\"conversation-empty\">Loading conversations...</div>";
    return;
  }

  if (state.threads.length === 0) {
    elements.conversationList.innerHTML = "<div class=\"conversation-empty\">No active conversations.</div>";
    return;
  }

  elements.conversationList.innerHTML = state.threads.map((thread) => {
    const threadId = String(thread?.id || "");
    const selected = threadId && threadId === state.selectedThreadId;
    const updatedAt = threadTimestamp(thread);
    const title = threadTitle(thread);
    const preview = oneLine(latestThreadText(thread), "No messages yet");

    return `
      <button
        type="button"
        class="conversation-item${selected ? " is-active" : ""}"
        data-action="select-thread"
        data-id="${escapeHtml(threadId)}"
      >
        <span class="conversation-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
        <span class="conversation-preview">${escapeHtml(preview)}</span>
        <span class="conversation-meta">
          <span>${escapeHtml(threadStatusLabel(thread))}</span>
          <span>${escapeHtml(formatRelativeTime(updatedAt))}</span>
        </span>
      </button>
    `;
  }).join("");
}

function renderProjects() {
  const project = selectedProject();
  elements.projectSelect.innerHTML = state.projects.map((item) => {
    const selected = item.id === state.selectedProjectId ? " selected" : "";
    return `<option value="${escapeHtml(item.id)}"${selected}>${escapeHtml(item.cwd || item.name || item.id)}</option>`;
  }).join("");
  elements.projectSelect.title = project?.cwd || "";

  if (!project) {
    renderConversationList();
    syncChatFrame();
    return;
  }

  renderConversationList();
  syncChatFrame();
}

function render() {
  syncShellLayout();
  renderProjects();
}

async function loadBoot() {
  const boot = await api("/boot");
  state.app = boot.app || null;
  state.projects = Array.isArray(boot.projects) ? boot.projects : [];

  if (!state.projects.some((project) => project.id === state.selectedProjectId)) {
    state.selectedProjectId = state.projects[0]?.id || "";
    if (state.selectedProjectId) {
      localStorage.setItem(STORAGE_KEYS.projectId, state.selectedProjectId);
    }
  }

  render();
}

async function loadThreads({ autoSelect = false } = {}) {
  const project = selectedProject();
  if (!project) {
    state.threads = [];
    state.selectedThreadId = "";
    localStorage.removeItem(STORAGE_KEYS.threadId);
    render();
    return;
  }

  state.threadsLoading = true;
  renderConversationList();

  try {
    const payload = await api(`/projects/${encodeURIComponent(project.id)}/threads?archived=false`);
    state.threads = normalizeThreadList(payload);

    const selectedStillExists = state.threads.some((thread) => String(thread?.id || "") === state.selectedThreadId);
    if (autoSelect && (!state.selectedThreadId || !selectedStillExists)) {
      state.selectedThreadId = String(state.threads[0]?.id || "");
    }

    if (state.selectedThreadId && !state.threads.some((thread) => String(thread?.id || "") === state.selectedThreadId)) {
      state.selectedThreadId = "";
      localStorage.removeItem(STORAGE_KEYS.threadId);
    } else if (state.selectedThreadId) {
      localStorage.setItem(STORAGE_KEYS.threadId, state.selectedThreadId);
    }
  } finally {
    state.threadsLoading = false;
    render();
  }
}

function scheduleThreadsReload() {
  clearTimeout(state.threadsReloadTimer);
  state.threadsReloadTimer = setTimeout(() => {
    void loadThreads().catch((error) => {
      setConnectionStatus(error.message, "danger");
    });
  }, 500);
}

function connectEvents() {
  if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) {
    return;
  }

  clearTimeout(state.socketRetryTimer);
  setConnectionStatus("Connecting", "idle");

  const socket = new WebSocket(websocketUrl("/events"));
  state.socket = socket;

  socket.addEventListener("open", () => {
    if (state.socket === socket) {
      setConnectionStatus("Connected", "ok");
    }
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      return;
    }

    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    const method = cleanString(payload.message?.method);
    const params = payload.message?.params || {};
    const threadId = String(params.threadId || params.thread?.id || "");

    if (threadId && !state.selectedThreadId) {
      state.selectedThreadId = threadId;
      localStorage.setItem(STORAGE_KEYS.threadId, threadId);
      syncChatFrame();
    }

    if (payload.type === "notification" && (method.startsWith("thread/") || method === "turn/completed" || method === "turn/aborted")) {
      scheduleThreadsReload();
    }
  });

  socket.addEventListener("close", () => {
    if (state.socket !== socket) {
      return;
    }

    state.socket = null;
    setConnectionStatus("Reconnecting", "warn");
    state.socketRetryTimer = setTimeout(connectEvents, 1000);
  });

  socket.addEventListener("error", () => {
    socket.close();
  });
}

function selectThread(threadId) {
  state.selectedThreadId = String(threadId || "");
  if (state.selectedThreadId) {
    localStorage.setItem(STORAGE_KEYS.threadId, state.selectedThreadId);
  } else {
    localStorage.removeItem(STORAGE_KEYS.threadId);
  }
  render();
}

function bindEvents() {
  syncTheme();

  elements.themeToggle.addEventListener("click", () => {
    syncTheme(saveTheme(nextTheme()));
  });

  elements.sidebarToggleButton.addEventListener("click", () => {
    state.sidebarCollapsed = true;
    localStorage.setItem(STORAGE_KEYS.shellSidebarCollapsed, String(state.sidebarCollapsed));
    syncShellLayout();
  });

  elements.sidebarExpandButton.addEventListener("click", () => {
    state.sidebarCollapsed = false;
    localStorage.setItem(STORAGE_KEYS.shellSidebarCollapsed, String(state.sidebarCollapsed));
    syncShellLayout();
  });

  elements.conversationDensityButton.addEventListener("click", () => {
    state.conversationListMode = state.conversationListMode === "compact" ? "comfortable" : "compact";
    localStorage.setItem(STORAGE_KEYS.shellConversationListMode, state.conversationListMode);
    syncConversationDensity();
  });

  elements.projectSelect.addEventListener("change", async () => {
    state.selectedProjectId = elements.projectSelect.value;
    localStorage.setItem(STORAGE_KEYS.projectId, state.selectedProjectId);
    selectThread("");
    await loadThreads({ autoSelect: true });
  });

  elements.refreshButton.addEventListener("click", () => {
    void loadBoot()
      .then(() => loadThreads({ autoSelect: Boolean(selectedThread()) }))
      .catch((error) => setConnectionStatus(error.message, "danger"));
  });

  elements.newThreadButton.addEventListener("click", () => {
    selectThread("");
    elements.chatFrame.focus();
  });

  elements.conversationList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action='select-thread']");
    if (!button) {
      return;
    }

    const threadId = button.dataset.id || "";
    if (!threadId || threadId === state.selectedThreadId) {
      return;
    }

    selectThread(threadId);
  });

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin || event.data?.source !== "new-app-chat") {
      return;
    }

    if (event.data.type === "theme-changed") {
      syncTheme(event.data.theme);
      return;
    }

    if (event.data.type === "thread-selected") {
      selectThread(event.data.threadId);
      scheduleThreadsReload();
    }
    if (event.data.type === "threads-changed") {
      scheduleThreadsReload();
    }
  });

  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEYS.theme) {
      syncTheme(event.newValue);
    }
  });
}

async function start() {
  bindEvents();

  try {
    await loadBoot();
    await loadThreads({ autoSelect: true });
    connectEvents();
  } catch (error) {
    setConnectionStatus("Boot failed", "danger");
    elements.conversationList.innerHTML = `<div class="conversation-empty">${escapeHtml(error.message)}</div>`;
  }
}

void start();
