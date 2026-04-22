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
import {
  captureHostComposerRenderState,
  createChatPaneComposer,
  mergeIncomingHostComposerState,
} from "./chat-pane-composer.mjs";
import { createChatPaneConversation } from "./chat-pane-conversation.mjs";
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

const {
  focusComposerInput,
  loadStandaloneComposerState,
  readFileAsDataUrl,
  renderComposer,
  sendComposerMessage,
  updateComposerSetting,
} = createChatPaneComposer({
  state,
  elements,
  standaloneMode,
  bridge,
  api,
  cleanString,
  escapeHtml,
  formatServiceTierLabel,
  resolveComposerSelection,
  supportedReasoningEffortsForModel,
  supportedServiceTiersForModel,
  normalizeRalphLoopLimit,
});

const {
  applyStreamingNotification,
  handleConversationDetailsToggle,
  latestAgentMessageText,
  maybeAutoApprovePendingRequests,
  removePendingServerRequest,
  renderConversation,
  respondToPendingServerRequest,
  upsertPendingServerRequest,
} = createChatPaneConversation({
  state,
  elements,
  bridge,
  api,
  buildAutoApprovalResult,
  renderChatHeader,
  findLatestTurnId,
  ensureSelectedTurn,
  ensureTurnItem,
  appendIndexedDelta,
  syncHostThreadSummary,
  oneLine,
  escapeHtml,
  formatStatus,
  isLiveStatus,
  describeStatusActivity,
  describeThreadActivity,
  renderActivityBadge,
  renderMessageContent,
  renderPendingServerRequest,
  renderToolCallBody,
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

function activeComposerDraftText() {
  const input = document.getElementById("chatPromptInput");

  if (!(input instanceof HTMLTextAreaElement) || document.activeElement !== input) {
    return undefined;
  }

  return input.value || "";
}

function composerRenderSignature() {
  return JSON.stringify(captureHostComposerRenderState(state));
}

async function applyHostState(payload = {}) {
  const nextThreadId = cleanString(payload.threadId);
  const previousThreadId = state.threadId;
  const previousComposerSignature = composerRenderSignature();
  const focusedDraftText = activeComposerDraftText();

  state.active = payload.active === true;
  state.projectId = cleanString(payload.projectId);
  state.projectName = cleanString(payload.projectName);
  state.autoscroll = payload.autoscroll !== false;
  state.approveAllDangerous = payload.approveAllDangerous === true;
  state.archived = payload.archived === true;
  state.pendingRalphLoopReplay = payload.pendingRalphLoopReplay || null;
  state.pendingNewThread = payload.pendingNewThread || null;
  if (payload.composer && typeof payload.composer === "object") {
    state.composer = mergeIncomingHostComposerState(state.composer, payload.composer, {
      draftTextOverride: focusedDraftText,
    });
  }
  state.threadId = nextThreadId;
  const shouldRenderComposer = previousComposerSignature !== composerRenderSignature();

  if (nextThreadId !== previousThreadId) {
    state.thread = null;
    state.pendingRequests = [];
    disconnectConversationSocket();
    if (shouldRenderComposer) {
      renderComposer();
    }
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

  if (shouldRenderComposer) {
    renderComposer();
  }
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
