import "./styles.css";
import { marked } from "marked";
import { buildAutoApprovalResult, normalizeCommandApprovalDecisions } from "./approval-utils.mjs";
import { parseLocalFileLinkHref } from "./file-link-utils.mjs";
import {
  formatServiceTierLabel,
  resolveComposerSelection,
  supportedReasoningEffortsForModel,
  supportedServiceTiersForModel,
} from "./model-capabilities.mjs";
import { createConversationUi } from "./conversation-ui.mjs";
import {
  api,
  cleanString,
  createPaneBridge,
  escapeHtml,
  formatStatus,
  isLiveStatus,
  oneLine,
  relativeTime,
  websocketUrl,
} from "./pane-bridge.mjs";
import { normalizeRalphLoopLimit } from "./ralph-loop-utils.mjs";
import {
  describeStatusActivity,
  describeThreadActivity,
  latestTurn,
  parsePendingDecision,
  renderActivityBadge,
} from "./ui-formatters.mjs";

marked.setOptions({
  gfm: true,
  breaks: true,
});

const markdownHtmlCache = new Map();
const MAX_MARKDOWN_CACHE_ENTRIES = 200;

const conversationUi = createConversationUi({
  normalizeCommandApprovalDecisions,
  renderCollapsibleItem,
  renderMarkdown,
});
const {
  renderContentEntry,
  renderMessageContent,
  renderPendingServerRequest,
  renderToolCallBody,
} = conversationUi;

const state = {
  active: false,
  projectId: "",
  projectName: "",
  threadId: "",
  models: [],
  thread: null,
  archived: false,
  pendingRequests: [],
  autoscroll: localStorage.getItem("autoscroll") !== "false",
  approveAllDangerous: localStorage.getItem("composerApproveAllDangerous") === "true",
  autoApprovalInFlight: new Set(),
  pendingRalphLoopReplay: null,
  pendingNewThread: null,
  composerModel: localStorage.getItem("composerModel") || "",
  composerEffort: localStorage.getItem("composerEffort") || "",
  composerServiceTier: localStorage.getItem("composerServiceTier") || "",
  composerCapabilities: { serviceTiers: [], defaultServiceTier: "" },
  composer: {
    draftText: "",
    attachments: [],
    modelLabel: "Select Model",
    effortLabel: "Reasoning",
    hasModelOptions: false,
    hasEffortOptions: false,
    modelMenuHtml: "",
    effortMenuHtml: "",
    mode: localStorage.getItem("composerMode") === "plan" ? "plan" : "default",
    modeLabel: localStorage.getItem("composerMode") === "plan" ? "Plan" : "Chat",
    approveAllDangerous: localStorage.getItem("composerApproveAllDangerous") === "true",
    ralphLoop: false,
    ralphLoopLimit: normalizeRalphLoopLimit(localStorage.getItem("composerRalphLoopLimit")),
  },
  ui: {
    composerSettingsOpen: false,
    composerMenuOpen: "",
    threadActionMenuOpen: false,
  },
  socket: null,
  socketRetryTimer: null,
  socketShouldReconnect: true,
};

const elements = {
  chatPaneHeader: document.getElementById("chatPaneHeader"),
  conversation: document.getElementById("conversation"),
  chatPaneComposer: document.getElementById("chatPaneComposer"),
};

const standaloneMode = window.parent === window;
const initialParams = new URLSearchParams(window.location.search);

const bridge = createPaneBridge("chat", {
  onState: (payload) => {
    void applyHostState(payload);
  },
  onFocus: () => {
    focusComposerInput();
  },
});

elements.conversation.addEventListener("toggle", handleConversationDetailsToggle, true);

document.addEventListener("click", async (event) => {
  if (state.ui.composerSettingsOpen && !event.target.closest(".composer-settings")) {
    state.ui.composerSettingsOpen = false;
    state.ui.composerMenuOpen = "";
    renderComposer();
  }

  if (state.ui.threadActionMenuOpen && !event.target.closest(".thread-action-menu")) {
    state.ui.threadActionMenuOpen = false;
    renderChatHeader();
  }

  const anchor = event.target.closest(".message-body a[href]");
  if (anchor instanceof HTMLAnchorElement) {
    const fileReference = parseLocalFileLinkHref(anchor.getAttribute("href"));

    if (fileReference) {
      event.preventDefault();
      bridge.send("open-resource", { reference: fileReference });
      return;
    }
  }

  const button = event.target.closest("[data-action]");
  if (!button) {
    return;
  }

  try {
    const action = button.dataset.action;

    if (action === "toggle-composer-settings") {
      state.ui.composerSettingsOpen = !state.ui.composerSettingsOpen;
      if (!state.ui.composerSettingsOpen) {
        state.ui.composerMenuOpen = "";
      }
      renderComposer();
      return;
    }

    if (action === "toggle-composer-menu") {
      state.ui.composerSettingsOpen = true;
      const nextMenu = button.dataset.menu === "effort" ? "effort" : "model";
      state.ui.composerMenuOpen = state.ui.composerMenuOpen === nextMenu ? "" : nextMenu;
      renderComposer();
      return;
    }

    if (action === "toggle-thread-action-menu") {
      state.ui.threadActionMenuOpen = !state.ui.threadActionMenuOpen;
      renderChatHeader();
      return;
    }

    if (action === "select-composer-model") {
      updateComposerSetting("model", button.dataset.value || "");
      state.ui.composerMenuOpen = "";
      renderComposer();
      return;
    }

    if (action === "select-composer-effort") {
      updateComposerSetting("effort", button.dataset.value || "");
      state.ui.composerMenuOpen = "";
      renderComposer();
      return;
    }

    if (action === "select-composer-service-tier") {
      updateComposerSetting("serviceTier", button.dataset.value || "");
      state.ui.composerMenuOpen = "";
      renderComposer();
      return;
    }

    if (action === "toggle-composer-mode") {
      updateComposerSetting("mode", state.composer.mode === "plan" ? "default" : "plan");
      renderComposer();
      return;
    }

    if (action === "toggle-autoscroll") {
      updateComposerSetting("autoscroll", !state.autoscroll);
      renderComposer();
      return;
    }

    if (action === "toggle-approve-all-dangerous") {
      updateComposerSetting("approveAllDangerous", !state.composer.approveAllDangerous);
      renderComposer();
      return;
    }

    if (action === "toggle-ralph-loop") {
      updateComposerSetting("ralphLoop", !state.composer.ralphLoop);
      renderComposer();
      return;
    }

    if (action === "open-composer-attachment") {
      bridge.send("open-composer-attachment", { id: button.dataset.id || "" });
      return;
    }

    if (action === "remove-composer-attachment") {
      state.composer.attachments = state.composer.attachments.filter((attachment) => attachment.id !== (button.dataset.id || ""));
      bridge.send("composer-attachments", { attachments: state.composer.attachments });
      renderComposer();
      return;
    }

    if (action === "rename-thread") {
      const name = window.prompt("Thread name", state.thread?.name || "");
      if (name) {
        bridge.send("thread-action", { action, name });
      }
      state.ui.threadActionMenuOpen = false;
      renderChatHeader();
      return;
    }

    if (["fork-thread", "compact-thread", "review-thread", "interrupt-thread", "archive-thread", "unarchive-thread"].includes(action)) {
      bridge.send("thread-action", { action });
      state.ui.threadActionMenuOpen = false;
      renderChatHeader();
      return;
    }

    if (action === "respond-command-approval") {
      const requestId = button.dataset.requestId || "";
      const request = state.pendingRequests.find((entry) => String(entry?.id) === requestId);
      await respondToPendingServerRequest(request || { id: requestId }, {
        decision: parsePendingDecision(button.dataset.decision),
      });
      return;
    }

    if (action === "respond-file-change-approval") {
      const requestId = button.dataset.requestId || "";
      const request = state.pendingRequests.find((entry) => String(entry?.id) === requestId);
      await respondToPendingServerRequest(request || { id: requestId }, {
        decision: button.dataset.decision || "decline",
      });
      return;
    }

    if (action === "respond-permissions-approval") {
      const requestId = button.dataset.requestId || "";
      const request = state.pendingRequests.find((entry) => String(entry?.id) === requestId);
      await respondToPendingServerRequest(request || { id: requestId }, {
        permissions: request?.params?.permissions || {},
        scope: button.dataset.scope === "session" ? "session" : "turn",
      });
    }
  } catch (error) {
    alert(error.message);
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  event.preventDefault();

  try {
    if (form.dataset.action === "composer-form") {
      await sendComposerMessage();
      return;
    }

    if (form.dataset.action !== "respond-tool-request-user-input") {
      return;
    }

    const requestId = form.dataset.requestId || "";
    const formData = new FormData(form);
    const request = state.pendingRequests.find((entry) => String(entry?.id) === requestId);
    const questions = Array.isArray(request?.params?.questions) ? request.params.questions : [];
    const answers = {};

    for (const question of questions) {
      const key = question.id;
      const selected = String(formData.get(key) || "").trim();
      const other = String(formData.get(`${key}__other`) || "").trim();
      const finalAnswer = selected === "__other__" ? other : selected;

      if (!finalAnswer) {
        throw new Error(`Answer required for ${question.header || key}`);
      }

      answers[key] = { answers: [finalAnswer] };
    }

    await respondToPendingServerRequest(request || { id: requestId }, { answers });
  } catch (error) {
    alert(error.message);
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;

  if (target instanceof HTMLInputElement && target.id === "chatRalphLoopLimitInput") {
    const nextLimit = normalizeRalphLoopLimit(target.value);
    target.value = String(nextLimit);
    updateComposerSetting("ralphLoopLimit", nextLimit);
    renderComposer();
    return;
  }

  if (!(target instanceof HTMLSelectElement) || target.dataset.hasOther !== "true") {
    return;
  }

  const otherTarget = document.getElementById(target.dataset.otherTarget || "");
  if (!(otherTarget instanceof HTMLElement)) {
    return;
  }

  otherTarget.classList.toggle("hidden", target.value !== "__other__");
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement) || target.id !== "chatPromptInput") {
    return;
  }

  state.composer.draftText = target.value || "";
  bridge.send("composer-draft", { text: state.composer.draftText });
});

document.addEventListener("paste", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement) || target.id !== "chatPromptInput") {
    return;
  }

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
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      name: file.name || `pasted-image-${Date.now()}-${index + 1}.png`,
      url: await readFileAsDataUrl(file),
    };
  }));

  const nextAttachments = state.composer.attachments.concat(pasted.filter(Boolean));
  state.composer.attachments = nextAttachments;
  bridge.send("composer-attachments", { attachments: nextAttachments });
  renderComposer();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.ui.composerMenuOpen) {
    state.ui.composerMenuOpen = "";
    renderComposer();
    return;
  }

  if (event.key === "Escape" && state.ui.composerSettingsOpen) {
    state.ui.composerSettingsOpen = false;
    state.ui.composerMenuOpen = "";
    renderComposer();
    return;
  }

  if (event.key === "Escape" && state.ui.threadActionMenuOpen) {
    state.ui.threadActionMenuOpen = false;
    renderChatHeader();
  }
});

window.addEventListener("beforeunload", disconnectConversationSocket);

if (standaloneMode) {
  queueMicrotask(() => {
    void bootstrapStandalone().catch(console.error);
  });
}

async function bootstrapStandalone() {
  state.projectId = cleanString(initialParams.get("projectId"));
  state.threadId = cleanString(initialParams.get("threadId"));
  state.projectName = state.projectId || "Conversation";
  await loadStandaloneComposerState().catch((error) => {
    console.error("Failed to load standalone composer state", error);
  });
  renderChatHeader();
  renderComposer();
  renderConversation();

  if (!state.threadId) {
    return;
  }

  await Promise.all([
    loadThread(state.threadId),
    loadPendingRequests(),
  ]);
  connectConversationSocket();
}

async function loadStandaloneComposerState() {
  const payload = await api("/api/models");
  state.models = Array.isArray(payload.data) ? payload.data : [];
  state.composerCapabilities = payload.capabilities || { serviceTiers: [], defaultServiceTier: "" };
  normalizeStandaloneComposerSettings();
}

async function applyHostState(payload = {}) {
  const nextThreadId = cleanString(payload.threadId);
  const previousThreadId = state.threadId;

  state.active = payload.active === true;
  state.projectId = cleanString(payload.projectId);
  state.projectName = cleanString(payload.projectName);
  state.autoscroll = payload.autoscroll !== false;
  state.approveAllDangerous = payload.approveAllDangerous === true;
  state.archived = payload.archived === true;
  state.pendingRalphLoopReplay = payload.pendingRalphLoopReplay || null;
  state.pendingNewThread = payload.pendingNewThread || null;
  if (payload.composer && typeof payload.composer === "object") {
    state.composer = {
      ...state.composer,
      ...payload.composer,
      attachments: Array.isArray(payload.composer.attachments) ? payload.composer.attachments : [],
    };
  }

  if (nextThreadId !== previousThreadId) {
    state.threadId = nextThreadId;
    state.thread = null;
    state.pendingRequests = [];
    disconnectConversationSocket();
    renderConversation();

    if (!state.threadId) {
      return;
    }

    await Promise.all([
      loadThread(state.threadId),
      loadPendingRequests(),
    ]);
    connectConversationSocket();
    await maybeAutoApprovePendingRequests();
    return;
  }

  renderChatHeader();
  renderComposer();
  renderConversation();
  await maybeAutoApprovePendingRequests();

  if (state.threadId && !state.socket && state.active) {
    connectConversationSocket();
  }
}

function conversationSocketUrl() {
  return websocketUrl("/ws/events");
}

function connectConversationSocket() {
  if (!state.threadId) {
    return;
  }

  if (state.socket && (
    state.socket.readyState === WebSocket.OPEN ||
    state.socket.readyState === WebSocket.CONNECTING
  )) {
    return;
  }

  clearTimeout(state.socketRetryTimer);
  state.socketRetryTimer = null;
  state.socketShouldReconnect = true;

  const socket = new WebSocket(conversationSocketUrl());
  state.socket = socket;

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

    if (payload.type === "server-request") {
      upsertPendingServerRequest(payload.request);
      renderConversation();
      void maybeAutoApprovePendingRequests([payload.request]);
      return;
    }

    if (payload.type !== "notification") {
      return;
    }

    const message = payload.message;
    const method = typeof message?.method === "string" ? message.method : "";
    const threadId = message.params?.threadId || message.params?.thread?.id;

    if (!method) {
      return;
    }

    if (method === "serverRequest/resolved" && message.params?.requestId != null) {
      removePendingServerRequest(message.params.requestId);
      renderConversation();
    }

    if (threadId && threadId === state.threadId) {
      const handledLive = applyStreamingNotification(message);

      if (!handledLive) {
        await loadThread(state.threadId).catch(console.error);
        await loadPendingRequests().catch(console.error);
      }
    }

    if (method.startsWith("thread/")) {
      bridge.send("refresh-threads");
    }
  });

  socket.addEventListener("close", () => {
    if (state.socket !== socket) {
      return;
    }

    state.socket = null;
    if (!state.socketShouldReconnect || !state.threadId) {
      return;
    }

    clearTimeout(state.socketRetryTimer);
    state.socketRetryTimer = setTimeout(() => {
      if (!state.socket) {
        connectConversationSocket();
      }
    }, 1000);
  });

  socket.addEventListener("error", () => {
    socket.close();
  });
}

function disconnectConversationSocket() {
  state.socketShouldReconnect = false;
  clearTimeout(state.socketRetryTimer);
  state.socketRetryTimer = null;
  if (state.socket) {
    const socket = state.socket;
    state.socket = null;
    socket.close();
  }
}

async function loadThread(threadId) {
  const requestedThreadId = cleanString(threadId);
  if (!requestedThreadId) {
    state.thread = null;
    renderConversation();
    return;
  }

  const payload = await api(`/api/threads/${encodeURIComponent(requestedThreadId)}`);

  if (state.threadId !== requestedThreadId) {
    return;
  }

  state.thread = payload.data?.thread || payload.data;
  syncHostThreadSummary();
  renderConversation();
}

async function loadPendingRequests() {
  if (!state.threadId) {
    state.pendingRequests = [];
    return;
  }

  const payload = await api("/api/pending-requests");
  const requests = Array.isArray(payload.data) ? payload.data : [];
  state.pendingRequests = requests.filter((request) => request?.params?.threadId === state.threadId);
  renderConversation();
}

function syncHostThreadSummary() {
  if (!state.thread?.id) {
    return;
  }

  bridge.send("thread-summary", {
    threadId: state.thread.id,
    currentTurnId: findLatestTurnId(state.thread),
    thread: {
      id: state.thread.id,
      name: state.thread.name || "",
      preview: state.thread.preview || state.thread.name || latestAgentMessageText(state.thread) || "",
      status: state.thread.status || "",
      cwd: state.thread.cwd || "",
      updatedAt: state.thread.updatedAt || Math.floor(Date.now() / 1000),
      createdAt: state.thread.createdAt || 0,
    },
  });
}

function renderThreadActionMenu() {
  const menuExpanded = state.ui.threadActionMenuOpen ? "true" : "false";
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
      <div class="thread-menu-popover ${state.ui.threadActionMenuOpen ? "" : "hidden"}" role="menu" aria-label="Thread actions">
        <button type="button" class="thread-menu-item" data-action="rename-thread">✎ Rename</button>
        <button type="button" class="thread-menu-item" data-action="fork-thread">⑂ Fork</button>
        <button type="button" class="thread-menu-item" data-action="compact-thread">⇲ Compact</button>
        <button type="button" class="thread-menu-item" data-action="review-thread">◌ Review</button>
        <button type="button" class="thread-menu-item" data-action="interrupt-thread">■ Interrupt</button>
        <button type="button" class="thread-menu-item danger" data-action="${state.archived ? "unarchive-thread" : "archive-thread"}">⌫ ${state.archived ? "Unarchive" : "Archive"}</button>
      </div>
    </div>
  `;
}

function renderChatHeader() {
  const thread = state.thread;
  const pendingNewThread = state.pendingNewThread;

  if (!thread?.id) {
    elements.chatPaneHeader.innerHTML = `
      <div class="thread-toolbar">
        <div class="thread-title-wrap">
          <h2 class="thread-title">${escapeHtml(pendingNewThread?.title || thread?.name || thread?.preview || state.projectName || "New conversation")}</h2>
          <p class="meta">${escapeHtml(pendingNewThread ? "Sending first message..." : state.threadId ? "Loading conversation..." : "Start a new conversation below. The first prompt creates the thread.")}</p>
        </div>
      </div>
    `;
    return;
  }

  const activity = describeThreadActivity(thread);
  const threadStatusText = activity.statusText || formatStatus(thread.status);
  elements.chatPaneHeader.innerHTML = `
    <div class="thread-toolbar-controls">
      <div class="thread-toolbar-top">
        <div class="thread-toolbar">
          <div class="thread-title-wrap">
            <h2 class="thread-title" title="${escapeHtml(thread.name || thread.preview || "Untitled thread")}">${escapeHtml(thread.name || thread.preview || "Untitled thread")}</h2>
            <div class="meta thread-meta">
              <span>${escapeHtml(state.projectName || "")}</span>
              <span>·</span>
              ${renderActivityBadge(activity.isWorking ? activity.label : threadStatusText, threadStatusText, activity.isWorking ? "live" : "idle")}
              <span>·</span>
              <span>${escapeHtml(thread.cwd || "")}</span>
            </div>
          </div>
        </div>
        ${renderThreadActionMenu()}
      </div>
    </div>
  `;
}

function currentStandaloneComposerModel() {
  return state.models.find((model) => model.id === state.composerModel) || null;
}

function formatEffortLabel(effort) {
  switch (effort) {
    case "xhigh":
      return "Extra High";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    case "minimal":
      return "Minimal";
    case "none":
      return "None";
    default:
      return effort;
  }
}

function formatComposerSettingsLabel(reasoningEffort, serviceTier) {
  const labels = [];

  if (reasoningEffort) {
    labels.push(formatEffortLabel(reasoningEffort));
  }

  if (serviceTier) {
    labels.push(formatServiceTierLabel(serviceTier));
  }

  return labels.join(" · ") || "Reasoning";
}

function persistStandaloneComposerSettings() {
  localStorage.setItem("composerModel", state.composerModel || "");
  localStorage.setItem("composerEffort", state.composerEffort || "");
  localStorage.setItem("composerServiceTier", state.composerServiceTier || "");
  localStorage.setItem("composerMode", state.composer.mode === "plan" ? "plan" : "default");
  localStorage.setItem("composerApproveAllDangerous", String(state.composer.approveAllDangerous));
  localStorage.setItem("composerRalphLoopLimit", String(state.composer.ralphLoopLimit));
  localStorage.setItem("autoscroll", String(state.autoscroll));
}

function normalizeStandaloneComposerSettings() {
  const selection = resolveComposerSelection({
    models: state.models,
    requestedModelId: state.composerModel,
    requestedEffort: state.composerEffort,
    requestedServiceTier: state.composerServiceTier,
    capabilities: state.composerCapabilities,
  });

  state.composerModel = selection.modelId;
  state.composerEffort = selection.effort;
  state.composerServiceTier = selection.serviceTier;
  state.composer.ralphLoopLimit = normalizeRalphLoopLimit(state.composer.ralphLoopLimit);
  if (!["default", "plan"].includes(state.composer.mode)) {
    state.composer.mode = "default";
  }
  state.composer.modeLabel = state.composer.mode === "plan" ? "Plan" : "Chat";
  persistStandaloneComposerSettings();
}

function buildStandaloneComposerViewState() {
  normalizeStandaloneComposerSettings();

  const model = currentStandaloneComposerModel();
  const reasoningOptions = supportedReasoningEffortsForModel(model);
  const supportedEfforts = reasoningOptions.map((entry) => entry.reasoningEffort);
  const supportedServiceTiers = supportedServiceTiersForModel(model, state.composerCapabilities);
  const hasModelOptions = state.models.length > 0;
  const hasEffortOptions = supportedEfforts.length > 0 || supportedServiceTiers.length > 0;
  const modelMenuHtml = hasModelOptions
    ? state.models.map((entry) => `
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
    `).join("")
    : '<div class="composer-picker-empty">No models available</div>';

  const defaultReasoningEffort = cleanString(
    model?.defaultReasoningEffort
    || model?.default_reasoning_effort
    || model?.defaultReasoningLevel
    || model?.default_reasoning_level,
  );
  const reasoningMarkup = reasoningOptions.map((entry) => `
    <button
      type="button"
      class="composer-picker-item${entry.reasoningEffort === state.composerEffort ? " active" : ""}"
      data-action="select-composer-effort"
      data-value="${escapeHtml(entry.reasoningEffort)}"
      role="option"
      aria-selected="${entry.reasoningEffort === state.composerEffort ? "true" : "false"}"
    >
      <span class="composer-picker-check" aria-hidden="true">${entry.reasoningEffort === state.composerEffort ? "✓" : ""}</span>
      <span class="composer-picker-item-label">${escapeHtml(formatEffortLabel(entry.reasoningEffort))}${entry.reasoningEffort === defaultReasoningEffort ? " (default)" : ""}</span>
    </button>
  `).join("");
  const serviceTierMarkup = supportedServiceTiers.length > 0
    ? `
      ${reasoningMarkup ? '<div class="composer-picker-divider" aria-hidden="true"></div>' : ""}
      <div class="composer-picker-section">Service Tier</div>
      <button
        type="button"
        class="composer-picker-item${!state.composerServiceTier ? " active" : ""}"
        data-action="select-composer-service-tier"
        data-value=""
        role="option"
        aria-selected="${!state.composerServiceTier ? "true" : "false"}"
      >
        <span class="composer-picker-check" aria-hidden="true">${!state.composerServiceTier ? "✓" : ""}</span>
        <span class="composer-picker-item-label">Auto</span>
      </button>
      ${supportedServiceTiers.map((serviceTier) => `
        <button
          type="button"
          class="composer-picker-item${serviceTier === state.composerServiceTier ? " active" : ""}"
          data-action="select-composer-service-tier"
          data-value="${escapeHtml(serviceTier)}"
          role="option"
          aria-selected="${serviceTier === state.composerServiceTier ? "true" : "false"}"
        >
          <span class="composer-picker-check" aria-hidden="true">${serviceTier === state.composerServiceTier ? "✓" : ""}</span>
          <span class="composer-picker-item-label">${escapeHtml(formatServiceTierLabel(serviceTier))}</span>
        </button>
      `).join("")}
    `
    : "";

  const effortMenuHtml = reasoningMarkup || serviceTierMarkup
    ? `${reasoningMarkup}${serviceTierMarkup}`
    : '<div class="composer-picker-empty">No settings available for this model</div>';

  return {
    modelLabel: model?.displayName || model?.id || state.composerModel || "Select Model",
    effortLabel: formatComposerSettingsLabel(state.composerEffort, state.composerServiceTier),
    hasModelOptions,
    hasEffortOptions,
    modelMenuHtml,
    effortMenuHtml,
    mode: state.composer.mode === "plan" ? "plan" : "default",
    modeLabel: state.composer.mode === "plan" ? "Plan" : "Chat",
    approveAllDangerous: state.composer.approveAllDangerous,
    ralphLoop: state.composer.ralphLoop,
    ralphLoopLimit: state.composer.ralphLoopLimit,
  };
}

function snapshotComposerInputState() {
  const input = document.getElementById("chatPromptInput");

  if (!(input instanceof HTMLTextAreaElement)) {
    return null;
  }

  return {
    focused: document.activeElement === input,
    selectionStart: input.selectionStart,
    selectionEnd: input.selectionEnd,
  };
}

function restoreComposerInputState(snapshot) {
  if (!snapshot?.focused) {
    return;
  }

  requestAnimationFrame(() => {
    const input = document.getElementById("chatPromptInput");

    if (!(input instanceof HTMLTextAreaElement)) {
      return;
    }

    input.focus();
    if (typeof snapshot.selectionStart === "number" && typeof snapshot.selectionEnd === "number") {
      input.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    }
  });
}

function renderComposerAttachments() {
  if (!state.composer.attachments.length) {
    return "";
  }

  return `
    <div class="composer-attachments">
      ${state.composer.attachments.map((attachment) => `
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
          >×</button>
        </figure>
      `).join("")}
    </div>
  `;
}

function renderComposer() {
  if (standaloneMode) {
    state.composer = {
      ...state.composer,
      ...buildStandaloneComposerViewState(),
    };
  }

  const inputSnapshot = snapshotComposerInputState();
  const modelMenuOpen = state.ui.composerMenuOpen === "model";
  const effortMenuOpen = state.ui.composerMenuOpen === "effort";
  const disabled = standaloneMode ? !state.threadId : !state.projectId;
  const sendInFlight = state.composer.sendInFlight === true;

  elements.chatPaneComposer.innerHTML = `
    <form class="composer" data-action="composer-form">
      ${renderComposerAttachments()}
      <textarea id="chatPromptInput" name="text" rows="5" ${disabled ? "disabled" : ""} placeholder="Ask Codex to inspect, edit, review, search, run commands, or delegate inside the selected project.">${escapeHtml(state.composer.draftText || "")}</textarea>
      <div class="composer-row composer-footer">
        <button type="submit" class="primary-button" ${(disabled || sendInFlight) ? "disabled" : ""}>${sendInFlight ? "Sending..." : "Send"}</button>
        <div class="composer-settings">
          <button
            type="button"
            class="ghost-button composer-settings-button"
            data-action="toggle-composer-settings"
            aria-haspopup="menu"
            aria-expanded="${state.ui.composerSettingsOpen ? "true" : "false"}"
            ${disabled ? "disabled" : ""}
          >Settings</button>
          <div class="composer-settings-menu ${state.ui.composerSettingsOpen ? "" : "hidden"}" aria-label="Composer settings">
            <div class="composer-controls">
              <div class="composer-picker">
                <button type="button" class="composer-picker-trigger" data-action="toggle-composer-menu" data-menu="model" aria-haspopup="listbox" aria-expanded="${modelMenuOpen ? "true" : "false"}" ${state.composer.hasModelOptions ? "" : "disabled"}>
                  <span class="composer-picker-icon" aria-hidden="true">◎</span>
                  <span class="composer-picker-label">${escapeHtml(state.composer.modelLabel)}</span>
                </button>
                <div class="composer-picker-menu ${modelMenuOpen ? "" : "hidden"}" role="listbox" aria-label="Model">${state.composer.modelMenuHtml}</div>
              </div>
              <div class="composer-picker">
                <button type="button" class="composer-picker-trigger" data-action="toggle-composer-menu" data-menu="effort" aria-haspopup="listbox" aria-expanded="${effortMenuOpen ? "true" : "false"}" ${state.composer.hasEffortOptions ? "" : "disabled"}>
                  <span class="composer-picker-label">${escapeHtml(state.composer.effortLabel)}</span>
                </button>
                <div class="composer-picker-menu ${effortMenuOpen ? "" : "hidden"}" role="listbox" aria-label="Reasoning">${state.composer.effortMenuHtml}</div>
              </div>
              <button type="button" class="composer-mode-button ${state.composer.mode === "plan" ? "plan" : ""}" data-action="toggle-composer-mode" aria-pressed="${state.composer.mode === "plan" ? "true" : "false"}">${escapeHtml(state.composer.modeLabel)}</button>
              <button type="button" class="composer-toggle composer-toggle-inline" data-action="toggle-autoscroll" aria-pressed="${state.autoscroll ? "true" : "false"}">
                <span aria-hidden="true">${state.autoscroll ? "☑" : "☐"}</span>
                <span>Autoscroll</span>
              </button>
              <button type="button" class="composer-toggle composer-toggle-inline composer-dangerous-toggle" data-action="toggle-approve-all-dangerous" aria-pressed="${state.composer.approveAllDangerous ? "true" : "false"}">
                <span aria-hidden="true">${state.composer.approveAllDangerous ? "☑" : "☐"}</span>
                <span>Approve all dangerous</span>
              </button>
              <button type="button" class="composer-toggle composer-toggle-inline composer-ralph-loop-toggle" data-action="toggle-ralph-loop" aria-pressed="${state.composer.ralphLoop ? "true" : "false"}">
                <span aria-hidden="true">${state.composer.ralphLoop ? "☑" : "☐"}</span>
                <span>Ralph loop</span>
              </button>
              <label class="composer-number-control composer-ralph-loop-limit">
                <span class="composer-number-control-copy">
                  <span class="composer-number-control-label">Ralph loop count</span>
                  <span class="composer-number-control-hint">0 keeps looping until you stop it</span>
                </span>
                <input
                  id="chatRalphLoopLimitInput"
                  class="composer-number-input"
                  type="number"
                  min="0"
                  step="1"
                  inputmode="numeric"
                  value="${escapeHtml(String(state.composer.ralphLoopLimit))}"
                  ${disabled ? "disabled" : ""}
                >
              </label>
            </div>
          </div>
        </div>
      </div>
    </form>
  `;

  restoreComposerInputState(inputSnapshot);
}

function updateComposerSetting(key, value) {
  if (key === "autoscroll") {
    state.autoscroll = value === true;
    if (standaloneMode) {
      persistStandaloneComposerSettings();
    }
  } else if (key === "approveAllDangerous") {
    state.composer.approveAllDangerous = value === true;
    state.approveAllDangerous = state.composer.approveAllDangerous;
    if (standaloneMode) {
      persistStandaloneComposerSettings();
    }
  } else if (key === "ralphLoop") {
    state.composer.ralphLoop = value === true;
  } else if (key === "ralphLoopLimit") {
    state.composer.ralphLoopLimit = normalizeRalphLoopLimit(value);
    if (standaloneMode) {
      persistStandaloneComposerSettings();
    }
  } else if (key === "mode") {
    state.composer.mode = value === "plan" ? "plan" : "default";
    state.composer.modeLabel = state.composer.mode === "plan" ? "Plan" : "Chat";
    if (standaloneMode) {
      persistStandaloneComposerSettings();
    }
  } else if (key === "model") {
    state.composerModel = cleanString(value);
    if (standaloneMode) {
      normalizeStandaloneComposerSettings();
    }
  } else if (key === "effort") {
    state.composerEffort = cleanString(value);
    if (standaloneMode) {
      normalizeStandaloneComposerSettings();
    }
  } else if (key === "serviceTier") {
    state.composerServiceTier = cleanString(value);
    if (standaloneMode) {
      normalizeStandaloneComposerSettings();
    }
  }

  if (!standaloneMode) {
    bridge.send("composer-setting", { key, value });
  }
}

async function sendComposerMessage() {
  if (standaloneMode && !state.threadId) {
    return;
  }

  const payload = {
    text: state.composer.draftText || "",
    images: state.composer.attachments.map((attachment) => ({
      type: "image",
      url: attachment.url,
      name: attachment.name,
    })),
  };

  if (standaloneMode) {
    const model = currentStandaloneComposerModel();
    const modelId = model?.id || state.composerModel || undefined;
    const reasoningEffort = state.composerEffort || undefined;
    await api(`/api/threads/${encodeURIComponent(state.threadId)}/message`, {
      method: "POST",
      body: {
        projectId: state.projectId,
        text: payload.text,
        images: payload.images,
        model: modelId,
        effort: reasoningEffort,
        serviceTier: state.composerServiceTier || undefined,
        collaborationMode: modelId
          ? {
            mode: state.composer.mode === "plan" ? "plan" : "default",
            settings: {
              model: modelId,
              reasoning_effort: reasoningEffort || undefined,
            },
          }
          : undefined,
      },
    });
    state.composer.draftText = "";
    state.composer.attachments = [];
    renderComposer();
    await loadThread(state.threadId);
    return;
  }

  bridge.send("send-message", payload);
}

function focusComposerInput() {
  document.getElementById("chatPromptInput")?.focus();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read pasted image"));
    reader.readAsDataURL(file);
  });
}

function findLatestTurnId(thread) {
  const turns = thread?.turns || [];
  return turns.length > 0 ? turns[turns.length - 1].id : "";
}

function ensureSelectedTurn(turnId, initialStatus = "inProgress") {
  if (!state.thread || !turnId) {
    return null;
  }

  state.thread.turns = Array.isArray(state.thread.turns) ? state.thread.turns : [];
  let turn = state.thread.turns.find((entry) => entry.id === turnId);

  if (!turn) {
    turn = { id: turnId, status: initialStatus, items: [] };
    state.thread.turns = state.thread.turns.concat(turn);
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

function upsertPendingServerRequest(request) {
  if (!request?.id || request?.params?.threadId !== state.threadId) {
    return;
  }

  const requestId = String(request.id);
  const existingIndex = state.pendingRequests.findIndex((entry) => String(entry?.id) === requestId);

  if (existingIndex === -1) {
    state.pendingRequests = state.pendingRequests.concat(request);
    return;
  }

  state.pendingRequests = state.pendingRequests.map((entry, index) => (index === existingIndex ? request : entry));
}

function removePendingServerRequest(requestId) {
  const normalizedId = String(requestId || "");
  if (!normalizedId) {
    return;
  }

  state.pendingRequests = state.pendingRequests.filter((entry) => String(entry?.id) !== normalizedId);
}

async function respondToPendingServerRequest(request, result) {
  const requestId = String(request?.id || "");

  if (!requestId) {
    return;
  }

  await api(`/api/server-requests/${encodeURIComponent(requestId)}/respond`, {
    method: "POST",
    body: { result },
  });

  removePendingServerRequest(requestId);
  renderConversation();
}

async function maybeAutoApprovePendingRequests(requests = state.pendingRequests) {
  if (!state.approveAllDangerous || !Array.isArray(requests) || requests.length === 0) {
    return;
  }

  const tasks = requests.map(async (request) => {
    const requestId = String(request?.id || "");
    const result = buildAutoApprovalResult(request);

    if (!requestId || !result || state.autoApprovalInFlight.has(requestId)) {
      return;
    }

    state.autoApprovalInFlight.add(requestId);

    try {
      await respondToPendingServerRequest(request, result);
    } catch (error) {
      console.error("Failed to auto-approve pending request", error);
    } finally {
      state.autoApprovalInFlight.delete(requestId);
    }
  });

  await Promise.all(tasks);
}

function pendingServerRequestsForThread(threadId) {
  if (!threadId) {
    return [];
  }

  return state.pendingRequests.filter((request) => request?.params?.threadId === threadId);
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

function isCollapsibleItem(item) {
  return [
    "userMessage",
    "agentMessage",
    "plan",
    "reasoning",
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "dynamicToolCall",
    "collabAgentToolCall",
  ].includes(item?.type);
}

function findLatestCollapsibleItemId(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    const items = Array.isArray(turns[turnIndex]?.items) ? turns[turnIndex].items : [];

    if (!isLiveStatus(turn?.status)) {
      for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
        const item = items[itemIndex];
        if (item?.type === "agentMessage" && item?.id) {
          return item.id;
        }
      }
    }

    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (isCollapsibleItem(item) && item?.id) {
        return item.id;
      }
    }
  }

  return "";
}

function shouldExpandConversationItem(itemId, latestCollapsibleItemId = "") {
  if (!itemId) {
    return false;
  }

  return itemId === latestCollapsibleItemId;
}

function findConversationItemElement(itemId) {
  if (!itemId) {
    return null;
  }

  const escapedItemId = typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(String(itemId))
    : String(itemId).replace(/["\\]/g, "\\$&");

  return elements.conversation.querySelector(`article[data-item-id="${escapedItemId}"]`);
}

function collapseConversationItemsExcept(itemId) {
  const detailsList = elements.conversation.querySelectorAll(".collapsed-item details[data-item-id]");

  detailsList.forEach((details) => {
    details.open = details.dataset.itemId === itemId;
    if (details.open) {
      hydrateConversationDetails(details);
    }
  });
}

function keepLatestCollapsibleItemExpanded() {
  const latestCollapsibleItemId = findLatestCollapsibleItemId(state.thread);

  if (!latestCollapsibleItemId) {
    collapseConversationItemsExcept("");
    return;
  }

  collapseConversationItemsExcept(latestCollapsibleItemId);

  const article = findConversationItemElement(latestCollapsibleItemId);
  const details = article?.querySelector("details[data-item-id]");

  if (details && !details.open) {
    details.open = true;
  }

  hydrateConversationDetails(details);
}

function getPlanDisplay(item) {
  return {
    title: "Plan",
    summary: oneLine(item.text || "Plan update"),
    body: item.text || "",
  };
}

function getReasoningDisplay(item) {
  const summary = oneLine((item.summary || []).join(" ")) || oneLine((item.content || []).join(" ")) || "Reasoning";
  const body = [
    (item.summary || []).length ? `Summary\n${(item.summary || []).join("\n")}` : "",
    (item.content || []).length ? `\nContent\n${(item.content || []).join("\n")}` : "",
  ].filter(Boolean).join("\n") || summary;

  return {
    title: "Reasoning",
    summary,
    body,
  };
}

function getCommandExecutionDisplay(item) {
  const summary = oneLine(item.command || "Command");
  const meta = `${formatStatus(item.status)}${item.exitCode != null ? ` · exit ${item.exitCode}` : ""}`;

  return {
    title: "Command",
    summary,
    body: [item.command || "", meta, item.aggregatedOutput || ""].filter(Boolean).join("\n"),
    meta,
  };
}

function summarizeMessageItem(item, fallbackTitle) {
  const content = Array.isArray(item?.content) ? item.content : [];
  const text = item?.text
    || content.map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }

      if (entry?.type === "text") {
        return entry.text || "";
      }

      return "";
    }).join(" ");

  return oneLine(text) || fallbackTitle;
}

function summarizeIntermediateItems(items) {
  const count = Array.isArray(items) ? items.length : 0;

  if (!count) {
    return "No steps";
  }

  const labels = [];
  const reasoningCount = items.filter((item) => item?.type === "reasoning").length;
  const commandCount = items.filter((item) => item?.type === "commandExecution").length;
  const toolCount = items.filter((item) => ["mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(item?.type)).length;
  const fileChangeCount = items.filter((item) => item?.type === "fileChange").length;

  if (reasoningCount) {
    labels.push(`${reasoningCount} reasoning`);
  }

  if (commandCount) {
    labels.push(`${commandCount} command${commandCount === 1 ? "" : "s"}`);
  }

  if (toolCount) {
    labels.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
  }

  if (fileChangeCount) {
    labels.push(`${fileChangeCount} file change${fileChangeCount === 1 ? "" : "s"}`);
  }

  return labels.length ? labels.join(" · ") : `${count} step${count === 1 ? "" : "s"}`;
}

function renderMessageItemBody(item) {
  return `<div class="message-body">${renderMessageContent(item.content, item.text || "")}</div>`;
}

function renderFileChangeBody(item) {
  return (item.changes || []).map((change) => `
    <details>
      <summary>${escapeHtml(change.kind || "change")} · ${escapeHtml(change.path || "")}</summary>
      <pre class="diff-block">${escapeHtml(change.diff || "")}</pre>
    </details>
  `).join("");
}

function renderCollapsibleDisplayBody(display) {
  if (typeof display?.bodyHtml === "string") {
    return display.bodyHtml;
  }

  const body = display?.body || display?.summary || display?.title || "";
  return `<pre data-role="body">${escapeHtml(body)}</pre>`;
}

function patchCollapsibleConversationItem(item, display) {
  const article = findConversationItemElement(item?.id);

  if (!article) {
    return false;
  }

  const details = article.querySelector("details[data-item-id]");
  const summaryNode = article.querySelector("[data-role='summary']");
  const bodyNode = article.querySelector("[data-role='body']");
  const metaNode = article.querySelector("[data-role='meta']");

  if (!summaryNode || !details) {
    return false;
  }

  summaryNode.textContent = display.summary || display.title;

  if (metaNode) {
    metaNode.textContent = display.meta || "";
  }

  if (details.open) {
    hydrateConversationDetails(details, { force: true });
    const nextBodyNode = article.querySelector("[data-role='body']");
    if (nextBodyNode && typeof display?.bodyHtml !== "string") {
      nextBodyNode.textContent = display.body || display.summary || display.title || "";
    }
  } else if (bodyNode && typeof display?.bodyHtml !== "string") {
    bodyNode.textContent = display.body || display.summary || display.title || "";
  }

  keepLatestCollapsibleItemExpanded();
  scrollConversationToBottom();
  return true;
}

function patchStreamingConversationItem(item) {
  if (!item?.id) {
    return false;
  }

  if (item.type === "agentMessage") {
    const article = findConversationItemElement(item.id);
    const bodyNode = article?.querySelector(".message-body");

    if (!bodyNode) {
      return false;
    }

    collapseConversationItemsExcept(item.id);
    bodyNode.innerHTML = renderMessageContent(item.content, item.text || "");
    scrollConversationToBottom();
    return true;
  }

  if (item.type === "reasoning") {
    return patchCollapsibleConversationItem(item, getReasoningDisplay(item));
  }

  if (item.type === "plan") {
    return patchCollapsibleConversationItem(item, getPlanDisplay(item));
  }

  if (item.type === "commandExecution") {
    return patchCollapsibleConversationItem(item, getCommandExecutionDisplay(item));
  }

  return false;
}

function findLastItemIndexByType(items, type) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.type === type) {
      return index;
    }
  }

  return -1;
}

function splitTurnItemsForRender(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];

  if (isLiveStatus(turn?.status) || items.length < 3) {
    return null;
  }

  const firstUserIndex = items.findIndex((item) => item?.type === "userMessage");
  const lastAgentIndex = findLastItemIndexByType(items, "agentMessage");

  if (firstUserIndex === -1 || lastAgentIndex === -1 || firstUserIndex >= lastAgentIndex) {
    return null;
  }

  return {
    leadingItems: items.slice(0, firstUserIndex + 1),
    intermediateItems: items.slice(firstUserIndex + 1, lastAgentIndex).concat(items.slice(lastAgentIndex + 1)),
    finalAgentItem: items[lastAgentIndex],
  };
}

function renderCollapsibleArticle({
  bubbleClass = "agent",
  itemId = "",
  itemType = "",
  title = "Item",
  summary = "",
  meta = "",
  open = false,
  bodyClass = "",
  bodyHtml = "",
}) {
  const escapedItemId = escapeHtml(itemId);
  const escapedItemType = escapeHtml(itemType);
  const bodyClasses = ["collapsed-body"];

  if (bodyClass) {
    bodyClasses.push(bodyClass);
  }

  return `
    <article class="bubble ${bubbleClass} collapsed-item" data-item-id="${escapedItemId}" data-item-type="${escapedItemType}">
      <details data-item-id="${escapedItemId}"${open ? " open" : ""}>
        <summary class="collapsed-summary">
          <span class="collapsed-title">${escapeHtml(title)}</span>
          <span class="collapsed-text" data-role="summary">${escapeHtml(summary || title)}</span>
          ${meta ? `<span class="collapsed-meta" data-role="meta">${escapeHtml(meta)}</span>` : ""}
        </summary>
        <div class="${bodyClasses.join(" ")}">${bodyHtml}</div>
      </details>
    </article>
  `;
}

function renderIntermediateItemsBody(items, latestCollapsibleItemId = "") {
  return items.map((item) => renderItem(item, latestCollapsibleItemId)).join("");
}

function renderIntermediateItemsGroup(turn, items, latestCollapsibleItemId = "") {
  if (!Array.isArray(items) || !items.length) {
    return "";
  }

  const groupId = `${turn.id}:steps`;
  const open = shouldExpandConversationItem(groupId, latestCollapsibleItemId);

  return renderCollapsibleArticle({
    itemId: groupId,
    itemType: "turnSteps",
    title: "Steps",
    summary: summarizeIntermediateItems(items),
    open,
    bodyClass: "turn-steps-body",
    bodyHtml: open ? renderIntermediateItemsBody(items, latestCollapsibleItemId) : "",
  });
}

function renderTurnItems(turn, latestCollapsibleItemId = "") {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const groupedItems = splitTurnItemsForRender(turn);

  if (!groupedItems) {
    return items.map((item) => renderItem(item, latestCollapsibleItemId)).join("");
  }

  return [
    ...groupedItems.leadingItems.map((item) => renderItem(item, latestCollapsibleItemId)),
    renderIntermediateItemsGroup(turn, groupedItems.intermediateItems, latestCollapsibleItemId),
    renderItem(groupedItems.finalAgentItem, latestCollapsibleItemId),
  ].filter(Boolean).join("");
}

function findConversationItemRecord(itemId, thread = state.thread) {
  if (!itemId || !thread) {
    return null;
  }

  const turns = Array.isArray(thread.turns) ? thread.turns : [];

  if (itemId.endsWith(":steps")) {
    const turnId = itemId.slice(0, -":steps".length);
    const turn = turns.find((entry) => entry?.id === turnId);
    const groupedItems = splitTurnItemsForRender(turn);

    if (!turn || !groupedItems?.intermediateItems.length) {
      return null;
    }

    return {
      kind: "turnSteps",
      itemId,
      items: groupedItems.intermediateItems,
    };
  }

  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    const item = items.find((entry) => entry?.id === itemId);

    if (item) {
      return {
        kind: "item",
        item,
      };
    }
  }

  return null;
}

function renderConversationItemBodyMarkup(itemId, latestCollapsibleItemId = findLatestCollapsibleItemId(state.thread)) {
  const record = findConversationItemRecord(itemId);

  if (!record) {
    return "";
  }

  if (record.kind === "turnSteps") {
    return renderIntermediateItemsBody(record.items, latestCollapsibleItemId);
  }

  const { item } = record;

  if (item.type === "userMessage" || item.type === "agentMessage") {
    return renderMessageItemBody(item);
  }

  if (item.type === "plan") {
    return renderCollapsibleDisplayBody(getPlanDisplay(item));
  }

  if (item.type === "reasoning") {
    return renderCollapsibleDisplayBody(getReasoningDisplay(item));
  }

  if (item.type === "commandExecution") {
    return renderCollapsibleDisplayBody(getCommandExecutionDisplay(item));
  }

  if (item.type === "fileChange") {
    return renderFileChangeBody(item);
  }

  if (item.type === "mcpToolCall") {
    return renderCollapsibleDisplayBody({
      title: "MCP Tool",
      summary: `${item.server || "mcp"} · ${item.tool || "tool"}`,
      body: JSON.stringify(item, null, 2),
      meta: formatStatus(item.status),
    });
  }

  if (item.type === "dynamicToolCall") {
    return renderCollapsibleDisplayBody({
      title: "Tool Call",
      summary: item.tool || "dynamic tool",
      bodyHtml: renderToolCallBody(item),
      meta: formatStatus(item.status),
    });
  }

  if (item.type === "collabAgentToolCall") {
    return renderCollapsibleDisplayBody({
      title: "Collaboration",
      summary: `${item.tool || "agent tool"}${item.model ? ` · ${item.model}` : ""}`,
      body: JSON.stringify(item, null, 2),
      meta: formatStatus(item.status),
    });
  }

  return renderCollapsibleDisplayBody({
    title: item.type,
    summary: oneLine(JSON.stringify(item)),
    body: JSON.stringify(item, null, 2),
  });
}

function hydrateConversationDetails(details, { force = false } = {}) {
  if (!(details instanceof HTMLDetailsElement)) {
    return;
  }

  const itemId = cleanString(details.dataset.itemId);
  const bodyNode = details.querySelector(".collapsed-body");

  if (!itemId || !bodyNode) {
    return;
  }

  if (!force && bodyNode.childElementCount > 0) {
    return;
  }

  bodyNode.innerHTML = renderConversationItemBodyMarkup(itemId);
}

function handleConversationDetailsToggle(event) {
  const details = event.target;

  if (!(details instanceof HTMLDetailsElement) || !details.open) {
    return;
  }

  hydrateConversationDetails(details);
}

function renderItem(item, latestCollapsibleItemId = "") {
  const itemId = item?.id ? escapeHtml(item.id) : "";
  const itemType = escapeHtml(item?.type || "");
  const isLatestItem = item?.id && item.id === latestCollapsibleItemId;

  if (item.type === "userMessage") {
    if (!isLatestItem) {
      return renderMessageCollapsibleItem(item, "User", latestCollapsibleItemId);
    }
    return `<article class="bubble user" data-item-id="${itemId}" data-item-type="${itemType}"><strong>User</strong><div class="message-body">${renderMessageContent(item.content, item.text || "")}</div></article>`;
  }

  if (item.type === "agentMessage") {
    if (!isLatestItem) {
      return renderMessageCollapsibleItem(item, "Agent", latestCollapsibleItemId);
    }
    return `<article class="bubble agent" data-item-id="${itemId}" data-item-type="${itemType}"><strong>Agent</strong><div class="message-body">${renderMessageContent(item.content, item.text || "")}</div></article>`;
  }

  if (item.type === "plan") {
    return renderCollapsibleItem(item, getPlanDisplay(item), latestCollapsibleItemId);
  }

  if (item.type === "reasoning") {
    return renderCollapsibleItem(item, getReasoningDisplay(item), latestCollapsibleItemId);
  }

  if (item.type === "commandExecution") {
    return renderCollapsibleItem(item, getCommandExecutionDisplay(item), latestCollapsibleItemId);
  }

  if (item.type === "fileChange") {
    const summary = `${item.changes?.length || 0} file ${item.changes?.length === 1 ? "change" : "changes"}`;
    const open = shouldExpandConversationItem(item.id, latestCollapsibleItemId);
    return renderCollapsibleArticle({
      itemId: item.id || "",
      itemType: item.type || "",
      title: "File Changes",
      summary,
      open,
      bodyHtml: open ? renderFileChangeBody(item) : "",
    });
  }

  if (item.type === "mcpToolCall") {
    return renderCollapsibleItem(item, {
      title: "MCP Tool",
      summary: `${item.server || "mcp"} · ${item.tool || "tool"}`,
      body: JSON.stringify(item, null, 2),
      meta: formatStatus(item.status),
    }, latestCollapsibleItemId);
  }

  if (item.type === "dynamicToolCall") {
    return renderCollapsibleItem(item, {
      title: "Tool Call",
      summary: item.tool || "dynamic tool",
      bodyHtml: renderToolCallBody(item),
      meta: formatStatus(item.status),
    }, latestCollapsibleItemId);
  }

  if (item.type === "collabAgentToolCall") {
    return renderCollapsibleItem(item, {
      title: "Collaboration",
      summary: `${item.tool || "agent tool"}${item.model ? ` · ${item.model}` : ""}`,
      body: JSON.stringify(item, null, 2),
      meta: formatStatus(item.status),
    }, latestCollapsibleItemId);
  }

  return renderCollapsibleItem(item, {
    title: item.type,
    summary: oneLine(JSON.stringify(item)),
    body: JSON.stringify(item, null, 2),
  }, latestCollapsibleItemId);
}

function renderMessageCollapsibleItem(item, title, latestCollapsibleItemId = "") {
  const summary = summarizeMessageItem(item, title);
  const open = shouldExpandConversationItem(item?.id, latestCollapsibleItemId);

  return renderCollapsibleArticle({
    bubbleClass: item.type === "userMessage" ? "user" : "agent",
    itemId: item.id || "",
    itemType: item.type || "",
    title,
    summary,
    open,
    bodyHtml: open ? renderMessageItemBody(item) : "",
  });
}

function renderCollapsibleItem(item, display, latestCollapsibleItemId = "") {
  const title = display?.title || item?.type || "Item";
  const summary = display?.summary || title;
  const meta = display?.meta || "";
  const open = shouldExpandConversationItem(item?.id, latestCollapsibleItemId);

  return renderCollapsibleArticle({
    itemId: item.id || "",
    itemType: item.type || "",
    title,
    summary,
    meta,
    open,
    bodyHtml: open ? renderCollapsibleDisplayBody(display) : "",
  });
}

function renderMarkdown(text) {
  const key = String(text || "");
  const cached = markdownHtmlCache.get(key);

  if (cached) {
    return cached;
  }

  const html = marked.parse(key);
  markdownHtmlCache.set(key, html);

  if (markdownHtmlCache.size > MAX_MARKDOWN_CACHE_ENTRIES) {
    const oldestKey = markdownHtmlCache.keys().next().value;
    markdownHtmlCache.delete(oldestKey);
  }

  return html;
}

function renderConversation() {
  const thread = state.thread;
  const pendingNewThread = state.pendingNewThread;
  const pendingRalphLoopReplay = state.pendingRalphLoopReplay && state.pendingRalphLoopReplay.threadId === state.threadId
    ? state.pendingRalphLoopReplay
    : null;

  renderChatHeader();
  renderComposer();

  if (!state.threadId) {
    if (pendingNewThread) {
      const pendingText = oneLine(pendingNewThread.input?.text || "");
      const imageCount = Array.isArray(pendingNewThread.input?.images) ? pendingNewThread.input.images.length : 0;
      elements.conversation.innerHTML = `
        <section class="conversation-activity-banner" aria-live="polite">
          ${renderActivityBadge("Starting", "Starting conversation", "live")}
          <span>Starting your conversation...</span>
        </section>
        <section class="turn-card">
          <div class="turn-topline">
            <span>pending</span>
            <span class="turn-status-wrap">
              ${renderActivityBadge("Sending", "Sending", "small")}
              <span class="status-live">Sending</span>
            </span>
          </div>
          ${pendingText ? `<div class="bubble user"><div class="message-body"><p>${escapeHtml(pendingText)}</p></div></div>` : ""}
          ${imageCount > 0 ? `<div class="bubble user"><div class="message-body"><p>${escapeHtml(imageCount === 1 ? "1 image attached" : `${imageCount} images attached`)}</p></div></div>` : ""}
        </section>
      `;
      scrollConversationToBottom();
      return;
    }

    elements.conversation.innerHTML = `<div class="empty">No turns yet.</div>`;
    return;
  }

  if (!thread?.id) {
    elements.conversation.innerHTML = pendingNewThread
      ? `
        <section class="conversation-activity-banner" aria-live="polite">
          ${renderActivityBadge("Starting", "Starting conversation", "live")}
          <span>Creating conversation...</span>
        </section>
      `
      : `<div class="empty loading">Loading conversation...</div>`;
    scrollConversationToBottom();
    return;
  }

  const pendingRequests = pendingServerRequestsForThread(thread.id);
  const latestCollapsibleItemId = findLatestCollapsibleItemId(thread);

  if (!thread?.turns?.length && pendingRequests.length === 0) {
    elements.conversation.innerHTML = `<div class="empty">No turns yet.</div>`;
    scrollConversationToBottom();
    return;
  }

  const activity = describeThreadActivity(thread);
  const pendingBanner = pendingRequests.length ? `
    <section class="conversation-activity-banner" aria-live="polite">
      ${renderActivityBadge(pendingRequests.some((request) => request.method === "item/tool/requestUserInput") ? "Needs Input" : "Needs Approval", "pending", "live")}
      <span>${escapeHtml(pendingRequests.length === 1 ? "Conversation is waiting for one response." : `Conversation is waiting for ${pendingRequests.length} responses.`)}</span>
    </section>
  ` : "";
  const activityBanner = activity.isWorking ? `
    <section class="conversation-activity-banner" aria-live="polite">
      ${renderActivityBadge(activity.label, activity.statusText, "live")}
      <span>Conversation is actively working.</span>
    </section>
  ` : "";
  const ralphLoopBanner = pendingRalphLoopReplay ? `
    <section class="conversation-activity-banner conversation-ralph-loop-banner" aria-live="polite">
      ${renderActivityBadge("Ralph Loop", "waiting", "live")}
      <span>Continuing in ${escapeHtml(String(pendingRalphLoopReplay.remainingSeconds))} second${pendingRalphLoopReplay.remainingSeconds === 1 ? "" : "s"}.</span>
    </section>
  ` : "";

  elements.conversation.innerHTML = `${pendingBanner}${activityBanner}${ralphLoopBanner}${thread.turns.map((turn) => {
    const items = renderTurnItems(turn, latestCollapsibleItemId);
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
  }).join("")}${pendingRequests.map(renderPendingServerRequest).join("")}`;

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

function applyStreamingNotification(message) {
  const method = typeof message?.method === "string" ? message.method : "";
  const params = message?.params || {};
  const threadId = params.threadId || params.thread?.id;

  if (!method || !threadId || threadId !== state.threadId || !state.thread) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  state.thread.updatedAt = now;

  if (method === "turn/started") {
    const turn = params.turn || {};
    ensureSelectedTurn(turn.id, turn.status || "inProgress");
    state.thread.status = "inProgress";
    syncHostThreadSummary();
    renderConversation();
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
    state.thread.status = completedTurn.status || state.thread.status || "completed";
    syncHostThreadSummary();
    renderConversation();
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

    syncHostThreadSummary();
    renderConversation();
    return true;
  }

  const turn = ensureSelectedTurn(params.turnId, "inProgress");
  if (!turn) {
    return false;
  }

  if (method === "item/agentMessage/delta") {
    const item = ensureTurnItem(turn, params.itemId, "agentMessage");
    item.text = `${item.text || ""}${params.delta || ""}`;
    syncHostThreadSummary();
    if (!patchStreamingConversationItem(item)) {
      renderConversation();
    }
    return true;
  }

  if (method === "item/commandExecution/outputDelta") {
    const item = ensureTurnItem(turn, params.itemId, "commandExecution");
    item.command = item.command || "";
    item.commandActions = Array.isArray(item.commandActions) ? item.commandActions : [];
    item.cwd = item.cwd || state.thread.cwd || "";
    item.status = item.status || "inProgress";
    item.aggregatedOutput = `${item.aggregatedOutput || ""}${params.delta || ""}`;
    if (!patchStreamingConversationItem(item)) {
      renderConversation();
    }
    return true;
  }

  if (method === "item/reasoning/textDelta") {
    const item = ensureTurnItem(turn, params.itemId, "reasoning");
    item.content = Array.isArray(item.content) ? item.content : [];
    item.summary = Array.isArray(item.summary) ? item.summary : [];
    appendIndexedDelta(item, "content", params.contentIndex, params.delta || "");
    if (!patchStreamingConversationItem(item)) {
      renderConversation();
    }
    return true;
  }

  if (method === "item/reasoning/summaryTextDelta") {
    const item = ensureTurnItem(turn, params.itemId, "reasoning");
    item.content = Array.isArray(item.content) ? item.content : [];
    item.summary = Array.isArray(item.summary) ? item.summary : [];
    appendIndexedDelta(item, "summary", params.summaryIndex, params.delta || "");
    if (!patchStreamingConversationItem(item)) {
      renderConversation();
    }
    return true;
  }

  if (method === "item/reasoning/summaryPartAdded") {
    const item = ensureTurnItem(turn, params.itemId, "reasoning");
    item.content = Array.isArray(item.content) ? item.content : [];
    item.summary = Array.isArray(item.summary) ? item.summary : [];
    appendIndexedDelta(item, "summary", params.summaryIndex, "");
    if (!patchStreamingConversationItem(item)) {
      renderConversation();
    }
    return true;
  }

  if (method === "item/plan/delta") {
    const item = ensureTurnItem(turn, params.itemId, "plan");
    item.text = `${item.text || ""}${params.delta || ""}`;
    if (!patchStreamingConversationItem(item)) {
      renderConversation();
    }
    return true;
  }

  if (method === "thread/status/changed" && params.status) {
    state.thread.status = params.status;
    syncHostThreadSummary();
    renderConversation();
    return true;
  }

  if (method === "thread/name/updated") {
    state.thread.name = params.threadName || state.thread.name;
    syncHostThreadSummary();
    renderConversation();
    return true;
  }

  return false;
}

