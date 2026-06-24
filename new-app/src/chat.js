import {
  createAttachmentId,
  guessImageExtension,
  readFileAsDataUrl,
} from "./attachment-utils.mjs";
import {
  createAppImageEditor,
  createImageEditorState,
} from "./app-image-editor.mjs";
import {
  STORAGE_KEYS,
  api,
  applyTheme,
  cleanString,
  currentTheme,
  defaultReasoningEffortForModel,
  escapeHtml,
  formatEffortLabel,
  formatServiceTierLabel,
  itemText,
  nextTheme,
  resolveComposerModel,
  saveTheme,
  supportedReasoningEffortsForModel,
  supportedServiceTiersForModel,
  threadTitle,
  toArray,
  updateThemeToggle,
  websocketUrl,
} from "./shared.js";

const params = new URLSearchParams(window.location.search);
document.body.classList.toggle("is-embedded", window.parent !== window);

const state = {
  projects: [],
  selectedProjectId: params.get("projectId") || localStorage.getItem(STORAGE_KEYS.projectId) || "",
  selectedThreadId: params.get("threadId") || localStorage.getItem(STORAGE_KEYS.threadId) || "",
  selectedThread: null,
  threadLoading: false,
  messages: [],
  pendingRequests: [],
  composerAttachments: [],
  imageEditor: createImageEditorState(),
  models: [],
  modelCapabilities: { serviceTiers: [], defaultServiceTier: "" },
  settingsOpen: false,
  settingsMenuOpen: "",
  chatSettings: {
    model: localStorage.getItem(STORAGE_KEYS.chatModel) || "",
    effort: localStorage.getItem(STORAGE_KEYS.chatEffort) || "",
    serviceTier: localStorage.getItem(STORAGE_KEYS.chatServiceTier) || "",
    mode: localStorage.getItem(STORAGE_KEYS.chatMode) === "plan" ? "plan" : "default",
    approvalPolicy: localStorage.getItem(STORAGE_KEYS.chatApprovalPolicy) || "",
    sandboxMode: localStorage.getItem(STORAGE_KEYS.chatSandboxMode) || "",
    summary: localStorage.getItem(STORAGE_KEYS.chatSummary) || "",
    personality: localStorage.getItem(STORAGE_KEYS.chatPersonality) || "",
  },
  socket: null,
  socketRetryTimer: null,
  sending: false,
  currentTurnId: "",
  queuedMessages: [],
  queueDraining: false,
  followOutput: true,
};

const elements = {
  workspaceKicker: document.getElementById("workspaceKicker"),
  workspaceTitle: document.getElementById("workspaceTitle"),
  pendingRequests: document.getElementById("pendingRequests"),
  transcript: document.getElementById("transcript"),
  composerForm: document.getElementById("composerForm"),
  composerAttachments: document.getElementById("composerAttachments"),
  promptInput: document.getElementById("promptInput"),
  composerHint: document.getElementById("composerHint"),
  sendButton: document.getElementById("sendButton"),
  openChatButton: document.getElementById("openChatButton"),
  settingsButton: document.getElementById("settingsButton"),
  settingsMenu: document.getElementById("settingsMenu"),
  modelSelect: document.getElementById("modelSelect"),
  effortSelect: document.getElementById("effortSelect"),
  serviceTierSelect: document.getElementById("serviceTierSelect"),
  modeSelect: document.getElementById("modeSelect"),
  approvalPolicySelect: document.getElementById("approvalPolicySelect"),
  sandboxModeSelect: document.getElementById("sandboxModeSelect"),
  summarySelect: document.getElementById("summarySelect"),
  personalitySelect: document.getElementById("personalitySelect"),
  themeToggle: document.getElementById("themeToggle"),
  scrollBottomButton: document.getElementById("scrollBottomButton"),
  imageEditorModal: document.getElementById("imageEditorModal"),
  imageEditorCanvasWrap: document.getElementById("imageEditorCanvasWrap"),
  imageEditorPreviewImage: document.getElementById("imageEditorPreviewImage"),
  imageEditorOverlayCanvas: document.getElementById("imageEditorOverlayCanvas"),
  imageEditorColor: document.getElementById("imageEditorColor"),
};

const SCROLL_BOTTOM_THRESHOLD = 72;
let imageEditor;

function selectedProject() {
  return state.projects.find((project) => project.id === state.selectedProjectId) || state.projects[0] || null;
}

function selectedModel() {
  return resolveComposerModel(state.models, state.chatSettings.model, selectedProject()?.defaultModel || "");
}

function optionHtml(value, label, selectedValue) {
  const selected = value === selectedValue ? " selected" : "";
  return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
}

function persistChatSettings() {
  localStorage.setItem(STORAGE_KEYS.chatModel, state.chatSettings.model || "");
  localStorage.setItem(STORAGE_KEYS.chatEffort, state.chatSettings.effort || "");
  localStorage.setItem(STORAGE_KEYS.chatServiceTier, state.chatSettings.serviceTier || "");
  localStorage.setItem(STORAGE_KEYS.chatMode, state.chatSettings.mode === "plan" ? "plan" : "default");
  localStorage.setItem(STORAGE_KEYS.chatApprovalPolicy, state.chatSettings.approvalPolicy || "");
  localStorage.setItem(STORAGE_KEYS.chatSandboxMode, state.chatSettings.sandboxMode || "");
  localStorage.setItem(STORAGE_KEYS.chatSummary, state.chatSettings.summary || "");
  localStorage.setItem(STORAGE_KEYS.chatPersonality, state.chatSettings.personality || "");
}

function normalizeChatSettings() {
  const model = selectedModel();
  const modelId = cleanString(model?.id || model?.model || state.chatSettings.model);
  const reasoningOptions = supportedReasoningEffortsForModel(model);
  const supportedEfforts = reasoningOptions.map((entry) => entry.reasoningEffort);
  const defaultEffort = defaultReasoningEffortForModel(model);
  const serviceTiers = supportedServiceTiersForModel(model, state.modelCapabilities);

  state.chatSettings.model = modelId;
  if (supportedEfforts.length > 0 && !supportedEfforts.includes(state.chatSettings.effort)) {
    state.chatSettings.effort = supportedEfforts.includes(defaultEffort) ? defaultEffort : supportedEfforts[0];
  } else if (supportedEfforts.length === 0 && !state.chatSettings.effort) {
    state.chatSettings.effort = defaultEffort;
  }
  if (state.chatSettings.serviceTier && !serviceTiers.includes(state.chatSettings.serviceTier)) {
    state.chatSettings.serviceTier = "";
  }
  state.chatSettings.mode = state.chatSettings.mode === "plan" ? "plan" : "default";
}

function renderSettings() {
  normalizeChatSettings();

  const model = selectedModel();
  const reasoningOptions = supportedReasoningEffortsForModel(model);
  const serviceTiers = supportedServiceTiersForModel(model, state.modelCapabilities);

  elements.settingsMenu.classList.toggle("hidden", !state.settingsOpen);
  elements.settingsButton.setAttribute("aria-expanded", state.settingsOpen ? "true" : "false");
  elements.modelSelect.innerHTML = state.models.length > 0
    ? state.models.map((entry) => optionHtml(entry.id, entry.displayName || entry.id, state.chatSettings.model)).join("")
    : optionHtml("", "No models available", "");
  elements.modelSelect.disabled = state.models.length === 0;
  elements.effortSelect.innerHTML = reasoningOptions.length > 0
    ? reasoningOptions.map((entry) => optionHtml(entry.reasoningEffort, `${formatEffortLabel(entry.reasoningEffort)}${entry.reasoningEffort === defaultReasoningEffortForModel(model) ? " (default)" : ""}`, state.chatSettings.effort)).join("")
    : optionHtml("", "Model default", "");
  elements.effortSelect.disabled = reasoningOptions.length === 0;
  elements.serviceTierSelect.innerHTML = [
    optionHtml("", "Auto", state.chatSettings.serviceTier),
    ...serviceTiers.map((tier) => optionHtml(tier, formatServiceTierLabel(tier), state.chatSettings.serviceTier)),
  ].join("");
  elements.modeSelect.value = state.chatSettings.mode;
  elements.approvalPolicySelect.value = state.chatSettings.approvalPolicy;
  elements.sandboxModeSelect.value = state.chatSettings.sandboxMode;
  elements.summarySelect.value = state.chatSettings.summary;
  elements.personalitySelect.value = state.chatSettings.personality;
}

function updateChatSetting(key, value) {
  state.chatSettings[key] = cleanString(value);
  if (key === "mode") {
    state.chatSettings.mode = value === "plan" ? "plan" : "default";
  }
  if (key === "model") {
    state.chatSettings.effort = "";
    state.chatSettings.serviceTier = "";
  }
  normalizeChatSettings();
  persistChatSettings();
  renderSettings();
}

function chatRequestSettings() {
  normalizeChatSettings();
  const model = selectedModel();
  const modelId = cleanString(model?.id || state.chatSettings.model);
  const effort = cleanString(state.chatSettings.effort);
  const body = {
    model: modelId || undefined,
    effort: effort || undefined,
    serviceTier: cleanString(state.chatSettings.serviceTier) || undefined,
    approvalPolicy: cleanString(state.chatSettings.approvalPolicy) || undefined,
    sandboxMode: cleanString(state.chatSettings.sandboxMode) || undefined,
    summary: cleanString(state.chatSettings.summary) || undefined,
    personality: cleanString(state.chatSettings.personality) || undefined,
  };

  if (modelId) {
    body.collaborationMode = {
      mode: state.chatSettings.mode === "plan" ? "plan" : "default",
      settings: {
        model: modelId,
        reasoning_effort: effort || undefined,
      },
    };
  }

  return body;
}

imageEditor = createAppImageEditor({
  state,
  elements,
  actions: {
    renderComposerAttachments,
    syncModalOpenState() {
      document.body.classList.toggle("has-modal-open", state.imageEditor.open);
    },
  },
});

function renderComposerAttachments() {
  if (state.composerAttachments.length === 0) {
    elements.composerAttachments.innerHTML = "";
    elements.composerAttachments.classList.add("hidden");
    return;
  }

  elements.composerAttachments.classList.remove("hidden");
  elements.composerAttachments.innerHTML = state.composerAttachments.map((attachment) => `
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
        aria-label="Remove image"
      >×</button>
    </figure>
  `).join("");
}

async function handleComposerPaste(event) {
  const clipboardItems = Array.from(event.clipboardData?.items || []);
  const imageItems = clipboardItems.filter((item) => item.type.startsWith("image/"));

  if (imageItems.length === 0) {
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
  setSending(state.sending);
}

function notifyParent(type, detail = {}) {
  if (window.parent === window) {
    return;
  }
  window.parent.postMessage({ source: "new-app-chat", type, ...detail }, window.location.origin);
}

function replaceUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("projectId");
  url.searchParams.delete("threadId");
  if (state.selectedProjectId) {
    url.searchParams.set("projectId", state.selectedProjectId);
  }
  if (state.selectedThreadId) {
    url.searchParams.set("threadId", state.selectedThreadId);
  }
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function syncTheme(theme = currentTheme(), { notify = false } = {}) {
  const normalizedTheme = applyTheme(theme);
  updateThemeToggle(elements.themeToggle, normalizedTheme);

  if (notify) {
    notifyParent("theme-changed", { theme: normalizedTheme });
  }
}

function scrollRoot() {
  return document.scrollingElement || document.documentElement;
}

function isAtPageBottom() {
  const root = scrollRoot();
  return root.scrollHeight - root.scrollTop - root.clientHeight <= SCROLL_BOTTOM_THRESHOLD;
}

function updateScrollBottomButton() {
  elements.scrollBottomButton.classList.toggle("hidden", isAtPageBottom());
}

function scrollToConversationBottom({ behavior = "smooth" } = {}) {
  const root = scrollRoot();
  root.scrollTo({
    top: root.scrollHeight,
    behavior,
  });
  state.followOutput = true;
  window.setTimeout(updateScrollBottomButton, behavior === "smooth" ? 250 : 0);
}

function afterConversationRender() {
  window.requestAnimationFrame(() => {
    if (state.followOutput) {
      scrollToConversationBottom({ behavior: "auto" });
    } else {
      updateScrollBottomButton();
    }
  });
}

function setSending(value) {
  state.sending = Boolean(value);
  elements.sendButton.disabled = !selectedProject();
  elements.promptInput.disabled = !selectedProject();
}

function clearComposer() {
  elements.promptInput.value = "";
  state.composerAttachments = [];
  renderComposerAttachments();
}

function addMessage(message) {
  state.messages = state.messages.concat({
    id: crypto.randomUUID(),
    role: message.role || "system",
    text: message.text || "",
    meta: message.meta || "",
    streaming: Boolean(message.streaming),
    itemId: message.itemId || "",
  });
  renderTranscript();
}

function upsertAssistantDelta({ itemId, delta, meta }) {
  if (!itemId || !delta) {
    return;
  }

  const existingIndex = state.messages.findIndex((message) => message.itemId === itemId);
  if (existingIndex === -1) {
    state.messages = state.messages.concat({
      id: crypto.randomUUID(),
      role: "assistant",
      text: delta,
      meta: meta || "Assistant",
      streaming: true,
      itemId,
    });
  } else {
    state.messages = state.messages.map((message, index) => index === existingIndex
      ? { ...message, text: `${message.text || ""}${delta}`, streaming: true }
      : message);
  }

  renderTranscript();
}

function finishAssistantItem(itemId) {
  if (!itemId) {
    return;
  }

  state.messages = state.messages.map((message) => message.itemId === itemId
    ? { ...message, streaming: false }
    : message);
  renderTranscript();
}

function renderHeader() {
  const project = selectedProject();
  elements.workspaceKicker.textContent = project?.cwd || "No project selected";
  elements.workspaceTitle.textContent = state.selectedThread ? threadTitle(state.selectedThread) : project?.name || "Conversation";
  elements.workspaceTitle.title = elements.workspaceTitle.textContent;
  elements.composerHint.textContent = state.queuedMessages.length
    ? `${state.queuedMessages.length} queued.`
    : state.selectedThreadId
    ? `Thread ${state.selectedThreadId.slice(0, 8)} is active.`
    : "A new thread starts automatically on first send.";
  setSending(state.sending);
}

function renderTranscript() {
  if (state.messages.length === 0) {
    elements.transcript.innerHTML = `
      <div class="empty-state">
        <h3>${state.threadLoading ? "Loading conversation" : "Start a focused Codex thread"}</h3>
        <p>${state.threadLoading ? "Fetching the selected conversation history." : "Select a conversation or write a prompt to start a new one."}</p>
      </div>
    `;
    afterConversationRender();
    return;
  }

  elements.transcript.innerHTML = state.messages.map((message) => `
    <article class="message message-${escapeHtml(message.role)}">
      <div class="message-meta">
        <span>${escapeHtml(message.role === "user" ? "You" : message.meta || "System")}</span>
        ${message.streaming ? "<span>Streaming</span>" : ""}
      </div>
      <div class="message-body">${escapeHtml(message.text)}</div>
    </article>
  `).join("");
  afterConversationRender();
}

function commandText(item) {
  return [
    item.command ? `$ ${item.command}` : "Command",
    item.status ? `status: ${item.status}` : "",
    item.exitCode != null ? `exit: ${item.exitCode}` : "",
    item.aggregatedOutput || "",
  ].filter(Boolean).join("\n");
}

function fileChangeText(item) {
  return [
    item.path || item.filePath || "File change",
    item.status ? `status: ${item.status}` : "",
    item.diff || item.summary || "",
  ].filter(Boolean).join("\n");
}

function toolText(item) {
  return [
    item.tool || item.server || item.type || "Tool call",
    item.status ? `status: ${item.status}` : "",
    item.result ? JSON.stringify(item.result, null, 2) : "",
  ].filter(Boolean).join("\n");
}

function messageFromItem(item, turnIndex, itemIndex) {
  const id = item?.id || `${turnIndex}-${itemIndex}`;
  const type = item?.type || "";

  if (type === "userMessage") {
    return { id, role: "user", meta: "You", text: itemText(item), itemId: item?.id || "" };
  }
  if (type === "agentMessage") {
    return { id, role: "assistant", meta: "Assistant", text: itemText(item), itemId: item?.id || "" };
  }
  if (type === "plan") {
    return { id, role: "system", meta: "Plan", text: itemText(item), itemId: item?.id || "" };
  }
  if (type === "reasoning") {
    return { id, role: "system", meta: "Reasoning", text: itemText(item), itemId: item?.id || "" };
  }
  if (type === "commandExecution") {
    return { id, role: "system", meta: "Command", text: commandText(item), itemId: item?.id || "" };
  }
  if (type === "fileChange") {
    return { id, role: "system", meta: "File Change", text: fileChangeText(item), itemId: item?.id || "" };
  }
  if (["mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(type)) {
    return { id, role: "system", meta: "Tool", text: toolText(item), itemId: item?.id || "" };
  }

  const text = itemText(item);
  return text ? { id, role: "system", meta: type || "Item", text, itemId: item?.id || "" } : null;
}

function messagesFromThread(thread) {
  const messages = [];
  toArray(thread?.turns).forEach((turn, turnIndex) => {
    toArray(turn?.items).forEach((item, itemIndex) => {
      const message = messageFromItem(item, turnIndex, itemIndex);
      if (message?.text) {
        messages.push(message);
      }
    });
  });
  return messages;
}

function requestSummary(request) {
  const method = cleanString(request?.method) || "Approval request";
  const requestParams = request?.params || {};

  if (method === "item/commandExecution/requestApproval") {
    return cleanString(requestParams.command || requestParams.cmd) || "Command approval";
  }
  if (method === "item/fileChange/requestApproval") {
    return cleanString(requestParams.path || requestParams.filePath) || "File change approval";
  }
  if (method === "item/permissions/requestApproval") {
    return "Permission approval";
  }

  return method;
}

function renderPendingRequests() {
  elements.pendingRequests.classList.toggle("hidden", state.pendingRequests.length === 0);

  if (state.pendingRequests.length === 0) {
    elements.pendingRequests.innerHTML = "";
    return;
  }

  elements.pendingRequests.innerHTML = state.pendingRequests.map((request) => `
    <article class="approval-row" data-request-id="${escapeHtml(String(request.id))}">
      <div>
        <strong>${escapeHtml(requestSummary(request))}</strong>
        <span>${escapeHtml(cleanString(request.method) || "server request")}</span>
      </div>
      <div class="approval-actions">
        <button type="button" class="secondary-button" data-action="deny-request" data-id="${escapeHtml(String(request.id))}" aria-label="Deny request" title="Deny request">×</button>
        <button type="button" class="primary-button" data-action="approve-request" data-id="${escapeHtml(String(request.id))}" aria-label="Approve request" title="Approve request">✓</button>
      </div>
    </article>
  `).join("");
}

async function loadBoot() {
  const boot = await api("/boot");
  state.projects = Array.isArray(boot.projects) ? boot.projects : [];

  if (!state.projects.some((project) => project.id === state.selectedProjectId)) {
    state.selectedProjectId = state.projects[0]?.id || "";
  }
  if (state.selectedProjectId) {
    localStorage.setItem(STORAGE_KEYS.projectId, state.selectedProjectId);
  }

  state.pendingRequests = Array.isArray(boot.pendingRequests) ? boot.pendingRequests : [];
  renderPendingRequests();
  renderSettings();
  renderHeader();
}

async function loadModels() {
  const payload = await api("/models");
  state.models = Array.isArray(payload.data) ? payload.data : [];
  state.modelCapabilities = payload.capabilities || { serviceTiers: [], defaultServiceTier: "" };
  renderSettings();
}

async function loadThread(threadId = state.selectedThreadId) {
  const normalizedThreadId = String(threadId || "");
  state.selectedThreadId = normalizedThreadId;
  state.selectedThread = null;
  state.threadLoading = Boolean(normalizedThreadId);
  state.messages = [];

  if (normalizedThreadId) {
    localStorage.setItem(STORAGE_KEYS.threadId, normalizedThreadId);
  } else {
    localStorage.removeItem(STORAGE_KEYS.threadId);
  }

  replaceUrl();
  renderHeader();
  renderTranscript();

  if (!normalizedThreadId) {
    state.threadLoading = false;
    renderHeader();
    notifyParent("thread-selected", { threadId: "" });
    return;
  }

  try {
    const payload = await api(`/threads/${encodeURIComponent(normalizedThreadId)}`);
    if (state.selectedThreadId !== normalizedThreadId) {
      return;
    }
    state.selectedThread = payload.data?.thread || payload.data || null;
    state.messages = messagesFromThread(state.selectedThread);
    state.currentTurnId = latestTurnId(state.selectedThread);
  } catch (error) {
    state.selectedThread = null;
    state.currentTurnId = "";
    state.messages = [{ id: crypto.randomUUID(), role: "system", meta: "Thread error", text: error.message }];
  } finally {
    if (state.selectedThreadId === normalizedThreadId) {
      state.threadLoading = false;
      renderHeader();
      renderTranscript();
      notifyParent("thread-selected", { threadId: normalizedThreadId });
    }
  }
}

function latestTurnId(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  return turns.length > 0 ? cleanString(turns[turns.length - 1]?.id) : "";
}

function applyNotification(message) {
  const method = cleanString(message?.method);
  const notificationParams = message?.params || {};
  const threadId = String(notificationParams.threadId || notificationParams.thread?.id || "");

  if (method.startsWith("thread/") || method === "turn/completed" || method === "turn/aborted") {
    notifyParent("threads-changed");
  }

  if (threadId && state.selectedThreadId && threadId !== state.selectedThreadId) {
    return;
  }

  if (threadId && !state.selectedThreadId) {
    state.selectedThreadId = threadId;
    localStorage.setItem(STORAGE_KEYS.threadId, threadId);
    replaceUrl();
    notifyParent("thread-selected", { threadId });
  }

  if (notificationParams.turnId) {
    state.currentTurnId = cleanString(notificationParams.turnId);
  }

  if (method === "item/agentMessage/delta") {
    upsertAssistantDelta({
      itemId: notificationParams.itemId,
      delta: notificationParams.delta || "",
      meta: "Assistant",
    });
    return;
  }

  if (method === "item/completed") {
    finishAssistantItem(notificationParams.item?.id || notificationParams.itemId);
    return;
  }

  if (method === "turn/completed" || method === "turn/aborted" || method === "thread/closed") {
    if (!notificationParams.turnId || notificationParams.turnId === state.currentTurnId) {
      state.currentTurnId = "";
    }
    setSending(false);
    if (state.selectedThreadId) {
      void loadThread(state.selectedThreadId);
    }
    void drainQueuedMessages();
    return;
  }

  if (method === "error") {
    state.currentTurnId = "";
    setSending(false);
    addMessage({ role: "system", meta: "Error", text: notificationParams.message || "Codex reported an error." });
    void drainQueuedMessages();
  }
}

function upsertPendingRequest(request) {
  const requestId = String(request?.id || "");
  if (!requestId) {
    return;
  }

  const existingIndex = state.pendingRequests.findIndex((item) => String(item.id) === requestId);
  state.pendingRequests = existingIndex === -1
    ? state.pendingRequests.concat(request)
    : state.pendingRequests.map((item, index) => (index === existingIndex ? request : item));
  renderPendingRequests();
}

function removePendingRequest(requestId) {
  const normalizedId = String(requestId || "");
  state.pendingRequests = state.pendingRequests.filter((request) => String(request.id) !== normalizedId);
  renderPendingRequests();
}

function connectEvents() {
  if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) {
    return;
  }

  clearTimeout(state.socketRetryTimer);

  const socket = new WebSocket(websocketUrl("/events"));
  state.socket = socket;

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

    if (payload.type === "server-request") {
      upsertPendingRequest(payload.request);
      return;
    }

    if (payload.type === "notification") {
      if (payload.message?.method === "serverRequest/resolved" && payload.message?.params?.requestId != null) {
        removePendingRequest(payload.message.params.requestId);
      }
      applyNotification(payload.message);
    }
  });

  socket.addEventListener("close", () => {
    if (state.socket !== socket) {
      return;
    }

    state.socket = null;
    state.socketRetryTimer = setTimeout(connectEvents, 1000);
  });

  socket.addEventListener("error", () => {
    socket.close();
  });
}

function draftFromComposer() {
  const project = selectedProject();
  const prompt = cleanString(elements.promptInput.value);
  const pendingAttachments = state.composerAttachments.slice();
  const images = pendingAttachments.map((attachment) => ({
    type: "image",
    url: attachment.url,
    name: attachment.name,
  }));

  if (!project || (!prompt && images.length === 0)) {
    return null;
  }

  return {
    project,
    prompt,
    pendingAttachments,
    images,
    settings: chatRequestSettings(),
  };
}

function restoreDraftToComposer(draft) {
  if (elements.promptInput.value || state.composerAttachments.length > 0) {
    state.queuedMessages.unshift(draft);
    renderHeader();
    return;
  }

  elements.promptInput.value = draft.prompt;
  state.composerAttachments = draft.pendingAttachments;
  renderComposerAttachments();
}

async function interruptCurrentTurn() {
  if (!state.selectedThreadId || !state.currentTurnId) {
    throw new Error("No active turn id available");
  }

  await api(`/threads/${encodeURIComponent(state.selectedThreadId)}/interrupt`, {
    method: "POST",
    body: { turnId: state.currentTurnId },
  });
}

async function sendDraft(draft) {
  if (!draft || state.sending) {
    return;
  }

  const { project, prompt, images, settings } = draft;
  addMessage({
    role: "user",
    meta: "You",
    text: [prompt, images.length ? `[${images.length} image${images.length === 1 ? "" : "s"} attached]` : ""].filter(Boolean).join("\n"),
  });
  setSending(true);

  try {
    if (!state.selectedThreadId) {
      const result = await api("/threads", {
        method: "POST",
        body: {
          projectId: project.id,
          prompt,
          images,
          ...settings,
        },
      });
      state.selectedThreadId = result.data?.thread?.id || "";
      state.currentTurnId = cleanString(result.data?.turn?.id || result.data?.turnId || result.data?.id || "");
      if (state.selectedThreadId) {
        localStorage.setItem(STORAGE_KEYS.threadId, state.selectedThreadId);
        replaceUrl();
        notifyParent("thread-selected", { threadId: state.selectedThreadId });
      }
      notifyParent("threads-changed");
      return;
    }

    const result = await api(`/threads/${encodeURIComponent(state.selectedThreadId)}/message`, {
      method: "POST",
      body: {
        projectId: project.id,
        text: prompt,
        images,
        ...settings,
      },
    });
    state.currentTurnId = cleanString(result.data?.turn?.id || result.data?.turnId || result.data?.id || state.currentTurnId);
    notifyParent("threads-changed");
  } catch (error) {
    restoreDraftToComposer(draft);
    setSending(false);
    addMessage({ role: "system", meta: "Error", text: error.message });
  }
}

async function drainQueuedMessages() {
  if (state.queueDraining || state.sending || state.queuedMessages.length === 0) {
    renderHeader();
    return;
  }

  state.queueDraining = true;
  try {
    const draft = state.queuedMessages.shift();
    renderHeader();
    await sendDraft(draft);
  } finally {
    state.queueDraining = false;
    renderHeader();
  }
}

async function sendPrompt() {
  const draft = draftFromComposer();
  if (!draft) {
    return;
  }

  clearComposer();

  if (state.sending) {
    state.queuedMessages.push(draft);
    renderHeader();
    const shouldInterrupt = window.confirm("A turn is running.\n\nOK interrupts it and sends this next.\nCancel queues this until the turn completes.");
    if (shouldInterrupt) {
      await interruptCurrentTurn().catch((error) => addMessage({ role: "system", meta: "Interrupt error", text: error.message }));
    }
    return;
  }

  await sendDraft(draft);
}

function approvalResult(request, approved) {
  const method = cleanString(request?.method);

  if (method === "item/commandExecution/requestApproval") {
    if (!approved) {
      return { decision: "decline" };
    }

    const decisions = Array.isArray(request?.params?.availableDecisions)
      ? request.params.availableDecisions
      : ["accept", "decline"];
    const decision = decisions.find((item) => item === "acceptForSession")
      || decisions.find((item) => item === "accept")
      || decisions.find((item) => typeof item === "string" && item.startsWith("accept"))
      || "accept";
    return { decision };
  }

  if (method === "item/fileChange/requestApproval") {
    return { decision: approved ? "acceptForSession" : "reject" };
  }

  if (method === "item/permissions/requestApproval") {
    return approved
      ? { permissions: request?.params?.permissions || {}, scope: "session" }
      : { permissions: {}, scope: "none" };
  }

  if (method === "mcpServer/elicitation/request") {
    return { action: approved ? "accept" : "decline", content: {} };
  }

  return approved ? { decision: "accept" } : { decision: "decline" };
}

async function respondToRequest(requestId, approved) {
  const request = state.pendingRequests.find((item) => String(item.id) === String(requestId));
  if (!request) {
    return;
  }

  await api(`/server-requests/${encodeURIComponent(requestId)}/respond`, {
    method: "POST",
    body: {
      result: approvalResult(request, approved),
    },
  });
  removePendingRequest(requestId);
}

function bindEvents() {
  syncTheme();

  elements.themeToggle.addEventListener("click", () => {
    syncTheme(saveTheme(nextTheme()), { notify: true });
  });

  elements.openChatButton.addEventListener("click", () => {
    window.open(`${window.location.pathname}${window.location.search}${window.location.hash}`, "_blank", "noopener");
  });

  elements.settingsButton.addEventListener("click", () => {
    state.settingsOpen = !state.settingsOpen;
    renderSettings();
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest(".chat-settings")) {
      return;
    }
    if (state.settingsOpen) {
      state.settingsOpen = false;
      renderSettings();
    }
  });

  elements.modelSelect.addEventListener("change", () => updateChatSetting("model", elements.modelSelect.value));
  elements.effortSelect.addEventListener("change", () => updateChatSetting("effort", elements.effortSelect.value));
  elements.serviceTierSelect.addEventListener("change", () => updateChatSetting("serviceTier", elements.serviceTierSelect.value));
  elements.modeSelect.addEventListener("change", () => updateChatSetting("mode", elements.modeSelect.value));
  elements.approvalPolicySelect.addEventListener("change", () => updateChatSetting("approvalPolicy", elements.approvalPolicySelect.value));
  elements.sandboxModeSelect.addEventListener("change", () => updateChatSetting("sandboxMode", elements.sandboxModeSelect.value));
  elements.summarySelect.addEventListener("change", () => updateChatSetting("summary", elements.summarySelect.value));
  elements.personalitySelect.addEventListener("change", () => updateChatSetting("personality", elements.personalitySelect.value));

  elements.scrollBottomButton.addEventListener("click", () => {
    scrollToConversationBottom();
  });

  window.addEventListener("scroll", () => {
    state.followOutput = isAtPageBottom();
    updateScrollBottomButton();
  }, { passive: true });

  window.addEventListener("resize", () => {
    updateScrollBottomButton();
  });

  elements.composerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendPrompt();
  });

  elements.promptInput.addEventListener("paste", (event) => {
    void handleComposerPaste(event).catch((error) => addMessage({ role: "system", meta: "Paste error", text: error.message }));
  });

  elements.composerAttachments.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) {
      return;
    }

    if (button.dataset.action === "open-composer-attachment") {
      void imageEditor.openImageEditor(button.dataset.id || "")
        .catch((error) => addMessage({ role: "system", meta: "Image editor error", text: error.message }));
      return;
    }

    if (button.dataset.action === "remove-composer-attachment") {
      state.composerAttachments = state.composerAttachments.filter((attachment) => attachment.id !== (button.dataset.id || ""));
      renderComposerAttachments();
    }
  });

  elements.imageEditorOverlayCanvas.addEventListener("pointerdown", imageEditor.handleImageEditorPointerDown);
  elements.imageEditorOverlayCanvas.addEventListener("pointermove", imageEditor.handleImageEditorPointerMove);
  elements.imageEditorOverlayCanvas.addEventListener("dblclick", imageEditor.handleImageEditorDoubleClick);
  window.addEventListener("pointerup", imageEditor.handleImageEditorPointerUp);
  window.addEventListener("resize", () => {
    if (state.imageEditor.open) {
      imageEditor.layoutImageEditorCanvas();
      imageEditor.renderImageEditor();
    }
  });
  elements.imageEditorColor.addEventListener("input", (event) => {
    imageEditor.updateImageEditorColor(event.target.value);
  });
  elements.imageEditorModal.addEventListener("click", (event) => {
    if (event.target === elements.imageEditorModal) {
      imageEditor.closeImageEditor();
    }
  });
  elements.imageEditorModal.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) {
      return;
    }

    if (button.dataset.action === "editor-tool") {
      imageEditor.setImageEditorTool(button.dataset.tool);
      return;
    }

    if (button.dataset.action === "close-image-editor") {
      imageEditor.closeImageEditor();
      return;
    }

    if (button.dataset.action === "apply-image-editor") {
      void imageEditor.applyImageEditor()
        .catch((error) => addMessage({ role: "system", meta: "Image editor error", text: error.message }));
    }
  });

  elements.pendingRequests.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) {
      return;
    }

    const approved = button.dataset.action === "approve-request";
    void respondToRequest(button.dataset.id, approved)
      .catch((error) => addMessage({ role: "system", meta: "Approval error", text: error.message }));
  });

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin || event.data?.source !== "new-app-shell") {
      return;
    }

    if (event.data.type === "theme-changed") {
      syncTheme(event.data.theme);
    }
  });

  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEYS.theme) {
      syncTheme(event.newValue);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.imageEditor.open) {
      imageEditor.closeImageEditor();
    }
  });
}

async function start() {
  bindEvents();
  renderHeader();
  renderTranscript();

  try {
    await loadBoot();
    await loadModels();
    await loadThread(state.selectedThreadId);
    connectEvents();
  } catch (error) {
    addMessage({ role: "system", meta: "Boot error", text: error.message });
  }
}

void start();
