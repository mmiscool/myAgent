import "./styles.css";
import { marked } from "marked";
import { RemoteXBrowserClient } from "../packages/browser-client/index.mjs";

marked.setOptions({
  gfm: true,
  breaks: true,
});

const state = {
  app: null,
  projects: [],
  models: [],
  threads: [],
  projectThreads: {},
  selectedProjectId: localStorage.getItem("selectedProjectId") || "",
  selectedThreadId: localStorage.getItem("selectedThreadId") || "",
  selectedThread: null,
  archived: false,
  expandedProjectIds: new Set(),
  currentTurnId: "",
  activeThreadTab: localStorage.getItem("activeThreadTab") || "chat",
  threadActionMenuOpen: false,
  composerMenuOpen: "",
  autoscroll: localStorage.getItem("autoscroll") !== "false",
  sidebarWidth: Number(localStorage.getItem("sidebarWidth")) || 305,
  composerModel: localStorage.getItem("composerModel") || "",
  composerEffort: localStorage.getItem("composerEffort") || "",
  composerServiceTier: localStorage.getItem("composerServiceTier") || "flex",
  composerMode: localStorage.getItem("composerMode") || "default",
  composerAttachments: [],
  desktopSessionByThreadId: {},
  desktopClient: null,
  desktopConnectInFlight: false,
  imageEditor: createImageEditorState(),
};

const elements = {
  layout: document.getElementById("appLayout"),
  sidebarResizeHandle: document.getElementById("sidebarResizeHandle"),
  projectList: document.getElementById("projectList"),
  projectQuickAddForm: document.getElementById("projectQuickAddForm"),
  projectPathInput: document.getElementById("projectPathInput"),
  archivedToggle: document.getElementById("archivedToggle"),
  threadHeader: document.getElementById("threadHeader"),
  conversation: document.getElementById("conversation"),
  threadDesktop: document.getElementById("threadDesktop"),
  threadDesktopStatus: document.getElementById("threadDesktopStatus"),
  threadDesktopFrameRate: document.getElementById("threadDesktopFrameRate"),
  threadDesktopScale: document.getElementById("threadDesktopScale"),
  threadDesktopScreenshot: document.getElementById("threadDesktopScreenshot"),
  threadDesktopStop: document.getElementById("threadDesktopStop"),
  threadDesktopCanvas: document.getElementById("threadDesktopCanvas"),
  composerForm: document.getElementById("composerForm"),
  autoscrollToggle: document.getElementById("autoscrollToggle"),
  composerAttachments: document.getElementById("composerAttachments"),
  promptInput: document.getElementById("promptInput"),
  composerModelButton: document.getElementById("composerModelButton"),
  composerModelLabel: document.getElementById("composerModelLabel"),
  composerModelMenu: document.getElementById("composerModelMenu"),
  composerEffortButton: document.getElementById("composerEffortButton"),
  composerEffortLabel: document.getElementById("composerEffortLabel"),
  composerEffortMenu: document.getElementById("composerEffortMenu"),
  composerModeButton: document.getElementById("composerModeButton"),
  imageEditorModal: document.getElementById("imageEditorModal"),
  imageEditorCanvasWrap: document.getElementById("imageEditorCanvasWrap"),
  imageEditorPreviewImage: document.getElementById("imageEditorPreviewImage"),
  imageEditorOverlayCanvas: document.getElementById("imageEditorOverlayCanvas"),
  imageEditorColor: document.getElementById("imageEditorColor"),
};

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const SUMMARIES = ["auto", "concise", "detailed", "none"];
const PERSONALITIES = ["none", "friendly", "pragmatic"];
const APPROVALS = ["untrusted", "on-failure", "on-request", "never"];
const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 560;
const DEFAULT_VISIBLE_THREADS = 6;
const COMPOSER_DRAFT_STORAGE_KEY = "composerDraft";
let desktopResizeObserver = null;
let desktopResizeTimer = null;
let conversationSocket = null;
let conversationSocketRetryTimer = null;
let conversationSocketShouldReconnect = true;
let sidebarResizeState = null;

boot().catch(showFatalError);

async function boot() {
  applySidebarWidth();
  await loadBoot();
  normalizeComposerSettings();
  elements.autoscrollToggle.checked = state.autoscroll;
  restoreComposerDraft();
  renderComposerControls();
  renderProjects();
  renderThreadHeader();
  renderConversation();
  renderThreadPane();

  connectEvents();

  await loadAllProjectThreads();
  renderProjects();

  if (state.selectedThreadId) {
    await loadThread(state.selectedThreadId);
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json();

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }

  return payload;
}

async function loadBoot() {
  const payload = await api("/api/boot");
  state.app = payload.app;
  state.projects = payload.projects;
  state.models = payload.models?.data || [];
  if (!state.selectedProjectId || !state.projects.some((project) => project.id === state.selectedProjectId)) {
    state.selectedProjectId = state.projects[0]?.id || "";
    persistSelection();
  }
}

function persistComposerSettings() {
  localStorage.setItem("composerModel", state.composerModel || "");
  localStorage.setItem("composerEffort", state.composerEffort || "");
  localStorage.setItem("composerServiceTier", state.composerServiceTier || "flex");
  localStorage.setItem("composerMode", state.composerMode || "default");
}

function currentComposerModel() {
  return state.models.find((model) => model.id === state.composerModel) || null;
}

function currentProjectDefaultModel() {
  const project = selectedProject();
  if (!project?.defaultModel) {
    return null;
  }

  return state.models.find((model) => model.id === project.defaultModel) || null;
}

function fallbackComposerModel() {
  return currentProjectDefaultModel()
    || state.models.find((model) => model.isDefault)
    || state.models[0]
    || null;
}

function supportedEffortsForModel(model) {
  const efforts = model?.supportedReasoningEfforts?.map((entry) => entry.reasoningEffort).filter(Boolean) || [];
  return efforts.length ? efforts : EFFORTS.slice();
}

function normalizeComposerSettings() {
  const model = currentComposerModel() || fallbackComposerModel();
  state.composerModel = model?.id || "";

  const supportedEfforts = supportedEffortsForModel(model);
  if (!supportedEfforts.includes(state.composerEffort)) {
    state.composerEffort = model?.defaultReasoningEffort || supportedEfforts[0] || "medium";
  }

  if (!["default", "plan"].includes(state.composerMode)) {
    state.composerMode = "default";
  }

  if (!["flex", "fast"].includes(state.composerServiceTier)) {
    state.composerServiceTier = "flex";
  }

  persistComposerSettings();
}

function formatEffortLabel(effort) {
  if (effort === "xhigh") {
    return "Extra High";
  }

  if (effort === "high") {
    return "High";
  }

  if (effort === "medium") {
    return "Medium";
  }

  if (effort === "low") {
    return "Low";
  }

  if (effort === "minimal") {
    return "Minimal";
  }

  if (effort === "none") {
    return "None";
  }

  return effort;
}

function renderComposerControls() {
  normalizeComposerSettings();

  const model = currentComposerModel();
  const supportedEfforts = supportedEffortsForModel(model);
  elements.composerModelLabel.textContent = model?.displayName || model?.id || "Select Model";
  elements.composerEffortLabel.textContent = formatEffortLabel(state.composerEffort);

  elements.composerModelMenu.innerHTML = state.models.map((entry) => `
    <button
      type="button"
      class="composer-picker-item${entry.id === state.composerModel ? " active" : ""}"
      data-action="select-composer-model"
      data-value="${escapeHtml(entry.id)}"
      role="option"
      aria-selected="${entry.id === state.composerModel ? "true" : "false"}"
    >
      <span class="composer-picker-check" aria-hidden="true">${entry.id === state.composerModel ? "✓" : ""}</span>
      <span class="composer-picker-item-label">${escapeHtml(entry.displayName || entry.id)}</span>
    </button>
  `).join("");

  elements.composerEffortMenu.innerHTML = supportedEfforts.map((effort) => `
    <button
      type="button"
      class="composer-picker-item${effort === state.composerEffort ? " active" : ""}"
      data-action="select-composer-effort"
      data-value="${escapeHtml(effort)}"
      role="option"
      aria-selected="${effort === state.composerEffort ? "true" : "false"}"
    >
      <span class="composer-picker-check" aria-hidden="true">${effort === state.composerEffort ? "✓" : ""}</span>
      <span class="composer-picker-item-label">${escapeHtml(formatEffortLabel(effort))}${effort === model?.defaultReasoningEffort ? " (default)" : ""}</span>
    </button>
  `).join("") + `
    <div class="composer-picker-divider" aria-hidden="true"></div>
    <div class="composer-picker-section">Fast Mode</div>
    <button
      type="button"
      class="composer-picker-item${state.composerServiceTier !== "fast" ? " active" : ""}"
      data-action="select-composer-fast-mode"
      data-value="off"
      role="option"
      aria-selected="${state.composerServiceTier !== "fast" ? "true" : "false"}"
    >
      <span class="composer-picker-check" aria-hidden="true">${state.composerServiceTier !== "fast" ? "✓" : ""}</span>
      <span class="composer-picker-item-label">off</span>
    </button>
    <button
      type="button"
      class="composer-picker-item${state.composerServiceTier === "fast" ? " active" : ""}"
      data-action="select-composer-fast-mode"
      data-value="on"
      role="option"
      aria-selected="${state.composerServiceTier === "fast" ? "true" : "false"}"
    >
      <span class="composer-picker-check" aria-hidden="true">${state.composerServiceTier === "fast" ? "✓" : ""}</span>
      <span class="composer-picker-item-label">on</span>
    </button>
  `;

  const modelMenuOpen = state.composerMenuOpen === "model";
  const effortMenuOpen = state.composerMenuOpen === "effort";
  elements.composerModelMenu.classList.toggle("hidden", !modelMenuOpen);
  elements.composerEffortMenu.classList.toggle("hidden", !effortMenuOpen);
  elements.composerModelButton.setAttribute("aria-expanded", modelMenuOpen ? "true" : "false");
  elements.composerEffortButton.setAttribute("aria-expanded", effortMenuOpen ? "true" : "false");

  elements.composerModeButton.textContent = state.composerMode === "plan" ? "Plan" : "Chat";
  elements.composerModeButton.classList.toggle("plan", state.composerMode === "plan");
  elements.composerModeButton.setAttribute("aria-pressed", state.composerMode === "plan" ? "true" : "false");
}

function composerRequestOverrides() {
  const model = currentComposerModel() || fallbackComposerModel();
  const overrides = {
    model: model?.id || undefined,
    effort: state.composerEffort || undefined,
    serviceTier: state.composerServiceTier || undefined,
  };

  if (model?.id) {
    overrides.collaborationMode = {
      mode: state.composerMode === "plan" ? "plan" : "default",
      settings: {
        model: model.id,
        reasoning_effort: state.composerEffort || null,
      },
    };
  }

  return overrides;
}

async function loadThreads() {
  const project = selectedProject();

  if (!project) {
    state.threads = [];
    renderProjects();
    return;
  }

  const payload = await api(`/api/projects/${encodeURIComponent(project.id)}/threads?archived=${state.archived}`);
  state.threads = payload.data?.data || payload.data?.threads || [];
  state.projectThreads[project.id] = state.threads;

  if (state.selectedThreadId && !state.threads.some((thread) => thread.id === state.selectedThreadId)) {
    state.selectedThreadId = "";
    state.selectedThread = null;
    state.currentTurnId = "";
    persistSelection();
  }

  renderProjects();
  renderThreadHeader();
  renderConversation();
  renderComposerControls();
}

async function loadProjectThreads(projectId) {
  const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/threads?archived=${state.archived}`);
  state.projectThreads[projectId] = payload.data?.data || payload.data?.threads || [];

  if (projectId === state.selectedProjectId) {
    state.threads = state.projectThreads[projectId];
    renderComposerControls();
  }
}

async function loadAllProjectThreads() {
  await Promise.all(state.projects.map((project) => loadProjectThreads(project.id).catch(() => {
    state.projectThreads[project.id] = [];
  })));

  state.threads = state.projectThreads[state.selectedProjectId] || [];
}

async function loadThread(threadId) {
  const payload = await api(`/api/threads/${encodeURIComponent(threadId)}`);
  state.selectedThread = payload.data?.thread || payload.data;
  state.selectedThreadId = state.selectedThread?.id || threadId;
  state.currentTurnId = findLatestTurnId(state.selectedThread);
  renderComposerControls();
  persistSelection();
  renderProjects();
  renderThreadHeader();
  renderConversation();
  renderThreadPane();
  if (state.activeThreadTab === "desktop") {
    await ensureThreadDesktop();
  }
}

function renderSelectedThread() {
  state.currentTurnId = findLatestTurnId(state.selectedThread);
  renderComposerControls();
  persistSelection();
  renderProjects();
  renderThreadHeader();
  renderConversation();
  renderThreadPane();
}

function syncThreadSummary(thread) {
  if (!thread?.id) {
    return;
  }

  const now = Math.floor(Date.now() / 1000);

  Object.keys(state.projectThreads).forEach((projectId) => {
    const threads = state.projectThreads[projectId];
    if (!Array.isArray(threads)) {
      return;
    }

    const index = threads.findIndex((entry) => entry.id === thread.id);
    if (index === -1) {
      return;
    }

    threads[index] = {
      ...threads[index],
      ...thread,
      updatedAt: thread.updatedAt || now,
      preview: thread.preview || thread.name || latestAgentMessageText(thread) || threads[index].preview,
    };
  });

  if (state.selectedThreadId === thread.id && state.selectedProjectId && Array.isArray(state.projectThreads[state.selectedProjectId])) {
    state.threads = state.projectThreads[state.selectedProjectId];
  }
}

function ensureSelectedTurn(turnId, initialStatus = "inProgress") {
  if (!state.selectedThread || !turnId) {
    return null;
  }

  state.selectedThread.turns = Array.isArray(state.selectedThread.turns) ? state.selectedThread.turns : [];
  let turn = state.selectedThread.turns.find((entry) => entry.id === turnId);

  if (!turn) {
    turn = { id: turnId, status: initialStatus, items: [] };
    state.selectedThread.turns = state.selectedThread.turns.concat(turn);
  }

  turn.items = Array.isArray(turn.items) ? turn.items : [];
  if (initialStatus && !turn.status) {
    turn.status = initialStatus;
  }

  return turn;
}

function ensureTurnItem(turn, itemOrId, fallbackType = "agentMessage") {
  if (!turn) {
    return null;
  }

  const item = typeof itemOrId === "string"
    ? { id: itemOrId, type: fallbackType }
    : itemOrId;

  if (!item?.id) {
    return null;
  }

  let existing = turn.items.find((entry) => entry.id === item.id);
  if (!existing) {
    existing = { ...item };
    turn.items = turn.items.concat(existing);
    return existing;
  }

  Object.assign(existing, item);
  return existing;
}

function appendIndexedDelta(target, key, index, delta) {
  if (!target || !key || !Number.isInteger(index) || index < 0 || typeof delta !== "string") {
    return;
  }

  const values = Array.isArray(target[key]) ? target[key].slice() : [];
  while (values.length <= index) {
    values.push("");
  }
  values[index] = `${values[index] || ""}${delta}`;
  target[key] = values;
}

function latestAgentMessageText(thread) {
  const turns = thread?.turns || [];

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = turns[turnIndex]?.items || [];

    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (item?.type === "agentMessage" && item.text) {
        return item.text;
      }
    }
  }

  return "";
}

function applyStreamingNotification(message) {
  const method = typeof message?.method === "string" ? message.method : "";
  const params = message?.params || {};
  const threadId = params.threadId || params.thread?.id;

  if (!method || !threadId || threadId !== state.selectedThreadId || !state.selectedThread) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  state.selectedThread.updatedAt = now;

  if (method === "turn/started") {
    const turn = params.turn || {};
    ensureSelectedTurn(turn.id, turn.status || "inProgress");
    if (turn.id) {
      state.currentTurnId = turn.id;
    }
    state.selectedThread.status = "inProgress";
    syncThreadSummary(state.selectedThread);
    renderSelectedThread();
    return true;
  }

  if (method === "turn/completed") {
    const completedTurn = params.turn || {};
    const turn = ensureSelectedTurn(completedTurn.id, completedTurn.status || "completed");
    if (turn) {
      Object.assign(turn, completedTurn, {
        items: Array.isArray(turn.items) ? turn.items : [],
      });
    }
    state.selectedThread.status = completedTurn.status || state.selectedThread.status || "completed";
    syncThreadSummary(state.selectedThread);
    renderSelectedThread();
    return true;
  }

  if (method === "item/started" || method === "item/completed") {
    const turn = ensureSelectedTurn(params.turnId, "inProgress");
    const item = ensureTurnItem(turn, params.item);
    if (!item) {
      return false;
    }

    if (method === "item/completed" && turn) {
      turn.status = turn.status === "completed" ? turn.status : "inProgress";
    }

    syncThreadSummary(state.selectedThread);
    renderSelectedThread();
    return true;
  }

  const turn = ensureSelectedTurn(params.turnId, "inProgress");
  if (!turn) {
    return false;
  }

  if (method === "item/agentMessage/delta") {
    const item = ensureTurnItem(turn, {
      id: params.itemId,
      type: "agentMessage",
      text: "",
    });
    item.text = `${item.text || ""}${params.delta || ""}`;
    syncThreadSummary(state.selectedThread);
    renderSelectedThread();
    return true;
  }

  if (method === "item/commandExecution/outputDelta") {
    const item = ensureTurnItem(turn, {
      id: params.itemId,
      type: "commandExecution",
      command: "",
      commandActions: [],
      cwd: state.selectedThread.cwd || "",
      status: "inProgress",
      aggregatedOutput: "",
    });
    item.aggregatedOutput = `${item.aggregatedOutput || ""}${params.delta || ""}`;
    renderSelectedThread();
    return true;
  }

  if (method === "item/reasoning/textDelta") {
    const item = ensureTurnItem(turn, {
      id: params.itemId,
      type: "reasoning",
      content: [],
      summary: [],
    });
    appendIndexedDelta(item, "content", params.contentIndex, params.delta || "");
    renderSelectedThread();
    return true;
  }

  if (method === "item/reasoning/summaryTextDelta") {
    const item = ensureTurnItem(turn, {
      id: params.itemId,
      type: "reasoning",
      content: [],
      summary: [],
    });
    appendIndexedDelta(item, "summary", params.summaryIndex, params.delta || "");
    renderSelectedThread();
    return true;
  }

  if (method === "item/reasoning/summaryPartAdded") {
    const item = ensureTurnItem(turn, {
      id: params.itemId,
      type: "reasoning",
      content: [],
      summary: [],
    });
    appendIndexedDelta(item, "summary", params.summaryIndex, "");
    renderSelectedThread();
    return true;
  }

  if (method === "item/plan/delta") {
    const item = ensureTurnItem(turn, {
      id: params.itemId,
      type: "plan",
      text: "",
    });
    item.text = `${item.text || ""}${params.delta || ""}`;
    renderSelectedThread();
    return true;
  }

  if (method === "thread/status/changed" && params.status) {
    state.selectedThread.status = params.status;
    syncThreadSummary(state.selectedThread);
    renderSelectedThread();
    return true;
  }

  if (method === "thread/name/updated") {
    state.selectedThread.name = params.threadName || state.selectedThread.name;
    syncThreadSummary(state.selectedThread);
    renderSelectedThread();
    return true;
  }

  return false;
}

function persistSelection() {
  localStorage.setItem("selectedProjectId", state.selectedProjectId || "");
  localStorage.setItem("selectedThreadId", state.selectedThreadId || "");
  localStorage.setItem("activeThreadTab", state.activeThreadTab || "chat");
  localStorage.setItem("autoscroll", String(state.autoscroll));
  localStorage.setItem("sidebarWidth", String(state.sidebarWidth));
  persistComposerSettings();
}

function restoreComposerDraft() {
  elements.promptInput.value = localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY) || "";
}

function persistComposerDraft() {
  localStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, elements.promptInput.value || "");
}

function clearComposerDraft() {
  localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
}

function selectedProject() {
  return state.projects.find((project) => project.id === state.selectedProjectId) || null;
}

function optionHtml(value, label) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
}

function renderThreadActionMenu() {
  const menuExpanded = state.threadActionMenuOpen ? "true" : "false";
  const menuItem = (action, label, icon, extraClass = "") => `
    <button class="thread-menu-item${extraClass ? ` ${extraClass}` : ""}" data-action="${action}" role="menuitem">
      <span class="thread-menu-icon" aria-hidden="true">${icon}</span>
      <span class="thread-menu-label">${label}</span>
    </button>
  `;

  if (!state.selectedThread) {
    return `
      <div class="thread-action-menu">
        <button
          type="button"
          class="thread-menu-trigger"
          data-action="toggle-thread-action-menu"
          aria-haspopup="menu"
          aria-expanded="${menuExpanded}"
          aria-label="Open thread actions"
          title="Thread actions"
        >☰</button>
        <div class="thread-menu-popover ${state.threadActionMenuOpen ? "" : "hidden"}" role="menu" aria-label="Thread actions">
          ${menuItem("new-thread", "New Thread", "+")}
          ${menuItem("refresh-threads", "Refresh", "↻")}
        </div>
      </div>
    `;
  }

  return `
    <div class="thread-action-menu">
      <button
        type="button"
        class="thread-menu-trigger"
        data-action="toggle-thread-action-menu"
        aria-haspopup="menu"
        aria-expanded="${menuExpanded}"
        aria-label="Open thread actions"
        title="Thread actions"
      >☰</button>
      <div class="thread-menu-popover ${state.threadActionMenuOpen ? "" : "hidden"}" role="menu" aria-label="Thread actions">
        ${menuItem("new-thread", "New Thread", "+")}
        ${menuItem("refresh-threads", "Refresh", "↻")}
        ${menuItem("rename-thread", "Rename", "✎")}
        ${menuItem("fork-thread", "Fork", "⑂")}
        ${menuItem("compact-thread", "Compact", "⇲")}
        ${menuItem("review-thread", "Review", "◌")}
        ${menuItem("interrupt-thread", "Interrupt", "■")}
        ${menuItem(state.archived ? "unarchive-thread" : "archive-thread", state.archived ? "Unarchive" : "Archive", "⌫", "danger")}
      </div>
    </div>
  `;
}

function renderProjects() {
  elements.archivedToggle.textContent = state.archived ? "Archived" : "Active";
  elements.archivedToggle.setAttribute("aria-pressed", state.archived ? "true" : "false");
  elements.archivedToggle.setAttribute(
    "aria-label",
    state.archived ? "Viewing archived conversations" : "Viewing active conversations",
  );
  elements.archivedToggle.title = state.archived ? "Viewing archived conversations" : "Viewing active conversations";
  elements.archivedToggle.classList.toggle("is-active", state.archived);

  if (state.projects.length === 0) {
    elements.projectList.innerHTML = `<div class="empty">No projects yet.</div>`;
    return;
  }

  elements.projectList.innerHTML = state.projects.map((project) => {
    const threads = state.projectThreads[project.id] || [];
    const collapsedVisibleCount = collapsedVisibleThreadCount(threads);
    const expanded = state.expandedProjectIds.has(project.id);
    const visibleThreads = expanded ? threads : threads.slice(0, collapsedVisibleCount);
    const moreCount = Math.max(0, threads.length - collapsedVisibleCount);

    return `
      <section class="project-node ${project.id === state.selectedProjectId ? "active" : ""}">
        ${project.id === state.selectedProjectId ? `
          <div class="project-row project-row-with-menu">
            <button class="project-row-main" data-action="select-project" data-id="${escapeHtml(project.id)}">
              <span class="project-caret">⌄</span>
              <span class="project-folder">□</span>
              <span class="project-name">${escapeHtml(project.name)}</span>
            </button>
            <button
              type="button"
              class="project-row-new-thread"
              data-action="new-thread"
              aria-label="New thread"
              title="New Thread"
            >+</button>
          </div>
        ` : `
          <button class="project-row" data-action="select-project" data-id="${escapeHtml(project.id)}">
            <span class="project-caret">⌄</span>
            <span class="project-folder">□</span>
            <span class="project-name">${escapeHtml(project.name)}</span>
          </button>
        `}
        <div class="conversation-stack">
          ${visibleThreads.length ? visibleThreads.map((thread) => {
            const preview = (thread.preview || thread.name || "New conversation").replace(/\s+/g, " ").trim();
            const timeText = relativeTime(thread.updatedAt || thread.createdAt);
            const selectedClass = thread.id === state.selectedThreadId ? "selected" : "";
            const activity = describeThreadActivity(thread);
            return `
              <button class="conversation-row ${selectedClass}" data-action="select-thread" data-project-id="${escapeHtml(project.id)}" data-id="${escapeHtml(thread.id)}">
                <span class="conversation-title-wrap">
                  <span class="conversation-title">${escapeHtml(preview)}</span>
                  ${activity.isWorking ? renderActivityBadge(activity.label, activity.statusText, "small") : ""}
                </span>
                <span class="conversation-time">${escapeHtml(timeText)}</span>
              </button>
            `;
          }).join("") : `<div class="conversation-empty">No conversations yet</div>`}
          ${moreCount > 0 ? `
            <button
              type="button"
              class="conversation-more-button"
              data-action="toggle-project-threads"
              data-project-id="${escapeHtml(project.id)}"
              aria-expanded="${expanded ? "true" : "false"}"
            >${expanded ? "Show less" : `Show ${moreCount} more`}</button>
          ` : ""}
        </div>
      </section>
    `;
  }).join("");
}

function collapsedVisibleThreadCount(threads) {
  if (!Array.isArray(threads) || threads.length === 0) {
    return 0;
  }

  const selectedIndex = threads.findIndex((thread) => thread.id === state.selectedThreadId);
  const requiredVisibleCount = selectedIndex >= 0 ? selectedIndex + 1 : DEFAULT_VISIBLE_THREADS;
  return Math.min(threads.length, Math.max(DEFAULT_VISIBLE_THREADS, requiredVisibleCount));
}

function renderThreadHeader() {
  const thread = state.selectedThread;
  const project = selectedProject();

  if (!thread) {
    elements.threadHeader.innerHTML = `
      <div class="thread-toolbar-controls">
        <div class="thread-toolbar-top">
          <div class="thread-tabbar" role="tablist" aria-label="Thread view">
            <button
              class="thread-tab ${state.activeThreadTab === "chat" ? "active" : ""}"
              data-action="select-thread-tab"
              data-tab="chat"
              role="tab"
              aria-selected="${state.activeThreadTab === "chat" ? "true" : "false"}"
            >Chat</button>
            <button
              class="thread-tab ${state.activeThreadTab === "desktop" ? "active" : ""}"
              data-action="select-thread-tab"
              data-tab="desktop"
              role="tab"
              aria-selected="${state.activeThreadTab === "desktop" ? "true" : "false"}"
            >Virtual Desktop</button>
          </div>
          ${renderThreadActionMenu()}
        </div>
      </div>
      <div class="thread-toolbar">
        <div class="thread-title-wrap">
          <h2 class="thread-title" title="${escapeHtml(project?.name || "No project selected")}">${escapeHtml(project?.name || "No project selected")}</h2>
          <p class="meta">Start a new conversation below. The first prompt creates the thread.</p>
        </div>
      </div>
    `;
    return;
  }

  const activity = describeThreadActivity(thread);
  const threadStatusText = activity.statusText || formatStatus(thread.status);

  elements.threadHeader.innerHTML = `
    <div class="thread-toolbar-controls">
      <div class="thread-toolbar-top">
        <div class="thread-tabbar" role="tablist" aria-label="Thread view">
          <button
            class="thread-tab ${state.activeThreadTab === "chat" ? "active" : ""}"
            data-action="select-thread-tab"
            data-tab="chat"
            role="tab"
            aria-selected="${state.activeThreadTab === "chat" ? "true" : "false"}"
          >Chat</button>
          <button
            class="thread-tab ${state.activeThreadTab === "desktop" ? "active" : ""}"
            data-action="select-thread-tab"
            data-tab="desktop"
            role="tab"
            aria-selected="${state.activeThreadTab === "desktop" ? "true" : "false"}"
          >Virtual Desktop</button>
        </div>
        ${renderThreadActionMenu()}
      </div>
    </div>
    <div class="thread-toolbar">
      <div class="thread-title-wrap">
        <h2 class="thread-title" title="${escapeHtml(thread.name || thread.preview || "Untitled thread")}">${escapeHtml(thread.name || thread.preview || "Untitled thread")}</h2>
        <div class="meta thread-meta">
          <span>${escapeHtml(selectedProject()?.name || "")}</span>
          <span>·</span>
          ${renderActivityBadge(activity.isWorking ? activity.label : threadStatusText, threadStatusText, activity.isWorking ? "live" : "idle")}
          <span>·</span>
          <span>${escapeHtml(thread.cwd || "")}</span>
        </div>
      </div>
    </div>
  `;
}

function renderThreadPane() {
  const desktopVisible = state.activeThreadTab === "desktop" && Boolean(state.selectedThreadId);
  elements.conversation.classList.toggle("hidden", desktopVisible);
  elements.composerForm.classList.toggle("hidden", desktopVisible);
  elements.threadDesktop.classList.toggle("hidden", !desktopVisible);
  elements.threadDesktop.setAttribute("aria-hidden", desktopVisible ? "false" : "true");
  syncDesktopInputBinding();

  if (!desktopVisible) {
    return;
  }

  if (!state.selectedThread) {
    elements.threadDesktopStatus.textContent = "Start a conversation first.";
    return;
  }

  const session = state.desktopSessionByThreadId[state.selectedThread.id];
  if (!session) {
    elements.threadDesktopStatus.textContent = "Starting virtual desktop...";
    return;
  }

  elements.threadDesktopFrameRate.value = String(session.frameRate || 30);

  const status = state.desktopClient?.client?.getState?.();
  if (status?.authenticated) {
    elements.threadDesktopStatus.textContent = `${session.state.width}x${session.state.height} · live`;
  } else {
    elements.threadDesktopStatus.textContent = `${session.state.displayName} · connecting`;
  }
}

function syncDesktopInputBinding() {
  const client = state.desktopClient?.client;

  if (!client) {
    return;
  }

  if (state.activeThreadTab === "desktop" && state.selectedThreadId === state.desktopClient.threadId) {
    client.attachInput(elements.threadDesktopCanvas);
    return;
  }

  client.detachInput();
}

function renderConversation() {
  const thread = state.selectedThread;

  if (!thread?.turns?.length) {
    elements.conversation.innerHTML = `<div class="empty">No turns yet.</div>`;
    scrollConversationToBottom();
    return;
  }

  const activity = describeThreadActivity(thread);
  const activityBanner = activity.isWorking ? `
    <section class="conversation-activity-banner" aria-live="polite">
      ${renderActivityBadge(activity.label, activity.statusText, "live")}
      <span>Conversation is actively working.</span>
    </section>
  ` : "";

  elements.conversation.innerHTML = `${activityBanner}${thread.turns.map((turn) => {
    const items = (turn.items || []).map(renderItem).join("");
    const turnWorking = isLiveStatus(turn.status);

    return `
      <section class="turn-card">
        <div class="turn-topline">
          <span>${escapeHtml(turn.id)}</span>
          <span class="turn-status-wrap">
            ${turnWorking ? renderActivityBadge(describeStatusActivity(turn.status), formatStatus(turn.status), "small") : ""}
            <span class="${turnWorking ? "status-live" : ""}">${escapeHtml(formatStatus(turn.status))}</span>
          </span>
        </div>
        ${items || `<div class="empty">No items recorded for this turn.</div>`}
        ${turn.error ? `<div class="bubble agent"><strong>Error</strong><div class="message-body"><pre>${escapeHtml(JSON.stringify(turn.error, null, 2))}</pre></div></div>` : ""}
      </section>
    `;
  }).join("")}`;

  scrollConversationToBottom();
}

function scrollConversationToBottom() {
  if (!state.autoscroll) {
    return;
  }

  requestAnimationFrame(() => {
    elements.conversation.scrollTop = elements.conversation.scrollHeight;
  });
}

function renderComposerAttachments() {
  const items = state.composerAttachments;

  if (!items.length) {
    elements.composerAttachments.innerHTML = "";
    elements.composerAttachments.classList.add("hidden");
    return;
  }

  elements.composerAttachments.classList.remove("hidden");
  elements.composerAttachments.innerHTML = items.map((attachment) => `
    <figure class="composer-attachment">
      <button
        type="button"
        class="composer-attachment-preview"
        data-action="open-composer-attachment"
        data-id="${escapeHtml(attachment.id)}"
        title="${escapeHtml(attachment.name || "Pasted image")}"
      >
        <img src="${escapeHtml(attachment.url)}" alt="${escapeHtml(attachment.name || "Pasted image")}" class="composer-attachment-image">
      </button>
      <button
        type="button"
        class="composer-attachment-remove"
        data-action="remove-composer-attachment"
        data-id="${escapeHtml(attachment.id)}"
        title="Remove image"
        aria-label="Remove image"
      >
        ×
      </button>
    </figure>
  `).join("");
}

function renderItem(item) {
  if (item.type === "userMessage") {
    return `<article class="bubble user"><strong>User</strong><div class="message-body">${renderMessageContent(item.content, item.text || "")}</div></article>`;
  }

  if (item.type === "agentMessage") {
    return `<article class="bubble agent"><strong>Agent</strong><div class="message-body">${renderMessageContent(item.content, item.text || "")}</div></article>`;
  }

  if (item.type === "plan") {
    return renderCollapsibleItem("Plan", oneLine(item.text || "Plan update"), escapeHtml(item.text || ""));
  }

  if (item.type === "reasoning") {
    const summary = oneLine((item.summary || []).join(" ")) || oneLine((item.content || []).join(" ")) || "Reasoning";
    const details = [
      (item.summary || []).length ? `Summary\n${(item.summary || []).join("\n")}` : "",
      (item.content || []).length ? `\nContent\n${(item.content || []).join("\n")}` : "",
    ].filter(Boolean).join("\n");
    return renderCollapsibleItem("Reasoning", summary, escapeHtml(details || summary));
  }

  if (item.type === "commandExecution") {
    const summary = oneLine(item.command || "Command");
    const meta = `${formatStatus(item.status)}${item.exitCode != null ? ` · exit ${item.exitCode}` : ""}`;
    const details = [item.command || "", meta, item.aggregatedOutput || ""].filter(Boolean).join("\n");
    return renderCollapsibleItem("Command", summary, escapeHtml(details), meta);
  }

  if (item.type === "fileChange") {
    const changes = (item.changes || []).map((change) => `
      <details>
        <summary>${escapeHtml(change.kind || "change")} · ${escapeHtml(change.path || "")}</summary>
        <pre class="diff-block">${escapeHtml(change.diff || "")}</pre>
      </details>
    `).join("");

    const summary = `${item.changes?.length || 0} file ${item.changes?.length === 1 ? "change" : "changes"}`;
    return `
      <article class="bubble agent collapsed-item">
        <details>
          <summary class="collapsed-summary">
            <span class="collapsed-title">File Changes</span>
            <span class="collapsed-text">${escapeHtml(summary)}</span>
          </summary>
          <div class="collapsed-body">${changes}</div>
        </details>
      </article>
    `;
  }

  if (item.type === "mcpToolCall") {
    const summary = `${item.server || "mcp"} · ${item.tool || "tool"}`;
    const details = JSON.stringify(item, null, 2);
    return renderCollapsibleItem("MCP Tool", summary, escapeHtml(details), formatStatus(item.status));
  }

  if (item.type === "dynamicToolCall") {
    const summary = item.tool || "dynamic tool";
    const details = JSON.stringify(item, null, 2);
    return renderCollapsibleItem("Tool Call", summary, escapeHtml(details), formatStatus(item.status));
  }

  if (item.type === "collabAgentToolCall") {
    const summary = `${item.tool || "agent tool"}${item.model ? ` · ${item.model}` : ""}`;
    const details = JSON.stringify(item, null, 2);
    return renderCollapsibleItem("Collaboration", summary, escapeHtml(details), formatStatus(item.status));
  }

  return renderCollapsibleItem(item.type, oneLine(JSON.stringify(item)), escapeHtml(JSON.stringify(item, null, 2)));
}

function renderCollapsibleItem(title, summary, body, meta = "") {
  return `
    <article class="bubble agent collapsed-item">
      <details>
        <summary class="collapsed-summary">
          <span class="collapsed-title">${escapeHtml(title)}</span>
          <span class="collapsed-text">${escapeHtml(summary || title)}</span>
          ${meta ? `<span class="collapsed-meta">${escapeHtml(meta)}</span>` : ""}
        </summary>
        <div class="collapsed-body">
          <pre>${body}</pre>
        </div>
      </details>
    </article>
  `;
}

function renderMarkdown(text) {
  return marked.parse(String(text || ""));
}

function renderMessageContent(items, fallbackText = "") {
  if (!Array.isArray(items) || items.length === 0) {
    return renderMarkdown(fallbackText || "");
  }

  return items.map((entry) => renderContentEntry(entry)).join("");
}

function renderContentEntry(entry) {
  if (typeof entry === "string") {
    return renderMarkdown(entry);
  }

  if (!entry || typeof entry !== "object") {
    return "";
  }

  if (entry.type === "text") {
    return renderMarkdown(entry.text || "");
  }

  const imageUrl = entry.url || entry.imageUrl || entry.image_url || entry.data;

  if ((entry.type === "image" || entry.type === "local_image" || entry.type === "localImage") && imageUrl) {
    return `
      <figure class="message-image-wrap">
        <img class="message-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(entry.alt || entry.name || "Attached image")}">
      </figure>
    `;
  }

  return `<pre>${escapeHtml(`[${entry.type || "content"}] ${entry.path || imageUrl || entry.name || ""}`)}</pre>`;
}

function connectEvents() {
  connectConversationSocket();
  window.addEventListener("beforeunload", disconnectConversationSocket);
  elements.sidebarResizeHandle.addEventListener("pointerdown", startSidebarResize);
  elements.sidebarResizeHandle.addEventListener("keydown", handleSidebarResizeKeydown);
  window.addEventListener("pointermove", handleSidebarResizePointerMove);
  window.addEventListener("pointerup", stopSidebarResize);
  window.addEventListener("pointercancel", stopSidebarResize);

  elements.promptInput.addEventListener("paste", handleComposerPaste);
  elements.promptInput.addEventListener("input", () => {
    persistComposerDraft();
  });
  elements.autoscrollToggle.addEventListener("change", (event) => {
    state.autoscroll = event.target.checked;
    persistSelection();
    if (state.autoscroll) {
      scrollConversationToBottom();
    }
  });
  elements.imageEditorOverlayCanvas.addEventListener("pointerdown", handleImageEditorPointerDown);
  elements.imageEditorOverlayCanvas.addEventListener("pointermove", handleImageEditorPointerMove);
  elements.imageEditorOverlayCanvas.addEventListener("dblclick", handleImageEditorDoubleClick);
  window.addEventListener("pointerup", handleImageEditorPointerUp);
  window.addEventListener("resize", () => {
    if (window.innerWidth > 980) {
      applySidebarWidth();
    }

    if (state.imageEditor.open) {
      layoutImageEditorCanvas();
      renderImageEditor();
    }
  });
  elements.imageEditorColor.addEventListener("input", (event) => {
    state.imageEditor.color = event.target.value;
    if (state.imageEditor.selectedShapeId) {
      const shape = findSelectedEditorShape();
      if (shape) {
        shape.color = state.imageEditor.color;
        renderImageEditor();
      }
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.threadActionMenuOpen) {
      state.threadActionMenuOpen = false;
      renderThreadHeader();
      return;
    }

    if (event.key === "Escape" && state.composerMenuOpen) {
      state.composerMenuOpen = "";
      renderComposerControls();
      return;
    }

    if (event.key === "Escape" && state.imageEditor.open) {
      closeImageEditor();
    }
  });

  elements.threadDesktopScale.addEventListener("change", () => {
    scheduleThreadDesktopResize();
  });

  elements.threadDesktopFrameRate.addEventListener("change", () => {
    void updateThreadDesktopFrameRate();
  });

  elements.threadDesktopScreenshot.addEventListener("click", () => {
    void captureThreadDesktopScreenshot();
  });

  elements.threadDesktopStop.addEventListener("click", () => {
    void stopThreadDesktop();
  });

  desktopResizeObserver = new ResizeObserver(() => {
    scheduleThreadDesktopResize();
  });
  desktopResizeObserver.observe(elements.threadDesktopCanvas);
}

function clampSidebarWidth(width) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function applySidebarWidth() {
  if (!elements.layout) {
    return;
  }

  state.sidebarWidth = clampSidebarWidth(state.sidebarWidth);
  elements.layout.style.setProperty("--sidebar-width", `${state.sidebarWidth}px`);
}

function startSidebarResize(event) {
  if (window.innerWidth <= 980) {
    return;
  }

  event.preventDefault();
  sidebarResizeState = {
    pointerId: event.pointerId,
  };
  elements.sidebarResizeHandle.setPointerCapture?.(event.pointerId);
  document.body.classList.add("is-resizing-sidebar");
}

function handleSidebarResizePointerMove(event) {
  if (!sidebarResizeState || event.pointerId !== sidebarResizeState.pointerId) {
    return;
  }

  state.sidebarWidth = clampSidebarWidth(event.clientX);
  applySidebarWidth();
}

function stopSidebarResize(event) {
  if (!sidebarResizeState || (event && event.pointerId !== sidebarResizeState.pointerId)) {
    return;
  }

  elements.sidebarResizeHandle.releasePointerCapture?.(sidebarResizeState.pointerId);
  sidebarResizeState = null;
  document.body.classList.remove("is-resizing-sidebar");
  persistSelection();
}

function handleSidebarResizeKeydown(event) {
  if (window.innerWidth <= 980) {
    return;
  }

  let nextWidth = state.sidebarWidth;

  if (event.key === "ArrowLeft") {
    nextWidth -= event.shiftKey ? 40 : 16;
  } else if (event.key === "ArrowRight") {
    nextWidth += event.shiftKey ? 40 : 16;
  } else if (event.key === "Home") {
    nextWidth = MIN_SIDEBAR_WIDTH;
  } else if (event.key === "End") {
    nextWidth = MAX_SIDEBAR_WIDTH;
  } else {
    return;
  }

  event.preventDefault();
  state.sidebarWidth = clampSidebarWidth(nextWidth);
  applySidebarWidth();
  persistSelection();
}

function conversationSocketUrl() {
  const url = new URL("/ws/events", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

  if (state.app?.port) {
    url.port = String(state.app.port);
  }

  return url.toString();
}

function connectConversationSocket() {
  if (conversationSocket && (
    conversationSocket.readyState === WebSocket.OPEN ||
    conversationSocket.readyState === WebSocket.CONNECTING
  )) {
    return;
  }

  clearTimeout(conversationSocketRetryTimer);
  conversationSocketRetryTimer = null;
  conversationSocketShouldReconnect = true;

  const url = conversationSocketUrl();
  const socket = new WebSocket(url);
  conversationSocket = socket;

  socket.addEventListener("message", async (event) => {
    if (typeof event.data !== "string") {
      return;
    }

    let payload;

    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      console.error("Failed to parse event payload", error);
      return;
    }

    if (payload.type === "notification") {
      const message = payload.message;
      const method = typeof message?.method === "string" ? message.method : "";
      const threadId = message.params?.threadId || message.params?.thread?.id;

      if (!method) {
        return;
      }

      if (threadId && threadId === state.selectedThreadId) {
        const handledLive = applyStreamingNotification(message);

        if (!handledLive) {
          await loadThread(state.selectedThreadId).catch(console.error);
        }
      }

      if (method.startsWith("thread/")) {
        await loadAllProjectThreads().catch(console.error);
        renderProjects();
      }
    }
  });

  socket.addEventListener("close", () => {
    if (conversationSocket !== socket) {
      return;
    }

    conversationSocket = null;
    if (!conversationSocketShouldReconnect) {
      return;
    }

    clearTimeout(conversationSocketRetryTimer);
    conversationSocketRetryTimer = setTimeout(() => {
      if (!conversationSocket) {
        connectConversationSocket();
      }
    }, 1000);
  });

  socket.addEventListener("error", () => {
    socket.close();
  });
}

function disconnectConversationSocket() {
  conversationSocketShouldReconnect = false;
  clearTimeout(conversationSocketRetryTimer);
  conversationSocketRetryTimer = null;
  if (conversationSocket) {
    const socket = conversationSocket;
    conversationSocket = null;
    socket.close();
  }
}

document.addEventListener("click", async (event) => {
  if (event.target === elements.imageEditorModal) {
    closeImageEditor();
    return;
  }

  if (state.threadActionMenuOpen && !event.target.closest(".thread-action-menu")) {
    state.threadActionMenuOpen = false;
    renderThreadHeader();
  }

  if (state.composerMenuOpen && !event.target.closest(".composer-picker")) {
    state.composerMenuOpen = "";
    renderComposerControls();
  }

  const button = event.target.closest("[data-action]");

  if (!button) {
    return;
  }

  try {
    const action = button.dataset.action;

    if (action === "toggle-project-adder") {
      elements.projectQuickAddForm.classList.toggle("hidden");
      if (!elements.projectQuickAddForm.classList.contains("hidden")) {
        elements.projectPathInput.focus();
      }
      return;
    }

    if (action === "toggle-thread-action-menu") {
      state.threadActionMenuOpen = !state.threadActionMenuOpen;
      renderThreadHeader();
      return;
    }

    if (action === "toggle-composer-menu") {
      const nextMenu = button.dataset.menu === "effort" ? "effort" : "model";
      state.composerMenuOpen = state.composerMenuOpen === nextMenu ? "" : nextMenu;
      renderComposerControls();
      return;
    }

    if (action === "select-composer-model") {
      state.composerModel = button.dataset.value || "";
      state.composerMenuOpen = "";
      normalizeComposerSettings();
      renderComposerControls();
      return;
    }

    if (action === "select-composer-effort") {
      state.composerEffort = button.dataset.value || "";
      state.composerMenuOpen = "";
      persistComposerSettings();
      renderComposerControls();
      return;
    }

    if (action === "select-composer-fast-mode") {
      state.composerServiceTier = button.dataset.value === "on" ? "fast" : "flex";
      state.composerMenuOpen = "";
      persistComposerSettings();
      renderComposerControls();
      return;
    }

    if (action === "toggle-composer-mode") {
      state.composerMode = state.composerMode === "plan" ? "default" : "plan";
      persistComposerSettings();
      renderComposerControls();
      return;
    }

    if (action === "open-composer-attachment") {
      await openImageEditor(button.dataset.id);
      return;
    }

    if (action === "remove-composer-attachment") {
      state.composerAttachments = state.composerAttachments.filter((attachment) => attachment.id !== button.dataset.id);
      renderComposerAttachments();
      return;
    }

    if (action === "editor-tool") {
      setImageEditorTool(button.dataset.tool);
      return;
    }

    if (action === "close-image-editor") {
      closeImageEditor();
      return;
    }

    if (action === "apply-image-editor") {
      await applyImageEditor();
      return;
    }

    if (action === "refresh-all-projects") {
      state.projects = await api("/api/projects").then((result) => result.data);
      await loadAllProjectThreads();
      renderProjects();
      return;
    }

    if (action === "select-project") {
      state.selectedProjectId = button.dataset.id;
      state.selectedThreadId = "";
      state.selectedThread = null;
      state.threadActionMenuOpen = false;
      await disconnectDesktopClient();
      persistSelection();
      renderProjects();
      await loadThreads();
      return;
    }

    if (action === "refresh-threads") {
      await loadAllProjectThreads();
      renderProjects();
      return;
    }

    if (action === "toggle-project-threads") {
      const projectId = button.dataset.projectId || "";
      if (!projectId) {
        return;
      }

      if (state.expandedProjectIds.has(projectId)) {
        state.expandedProjectIds.delete(projectId);
      } else {
        state.expandedProjectIds.add(projectId);
      }

      renderProjects();
      return;
    }

    if (action === "select-thread-tab") {
      state.activeThreadTab = button.dataset.tab === "desktop" ? "desktop" : "chat";
      state.threadActionMenuOpen = false;
      persistSelection();
      renderThreadHeader();
      renderThreadPane();
      if (state.activeThreadTab === "desktop") {
        await ensureThreadDesktop();
      }
      return;
    }

    if (action === "toggle-archived") {
      state.archived = !state.archived;
      state.threadActionMenuOpen = false;
      await loadAllProjectThreads();
      renderProjects();
      return;
    }

    if (action === "new-thread") {
      state.selectedThreadId = "";
      state.selectedThread = null;
      state.currentTurnId = "";
      state.threadActionMenuOpen = false;
      await disconnectDesktopClient();
      persistSelection();
      renderThreadHeader();
      renderConversation();
      renderThreadPane();
      return;
    }

    if (action === "select-thread") {
      if (button.dataset.projectId && button.dataset.projectId !== state.selectedProjectId) {
        state.selectedProjectId = button.dataset.projectId;
      }
      state.threadActionMenuOpen = false;
      await loadThread(button.dataset.id);
      return;
    }

    if (action === "rename-thread") {
      if (!state.selectedThreadId) {
        return;
      }

      const name = window.prompt("Thread name", state.selectedThread?.name || "");

      if (!name) {
        return;
      }

      state.threadActionMenuOpen = false;
      await api(`/api/threads/${encodeURIComponent(state.selectedThreadId)}/name`, {
        method: "POST",
        body: { name },
      });
      await loadThread(state.selectedThreadId);
      await loadAllProjectThreads();
      renderProjects();
      return;
    }

    if (action === "fork-thread") {
      state.threadActionMenuOpen = false;
      await api(`/api/threads/${encodeURIComponent(state.selectedThreadId)}/fork`, { method: "POST", body: {} });
      await loadAllProjectThreads();
      renderProjects();
      return;
    }

    if (action === "compact-thread") {
      state.threadActionMenuOpen = false;
      await api(`/api/threads/${encodeURIComponent(state.selectedThreadId)}/compact`, { method: "POST", body: {} });
      return;
    }

    if (action === "review-thread") {
      state.threadActionMenuOpen = false;
      await api(`/api/threads/${encodeURIComponent(state.selectedThreadId)}/review`, {
        method: "POST",
        body: { targetType: "uncommittedChanges", delivery: "inline" },
      });
      return;
    }

    if (action === "interrupt-thread") {
      if (!state.currentTurnId) {
        throw new Error("No active turn id available");
      }

      state.threadActionMenuOpen = false;
      await api(`/api/threads/${encodeURIComponent(state.selectedThreadId)}/interrupt`, {
        method: "POST",
        body: { turnId: state.currentTurnId },
      });
      return;
    }

    if (action === "archive-thread" || action === "unarchive-thread") {
      state.threadActionMenuOpen = false;
      await api(`/api/threads/${encodeURIComponent(state.selectedThreadId)}/${action === "archive-thread" ? "archive" : "unarchive"}`, {
        method: "POST",
        body: {},
      });
      await loadAllProjectThreads();
      renderProjects();
      state.selectedThreadId = "";
      state.selectedThread = null;
      await disconnectDesktopClient();
      renderThreadHeader();
      renderConversation();
      renderThreadPane();
      return;
    }

  } catch (error) {
    alert(error.message);
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  event.preventDefault();

  try {
    if (form === elements.projectQuickAddForm) {
      const formData = new FormData(form);
      const cwd = String(formData.get("cwd") || "").trim();

      if (!cwd) {
        throw new Error("Paste a folder path");
      }

      const body = {
        cwd,
        name: cwd.split("/").filter(Boolean).pop() || cwd,
        defaultEffort: "medium",
        defaultSummary: "auto",
        defaultPersonality: "pragmatic",
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        networkAccess: true,
      };
      const savedPayload = await api("/api/projects", { method: "POST", body });
      const created = savedPayload.data;
      state.projects = await api("/api/projects").then((result) => result.data);
      state.selectedProjectId = created.id;
      state.selectedThreadId = "";
      state.selectedThread = null;
      form.reset();
      elements.projectQuickAddForm.classList.add("hidden");
      persistSelection();
      await loadAllProjectThreads();
      renderProjects();
      return;
    }

    if (form === elements.composerForm) {
      const project = selectedProject();
      const text = elements.promptInput.value.trim();
      const overrides = composerRequestOverrides();
      const images = state.composerAttachments.map((attachment) => ({
        type: "image",
        url: attachment.url,
        name: attachment.name,
      }));

      if (!project) {
        throw new Error("Select a project first");
      }

      if (!text && images.length === 0) {
        throw new Error("Enter a prompt or paste an image");
      }

      if (state.selectedThreadId) {
        await api(`/api/threads/${encodeURIComponent(state.selectedThreadId)}/message`, {
          method: "POST",
          body: { projectId: project.id, text, images, ...overrides },
        });
      } else {
        const created = await api("/api/threads", {
          method: "POST",
          body: { projectId: project.id, prompt: text, images, ...overrides },
        });

        state.selectedThreadId = created.data?.thread?.id;
      }

      elements.promptInput.value = "";
      clearComposerDraft();
      state.composerAttachments = [];
      renderComposerAttachments();
      persistSelection();
      await loadAllProjectThreads();
      renderProjects();

      if (state.selectedThreadId) {
        await loadThread(state.selectedThreadId);
      }

      return;
    }

  } catch (error) {
    alert(error.message);
  }
});

function findLatestTurnId(thread) {
  const turns = thread?.turns || [];
  return turns.length > 0 ? turns[turns.length - 1].id : "";
}

async function ensureThreadDesktop() {
  if (!state.selectedThreadId || state.desktopConnectInFlight) {
    return;
  }

  const threadId = state.selectedThreadId;
  const project = selectedProject();
  if (!project) {
    return;
  }

  state.desktopConnectInFlight = true;
  renderThreadPane();

  try {
    const payload = await api(`/api/threads/${encodeURIComponent(threadId)}/desktop`, {
      method: "POST",
      body: { projectId: project.id },
    });
    state.desktopSessionByThreadId[threadId] = payload.data || payload;
    await connectDesktopClient(state.desktopSessionByThreadId[threadId], threadId);
  } finally {
    state.desktopConnectInFlight = false;
    renderThreadPane();
  }
}

async function connectDesktopClient(session, threadId) {
  if (!session || threadId !== state.selectedThreadId) {
    return;
  }

  const current = state.desktopClient;
  if (current?.threadId === threadId) {
    const currentState = current.client.getState();
    syncDesktopInputBinding();
    if (currentState.connected && currentState.authenticated) {
      scheduleThreadDesktopResize();
      return;
    }
  }

  await disconnectDesktopClient();

  const client = new RemoteXBrowserClient({
    url: session.wsUrl,
    preferredEncoding: session.state.encoding,
    autoScale: true,
  });

  client.attachCanvas(elements.threadDesktopCanvas);
  client.on("connected", () => {
    if (state.selectedThreadId === threadId && state.activeThreadTab === "desktop") {
      elements.threadDesktopStatus.textContent = `${session.state.displayName} · connected`;
    }
  });
  client.on("authenticated", () => {
    if (state.selectedThreadId === threadId && state.activeThreadTab === "desktop") {
      elements.threadDesktopStatus.textContent = `${session.state.displayName} · authenticated`;
    }
    scheduleThreadDesktopResize();
  });
  client.on("screen-info", (screen) => {
    if (state.selectedThreadId === threadId && state.activeThreadTab === "desktop") {
      elements.threadDesktopStatus.textContent = `${screen.width}x${screen.height} · live`;
    }
  });
  client.on("disconnected", () => {
    if (state.desktopClient?.threadId === threadId) {
      elements.threadDesktopStatus.textContent = "Virtual desktop disconnected";
    }
  });
  client.on("error", (error) => {
    if (state.desktopClient?.threadId === threadId) {
      elements.threadDesktopStatus.textContent = `Desktop error: ${error.message}`;
    }
  });

  state.desktopClient = { threadId, client };
  await client.connect();
  await client.authenticate(session.authToken);
  syncDesktopInputBinding();
}

async function disconnectDesktopClient() {
  if (!state.desktopClient) {
    return;
  }
  const { client } = state.desktopClient;
  state.desktopClient = null;
  await client.disconnect();
  client.detachCanvas();
}

function scheduleThreadDesktopResize() {
  clearTimeout(desktopResizeTimer);
  desktopResizeTimer = setTimeout(() => {
    void applyThreadDesktopResize();
  }, 120);
}

async function applyThreadDesktopResize() {
  if (!state.desktopClient || state.activeThreadTab !== "desktop") {
    return;
  }

  const clientState = state.desktopClient.client.getState();
  if (!clientState.connected || !clientState.authenticated) {
    return;
  }

  const rect = elements.threadDesktopCanvas.getBoundingClientRect();
  const scale = Number(elements.threadDesktopScale.value) || 1;
  const width = Math.max(64, Math.round(rect.width * (window.devicePixelRatio || 1) * scale));
  const height = Math.max(64, Math.round(rect.height * (window.devicePixelRatio || 1) * scale));
  await state.desktopClient.client.requestResize(width, height, scale);
}

async function stopThreadDesktop() {
  if (!state.selectedThreadId) {
    return;
  }

  await disconnectDesktopClient();
  await api(`/api/threads/${encodeURIComponent(state.selectedThreadId)}/desktop`, {
    method: "DELETE",
  });
  delete state.desktopSessionByThreadId[state.selectedThreadId];
  if (state.activeThreadTab === "desktop") {
    elements.threadDesktopStatus.textContent = "Virtual desktop stopped";
  }
}

async function updateThreadDesktopFrameRate() {
  if (!state.selectedThreadId) {
    return;
  }

  const frameRate = Number(elements.threadDesktopFrameRate.value) || 30;
  const payload = await api(`/api/threads/${encodeURIComponent(state.selectedThreadId)}/desktop/frame-rate`, {
    method: "POST",
    body: { frameRate },
  });
  state.desktopSessionByThreadId[state.selectedThreadId] = payload.data || payload;
  renderThreadPane();
}

async function captureThreadDesktopScreenshot() {
  if (!state.selectedThreadId || state.activeThreadTab !== "desktop") {
    return;
  }

  const desktopState = state.desktopClient?.client?.getState?.();
  if (!desktopState?.authenticated) {
    throw new Error("Virtual desktop is not connected");
  }

  const canvas = elements.threadDesktopCanvas;
  if (!canvas || canvas.width < 1 || canvas.height < 1) {
    throw new Error("No virtual desktop frame available");
  }

  const url = canvas.toDataURL("image/png");
  const attachmentId = createAttachmentId();
  const threadName = (state.selectedThread?.name || state.selectedThread?.preview || "desktop")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "desktop";

  state.composerAttachments = state.composerAttachments.concat([{
    id: attachmentId,
    name: `${threadName}-screenshot-${Date.now()}.png`,
    url,
  }]);
  renderComposerAttachments();

  state.activeThreadTab = "chat";
  persistSelection();
  renderThreadHeader();
  renderThreadPane();

  await openImageEditor(attachmentId);
}

async function handleComposerPaste(event) {
  const clipboardItems = Array.from(event.clipboardData?.items || []);
  const imageItems = clipboardItems.filter((item) => item.type.startsWith("image/"));

  if (!imageItems.length) {
    return;
  }

  event.preventDefault();

  const pasted = await Promise.all(imageItems.map(async (item, index) => {
    const file = item.getAsFile();

    if (!file) {
      return null;
    }

    return {
      id: createAttachmentId(),
      name: file.name || `pasted-image-${Date.now()}-${index + 1}.${guessImageExtension(file.type)}`,
      url: await readFileAsDataUrl(file),
    };
  }));

  state.composerAttachments = state.composerAttachments.concat(pasted.filter(Boolean));
  renderComposerAttachments();
}

function createAttachmentId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function guessImageExtension(mimeType) {
  if (mimeType === "image/jpeg") {
    return "jpg";
  }

  if (mimeType === "image/png") {
    return "png";
  }

  if (mimeType === "image/webp") {
    return "webp";
  }

  if (mimeType === "image/gif") {
    return "gif";
  }

  return "img";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read pasted image"));
    reader.readAsDataURL(file);
  });
}

function createImageEditorState() {
  return {
    open: false,
    attachmentId: "",
    image: null,
    imageUrl: "",
    naturalWidth: 0,
    naturalHeight: 0,
    displayWidth: 0,
    displayHeight: 0,
    scale: 1,
    tool: "select",
    color: "#d100ff",
    shapes: [],
    cropRect: null,
    selectedShapeId: "",
    drag: null,
  };
}

async function openImageEditor(attachmentId) {
  const attachment = state.composerAttachments.find((item) => item.id === attachmentId);

  if (!attachment) {
    return;
  }

  const image = await loadImage(attachment.url);
  state.imageEditor = {
    ...createImageEditorState(),
    open: true,
    attachmentId,
    image,
    imageUrl: attachment.url,
    naturalWidth: image.naturalWidth || image.width,
    naturalHeight: image.naturalHeight || image.height,
    color: elements.imageEditorColor.value || "#d100ff",
  };
  elements.imageEditorModal.classList.remove("hidden");
  elements.imageEditorModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  elements.imageEditorPreviewImage.src = attachment.url;
  layoutImageEditorCanvas();
  syncImageEditorToolbar();
  renderImageEditor();
}

function closeImageEditor() {
  state.imageEditor = createImageEditorState();
  elements.imageEditorModal.classList.add("hidden");
  elements.imageEditorModal.setAttribute("aria-hidden", "true");
  elements.imageEditorPreviewImage.removeAttribute("src");
  document.body.classList.remove("modal-open");
}

function setImageEditorTool(tool) {
  if (!state.imageEditor.open) {
    return;
  }

  state.imageEditor.tool = tool || "select";
  if (state.imageEditor.tool !== "select") {
    state.imageEditor.selectedShapeId = "";
  }
  syncImageEditorToolbar();
  renderImageEditor();
}

function syncImageEditorToolbar() {
  document.querySelectorAll("[data-action='editor-tool']").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === state.imageEditor.tool);
  });
  elements.imageEditorColor.value = state.imageEditor.color || "#d100ff";
  elements.imageEditorOverlayCanvas.classList.toggle("select-mode", state.imageEditor.tool === "select");
}

function layoutImageEditorCanvas() {
  const editor = state.imageEditor;

  if (!editor.open || !editor.naturalWidth || !editor.naturalHeight) {
    return;
  }

  const maxWidth = Math.max(320, window.innerWidth - 160);
  const maxHeight = Math.max(240, window.innerHeight - 220);
  const scale = Math.min(maxWidth / editor.naturalWidth, maxHeight / editor.naturalHeight, 1);
  editor.scale = scale;
  editor.displayWidth = Math.max(1, Math.round(editor.naturalWidth * scale));
  editor.displayHeight = Math.max(1, Math.round(editor.naturalHeight * scale));

  resizeCanvas(elements.imageEditorOverlayCanvas, editor.displayWidth, editor.displayHeight);
  elements.imageEditorCanvasWrap.style.width = `${editor.displayWidth}px`;
  elements.imageEditorCanvasWrap.style.height = `${editor.displayHeight}px`;
  elements.imageEditorPreviewImage.style.width = `${editor.displayWidth}px`;
  elements.imageEditorPreviewImage.style.height = `${editor.displayHeight}px`;
}

function resizeCanvas(canvas, width, height) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function renderImageEditor() {
  const editor = state.imageEditor;

  if (!editor.open || !editor.image) {
    return;
  }

  const overlay = elements.imageEditorOverlayCanvas.getContext("2d");
  overlay.clearRect(0, 0, editor.displayWidth, editor.displayHeight);

  if (editor.cropRect && !shapeSizeTooSmall(editor.cropRect)) {
    overlay.save();
    clipToRect(overlay, editor.cropRect, editor.scale);
    for (const shape of editor.shapes) {
      drawEditorShape(overlay, shape, editor.scale, shape.id === editor.selectedShapeId);
    }
    overlay.restore();
    drawCropOverlay(overlay, editor.cropRect, editor.scale, editor.selectedShapeId === "__crop__");
    return;
  }

  for (const shape of editor.shapes) {
    drawEditorShape(overlay, shape, editor.scale, shape.id === editor.selectedShapeId);
  }
}

function clipToRect(context, rect, scale) {
  context.beginPath();
  context.rect(rect.x * scale, rect.y * scale, rect.w * scale, rect.h * scale);
  context.clip();
}

function drawCropOverlay(context, rect, scale, selected) {
  const x = rect.x * scale;
  const y = rect.y * scale;
  const w = rect.w * scale;
  const h = rect.h * scale;

  context.save();
  context.fillStyle = "rgba(0, 0, 0, 0.38)";
  context.fillRect(0, 0, state.imageEditor.displayWidth, state.imageEditor.displayHeight);
  context.clearRect(x, y, w, h);
  context.strokeStyle = "#ffffff";
  context.lineWidth = 2;
  context.setLineDash([8, 6]);
  context.strokeRect(x, y, w, h);
  context.setLineDash([]);
  if (selected) {
    drawRectHandles(context, rect, scale);
  }
  context.restore();
}

function drawEditorShape(context, shape, scale, selected) {
  context.save();
  context.strokeStyle = shape.color;
  context.lineWidth = 3;
  context.lineJoin = "round";
  context.lineCap = "round";

  if (shape.type === "rect") {
    context.strokeRect(shape.x * scale, shape.y * scale, shape.w * scale, shape.h * scale);
    if (selected) {
      drawRectHandles(context, shape, scale);
    }
  } else {
    const x1 = shape.x1 * scale;
    const y1 = shape.y1 * scale;
    const x2 = shape.x2 * scale;
    const y2 = shape.y2 * scale;
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.stroke();
    if (shape.type === "arrow") {
      drawArrowHead(context, x1, y1, x2, y2, shape.color);
    }
    if (selected) {
      drawPointHandle(context, x1, y1);
      drawPointHandle(context, x2, y2);
    }
  }

  context.restore();
}

function drawArrowHead(context, x1, y1, x2, y2, color) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLength = 16;
  context.fillStyle = color;
  context.beginPath();
  context.moveTo(x2, y2);
  context.lineTo(x2 - headLength * Math.cos(angle - Math.PI / 6), y2 - headLength * Math.sin(angle - Math.PI / 6));
  context.lineTo(x2 - headLength * Math.cos(angle + Math.PI / 6), y2 - headLength * Math.sin(angle + Math.PI / 6));
  context.closePath();
  context.fill();
}

function drawRectHandles(context, shape, scale) {
  for (const point of rectCornerPoints(shape)) {
    drawPointHandle(context, point.x * scale, point.y * scale);
  }
}

function drawPointHandle(context, x, y) {
  context.save();
  context.fillStyle = "#ffffff";
  context.strokeStyle = "#0d0e10";
  context.lineWidth = 1.5;
  context.beginPath();
  context.arc(x, y, 5, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.restore();
}

function handleImageEditorPointerDown(event) {
  const editor = state.imageEditor;

  if (!editor.open) {
    return;
  }

  const point = getEditorPoint(event);

  if (editor.tool === "crop") {
    startCropRect(point);
    return;
  }

  if (editor.tool === "rect" || editor.tool === "line" || editor.tool === "arrow") {
    startEditorShape(point);
    return;
  }

  const hit = hitTestEditorTargets(point);
  editor.selectedShapeId = hit?.shape?.id || "";
  syncImageEditorToolbar();

  if (!hit) {
    renderImageEditor();
    return;
  }

  editor.drag = {
    mode: hit.mode,
    shapeId: hit.shape.id,
    handle: hit.handle || "",
    startPoint: point,
    startShape: cloneShape(hit.shape),
  };
  renderImageEditor();
}

function handleImageEditorPointerMove(event) {
  const editor = state.imageEditor;

  if (!editor.open || !editor.drag) {
    return;
  }

  const point = getEditorPoint(event);
  const shape = editor.shapes.find((item) => item.id === editor.drag.shapeId)
    || (editor.drag.shapeId === "__crop__" ? editor.cropRect : null);

  if (!shape) {
    return;
  }

  if (editor.drag.mode === "draw") {
    updateDraftShape(shape, editor.drag.startPoint, point);
  } else if (shape.type === "rect") {
    updateDraggedRect(shape, editor.drag, point);
  } else {
    updateDraggedLine(shape, editor.drag, point);
  }

  normalizeShape(shape);
  renderImageEditor();
}

function handleImageEditorPointerUp() {
  const editor = state.imageEditor;

  if (!editor.open || !editor.drag) {
    return;
  }

  const shape = editor.shapes.find((item) => item.id === editor.drag.shapeId)
    || (editor.drag.shapeId === "__crop__" ? editor.cropRect : null);

  if (editor.drag.mode === "draw" && shape && shapeSizeTooSmall(shape)) {
    if (shape.id === "__crop__") {
      editor.cropRect = null;
    }
  }

  if (editor.drag.mode === "draw" && shape && shape.id !== "__crop__" && shapeSizeTooSmall(shape)) {
    editor.shapes = editor.shapes.filter((item) => item.id !== shape.id);
    editor.selectedShapeId = "";
  } else if (shape) {
    editor.selectedShapeId = shape.id;
  }

  editor.drag = null;
  syncImageEditorToolbar();
  renderImageEditor();
}

function handleImageEditorDoubleClick() {
  if (!state.imageEditor.open) {
    return;
  }

  state.imageEditor.tool = "select";
  syncImageEditorToolbar();
  renderImageEditor();
}

function startEditorShape(point) {
  const editor = state.imageEditor;
  const id = createAttachmentId();
  const shape = editor.tool === "rect"
    ? { id, type: "rect", color: editor.color, x: point.x, y: point.y, w: 0, h: 0 }
    : { id, type: editor.tool, color: editor.color, x1: point.x, y1: point.y, x2: point.x, y2: point.y };
  editor.shapes.push(shape);
  editor.selectedShapeId = id;
  editor.drag = {
    mode: "draw",
    shapeId: id,
    startPoint: point,
  };
  renderImageEditor();
}

function startCropRect(point) {
  const editor = state.imageEditor;
  editor.cropRect = { id: "__crop__", type: "rect", color: "#ffffff", x: point.x, y: point.y, w: 0, h: 0 };
  editor.selectedShapeId = "__crop__";
  editor.drag = {
    mode: "draw",
    shapeId: "__crop__",
    startPoint: point,
  };
  renderImageEditor();
}

function updateDraftShape(shape, start, point) {
  if (shape.type === "rect") {
    shape.x = Math.min(start.x, point.x);
    shape.y = Math.min(start.y, point.y);
    shape.w = Math.abs(point.x - start.x);
    shape.h = Math.abs(point.y - start.y);
    return;
  }

  shape.x2 = point.x;
  shape.y2 = point.y;
}

function hitTestEditorTargets(point) {
  if (state.imageEditor.cropRect) {
    const cropHit = hitTestRect(state.imageEditor.cropRect, point);
    if (cropHit) {
      return { ...cropHit, shape: state.imageEditor.cropRect };
    }
  }

  for (let index = state.imageEditor.shapes.length - 1; index >= 0; index -= 1) {
    const shape = state.imageEditor.shapes[index];
    const hit = shape.type === "rect" ? hitTestRect(shape, point) : hitTestLine(shape, point);
    if (hit) {
      return { ...hit, shape };
    }
  }

  return null;
}

function hitTestRect(shape, point) {
  const threshold = 10 / state.imageEditor.scale;
  const corners = rectCornerPoints(shape);
  const labels = ["nw", "ne", "se", "sw"];

  for (let index = 0; index < corners.length; index += 1) {
    if (distance(point, corners[index]) <= threshold) {
      return { mode: "resize", handle: labels[index] };
    }
  }

  if (point.x >= shape.x && point.x <= shape.x + shape.w && point.y >= shape.y && point.y <= shape.y + shape.h) {
    return { mode: "move" };
  }

  return null;
}

function hitTestLine(shape, point) {
  const threshold = 10 / state.imageEditor.scale;
  const start = { x: shape.x1, y: shape.y1 };
  const end = { x: shape.x2, y: shape.y2 };

  if (distance(point, start) <= threshold) {
    return { mode: "endpoint", handle: "start" };
  }

  if (distance(point, end) <= threshold) {
    return { mode: "endpoint", handle: "end" };
  }

  if (distanceToSegment(point, start, end) <= threshold) {
    return { mode: "move" };
  }

  return null;
}

function updateDraggedRect(shape, drag, point) {
  const dx = point.x - drag.startPoint.x;
  const dy = point.y - drag.startPoint.y;

  if (drag.mode === "move") {
    shape.x = drag.startShape.x + dx;
    shape.y = drag.startShape.y + dy;
    return;
  }

  if (drag.handle === "nw") {
    shape.x = drag.startShape.x + dx;
    shape.y = drag.startShape.y + dy;
    shape.w = drag.startShape.w - dx;
    shape.h = drag.startShape.h - dy;
  } else if (drag.handle === "ne") {
    shape.y = drag.startShape.y + dy;
    shape.w = drag.startShape.w + dx;
    shape.h = drag.startShape.h - dy;
  } else if (drag.handle === "se") {
    shape.w = drag.startShape.w + dx;
    shape.h = drag.startShape.h + dy;
  } else if (drag.handle === "sw") {
    shape.x = drag.startShape.x + dx;
    shape.w = drag.startShape.w - dx;
    shape.h = drag.startShape.h + dy;
  }
}

function updateDraggedLine(shape, drag, point) {
  const dx = point.x - drag.startPoint.x;
  const dy = point.y - drag.startPoint.y;

  if (drag.mode === "move") {
    shape.x1 = drag.startShape.x1 + dx;
    shape.y1 = drag.startShape.y1 + dy;
    shape.x2 = drag.startShape.x2 + dx;
    shape.y2 = drag.startShape.y2 + dy;
    return;
  }

  if (drag.handle === "start") {
    shape.x1 = point.x;
    shape.y1 = point.y;
  } else if (drag.handle === "end") {
    shape.x2 = point.x;
    shape.y2 = point.y;
  }
}

function normalizeShape(shape) {
  const editor = state.imageEditor;

  if (shape.type === "rect") {
    if (shape.w < 0) {
      shape.x += shape.w;
      shape.w = Math.abs(shape.w);
    }
    if (shape.h < 0) {
      shape.y += shape.h;
      shape.h = Math.abs(shape.h);
    }
    shape.x = clamp(shape.x, 0, editor.naturalWidth);
    shape.y = clamp(shape.y, 0, editor.naturalHeight);
    shape.w = clamp(shape.w, 0, editor.naturalWidth - shape.x);
    shape.h = clamp(shape.h, 0, editor.naturalHeight - shape.y);
    return;
  }

  shape.x1 = clamp(shape.x1, 0, editor.naturalWidth);
  shape.y1 = clamp(shape.y1, 0, editor.naturalHeight);
  shape.x2 = clamp(shape.x2, 0, editor.naturalWidth);
  shape.y2 = clamp(shape.y2, 0, editor.naturalHeight);
}

function shapeSizeTooSmall(shape) {
  if (shape.type === "rect") {
    return shape.w < 6 || shape.h < 6;
  }

  return distance({ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }) < 6;
}

function rectCornerPoints(shape) {
  return [
    { x: shape.x, y: shape.y },
    { x: shape.x + shape.w, y: shape.y },
    { x: shape.x + shape.w, y: shape.y + shape.h },
    { x: shape.x, y: shape.y + shape.h },
  ];
}

function getEditorPoint(event) {
  const rect = elements.imageEditorOverlayCanvas.getBoundingClientRect();
  const scale = state.imageEditor.scale || 1;
  return {
    x: clamp((event.clientX - rect.left) / scale, 0, state.imageEditor.naturalWidth),
    y: clamp((event.clientY - rect.top) / scale, 0, state.imageEditor.naturalHeight),
  };
}

async function applyImageEditor() {
  const editor = state.imageEditor;
  const attachment = state.composerAttachments.find((item) => item.id === editor.attachmentId);

  if (!editor.open || !attachment || !editor.image) {
    closeImageEditor();
    return;
  }

  const crop = normalizedCropRect(editor);
  const canvas = document.createElement("canvas");
  canvas.width = crop.w;
  canvas.height = crop.h;
  const context = canvas.getContext("2d");
  context.drawImage(editor.image, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
  context.save();
  clipToRect(context, { x: 0, y: 0, w: crop.w, h: crop.h }, 1);
  for (const shape of editor.shapes) {
    drawEditorShape(context, offsetShapeForCrop(shape, crop), 1, false);
  }
  context.restore();
  attachment.url = canvas.toDataURL("image/png");
  renderComposerAttachments();
  closeImageEditor();
}

function normalizedCropRect(editor) {
  if (!editor.cropRect || shapeSizeTooSmall(editor.cropRect)) {
    return {
      x: 0,
      y: 0,
      w: editor.naturalWidth,
      h: editor.naturalHeight,
    };
  }

  return {
    x: Math.round(editor.cropRect.x),
    y: Math.round(editor.cropRect.y),
    w: Math.max(1, Math.round(editor.cropRect.w)),
    h: Math.max(1, Math.round(editor.cropRect.h)),
  };
}

function offsetShapeForCrop(shape, crop) {
  const next = cloneShape(shape);

  if (next.type === "rect") {
    next.x -= crop.x;
    next.y -= crop.y;
    return next;
  }

  next.x1 -= crop.x;
  next.y1 -= crop.y;
  next.x2 -= crop.x;
  next.y2 -= crop.y;
  return next;
}

function findSelectedEditorShape() {
  if (state.imageEditor.selectedShapeId === "__crop__") {
    return state.imageEditor.cropRect;
  }

  return state.imageEditor.shapes.find((shape) => shape.id === state.imageEditor.selectedShapeId) || null;
}

function cloneShape(shape) {
  return JSON.parse(JSON.stringify(shape));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceToSegment(point, start, end) {
  const lengthSquared = ((end.x - start.x) ** 2) + ((end.y - start.y) ** 2);

  if (lengthSquared === 0) {
    return distance(point, start);
  }

  let t = (((point.x - start.x) * (end.x - start.x)) + ((point.y - start.y) * (end.y - start.y))) / lengthSquared;
  t = clamp(t, 0, 1);
  return distance(point, {
    x: start.x + (t * (end.x - start.x)),
    y: start.y + (t * (end.y - start.y)),
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load image"));
    image.src = src;
  });
}

function relativeTime(unixSeconds) {
  if (!unixSeconds) {
    return "";
  }

  const diffSeconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);

  if (diffSeconds < 60) {
    return "just now";
  }

  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function latestTurn(thread) {
  const turns = thread?.turns || [];
  return turns.length ? turns[turns.length - 1] : null;
}

function describeStatusActivity(status) {
  const text = formatStatus(status).toLowerCase();

  if (text.includes("think")) {
    return "Thinking";
  }

  return "Working";
}

function describeThreadActivity(thread) {
  const turn = latestTurn(thread);
  const activeStatus = isLiveStatus(turn?.status) ? turn.status : thread?.status;
  const isWorking = isLiveStatus(activeStatus);

  return {
    isWorking,
    label: isWorking ? describeStatusActivity(activeStatus) : "Idle",
    statusText: formatStatus(activeStatus || thread?.status),
    turnId: turn?.id || "",
  };
}

function renderActivityBadge(label, statusText = "", tone = "idle") {
  const className = `status-badge${tone === "live" ? " live" : ""}${tone === "small" ? " small live" : ""}`;
  const title = statusText ? ` title="${escapeHtml(statusText)}"` : "";
  return `<span class="${className}"${title}><span class="status-dot" aria-hidden="true"></span>${escapeHtml(label)}</span>`;
}

function formatStatus(status) {
  if (!status) {
    return "unknown";
  }

  if (typeof status === "string") {
    return status;
  }

  if (typeof status === "object" && status.type) {
    return status.type;
  }

  return JSON.stringify(status);
}

function isLiveStatus(status) {
  const text = formatStatus(status).toLowerCase();
  return text.includes("progress")
    || text.includes("active")
    || text.includes("running")
    || text.includes("working")
    || text.includes("thinking")
    || text.includes("stream")
    || text.includes("respond");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function showFatalError(error) {
  document.body.innerHTML = `<pre style="padding:24px">${escapeHtml(error.stack || error.message || String(error))}</pre>`;
}
