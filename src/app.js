import "./styles.css";
import { marked } from "marked";
import {
  buildAutoApprovalResult,
  composerApprovalPolicyOverride,
  normalizeCommandApprovalDecisions,
} from "./approval-utils.mjs";
import { parseLocalFileLinkHref } from "./file-link-utils.mjs";
import {
  formatServiceTierLabel,
  resolveComposerSelection,
  supportedReasoningEffortsForModel,
  supportedServiceTiersForModel,
} from "./model-capabilities.mjs";
import { RALPH_LOOP_DELAY_SECONDS, startRalphLoopCountdown } from "./ralph-loop-countdown.mjs";
import {
  consumeRalphLoopBudget,
  createRalphLoopBudget,
  hasRalphLoopBudgetRemaining,
  findLatestRalphLoopInput,
  normalizeRalphLoopInput,
  normalizeRalphLoopLimit,
} from "./ralph-loop-utils.mjs";

marked.setOptions({
  gfm: true,
  breaks: true,
});

const markdownHtmlCache = new Map();

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
  currentTurnId: "",
  activeThreadTab: localStorage.getItem("activeThreadTab") || "chat",
  threadTabByProjectId: {},
  openTabsByProjectId: {},
  activeTabIdByProjectId: {},
  draftTabSequence: 0,
  threadActionMenuOpen: false,
  composerSettingsOpen: false,
  composerMenuOpen: "",
  sidebarCollapsed: localStorage.getItem("sidebarCollapsed") === "true",
  autoscroll: localStorage.getItem("autoscroll") !== "false",
  sidebarWidth: Number(localStorage.getItem("sidebarWidth")) || 305,
  composerModel: localStorage.getItem("composerModel") || "",
  composerEffort: localStorage.getItem("composerEffort") || "",
  composerServiceTier: localStorage.getItem("composerServiceTier") || "",
  composerCapabilities: { serviceTiers: [], defaultServiceTier: "" },
  composerMode: localStorage.getItem("composerMode") || "default",
  composerApproveAllDangerous: localStorage.getItem("composerApproveAllDangerous") === "true",
  composerRalphLoop: false,
  composerRalphLoopLimit: normalizeRalphLoopLimit(localStorage.getItem("composerRalphLoopLimit")),
  composerAttachments: [],
  pendingNewThread: null,
  manualSendInFlight: false,
  pendingServerRequests: [],
  autoApprovalInFlight: new Set(),
  ralphLoopLastCompletedTurnId: "",
  ralphLoopPendingReplay: null,
  ralphLoopAutoCompactThreadId: "",
  ralphLoopBudget: null,
  resourceTabsByProjectId: {},
  activeResourceIdByProjectId: {},
  imageEditor: createImageEditorState(),
};

const elements = {
  layout: document.getElementById("appLayout"),
  sidebarPanel: document.getElementById("sidebarPanel"),
  sidebarResizeHandle: document.getElementById("sidebarResizeHandle"),
  sidebarToggleButton: document.getElementById("sidebarToggleButton"),
  sidebarRailToggle: document.getElementById("sidebarRailToggle"),
  projectList: document.getElementById("projectList"),
  projectSelect: document.getElementById("projectSelect"),
  projectQuickAddForm: document.getElementById("projectQuickAddForm"),
  projectPathInput: document.getElementById("projectPathInput"),
  archivedToggle: document.getElementById("archivedToggle"),
  threadHeader: document.getElementById("threadHeader"),
  conversation: document.getElementById("conversation"),
  composerForm: document.getElementById("composerForm"),
  autoscrollToggle: document.getElementById("autoscrollToggle"),
  approveAllDangerousToggle: document.getElementById("approveAllDangerousToggle"),
  ralphLoopToggle: document.getElementById("ralphLoopToggle"),
  composerAttachments: document.getElementById("composerAttachments"),
  promptInput: document.getElementById("promptInput"),
  composerModelButton: document.getElementById("composerModelButton"),
  composerModelLabel: document.getElementById("composerModelLabel"),
  composerModelMenu: document.getElementById("composerModelMenu"),
  composerEffortButton: document.getElementById("composerEffortButton"),
  composerEffortLabel: document.getElementById("composerEffortLabel"),
  composerEffortMenu: document.getElementById("composerEffortMenu"),
  composerModeButton: document.getElementById("composerModeButton"),
  composerSettingsButton: document.getElementById("composerSettingsButton"),
  composerSettingsMenu: document.getElementById("composerSettingsMenu"),
  ralphLoopModal: document.getElementById("ralphLoopModal"),
  ralphLoopCountdownValue: document.getElementById("ralphLoopCountdownValue"),
  ralphLoopCountdownNumber: document.getElementById("ralphLoopCountdownNumber"),
  ralphLoopCountdownLabel: document.getElementById("ralphLoopCountdownLabel"),
  ralphLoopLimitInput: document.getElementById("ralphLoopLimitInput"),
  imageEditorModal: document.getElementById("imageEditorModal"),
  imageEditorCanvasWrap: document.getElementById("imageEditorCanvasWrap"),
  imageEditorPreviewImage: document.getElementById("imageEditorPreviewImage"),
  imageEditorOverlayCanvas: document.getElementById("imageEditorOverlayCanvas"),
  imageEditorColor: document.getElementById("imageEditorColor"),
};

const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 560;
const COMPOSER_DRAFT_STORAGE_KEY = "composerDraft";
const MAX_MARKDOWN_CACHE_ENTRIES = 200;
let projectThreadsRenderScheduled = false;
let projectThreadsReloadTimer = null;
let projectThreadsReloadInFlight = false;
let projectThreadsReloadQueued = false;
const paneFrameEntries = new Map();
let conversationSocket = null;
let conversationSocketRetryTimer = null;
let conversationSocketShouldReconnect = true;
let sidebarResizeState = null;

boot().catch(showFatalError);

async function boot() {
  applySidebarLayout();
  await loadBoot({ includeModels: false });
  if (!["chat", "terminal", "resource"].includes(state.activeThreadTab)) {
    state.activeThreadTab = "chat";
  }
  initializeProjectTabs();
  syncSelectedProjectThreadTab();
  normalizeComposerSettings();
  elements.autoscrollToggle.checked = state.autoscroll;
  elements.approveAllDangerousToggle.checked = state.composerApproveAllDangerous;
  elements.ralphLoopToggle.checked = state.composerRalphLoop;
  restoreComposerDraft();
  renderComposerControls();
  renderProjects();
  renderThreadHeader();
  renderConversation();
  renderThreadPane();

  connectEvents();
  connectConversationSocket();
  void loadModels().catch((error) => {
    console.error("Failed to load models", error);
  });
  void maybeAutoApprovePendingRequests();
  void loadAllProjectThreads().catch((error) => {
    console.error("Failed to load project threads", error);
  });

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

async function loadBoot({ includeModels = true } = {}) {
  const payload = await api(includeModels ? "/api/boot" : "/api/boot?includeModels=false");
  state.app = payload.app;
  state.projects = payload.projects;
  state.models = payload.models?.data || [];
  state.composerCapabilities = payload.models?.capabilities || { serviceTiers: [], defaultServiceTier: "" };
  state.pendingServerRequests = Array.isArray(payload.pendingRequests) ? payload.pendingRequests : [];
  if (!state.selectedProjectId || !state.projects.some((project) => project.id === state.selectedProjectId)) {
    state.selectedProjectId = state.projects[0]?.id || "";
    persistSelection();
  }
}

async function loadModels() {
  const payload = await api("/api/models");
  state.models = payload.data || [];
  state.composerCapabilities = payload.capabilities || { serviceTiers: [], defaultServiceTier: "" };
  normalizeComposerSettings();
  renderComposerControls();
}

function persistComposerSettings() {
  localStorage.setItem("composerModel", state.composerModel || "");
  localStorage.setItem("composerEffort", state.composerEffort || "");
  localStorage.setItem("composerServiceTier", state.composerServiceTier || "");
  localStorage.setItem("composerMode", state.composerMode || "default");
  localStorage.setItem("composerApproveAllDangerous", String(state.composerApproveAllDangerous));
  localStorage.setItem("composerRalphLoopLimit", String(state.composerRalphLoopLimit));
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

function normalizeComposerSettings() {
  const selection = resolveComposerSelection({
    models: state.models,
    requestedModelId: state.composerModel,
    fallbackModelId: selectedProject()?.defaultModel || "",
    requestedEffort: state.composerEffort,
    requestedServiceTier: state.composerServiceTier,
    capabilities: state.composerCapabilities,
  });

  state.composerModel = selection.modelId;
  state.composerEffort = selection.effort;
  state.composerServiceTier = selection.serviceTier;
  state.composerRalphLoopLimit = normalizeRalphLoopLimit(state.composerRalphLoopLimit);

  if (!["default", "plan"].includes(state.composerMode)) {
    state.composerMode = "default";
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

function renderComposerControls() {
  normalizeComposerSettings();

  const composerView = buildComposerViewState();
  const modelMenuOpen = state.composerMenuOpen === "model";
  const effortMenuOpen = state.composerMenuOpen === "effort";

  if (!elements.composerModelLabel) {
    syncAllPaneFrames();
    return;
  }

  elements.composerModelLabel.textContent = composerView.modelLabel;
  elements.composerEffortLabel.textContent = composerView.effortLabel;
  elements.composerModelButton.disabled = !composerView.hasModelOptions;
  elements.composerEffortButton.disabled = !composerView.hasEffortOptions;
  elements.composerModelMenu.innerHTML = composerView.modelMenuHtml;
  elements.composerEffortMenu.innerHTML = composerView.effortMenuHtml;
  elements.composerSettingsMenu.classList.toggle("hidden", !state.composerSettingsOpen);
  elements.composerSettingsButton.setAttribute("aria-expanded", state.composerSettingsOpen ? "true" : "false");
  elements.composerModelMenu.classList.toggle("hidden", !modelMenuOpen);
  elements.composerEffortMenu.classList.toggle("hidden", !effortMenuOpen);
  elements.composerModelButton.setAttribute("aria-expanded", modelMenuOpen ? "true" : "false");
  elements.composerEffortButton.setAttribute("aria-expanded", effortMenuOpen ? "true" : "false");
  elements.composerModeButton.textContent = composerView.modeLabel;
  elements.composerModeButton.classList.toggle("plan", composerView.mode === "plan");
  elements.composerModeButton.setAttribute("aria-pressed", composerView.mode === "plan" ? "true" : "false");
  elements.approveAllDangerousToggle.checked = composerView.approveAllDangerous;
  elements.ralphLoopToggle.checked = composerView.ralphLoop;
  elements.ralphLoopLimitInput.value = String(composerView.ralphLoopLimit);
  const submitButton = elements.composerForm?.querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.disabled = state.manualSendInFlight;
    submitButton.textContent = state.manualSendInFlight ? "Sending..." : "Send";
  }
  syncAllPaneFrames();
}

function buildComposerViewState() {
  const model = currentComposerModel();
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
      <span class="composer-picker-item-label">${escapeHtml(formatEffortLabel(entry.reasoningEffort))}${entry.reasoningEffort === model?.defaultReasoningEffort ? " (default)" : ""}</span>
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
    mode: state.composerMode === "plan" ? "plan" : "default",
    modeLabel: state.composerMode === "plan" ? "Plan" : "Chat",
    approveAllDangerous: state.composerApproveAllDangerous,
    ralphLoop: state.composerRalphLoop,
    ralphLoopLimit: state.composerRalphLoopLimit,
  };
}

function composerRequestOverrides() {
  const model = currentComposerModel() || fallbackComposerModel();
  const modelId = model?.id || state.composerModel || undefined;
  const reasoningEffort = state.composerEffort || model?.defaultReasoningEffort || undefined;
  const overrides = {
    approvalPolicy: composerApprovalPolicyOverride(
      selectedProject()?.approvalPolicy,
      state.composerApproveAllDangerous,
    ),
    model: modelId,
    effort: reasoningEffort,
    serviceTier: state.composerServiceTier || undefined,
  };

  if (modelId) {
    overrides.collaborationMode = {
      mode: state.composerMode === "plan" ? "plan" : "default",
      settings: {
        model: modelId,
        reasoning_effort: reasoningEffort || null,
      },
    };
  }

  return overrides;
}

function currentComposerInput() {
  return normalizeRalphLoopInput({
    text: elements.promptInput.value,
    images: state.composerAttachments.map((attachment) => ({
      type: "image",
      url: attachment.url,
      name: attachment.name,
    })),
  });
}

function pendingThreadPreview(input) {
  const text = oneLine(input?.text || "");

  if (text) {
    return text.slice(0, 120);
  }

  const imageCount = Array.isArray(input?.images) ? input.images.length : 0;
  if (imageCount > 0) {
    return imageCount === 1 ? "Image message" : `${imageCount} images`;
  }

  return "New conversation";
}

function currentRalphLoopInput(threadId) {
  const normalizedThreadId = String(threadId || "");

  if (!normalizedThreadId || normalizedThreadId !== state.selectedThreadId) {
    return null;
  }

  const currentInput = currentComposerInput();
  if (currentInput.text || currentInput.images.length > 0) {
    return currentInput;
  }

  if (state.selectedThread?.id === normalizedThreadId) {
    return findLatestRalphLoopInput(state.selectedThread);
  }

  return null;
}

function isRalphLoopActiveForThread(threadId) {
  return state.composerRalphLoop
    && state.activeThreadTab === "chat"
    && Boolean(threadId)
    && threadId === state.selectedThreadId
    && Boolean(state.selectedThread?.id);
}

function currentPendingRalphLoopReplay(threadId) {
  const normalizedThreadId = String(threadId || "");
  const pendingReplay = state.ralphLoopPendingReplay;

  if (!pendingReplay || pendingReplay.threadId !== normalizedThreadId) {
    return null;
  }

  return pendingReplay;
}

function setRalphLoopBudget(threadId) {
  const normalizedThreadId = cleanString(threadId);
  state.ralphLoopBudget = normalizedThreadId
    ? createRalphLoopBudget(state.composerRalphLoopLimit, normalizedThreadId)
    : null;
}

function clearRalphLoopBudget() {
  state.ralphLoopBudget = null;
}

function syncConfiguredRalphLoopBudget() {
  const budgetThreadId = cleanString(state.ralphLoopBudget?.threadId);

  if (!budgetThreadId || budgetThreadId !== state.selectedThreadId) {
    return;
  }

  if (!state.composerRalphLoop) {
    clearRalphLoopBudget();
    return;
  }

  setRalphLoopBudget(budgetThreadId);
}

function cancelPendingRalphLoop({ disableLoop = false, render = true, cancelAutoCompact = false } = {}) {
  const pendingReplay = state.ralphLoopPendingReplay;
  state.ralphLoopPendingReplay = null;

  if (cancelAutoCompact) {
    state.ralphLoopAutoCompactThreadId = "";
  }

  if (pendingReplay?.cancel) {
    pendingReplay.cancel();
  }

  if (disableLoop) {
    state.composerRalphLoop = false;
    elements.ralphLoopToggle.checked = false;
  }

  if (disableLoop || cancelAutoCompact) {
    clearRalphLoopBudget();
  }

  if (render) {
    renderConversation();
  } else {
    renderRalphLoopDialog(null);
  }

  if (disableLoop) {
    renderComposerControls();
  }
}

function syncPendingRalphLoopReplay() {
  const pendingReplay = state.ralphLoopPendingReplay;

  if (!pendingReplay) {
    return;
  }

  if (!isRalphLoopActiveForThread(pendingReplay.threadId)) {
    cancelPendingRalphLoop({ render: false, cancelAutoCompact: true });
  }
}

function syncModalOpenState() {
  const hasOpenModal = state.imageEditor.open || !elements.ralphLoopModal.classList.contains("hidden");
  document.body.classList.toggle("modal-open", hasOpenModal);
}

function renderRalphLoopDialog(pendingReplay = currentPendingRalphLoopReplay(state.selectedThread?.id || state.selectedThreadId)) {
  const visible = Boolean(pendingReplay);
  elements.ralphLoopModal.classList.toggle("hidden", !visible);
  elements.ralphLoopModal.setAttribute("aria-hidden", visible ? "false" : "true");

  if (!visible) {
    syncModalOpenState();
    return;
  }

  const remainingSeconds = Math.max(0, Number(pendingReplay.remainingSeconds) || 0);
  const durationText = `${remainingSeconds} second${remainingSeconds === 1 ? "" : "s"}`;
  elements.ralphLoopCountdownValue.textContent = durationText;
  elements.ralphLoopCountdownNumber.textContent = String(remainingSeconds);
  elements.ralphLoopCountdownLabel.textContent = remainingSeconds === 1 ? "second remaining" : "seconds remaining";
  syncModalOpenState();
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function readThreadSnapshot(threadId) {
  const payload = await api(`/api/threads/${encodeURIComponent(threadId)}`);
  return payload.data?.thread || payload.data || null;
}

function threadHasLiveWork(thread) {
  return isLiveStatus(thread?.status) || isLiveStatus(latestTurn(thread)?.status);
}

async function autoCompactRalphLoopThread(threadId, previousTurnId = "") {
  const normalizedThreadId = String(threadId || "");

  if (!normalizedThreadId) {
    return false;
  }

  state.ralphLoopAutoCompactThreadId = normalizedThreadId;

  try {
    await api(`/api/threads/${encodeURIComponent(normalizedThreadId)}/compact`, {
      method: "POST",
      body: {},
    });

    const startDeadline = Date.now() + 5000;
    const completionDeadline = Date.now() + 60000;
    let compactStarted = false;

    while (Date.now() < completionDeadline) {
      if (state.ralphLoopAutoCompactThreadId !== normalizedThreadId) {
        return false;
      }

      if (!isRalphLoopActiveForThread(normalizedThreadId)) {
        return false;
      }

      const thread = await readThreadSnapshot(normalizedThreadId);
      const latest = latestTurn(thread);
      const latestTurnChanged = Boolean(latest?.id) && latest.id !== previousTurnId;
      const liveWork = threadHasLiveWork(thread);

      compactStarted = compactStarted || latestTurnChanged || liveWork;

      if (compactStarted && !liveWork) {
        if (state.selectedThreadId === normalizedThreadId) {
          await loadThread(normalizedThreadId);
        }
        return true;
      }

      if (!compactStarted && Date.now() >= startDeadline) {
        if (state.selectedThreadId === normalizedThreadId) {
          await loadThread(normalizedThreadId);
        }
        return true;
      }

      await sleep(400);
    }

    if (state.selectedThreadId === normalizedThreadId) {
      await loadThread(normalizedThreadId);
    }

    return true;
  } finally {
    if (state.ralphLoopAutoCompactThreadId === normalizedThreadId) {
      state.ralphLoopAutoCompactThreadId = "";
    }
  }
}

async function waitForRalphLoopReplay(threadId, completedTurnId = "") {
  cancelPendingRalphLoop({ render: false });

  const normalizedThreadId = String(threadId || "");
  if (!normalizedThreadId) {
    return false;
  }

  const replayKey = `${normalizedThreadId}:${completedTurnId || "latest"}:${Date.now()}`;
  const countdown = startRalphLoopCountdown({
    seconds: RALPH_LOOP_DELAY_SECONDS,
    onTick: (remainingSeconds) => {
      if (state.ralphLoopPendingReplay?.key !== replayKey) {
        return;
      }

      state.ralphLoopPendingReplay.remainingSeconds = remainingSeconds;
      renderConversation();
    },
  });

  state.ralphLoopPendingReplay = {
    key: replayKey,
    threadId: normalizedThreadId,
    completedTurnId: completedTurnId || "",
    remainingSeconds: RALPH_LOOP_DELAY_SECONDS,
    cancel: countdown.cancel,
  };
  renderConversation();

  const completed = await countdown.done;

  if (state.ralphLoopPendingReplay?.key === replayKey) {
    state.ralphLoopPendingReplay = null;
    renderConversation();
  }

  return completed;
}

async function sendConversationMessage(input, options = {}) {
  const project = selectedProject();
  const activeTab = activeProjectTab(project?.id);
  const normalizedInput = normalizeRalphLoopInput(input);
  const overrides = composerRequestOverrides();
  const fromRalphLoop = options.fromRalphLoop === true;
  const manualSend = !fromRalphLoop;
  const startingNewThread = manualSend && !state.selectedThreadId;

  if (!project) {
    throw new Error("Select a project first");
  }

  if (!normalizedInput.text && normalizedInput.images.length === 0) {
    throw new Error("Enter a prompt or paste an image");
  }

  if (!fromRalphLoop) {
    cancelPendingRalphLoop({ render: false, cancelAutoCompact: true });
  }

  if (manualSend && state.manualSendInFlight) {
    throw new Error("A message is already being sent");
  }

  if (activeTab?.pane && activeTab.pane !== "chat") {
    throw new Error("Switch to a conversation tab before sending a message");
  }

  if (manualSend) {
    state.manualSendInFlight = true;
    renderComposerControls();
  }

  if (startingNewThread) {
    state.pendingNewThread = {
      projectId: project.id,
      title: pendingThreadPreview(normalizedInput),
      input: normalizedInput,
    };
    renderProjects();
    renderThreadHeader();
    renderConversation();
  }

  try {
    if (state.selectedThreadId) {
      await api(`/api/threads/${encodeURIComponent(state.selectedThreadId)}/message`, {
        method: "POST",
        body: { projectId: project.id, text: normalizedInput.text, images: normalizedInput.images, ...overrides },
      });
    } else {
      const created = await api("/api/threads", {
        method: "POST",
        body: { projectId: project.id, prompt: normalizedInput.text, images: normalizedInput.images, ...overrides },
      });

      state.selectedThreadId = created.data?.thread?.id || "";
      if (state.selectedThreadId) {
        const nextTab = createThreadTab(project.id, state.selectedThreadId);
        if (activeTab?.pane === "chat" && !cleanString(activeTab.threadId)) {
          replaceProjectTab(project.id, activeTab.id, nextTab);
        } else {
          openProjectThreadTab(project.id, state.selectedThreadId, { activate: true });
        }
        syncSelectedProjectThreadTab();
      }
    }

    persistSelection();
    syncAllPaneFrames();
    await loadAllProjectThreads();
    renderProjects();

    if (state.selectedThreadId) {
      await loadThread(state.selectedThreadId);
    }

    if (!fromRalphLoop) {
      if (state.composerRalphLoop && state.selectedThreadId) {
        setRalphLoopBudget(state.selectedThreadId);
      } else {
        clearRalphLoopBudget();
      }
    }

    return state.selectedThreadId;
  } finally {
    if (startingNewThread) {
      state.pendingNewThread = null;
    }
    if (manualSend) {
      state.manualSendInFlight = false;
      renderComposerControls();
      renderProjects();
      renderThreadHeader();
      renderConversation();
    }
  }
}

async function maybeRunRalphLoop(threadId, completedTurnId = "") {
  if (!isRalphLoopActiveForThread(threadId)) {
    return;
  }

  if (!hasRalphLoopBudgetRemaining(state.ralphLoopBudget, threadId)) {
    return;
  }

  if (completedTurnId && state.ralphLoopLastCompletedTurnId === completedTurnId) {
    return;
  }

  if (!currentRalphLoopInput(threadId)) {
    return;
  }

  state.ralphLoopLastCompletedTurnId = completedTurnId || state.ralphLoopLastCompletedTurnId;

  try {
    const shouldReplay = await waitForRalphLoopReplay(threadId, completedTurnId);

    if (!shouldReplay || !isRalphLoopActiveForThread(threadId)) {
      return;
    }

    if (!currentRalphLoopInput(threadId)) {
      return;
    }

    const compacted = await autoCompactRalphLoopThread(threadId, completedTurnId);
    if (!compacted || !isRalphLoopActiveForThread(threadId)) {
      return;
    }

    const replayInput = currentRalphLoopInput(threadId);
    if (!replayInput) {
      return;
    }

    if (!hasRalphLoopBudgetRemaining(state.ralphLoopBudget, threadId)) {
      return;
    }

    await sendConversationMessage(replayInput, { fromRalphLoop: true });
    state.ralphLoopBudget = consumeRalphLoopBudget(state.ralphLoopBudget, threadId);
  } catch (error) {
    console.error("Ralph loop failed", error);
  }
}

async function loadThreads() {
  const project = selectedProject();

  if (!project) {
    state.threads = [];
    renderProjects();
    renderThreadPane();
    return;
  }

  const payload = await api(`/api/projects/${encodeURIComponent(project.id)}/threads?archived=${state.archived}`);
  state.threads = payload.data?.data || payload.data?.threads || [];
  state.projectThreads[project.id] = state.threads;

  renderProjects();
  renderThreadHeader();
  renderConversation();
  renderComposerControls();
  renderThreadPane();
}

async function loadProjectThreads(projectId) {
  try {
    const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/threads?archived=${state.archived}`);
    state.projectThreads[projectId] = payload.data?.data || payload.data?.threads || [];
  } catch (error) {
    state.projectThreads[projectId] = [];
    throw error;
  } finally {
    if (projectId === state.selectedProjectId) {
      state.threads = state.projectThreads[projectId];
      renderComposerControls();
    }

    scheduleProjectsRender();
  }
}

async function loadAllProjectThreads() {
  const projectId = cleanString(state.selectedProjectId);

  if (!projectId) {
    state.threads = [];
    renderProjects();
    return;
  }

  await loadProjectThreads(projectId).catch((error) => {
    console.error(`Failed to load threads for project ${projectId}`, error);
  });
  state.threads = state.projectThreads[projectId] || [];
  renderProjects();
}

async function switchSelectedProject(projectId) {
  const nextProjectId = cleanString(projectId);

  if (nextProjectId === cleanString(state.selectedProjectId) && Object.prototype.hasOwnProperty.call(state.projectThreads, nextProjectId)) {
    state.threadActionMenuOpen = false;
    syncSelectedProjectThreadTab();
    persistSelection();
    renderProjects();
    renderThreadHeader();
    renderConversation();
    renderComposerControls();
    renderThreadPane();
    if (state.selectedThreadId) {
      await loadThread(state.selectedThreadId).catch(console.error);
    }
    return;
  }

  state.selectedProjectId = nextProjectId;
  state.threadActionMenuOpen = false;
  syncSelectedProjectThreadTab();
  persistSelection();
  renderProjects();
  await loadThreads();
  if (state.selectedThreadId) {
    await loadThread(state.selectedThreadId).catch(console.error);
  }
}

async function loadThread(threadId) {
  const requestedThreadId = String(threadId || "");
  const payload = await api(`/api/threads/${encodeURIComponent(requestedThreadId)}`);

  if (state.selectedThreadId !== requestedThreadId) {
    return;
  }

  state.selectedThread = payload.data?.thread || payload.data;
  state.selectedThreadId = state.selectedThread?.id || requestedThreadId;
  state.currentTurnId = findLatestTurnId(state.selectedThread);
  syncThreadSummary(state.selectedThread);
  renderComposerControls();
  persistSelection();
  renderProjects();
  renderThreadHeader();
  renderConversation();
  renderThreadPane();
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

function upsertPendingServerRequest(request) {
  if (!request?.id) {
    return;
  }

  const requestId = String(request.id);
  const existingIndex = state.pendingServerRequests.findIndex((entry) => String(entry?.id) === requestId);

  if (existingIndex === -1) {
    state.pendingServerRequests = state.pendingServerRequests.concat(request);
    return;
  }

  state.pendingServerRequests = state.pendingServerRequests.map((entry, index) => (index === existingIndex ? request : entry));
}

function removePendingServerRequest(requestId) {
  const normalizedId = String(requestId || "");
  if (!normalizedId) {
    return;
  }

  state.pendingServerRequests = state.pendingServerRequests.filter((entry) => String(entry?.id) !== normalizedId);
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

  if (request?.params?.threadId === state.selectedThreadId) {
    renderSelectedThread();
  }
}

async function maybeAutoApprovePendingRequests(requests = state.pendingServerRequests) {
  if (!state.composerApproveAllDangerous || !Array.isArray(requests) || requests.length === 0) {
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

async function loadPendingServerRequests() {
  const payload = await api("/api/pending-requests");
  state.pendingServerRequests = Array.isArray(payload.data) ? payload.data : [];
}

function pendingServerRequestsForThread(threadId) {
  if (!threadId) {
    return [];
  }

  return state.pendingServerRequests.filter((request) => request?.params?.threadId === threadId);
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
  const latestCollapsibleItemId = findLatestCollapsibleItemId(state.selectedThread);

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

function findConversationItemRecord(itemId, thread = state.selectedThread) {
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

function renderConversationItemBodyMarkup(itemId, latestCollapsibleItemId = findLatestCollapsibleItemId(state.selectedThread)) {
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
    cancelPendingRalphLoop({ render: false });
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
    if (state.ralphLoopAutoCompactThreadId !== threadId) {
      void maybeRunRalphLoop(threadId, completedTurn.id || turn?.id || "");
    }
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
    const item = ensureTurnItem(turn, params.itemId, "agentMessage");
    item.text = item.text || "";
    item.text = `${item.text || ""}${params.delta || ""}`;
    syncThreadSummary(state.selectedThread);
    scheduleProjectsRender();
    if (!patchStreamingConversationItem(item)) {
      renderSelectedThread();
    }
    return true;
  }

  if (method === "item/commandExecution/outputDelta") {
    const item = ensureTurnItem(turn, params.itemId, "commandExecution");
    item.command = item.command || "";
    item.commandActions = Array.isArray(item.commandActions) ? item.commandActions : [];
    item.cwd = item.cwd || state.selectedThread.cwd || "";
    item.status = item.status || "inProgress";
    item.aggregatedOutput = item.aggregatedOutput || "";
    item.aggregatedOutput = `${item.aggregatedOutput || ""}${params.delta || ""}`;
    if (!patchStreamingConversationItem(item)) {
      renderSelectedThread();
    }
    return true;
  }

  if (method === "item/reasoning/textDelta") {
    const item = ensureTurnItem(turn, params.itemId, "reasoning");
    item.content = Array.isArray(item.content) ? item.content : [];
    item.summary = Array.isArray(item.summary) ? item.summary : [];
    appendIndexedDelta(item, "content", params.contentIndex, params.delta || "");
    if (!patchStreamingConversationItem(item)) {
      renderSelectedThread();
    }
    return true;
  }

  if (method === "item/reasoning/summaryTextDelta") {
    const item = ensureTurnItem(turn, params.itemId, "reasoning");
    item.content = Array.isArray(item.content) ? item.content : [];
    item.summary = Array.isArray(item.summary) ? item.summary : [];
    appendIndexedDelta(item, "summary", params.summaryIndex, params.delta || "");
    if (!patchStreamingConversationItem(item)) {
      renderSelectedThread();
    }
    return true;
  }

  if (method === "item/reasoning/summaryPartAdded") {
    const item = ensureTurnItem(turn, params.itemId, "reasoning");
    item.content = Array.isArray(item.content) ? item.content : [];
    item.summary = Array.isArray(item.summary) ? item.summary : [];
    appendIndexedDelta(item, "summary", params.summaryIndex, "");
    if (!patchStreamingConversationItem(item)) {
      renderSelectedThread();
    }
    return true;
  }

  if (method === "item/plan/delta") {
    const item = ensureTurnItem(turn, params.itemId, "plan");
    item.text = item.text || "";
    item.text = `${item.text || ""}${params.delta || ""}`;
    if (!patchStreamingConversationItem(item)) {
      renderSelectedThread();
    }
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
  localStorage.setItem("selectedThreadId", persistedProjectThreadId() || "");
  localStorage.setItem("activeThreadTab", projectThreadTab() || state.activeThreadTab || "chat");
  localStorage.setItem("sidebarCollapsed", String(state.sidebarCollapsed));
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

function isSelectedThreadLoading() {
  return Boolean(state.selectedThreadId) && state.selectedThread?.id !== state.selectedThreadId;
}

function projectDisplayName(project) {
  const cwd = String(project?.cwd || "").trim();
  if (!cwd) {
    return String(project?.name || "Project");
  }

  const normalized = cwd.replace(/[\\/]+$/g, "");
  if (!normalized) {
    return cwd;
  }

  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  return segments.at(-1) || normalized || cwd;
}

function optionHtml(value, label) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
}

function createResourceTab(pathname, position = {}) {
  return {
    id: createAttachmentId(),
    projectId: cleanString(position.projectId),
    path: pathname,
    name: fileNameFromPath(pathname),
    pendingSelection: normalizeResourceSelection(position),
  };
}

function normalizeResourceSelection(position = {}) {
  const line = Number(position.line) || 0;
  const column = Number(position.column) || 0;
  return line > 0 || column > 0
    ? { line: Math.max(1, line || 1), column: Math.max(1, column || 1) }
    : null;
}

function ensureProjectResourceState(projectId = state.selectedProjectId) {
  const normalizedProjectId = cleanString(projectId);

  if (!normalizedProjectId) {
    return { resources: [], activeResourceId: "" };
  }

  if (!Array.isArray(state.resourceTabsByProjectId[normalizedProjectId])) {
    state.resourceTabsByProjectId[normalizedProjectId] = [];
  }

  if (typeof state.activeResourceIdByProjectId[normalizedProjectId] !== "string") {
    state.activeResourceIdByProjectId[normalizedProjectId] = "";
  }

  return {
    resources: state.resourceTabsByProjectId[normalizedProjectId],
    activeResourceId: state.activeResourceIdByProjectId[normalizedProjectId],
  };
}

function projectResources(projectId = state.selectedProjectId) {
  return ensureProjectResourceState(projectId).resources;
}

function projectActiveResourceId(projectId = state.selectedProjectId) {
  return ensureProjectResourceState(projectId).activeResourceId;
}

function setProjectActiveResource(projectId, resourceId = "") {
  const normalizedProjectId = cleanString(projectId);

  if (!normalizedProjectId) {
    return;
  }

  ensureProjectResourceState(normalizedProjectId);
  state.activeResourceIdByProjectId[normalizedProjectId] = cleanString(resourceId);
}

function createDraftThreadTab(projectId) {
  state.draftTabSequence += 1;
  const normalizedProjectId = cleanString(projectId);
  return {
    id: `chat:draft:${normalizedProjectId}:${Date.now()}:${state.draftTabSequence}`,
    pane: "chat",
    projectId: normalizedProjectId,
    threadId: "",
  };
}

function createThreadTab(projectId, threadId) {
  const normalizedProjectId = cleanString(projectId);
  const normalizedThreadId = cleanString(threadId);
  return {
    id: `chat:${normalizedThreadId}`,
    pane: "chat",
    projectId: normalizedProjectId,
    threadId: normalizedThreadId,
  };
}

function createTerminalTab(projectId) {
  const normalizedProjectId = cleanString(projectId);
  return {
    id: `terminal:${normalizedProjectId}`,
    pane: "terminal",
    projectId: normalizedProjectId,
  };
}

function createResourcePaneTab(projectId, resourceId) {
  const normalizedProjectId = cleanString(projectId);
  const normalizedResourceId = cleanString(resourceId);
  return {
    id: `resource:${normalizedResourceId}`,
    pane: "resource",
    projectId: normalizedProjectId,
    resourceId: normalizedResourceId,
  };
}

function ensureProjectOpenTabState(projectId = state.selectedProjectId) {
  const normalizedProjectId = cleanString(projectId);

  if (!normalizedProjectId) {
    return { tabs: [], activeTabId: "" };
  }

  if (!Array.isArray(state.openTabsByProjectId[normalizedProjectId])) {
    state.openTabsByProjectId[normalizedProjectId] = [];
  }

  if (typeof state.activeTabIdByProjectId[normalizedProjectId] !== "string") {
    state.activeTabIdByProjectId[normalizedProjectId] = "";
  }

  return {
    tabs: state.openTabsByProjectId[normalizedProjectId],
    activeTabId: state.activeTabIdByProjectId[normalizedProjectId],
  };
}

function projectOpenTabs(projectId = state.selectedProjectId) {
  return ensureProjectOpenTabState(projectId).tabs;
}

function projectActiveTabId(projectId = state.selectedProjectId) {
  return ensureProjectOpenTabState(projectId).activeTabId;
}

function setProjectActiveTabId(projectId, tabId = "") {
  const normalizedProjectId = cleanString(projectId);

  if (!normalizedProjectId) {
    return;
  }

  ensureProjectOpenTabState(normalizedProjectId);
  state.activeTabIdByProjectId[normalizedProjectId] = cleanString(tabId);
}

function findProjectTab(projectId, tabId) {
  const normalizedTabId = cleanString(tabId);
  if (!normalizedTabId) {
    return null;
  }

  return projectOpenTabs(projectId).find((tab) => tab.id === normalizedTabId) || null;
}

function activeProjectTab(projectId = state.selectedProjectId) {
  const activeTabId = projectActiveTabId(projectId);
  return findProjectTab(projectId, activeTabId);
}

function upsertProjectTab(tab, { activate = true } = {}) {
  if (!tab?.id || !tab?.projectId) {
    return null;
  }

  const tabs = projectOpenTabs(tab.projectId);
  const existingIndex = tabs.findIndex((entry) => entry.id === tab.id);

  if (existingIndex >= 0) {
    tabs[existingIndex] = {
      ...tabs[existingIndex],
      ...tab,
    };
  } else {
    tabs.push({ ...tab });
  }

  if (activate) {
    setProjectActiveTabId(tab.projectId, tab.id);
  }

  return findProjectTab(tab.projectId, tab.id);
}

function openProjectThreadTab(projectId, threadId, { activate = true } = {}) {
  const normalizedThreadId = cleanString(threadId);

  if (!normalizedThreadId) {
    return null;
  }

  return upsertProjectTab(createThreadTab(projectId, normalizedThreadId), { activate });
}

function openProjectTerminalTab(projectId, { activate = true } = {}) {
  return upsertProjectTab(createTerminalTab(projectId), { activate });
}

function openProjectResourceTab(projectId, resourceId, { activate = true } = {}) {
  const normalizedResourceId = cleanString(resourceId);

  if (!normalizedResourceId) {
    return null;
  }

  return upsertProjectTab(createResourcePaneTab(projectId, normalizedResourceId), { activate });
}

function createProjectDraftTab(projectId, { activate = true } = {}) {
  return upsertProjectTab(createDraftThreadTab(projectId), { activate });
}

function allOpenTabs() {
  return Object.values(state.openTabsByProjectId)
    .flatMap((tabs) => Array.isArray(tabs) ? tabs : []);
}

function findOpenTab(tabId) {
  const normalizedTabId = cleanString(tabId);

  if (!normalizedTabId) {
    return null;
  }

  return allOpenTabs().find((tab) => tab.id === normalizedTabId) || null;
}

function paneFrameSrc(tab) {
  const pane = tab?.pane;
  if (pane === "terminal") {
    return "/panes/terminal.html";
  }

  if (pane === "resource") {
    return "/panes/resource.html";
  }

  const url = new URL("/panes/chat.html", window.location.origin);
  if (tab?.projectId) {
    url.searchParams.set("projectId", cleanString(tab.projectId));
  }
  if (tab?.threadId) {
    url.searchParams.set("threadId", cleanString(tab.threadId));
  }
  if (tab?.id) {
    url.searchParams.set("tabId", cleanString(tab.id));
  }
  return `${url.pathname}${url.search}`;
}

function paneFrameTitle(tab) {
  const label = projectTabLabel(tab);
  if (!label) {
    return "Project tab";
  }

  return `${label} · ${formatStatus(tab?.pane || "tab")}`;
}

function ensurePaneFrameEntry(tab) {
  if (!tab?.id || !tab?.pane) {
    return null;
  }

  let entry = paneFrameEntries.get(tab.id);

  if (entry && entry.pane !== tab.pane) {
    removePaneFrameEntry(tab.id);
    entry = null;
  }

  if (entry) {
    entry.frame.title = paneFrameTitle(tab);
    return entry;
  }

  const frame = document.createElement("iframe");
  frame.className = "pane-frame tab-pane-frame";
  frame.dataset.tabId = tab.id;
  frame.dataset.pane = tab.pane;
  frame.title = paneFrameTitle(tab);
  frame.src = paneFrameSrc(tab);
  frame.setAttribute("aria-hidden", "true");
  elements.conversation.appendChild(frame);

  entry = {
    tabId: tab.id,
    pane: tab.pane,
    frame,
    ready: false,
  };
  paneFrameEntries.set(tab.id, entry);
  return entry;
}

function removePaneFrameEntry(tabId) {
  const normalizedTabId = cleanString(tabId);
  const entry = paneFrameEntries.get(normalizedTabId);

  if (!entry) {
    return;
  }

  paneFrameEntries.delete(normalizedTabId);
  entry.frame.remove();
}

function renamePaneFrameEntry(previousTabId, nextTab) {
  const normalizedPreviousTabId = cleanString(previousTabId);
  const entry = paneFrameEntries.get(normalizedPreviousTabId);

  if (!entry || !nextTab?.id) {
    return;
  }

  paneFrameEntries.delete(normalizedPreviousTabId);
  entry.tabId = nextTab.id;
  entry.pane = nextTab.pane;
  entry.frame.dataset.tabId = nextTab.id;
  entry.frame.dataset.pane = nextTab.pane;
  entry.frame.title = paneFrameTitle(nextTab);
  entry.frame.src = paneFrameSrc(nextTab);
  paneFrameEntries.set(nextTab.id, entry);
}

function paneFrameEntryForWindow(targetWindow) {
  if (!targetWindow) {
    return null;
  }

  for (const entry of paneFrameEntries.values()) {
    if (entry.frame.contentWindow === targetWindow) {
      return entry;
    }
  }

  return null;
}

function replaceProjectTab(projectId, previousTabId, nextTab) {
  const normalizedProjectId = cleanString(projectId);
  const normalizedPreviousTabId = cleanString(previousTabId);

  if (!normalizedProjectId || !normalizedPreviousTabId || !nextTab?.id) {
    return null;
  }

  const tabs = projectOpenTabs(normalizedProjectId);
  const previousIndex = tabs.findIndex((entry) => entry.id === normalizedPreviousTabId);

  if (previousIndex === -1) {
    return upsertProjectTab(nextTab, { activate: true });
  }

  const existingIndex = tabs.findIndex((entry) => entry.id === nextTab.id);
  if (existingIndex >= 0 && existingIndex !== previousIndex) {
    tabs.splice(previousIndex, 1);
  } else {
    tabs[previousIndex] = {
      ...tabs[previousIndex],
      ...nextTab,
    };
  }

  if (projectActiveTabId(normalizedProjectId) === normalizedPreviousTabId) {
    setProjectActiveTabId(normalizedProjectId, nextTab.id);
  }

  renamePaneFrameEntry(normalizedPreviousTabId, nextTab);
  return findProjectTab(normalizedProjectId, nextTab.id);
}

function closeProjectTab(projectId, tabId, { ensureFallback = true } = {}) {
  const normalizedProjectId = cleanString(projectId);
  const normalizedTabId = cleanString(tabId);

  if (!normalizedProjectId || !normalizedTabId) {
    return;
  }

  const tabs = projectOpenTabs(normalizedProjectId);
  const index = tabs.findIndex((entry) => entry.id === normalizedTabId);

  if (index === -1) {
    return;
  }

  tabs.splice(index, 1);
  removePaneFrameEntry(normalizedTabId);

  if (projectActiveTabId(normalizedProjectId) === normalizedTabId) {
    const nextTab = tabs[index] || tabs[index - 1] || null;
    setProjectActiveTabId(normalizedProjectId, nextTab?.id || "");
  }

  if (ensureFallback && tabs.length === 0) {
    createProjectDraftTab(normalizedProjectId, { activate: true });
  }
}

function closeProjectThreadTabs(projectId, threadId) {
  const normalizedProjectId = cleanString(projectId);
  const normalizedThreadId = cleanString(threadId);

  if (!normalizedProjectId || !normalizedThreadId) {
    return;
  }

  const tabIds = projectOpenTabs(normalizedProjectId)
    .filter((tab) => tab.pane === "chat" && cleanString(tab.threadId) === normalizedThreadId)
    .map((tab) => tab.id);

  tabIds.forEach((tabId, index) => {
    closeProjectTab(normalizedProjectId, tabId, { ensureFallback: index === tabIds.length - 1 });
  });
}

function normalizeThreadTab(tab) {
  return ["chat", "terminal", "resource"].includes(tab) ? tab : "chat";
}

function projectThreadTab(projectId = state.selectedProjectId) {
  return normalizeThreadTab(activeProjectTab(projectId)?.pane || "chat");
}

function setProjectThreadTab(tab, projectId = state.selectedProjectId) {
  const normalizedProjectId = cleanString(projectId);
  const nextTab = normalizeThreadTab(tab);

  if (!normalizedProjectId) {
    state.activeThreadTab = nextTab;
    return;
  }

  if (nextTab === "terminal") {
    openProjectTerminalTab(normalizedProjectId, { activate: true });
  } else if (nextTab === "resource") {
    const resourceId = projectActiveResourceId(normalizedProjectId);
    if (resourceId) {
      openProjectResourceTab(normalizedProjectId, resourceId, { activate: true });
    } else {
      createProjectDraftTab(normalizedProjectId, { activate: true });
    }
  } else {
    const existingChatTab = projectOpenTabs(normalizedProjectId).find((entry) => entry.pane === "chat");
    if (existingChatTab) {
      setProjectActiveTabId(normalizedProjectId, existingChatTab.id);
    } else {
      createProjectDraftTab(normalizedProjectId, { activate: true });
    }
  }

  state.threadTabByProjectId[normalizedProjectId] = nextTab;
  state.activeThreadTab = nextTab;
}

function persistedProjectThreadId(projectId = state.selectedProjectId) {
  const activeTab = activeProjectTab(projectId);
  if (activeTab?.pane === "chat" && activeTab.threadId) {
    return activeTab.threadId;
  }

  return projectOpenTabs(projectId).find((tab) => tab.pane === "chat" && cleanString(tab.threadId))?.threadId || "";
}

function normalizeProjectOpenTabs(projectId = state.selectedProjectId) {
  const normalizedProjectId = cleanString(projectId);

  if (!normalizedProjectId) {
    return;
  }

  const tabs = projectOpenTabs(normalizedProjectId);
  const filteredTabs = tabs.filter((tab) => {
    if (tab.pane === "resource") {
      return Boolean(findResource(tab.resourceId));
    }

    return true;
  });

  if (filteredTabs.length !== tabs.length) {
    state.openTabsByProjectId[normalizedProjectId] = filteredTabs;
  }

  if (!projectOpenTabs(normalizedProjectId).some((tab) => tab.id === projectActiveTabId(normalizedProjectId))) {
    setProjectActiveTabId(normalizedProjectId, projectOpenTabs(normalizedProjectId)[0]?.id || "");
  }

  if (!projectOpenTabs(normalizedProjectId).length) {
    createProjectDraftTab(normalizedProjectId, { activate: true });
  }
}

function initializeProjectTabs() {
  const projectId = cleanString(state.selectedProjectId);

  if (!projectId) {
    return;
  }

  const initialTab = normalizeThreadTab(state.activeThreadTab);
  const persistedThreadId = cleanString(state.selectedThreadId);

  if (persistedThreadId) {
    openProjectThreadTab(projectId, persistedThreadId, { activate: initialTab === "chat" });
  }

  if (initialTab === "terminal") {
    openProjectTerminalTab(projectId, { activate: true });
  }

  if (!projectOpenTabs(projectId).length) {
    createProjectDraftTab(projectId, { activate: true });
  }
}

function syncSelectedProjectThreadTab() {
  const projectId = cleanString(state.selectedProjectId);
  if (!projectId) {
    state.activeThreadTab = normalizeThreadTab(state.activeThreadTab);
    state.selectedThreadId = "";
    state.selectedThread = null;
    state.currentTurnId = "";
    return;
  }

  normalizeProjectOpenTabs(projectId);
  const tab = activeProjectTab(projectId) || projectOpenTabs(projectId)[0] || null;

  if (!tab) {
    state.activeThreadTab = "chat";
    state.selectedThreadId = "";
    state.selectedThread = null;
    state.currentTurnId = "";
    return;
  }

  setProjectActiveTabId(projectId, tab.id);
  state.threadTabByProjectId[projectId] = tab.pane;
  state.activeThreadTab = normalizeThreadTab(tab.pane);

  if (tab.pane === "chat") {
    const nextThreadId = cleanString(tab.threadId);
    if (nextThreadId !== state.selectedThreadId) {
      state.selectedThreadId = nextThreadId;
      if (state.selectedThread?.id !== nextThreadId) {
        state.selectedThread = null;
        state.currentTurnId = "";
      } else {
        state.currentTurnId = findLatestTurnId(state.selectedThread);
      }
    }
  } else {
    state.selectedThreadId = "";
    state.selectedThread = null;
    state.currentTurnId = "";
  }

  if (tab.pane === "resource" && tab.resourceId) {
    setProjectActiveResource(projectId, tab.resourceId);
  }

  normalizeSelectedProjectResourceTab();
}

function normalizeSelectedProjectResourceTab() {
  const projectId = cleanString(state.selectedProjectId);
  const resources = projectResources(projectId);
  const activeResourceId = projectActiveResourceId(projectId);
  const hasActiveResource = resources.some((resource) => resource.id === activeResourceId);

  if (!hasActiveResource) {
    setProjectActiveResource(projectId, resources[0]?.id || "");
  }

  if (state.activeThreadTab === "resource" && !activeResource(projectId)) {
    setProjectThreadTab("chat", projectId);
  }
}

function allProjectResources() {
  return Object.values(state.resourceTabsByProjectId).flatMap((resources) => Array.isArray(resources) ? resources : []);
}

function activeResource(projectId = state.selectedProjectId) {
  const activeId = projectActiveResourceId(projectId);
  return projectResources(projectId).find((resource) => resource.id === activeId) || null;
}

function findResource(resourceId) {
  return allProjectResources().find((resource) => resource.id === resourceId) || null;
}

function fileNameFromPath(pathname) {
  const value = String(pathname || "").replace(/[\\/]+$/g, "");
  return value.split(/[\\/]/).filter(Boolean).at(-1) || value || "file";
}

function findThreadSummary(projectId, threadId) {
  const normalizedThreadId = cleanString(threadId);

  if (!normalizedThreadId) {
    return null;
  }

  if (state.selectedThread?.id === normalizedThreadId) {
    return state.selectedThread;
  }

  const threads = state.projectThreads[cleanString(projectId)] || [];
  return threads.find((thread) => thread.id === normalizedThreadId) || null;
}

function projectTabLabel(tab) {
  if (!tab) {
    return "Tab";
  }

  if (tab.pane === "terminal") {
    return "Terminal";
  }

  if (tab.pane === "resource") {
    return findResource(tab.resourceId)?.name || "Resource";
  }

  if (!cleanString(tab.threadId)) {
    return "New Chat";
  }

  const thread = findThreadSummary(tab.projectId, tab.threadId);
  return oneLine(thread?.name || thread?.preview || "Conversation") || "Conversation";
}

function projectTabTitle(tab) {
  if (!tab) {
    return "Open tab";
  }

  if (tab.pane === "terminal") {
    const project = state.projects.find((entry) => entry.id === tab.projectId);
    return project?.cwd || projectDisplayName(project) || "Terminal";
  }

  if (tab.pane === "resource") {
    return findResource(tab.resourceId)?.path || projectTabLabel(tab);
  }

  const thread = findThreadSummary(tab.projectId, tab.threadId);
  return thread?.name || thread?.preview || "New conversation";
}

function renderThreadTabs() {
  const projectId = cleanString(state.selectedProjectId);
  const tabs = projectOpenTabs(projectId);
  const activeTabId = projectActiveTabId(projectId);
  const hasTerminalTab = tabs.some((tab) => tab.pane === "terminal");

  return `
    <div class="thread-tabbar-wrap">
      <div class="thread-tabbar" role="tablist" aria-label="Project tabs">
        ${tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const label = projectTabLabel(tab);
          const title = projectTabTitle(tab);

          return `
            <span class="thread-resource-tab ${active ? "active" : ""}">
              <button
                class="thread-tab thread-resource-tab-button ${active ? "active" : ""}"
                data-action="select-project-tab"
                data-id="${escapeHtml(tab.id)}"
                role="tab"
                aria-selected="${active ? "true" : "false"}"
                title="${escapeHtml(title)}"
              >${escapeHtml(label)}</button>
              <button
                type="button"
                class="thread-resource-tab-close"
                data-action="close-project-tab"
                data-id="${escapeHtml(tab.id)}"
                aria-label="${escapeHtml(`Close ${label}`)}"
                title="${escapeHtml(`Close ${label}`)}"
              >×</button>
            </span>
          `;
        }).join("")}
      </div>
      <div class="thread-tabbar-actions">
        <button type="button" class="thread-tab-action" data-action="new-thread" title="Open a new conversation tab">+ Chat</button>
        ${hasTerminalTab ? "" : `<button type="button" class="thread-tab-action" data-action="open-terminal-tab" title="Open a terminal tab">Terminal</button>`}
      </div>
    </div>
  `;
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
  const projects = state.projects.slice();
  const project = selectedProject();
  const projectId = cleanString(project?.id || state.selectedProjectId);
  const projectPath = project ? (project.cwd || projectDisplayName(project)) : "";
  const threadsLoaded = Boolean(projectId) && Object.prototype.hasOwnProperty.call(state.projectThreads, projectId);
  const threads = threadsLoaded ? (state.projectThreads[projectId] || []) : [];
  const pendingNewThread = state.pendingNewThread
    && !state.selectedThreadId
    && cleanString(state.pendingNewThread.projectId) === projectId
      ? state.pendingNewThread
      : null;

  if (elements.projectSelect) {
    elements.projectSelect.innerHTML = projects.length
      ? projects.map((entry) => optionHtml(entry.id, projectDisplayName(entry))).join("")
      : optionHtml("", "No projects");
    elements.projectSelect.disabled = projects.length === 0;
    elements.projectSelect.value = projects.some((entry) => entry.id === projectId) ? projectId : "";
    elements.projectSelect.title = projectPath || "No project selected";
  }

  elements.archivedToggle.textContent = state.archived ? "Archived" : "Active";
  elements.archivedToggle.setAttribute("aria-pressed", state.archived ? "true" : "false");
  elements.archivedToggle.setAttribute(
    "aria-label",
    state.archived ? "Viewing archived conversations" : "Viewing active conversations",
  );
  elements.archivedToggle.title = state.archived ? "Viewing archived conversations" : "Viewing active conversations";
  elements.archivedToggle.classList.toggle("is-active", state.archived);

  if (projects.length === 0) {
    elements.projectList.innerHTML = `<div class="empty">No projects yet.</div>`;
    return;
  }

  elements.projectList.innerHTML = !threadsLoaded
    ? `<div class="conversation-empty loading">Loading conversations...</div>`
    : (threads.length || pendingNewThread)
      ? `${pendingNewThread ? `
        <button class="conversation-row selected working" type="button" disabled>
          <span class="conversation-primary">
            <span class="conversation-title">${escapeHtml(pendingNewThread.title)}</span>
            <span class="conversation-status">${renderActivityBadge("Starting", "Starting conversation", "sidebar")}</span>
          </span>
          <span class="conversation-time">now</span>
        </button>
      ` : ""}${threads.map((thread) => {
        const preview = (thread.preview || thread.name || "New conversation").replace(/\s+/g, " ").trim();
        const timeText = relativeTime(thread.updatedAt || thread.createdAt);
        const activity = describeThreadActivity(thread);
        const rowClasses = ["conversation-row"];
        if (thread.id === state.selectedThreadId) {
          rowClasses.push("selected");
        }
        if (activity.isWorking) {
          rowClasses.push("working");
        }
        return `
          <button class="${rowClasses.join(" ")}" data-action="select-thread" data-project-id="${escapeHtml(projectId)}" data-id="${escapeHtml(thread.id)}">
            <span class="conversation-primary">
              <span class="conversation-title">${escapeHtml(preview)}</span>
              ${activity.isWorking ? `<span class="conversation-status">${renderActivityBadge(activity.label, activity.statusText, "sidebar")}</span>` : ""}
            </span>
            <span class="conversation-time">${escapeHtml(timeText)}</span>
          </button>
        `;
      }).join("")}`
      : `<div class="conversation-empty">No conversations yet</div>`;
}

function renderThreadHeader() {
  normalizeSelectedProjectResourceTab();

  const currentTab = activeProjectTab();
  const chatTab = currentTab?.pane === "chat";
  const thread = currentTab?.pane === "chat" ? state.selectedThread : null;
  const project = selectedProject();
  const compactHeaderOnly = currentTab?.pane === "resource" || currentTab?.pane === "terminal";
  const projectName = project ? projectDisplayName(project) : "";
  const pendingNewThread = state.pendingNewThread
    && !state.selectedThreadId
    && cleanString(state.pendingNewThread.projectId) === cleanString(project?.id)
      ? state.pendingNewThread
      : null;
  const emptyStateSubtitle = isSelectedThreadLoading()
    ? "Loading conversation..."
    : currentTab?.pane === "terminal"
    ? "Open a shell in the selected project on the host."
    : currentTab?.pane === "resource"
    ? "Open a file link in the conversation to inspect it here."
    : pendingNewThread
    ? "Sending first message..."
    : "Start a new conversation below. The first prompt creates the thread.";

  if (!thread) {
    elements.threadHeader.innerHTML = `
      <div class="thread-toolbar-controls">
        <div class="thread-toolbar-top">
          ${renderThreadTabs()}
          ${chatTab ? "" : renderThreadActionMenu()}
        </div>
      </div>
      ${chatTab || compactHeaderOnly ? "" : `
        <div class="thread-toolbar">
          <div class="thread-title-wrap">
            <h2 class="thread-title" title="${escapeHtml(pendingNewThread?.title || project?.cwd || projectName || "No project selected")}">${escapeHtml(pendingNewThread?.title || projectName || "No project selected")}</h2>
            <p class="meta">${escapeHtml(emptyStateSubtitle)}</p>
          </div>
        </div>
      `}
    `;
    return;
  }

  const activity = describeThreadActivity(thread);
  const threadStatusText = activity.statusText || formatStatus(thread.status);

  elements.threadHeader.innerHTML = `
    <div class="thread-toolbar-controls">
      <div class="thread-toolbar-top">
        ${renderThreadTabs()}
        ${chatTab ? "" : renderThreadActionMenu()}
      </div>
    </div>
    ${chatTab || compactHeaderOnly ? "" : `
      <div class="thread-toolbar">
        <div class="thread-title-wrap">
          <h2 class="thread-title" title="${escapeHtml(thread.name || thread.preview || "Untitled thread")}">${escapeHtml(thread.name || thread.preview || "Untitled thread")}</h2>
          <div class="meta thread-meta">
            <span>${escapeHtml(projectName)}</span>
            <span>·</span>
            ${renderActivityBadge(activity.isWorking ? activity.label : threadStatusText, threadStatusText, activity.isWorking ? "live" : "idle")}
            <span>·</span>
            <span>${escapeHtml(thread.cwd || "")}</span>
          </div>
        </div>
      </div>
    `}
  `;
}

function renderThreadPane() {
  normalizeSelectedProjectResourceTab();
  syncPendingRalphLoopReplay();
  syncAllPaneFrames();
}

function scheduleProjectsRender() {
  if (projectThreadsRenderScheduled) {
    return;
  }

  projectThreadsRenderScheduled = true;
  requestAnimationFrame(() => {
    projectThreadsRenderScheduled = false;
    renderProjects();
  });
}

function scheduleProjectThreadsReload(delayMs = 180) {
  clearTimeout(projectThreadsReloadTimer);
  projectThreadsReloadTimer = setTimeout(() => {
    projectThreadsReloadTimer = null;
    void flushProjectThreadsReload();
  }, delayMs);
}

async function flushProjectThreadsReload() {
  if (projectThreadsReloadInFlight) {
    projectThreadsReloadQueued = true;
    return;
  }

  projectThreadsReloadInFlight = true;

  try {
    await loadAllProjectThreads();
  } catch (error) {
    console.error("Failed to refresh project threads", error);
  } finally {
    projectThreadsReloadInFlight = false;

    if (projectThreadsReloadQueued) {
      projectThreadsReloadQueued = false;
      scheduleProjectThreadsReload();
    }
  }
}

function visibleProjectTab() {
  return activeProjectTab(state.selectedProjectId);
}

function postPaneMessage(tabId, pane, type, payload = {}) {
  const entry = paneFrameEntries.get(cleanString(tabId));

  if (!entry?.frame?.contentWindow || entry.ready !== true) {
    return;
  }

  entry.frame.contentWindow.postMessage({
    source: "codex-host",
    pane,
    type,
    payload,
  }, window.location.origin);
}

function syncChatPaneFrame(tab) {
  if (!tab?.id || tab.pane !== "chat") {
    return;
  }

  const visibleTabId = visibleProjectTab()?.id || "";
  const project = state.projects.find((entry) => entry.id === cleanString(tab.projectId)) || null;
  const replay = state.ralphLoopPendingReplay?.threadId === cleanString(tab.threadId)
    ? {
      threadId: state.ralphLoopPendingReplay.threadId,
      remainingSeconds: state.ralphLoopPendingReplay.remainingSeconds,
    }
    : null;
  const composerView = buildComposerViewState();

  postPaneMessage(tab.id, "chat", "state", {
    active: visibleTabId === tab.id,
    projectId: cleanString(tab.projectId),
    threadId: cleanString(tab.threadId),
    projectName: project ? projectDisplayName(project) : "",
    archived: state.archived,
    autoscroll: state.autoscroll,
    approveAllDangerous: state.composerApproveAllDangerous,
    pendingRalphLoopReplay: replay,
    pendingNewThread: state.pendingNewThread
      && cleanString(state.pendingNewThread.projectId) === cleanString(tab.projectId)
      ? state.pendingNewThread
      : null,
    composer: {
      draftText: elements.promptInput.value || "",
      attachments: state.composerAttachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        url: attachment.url,
      })),
      sendInFlight: state.manualSendInFlight,
      ...composerView,
    },
  });
}

function syncTerminalPaneFrame(tab) {
  if (!tab?.id || tab.pane !== "terminal") {
    return;
  }

  const visibleTabId = visibleProjectTab()?.id || "";

  postPaneMessage(tab.id, "terminal", "state", {
    active: visibleTabId === tab.id,
    projectId: cleanString(tab.projectId),
  });
}

function syncResourcePaneFrame(tab) {
  if (!tab?.id || tab.pane !== "resource") {
    return;
  }

  const visibleTabId = visibleProjectTab()?.id || "";
  const resource = findResource(tab.resourceId);

  postPaneMessage(tab.id, "resource", "state", {
    active: visibleTabId === tab.id,
    projectId: cleanString(tab.projectId),
    resource: resource
      ? {
        id: resource.id,
        projectId: resource.projectId,
        path: resource.path,
        name: resource.name,
      }
      : null,
  });
}

function syncAllPaneFrames() {
  const tabs = allOpenTabs();
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const visibleTabId = visibleProjectTab()?.id || "";
  const visibleTab = visibleTabId
    ? tabs.find((tab) => tab.id === visibleTabId) || null
    : null;

  for (const tabId of Array.from(paneFrameEntries.keys())) {
    if (!tabIds.has(tabId) || tabId !== visibleTabId) {
      removePaneFrameEntry(tabId);
    }
  }

  if (!visibleTab) {
    return;
  }

  const entry = ensurePaneFrameEntry(visibleTab);

  if (!entry) {
    return;
  }

  entry.frame.classList.add("is-active");
  entry.frame.setAttribute("aria-hidden", "false");

  if (visibleTab.pane === "terminal") {
    syncTerminalPaneFrame(visibleTab);
    return;
  }

  if (visibleTab.pane === "resource") {
    syncResourcePaneFrame(visibleTab);
    return;
  }

  syncChatPaneFrame(visibleTab);
}

function applyPaneThreadSummary(tab, payload = {}) {
  const thread = payload.thread && typeof payload.thread === "object" ? payload.thread : null;
  const currentTurnId = cleanString(payload.currentTurnId);

  if (!thread?.id) {
    return;
  }

  if (thread.id === state.selectedThreadId) {
    state.selectedThread = {
      ...(state.selectedThread && state.selectedThread.id === thread.id ? state.selectedThread : {}),
      ...thread,
    };

    if (currentTurnId) {
      state.currentTurnId = currentTurnId;
    }
  }

  syncThreadSummary(thread);
  renderProjects();

  if (thread.id === state.selectedThreadId || cleanString(tab?.projectId) === cleanString(state.selectedProjectId)) {
    renderThreadHeader();
  }
}

async function performThreadAction(action, options = {}) {
  if (!state.selectedThreadId) {
    return;
  }

  if (action === "rename-thread") {
    const name = cleanString(options.name);
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
    const archivedThreadId = state.selectedThreadId;
    await api(`/api/threads/${encodeURIComponent(state.selectedThreadId)}/${action === "archive-thread" ? "archive" : "unarchive"}`, {
      method: "POST",
      body: {},
    });
    await loadAllProjectThreads();
    closeProjectThreadTabs(state.selectedProjectId, archivedThreadId);
    syncSelectedProjectThreadTab();
    persistSelection();
    renderProjects();
    renderThreadHeader();
    renderConversation();
    renderThreadPane();
    if (state.selectedThreadId) {
      await loadThread(state.selectedThreadId).catch(console.error);
    }
  }
}

function handlePaneMessage(event) {
  if (event.origin !== window.location.origin) {
    return;
  }

  const data = event.data;

  if (!data || data.source !== "codex-pane") {
    return;
  }

  const entry = paneFrameEntryForWindow(event.source);
  if (!entry) {
    return;
  }

  const tab = findOpenTab(entry.tabId);
  const pane = cleanString(data.pane);

  if (data.type === "ready" && pane) {
    entry.ready = true;
    if (tab?.pane === "chat") {
      syncChatPaneFrame(tab);
    } else if (tab?.pane === "terminal") {
      syncTerminalPaneFrame(tab);
    } else if (tab?.pane === "resource") {
      syncResourcePaneFrame(tab);
    }
    return;
  }

  if (pane === "chat" && data.type === "thread-summary") {
    applyPaneThreadSummary(tab, data.payload);
    return;
  }

  if (pane === "chat" && data.type === "open-resource") {
    void openResourceFromFileLink(data.payload?.reference, { projectId: tab?.projectId }).catch(console.error);
    return;
  }

  if (pane === "chat" && data.type === "refresh-threads") {
    void loadAllProjectThreads().catch(console.error);
    return;
  }

  if (pane === "chat" && data.type === "send-message") {
    void sendConversationMessage(data.payload || {}).then(() => {
      if (state.composerRalphLoop) {
        persistComposerDraft();
      } else {
        elements.promptInput.value = "";
        clearComposerDraft();
        state.composerAttachments = [];
      }
      renderComposerAttachments();
      syncAllPaneFrames();
    }).catch((error) => {
      alert(error.message);
    });
    return;
  }

  if (pane === "chat" && data.type === "composer-draft") {
    elements.promptInput.value = String(data.payload?.text || "");
    persistComposerDraft();
    return;
  }

  if (pane === "chat" && data.type === "composer-attachments") {
    state.composerAttachments = Array.isArray(data.payload?.attachments)
      ? data.payload.attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        url: attachment.url,
      }))
      : [];
    renderComposerAttachments();
    return;
  }

  if (pane === "chat" && data.type === "composer-setting") {
    const key = cleanString(data.payload?.key);
    const value = data.payload?.value;

    if (key === "autoscroll") {
      state.autoscroll = value === true;
      persistSelection();
    } else if (key === "approveAllDangerous") {
      state.composerApproveAllDangerous = value === true;
      persistSelection();
    } else if (key === "ralphLoop") {
      state.composerRalphLoop = value === true;
      if (!state.composerRalphLoop) {
        cancelPendingRalphLoop({ cancelAutoCompact: true });
      } else if (state.selectedThreadId && currentRalphLoopInput(state.selectedThreadId)) {
        setRalphLoopBudget(state.selectedThreadId);
      }
    } else if (key === "ralphLoopLimit") {
      state.composerRalphLoopLimit = normalizeRalphLoopLimit(value);
      syncConfiguredRalphLoopBudget();
    } else if (key === "model") {
      state.composerModel = cleanString(value);
    } else if (key === "effort") {
      state.composerEffort = cleanString(value);
    } else if (key === "serviceTier") {
      state.composerServiceTier = cleanString(value);
    } else if (key === "mode") {
      state.composerMode = value === "plan" ? "plan" : "default";
    }

    normalizeComposerSettings();
    persistComposerSettings();
    renderComposerControls();
    return;
  }

  if (pane === "chat" && data.type === "open-composer-attachment") {
    void openImageEditor(cleanString(data.payload?.id)).catch(console.error);
    return;
  }

  if (pane === "chat" && data.type === "remove-composer-attachment") {
    state.composerAttachments = state.composerAttachments.filter((attachment) => attachment.id !== cleanString(data.payload?.id));
    renderComposerAttachments();
    return;
  }

  if (pane === "chat" && data.type === "thread-action") {
    void performThreadAction(cleanString(data.payload?.action), { name: data.payload?.name }).catch((error) => {
      alert(error.message);
    });
    return;
  }

  if (pane === "resource" && data.type === "close-resource") {
    closeResourceTab(cleanString(data.payload?.resourceId) || cleanString(tab?.resourceId));
  }
}

function focusActiveThreadPane(tab = state.activeThreadTab) {
  const activeTab = visibleProjectTab();

  requestAnimationFrame(() => {
    if (!activeTab?.id) {
      return;
    }

    if (tab === "terminal") {
      postPaneMessage(activeTab.id, "terminal", "focus");
      return;
    }

    if (tab === "resource") {
      postPaneMessage(activeTab.id, "resource", "focus");
      return;
    }

    if (tab === "chat") {
      postPaneMessage(activeTab.id, "chat", "focus");
    }
  });
}

async function openResourceFromFileLink(reference, options = {}) {
  if (!reference?.path) {
    return;
  }

  const projectId = cleanString(options.projectId || state.selectedProjectId);

  if (!projectId) {
    return;
  }

  if (projectId !== state.selectedProjectId) {
    state.selectedProjectId = projectId;
  }

  const resources = projectResources(projectId);
  let resource = resources.find((entry) => entry.path === reference.path);

  if (!resource) {
    resource = createResourceTab(reference.path, { ...reference, projectId });
    resources.push(resource);
  } else if (reference.line || reference.column) {
    resource.pendingSelection = normalizeResourceSelection(reference);
  }

  setProjectActiveResource(projectId, resource.id);
  openProjectResourceTab(projectId, resource.id, { activate: true });
  syncSelectedProjectThreadTab();
  persistSelection();
  renderThreadHeader();
  renderThreadPane();
  focusActiveThreadPane("resource");
}

function closeResourceTab(resourceId) {
  const resource = findResource(resourceId);

  if (!resource) {
    return;
  }

  const resources = projectResources(resource.projectId);
  const index = resources.findIndex((entry) => entry.id === resourceId);

  if (index < 0) {
    return;
  }

  resources.splice(index, 1);

  if (projectActiveResourceId(resource.projectId) === resourceId) {
    const nextActive = resources[index] || resources[index - 1] || null;
    setProjectActiveResource(resource.projectId, nextActive?.id || "");
  }

  closeProjectTab(resource.projectId, `resource:${resourceId}`, { ensureFallback: true });
  if (cleanString(resource.projectId) === cleanString(state.selectedProjectId)) {
    syncSelectedProjectThreadTab();
  }

  persistSelection();
  renderThreadHeader();
  renderThreadPane();
}

function renderConversation() {
  syncPendingRalphLoopReplay();
  renderRalphLoopDialog(currentPendingRalphLoopReplay(state.selectedThread?.id || state.selectedThreadId));
  syncAllPaneFrames();
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
    syncAllPaneFrames();
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
  syncAllPaneFrames();
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
    const display = getPlanDisplay(item);
    return renderCollapsibleItem(item, display, latestCollapsibleItemId);
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
    const summary = `${item.server || "mcp"} · ${item.tool || "tool"}`;
    const details = JSON.stringify(item, null, 2);
    return renderCollapsibleItem(item, {
      title: "MCP Tool",
      summary,
      body: details,
      meta: formatStatus(item.status),
    }, latestCollapsibleItemId);
  }

  if (item.type === "dynamicToolCall") {
    const summary = item.tool || "dynamic tool";
    return renderCollapsibleItem(item, {
      title: "Tool Call",
      summary,
      bodyHtml: renderToolCallBody(item),
      meta: formatStatus(item.status),
    }, latestCollapsibleItemId);
  }

  if (item.type === "collabAgentToolCall") {
    const summary = `${item.tool || "agent tool"}${item.model ? ` · ${item.model}` : ""}`;
    const details = JSON.stringify(item, null, 2);
    return renderCollapsibleItem(item, {
      title: "Collaboration",
      summary,
      body: details,
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

function renderToolCallBody(item) {
  const metadata = [];

  if (item?.id) {
    metadata.push(`id: ${item.id}`);
  }

  if (item?.tool) {
    metadata.push(`tool: ${item.tool}`);
  }

  if (item?.status) {
    metadata.push(`status: ${item.status}`);
  }

  if (item?.arguments && Object.keys(item.arguments).length > 0) {
    metadata.push(`arguments:\n${JSON.stringify(item.arguments, null, 2)}`);
  }

  const contentItems = Array.isArray(item?.contentItems) ? item.contentItems : [];
  const sections = [];

  if (metadata.length > 0) {
    sections.push(`<pre data-role="body">${escapeHtml(metadata.join("\n\n"))}</pre>`);
  }

  if (contentItems.length > 0) {
    sections.push(`<div class="message-body tool-call-content">${renderMessageContent(contentItems)}</div>`);
  }

  if (!sections.length) {
    sections.push(`<pre data-role="body">${escapeHtml(JSON.stringify(item, null, 2))}</pre>`);
  }

  return `<div class="tool-call-body">${sections.join("")}</div>`;
}

function renderPendingServerRequest(request) {
  if (!request?.method) {
    return "";
  }

  if (request.method === "item/tool/requestUserInput") {
    const questions = Array.isArray(request.params?.questions) ? request.params.questions : [];
    const body = questions.map((question, index) => {
      const options = Array.isArray(question.options) ? question.options : [];
      const fieldId = `pending-${escapeHtml(String(request.id))}-${escapeHtml(question.id || String(index))}`;
      const useSelect = options.length > 0;
      const allowOther = Boolean(question.isOther);

      return `
        <label class="pending-request-field" for="${fieldId}">
          <span class="pending-request-label">${escapeHtml(question.header || question.id || `Question ${index + 1}`)}</span>
          <span class="pending-request-help">${escapeHtml(question.question || "")}</span>
          ${useSelect ? `
            <select id="${fieldId}" name="${escapeHtml(question.id || `question_${index}`)}" class="pending-request-input" ${allowOther ? `data-has-other="true" data-other-target="${fieldId}-other"` : ""}>
              <option value="">Select an answer</option>
              ${options.map((option) => `<option value="${escapeHtml(option.label || "")}">${escapeHtml(option.label || "")}</option>`).join("")}
              ${allowOther ? `<option value="__other__">Other</option>` : ""}
            </select>
          ` : `
            <input id="${fieldId}" name="${escapeHtml(question.id || `question_${index}`)}" class="pending-request-input" type="${question.isSecret ? "password" : "text"}" autocomplete="off">
          `}
          ${allowOther ? `<input id="${fieldId}-other" name="${escapeHtml(question.id || `question_${index}`)}__other" class="pending-request-input hidden" type="${question.isSecret ? "password" : "text"}" autocomplete="off" placeholder="Enter another answer">` : ""}
        </label>
      `;
    }).join("");

    return `
      <article class="bubble agent pending-request-card">
        <strong>Input Required</strong>
        <div class="message-body">
          <form data-action="respond-tool-request-user-input" data-request-id="${escapeHtml(String(request.id))}">
            ${body}
            <div class="pending-request-actions">
              <button type="submit">Send Response</button>
            </div>
          </form>
        </div>
      </article>
    `;
  }

  if (request.method === "item/commandExecution/requestApproval") {
    const decisions = normalizeCommandApprovalDecisions(request.params?.availableDecisions);
    const reason = request.params?.reason || "";
    const command = request.params?.command || "";
    const cwd = request.params?.cwd || "";
    const hasDetails = Boolean(reason || command || cwd);

    return `
      <article class="bubble agent pending-request-card">
        <strong>Command Approval</strong>
        <div class="message-body">
          ${hasDetails ? "" : "<p>This approval request arrived without command details. You can still allow or decline it.</p>"}
          ${reason ? `<p>${escapeHtml(reason)}</p>` : ""}
          ${command ? `<pre>${escapeHtml(command)}</pre>` : ""}
          ${cwd ? `<p><strong>cwd</strong> ${escapeHtml(cwd)}</p>` : ""}
          <div class="pending-request-actions">
            ${decisions.map((decision) => {
              const value = typeof decision === "string" ? decision : JSON.stringify(decision);
              return `<button type="button" data-action="respond-command-approval" data-request-id="${escapeHtml(String(request.id))}" data-decision="${escapeHtml(value)}">${escapeHtml(commandApprovalDecisionLabel(decision))}</button>`;
            }).join("")}
          </div>
        </div>
      </article>
    `;
  }

  if (request.method === "item/fileChange/requestApproval") {
    const reason = request.params?.reason || "Approve file changes?";
    const grantRoot = request.params?.grantRoot || "";

    return `
      <article class="bubble agent pending-request-card">
        <strong>File Change Approval</strong>
        <div class="message-body">
          <p>${escapeHtml(reason)}</p>
          ${grantRoot ? `<p><strong>root</strong> ${escapeHtml(grantRoot)}</p>` : ""}
          <div class="pending-request-actions">
            <button type="button" data-action="respond-file-change-approval" data-request-id="${escapeHtml(String(request.id))}" data-decision="accept">Allow</button>
            <button type="button" data-action="respond-file-change-approval" data-request-id="${escapeHtml(String(request.id))}" data-decision="acceptForSession">Allow For Session</button>
            <button type="button" data-action="respond-file-change-approval" data-request-id="${escapeHtml(String(request.id))}" data-decision="decline">Decline</button>
            <button type="button" data-action="respond-file-change-approval" data-request-id="${escapeHtml(String(request.id))}" data-decision="cancel">Cancel</button>
          </div>
        </div>
      </article>
    `;
  }

  if (request.method === "item/permissions/requestApproval") {
    const reason = request.params?.reason || "Grant additional permissions?";
    const details = request.params?.permissions ? escapeHtml(JSON.stringify(request.params.permissions, null, 2)) : "";

    return `
      <article class="bubble agent pending-request-card">
        <strong>Permissions Approval</strong>
        <div class="message-body">
          <p>${escapeHtml(reason)}</p>
          ${details ? `<pre>${details}</pre>` : ""}
          <div class="pending-request-actions">
            <button type="button" data-action="respond-permissions-approval" data-request-id="${escapeHtml(String(request.id))}" data-scope="turn">Grant For Turn</button>
            <button type="button" data-action="respond-permissions-approval" data-request-id="${escapeHtml(String(request.id))}" data-scope="session">Grant For Session</button>
          </div>
        </div>
      </article>
    `;
  }

  return renderCollapsibleItem({
    id: request.id || request.method,
    type: "pendingRequest",
  }, {
    title: "Pending Request",
    summary: request.method,
    body: JSON.stringify(request, null, 2),
  });
}

function commandApprovalDecisionLabel(decision) {
  if (typeof decision === "string") {
    switch (decision) {
      case "accept":
        return "Allow";
      case "acceptForSession":
        return "Allow For Session";
      case "decline":
        return "Decline";
      case "cancel":
        return "Cancel";
      default:
        return decision;
    }
  }

  if (decision?.acceptWithExecpolicyAmendment) {
    return "Allow With Policy";
  }

  if (decision?.applyNetworkPolicyAmendment) {
    return "Allow Network Policy";
  }

  return "Respond";
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

  if (entry.type === "inputText") {
    return `<pre>${escapeHtml(entry.text || "")}</pre>`;
  }

  const imageUrl = entry.url || entry.imageUrl || entry.image_url || entry.data;

  if ((entry.type === "image" || entry.type === "local_image" || entry.type === "localImage" || entry.type === "inputImage") && imageUrl) {
    return `
      <figure class="message-image-wrap">
        <img class="message-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(entry.alt || entry.name || "Attached image")}">
      </figure>
    `;
  }

  return `<pre>${escapeHtml(`[${entry.type || "content"}] ${entry.path || imageUrl || entry.name || ""}`)}</pre>`;
}

function connectEvents() {
  window.addEventListener("message", handlePaneMessage);
  elements.sidebarResizeHandle.addEventListener("pointerdown", startSidebarResize);
  elements.sidebarResizeHandle.addEventListener("dblclick", handleSidebarResizeDoubleClick);
  elements.sidebarResizeHandle.addEventListener("keydown", handleSidebarResizeKeydown);
  window.addEventListener("pointermove", handleSidebarResizePointerMove);
  window.addEventListener("pointerup", stopSidebarResize);
  window.addEventListener("pointercancel", stopSidebarResize);

  elements.promptInput.addEventListener("paste", handleComposerPaste);
  elements.promptInput.addEventListener("input", () => {
    persistComposerDraft();
  });
  elements.projectSelect?.addEventListener("change", async (event) => {
    try {
      await switchSelectedProject(event.target.value);
    } catch (error) {
      alert(error.message);
    }
  });
  elements.autoscrollToggle.addEventListener("change", (event) => {
    state.autoscroll = event.target.checked;
    persistSelection();
    syncAllPaneFrames();
  });
  elements.approveAllDangerousToggle.addEventListener("change", (event) => {
    state.composerApproveAllDangerous = event.target.checked;
    persistSelection();
    syncAllPaneFrames();
  });
  elements.ralphLoopToggle.addEventListener("change", (event) => {
    state.composerRalphLoop = event.target.checked;
    if (!state.composerRalphLoop) {
      cancelPendingRalphLoop({ cancelAutoCompact: true });
    } else if (state.selectedThreadId && currentRalphLoopInput(state.selectedThreadId)) {
      setRalphLoopBudget(state.selectedThreadId);
    }
  });
  elements.ralphLoopLimitInput.addEventListener("change", (event) => {
    const nextLimit = normalizeRalphLoopLimit(event.target.value);
    state.composerRalphLoopLimit = nextLimit;
    event.target.value = String(nextLimit);
    syncConfiguredRalphLoopBudget();
    persistSelection();
    syncAllPaneFrames();
  });
  elements.imageEditorOverlayCanvas.addEventListener("pointerdown", handleImageEditorPointerDown);
  elements.imageEditorOverlayCanvas.addEventListener("pointermove", handleImageEditorPointerMove);
  elements.imageEditorOverlayCanvas.addEventListener("dblclick", handleImageEditorDoubleClick);
  window.addEventListener("pointerup", handleImageEditorPointerUp);
  window.addEventListener("resize", () => {
    if (window.innerWidth > 980) {
      applySidebarLayout();
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

    if (event.key === "Escape" && state.composerSettingsOpen) {
      state.composerSettingsOpen = false;
      state.composerMenuOpen = "";
      renderComposerControls();
      return;
    }

    if (event.key === "Escape" && state.imageEditor.open) {
      closeImageEditor();
      return;
    }

    if (event.key === "Escape" && state.ralphLoopPendingReplay) {
      cancelPendingRalphLoop({ disableLoop: true, cancelAutoCompact: true });
    }
  });

  window.addEventListener("beforeunload", disconnectConversationSocket);
}

function clampSidebarWidth(width) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function syncSidebarToggleControls() {
  const collapsed = state.sidebarCollapsed;
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const icon = collapsed ? "&gt;" : "&lt;";

  [elements.sidebarToggleButton, elements.sidebarRailToggle].forEach((button) => {
    if (!button) {
      return;
    }

    button.setAttribute("aria-pressed", collapsed ? "true" : "false");
    button.setAttribute("aria-label", label);
    button.title = label;
    button.innerHTML = `<span aria-hidden="true">${icon}</span>`;
  });

  if (elements.sidebarPanel) {
    elements.sidebarPanel.setAttribute("aria-hidden", collapsed ? "true" : "false");
  }
}

function applySidebarLayout() {
  if (!elements.layout) {
    return;
  }

  state.sidebarWidth = clampSidebarWidth(state.sidebarWidth);
  elements.layout.style.setProperty("--sidebar-width", `${state.sidebarWidth}px`);
  elements.layout.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  elements.sidebarResizeHandle.setAttribute("aria-label", state.sidebarCollapsed ? "Expand sidebar" : "Resize sidebar");
  syncSidebarToggleControls();
}

function toggleSidebarCollapsed(force) {
  const nextCollapsed = typeof force === "boolean" ? force : !state.sidebarCollapsed;
  if (nextCollapsed === state.sidebarCollapsed) {
    return;
  }

  state.sidebarCollapsed = nextCollapsed;
  applySidebarLayout();
  persistSelection();
}

function startSidebarResize(event) {
  if (state.sidebarCollapsed || window.innerWidth <= 980 || event.target.closest("[data-action='toggle-sidebar']")) {
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
  applySidebarLayout();
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

function handleSidebarResizeDoubleClick(event) {
  if (event.target.closest("[data-action='toggle-sidebar']")) {
    return;
  }

  event.preventDefault();
  toggleSidebarCollapsed();
}

function handleSidebarResizeKeydown(event) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    toggleSidebarCollapsed();
    return;
  }

  if (window.innerWidth <= 980 || state.sidebarCollapsed) {
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
  applySidebarLayout();
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

  socket.addEventListener("open", async () => {
    if (conversationSocket !== socket) {
      return;
    }

    try {
      await loadPendingServerRequests();
      renderProjects();
      renderSelectedThread();
      void maybeAutoApprovePendingRequests();
    } catch (error) {
      console.error("Failed to sync pending requests", error);
    }
  });

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
      void maybeAutoApprovePendingRequests([payload.request]);

      if (payload.request?.params?.threadId === state.selectedThreadId) {
        renderSelectedThread();
      }

      return;
    }

    if (payload.type === "notification") {
      const message = payload.message;
      const method = typeof message?.method === "string" ? message.method : "";
      const threadId = message.params?.threadId || message.params?.thread?.id;

      if (!method) {
        return;
      }

      if (method === "serverRequest/resolved" && message.params?.requestId != null) {
        removePendingServerRequest(message.params.requestId);
      }

      if (threadId && threadId === state.selectedThreadId) {
        const handledLive = applyStreamingNotification(message);

        if (!handledLive) {
          await loadThread(state.selectedThreadId).catch(console.error);
        }
      }

      if (method.startsWith("thread/")) {
        scheduleProjectThreadsReload();
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
  clearTimeout(projectThreadsReloadTimer);
  projectThreadsReloadTimer = null;
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

  const anchor = event.target.closest(".message-body a[href]");
  if (anchor instanceof HTMLAnchorElement) {
    const fileReference = parseLocalFileLinkHref(anchor.getAttribute("href"));

    if (fileReference) {
      event.preventDefault();
      await openResourceFromFileLink(fileReference);
      return;
    }
  }

  if (state.threadActionMenuOpen && !event.target.closest(".thread-action-menu")) {
    state.threadActionMenuOpen = false;
    renderThreadHeader();
  }

  if (state.composerMenuOpen && !event.target.closest(".composer-settings")) {
    state.composerMenuOpen = "";
    renderComposerControls();
  }

  if (state.composerSettingsOpen && !event.target.closest(".composer-settings")) {
    state.composerSettingsOpen = false;
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

    if (action === "toggle-sidebar") {
      toggleSidebarCollapsed();
      return;
    }

    if (action === "toggle-thread-action-menu") {
      state.threadActionMenuOpen = !state.threadActionMenuOpen;
      renderThreadHeader();
      return;
    }

    if (action === "toggle-composer-settings") {
      state.composerSettingsOpen = !state.composerSettingsOpen;
      if (!state.composerSettingsOpen) {
        state.composerMenuOpen = "";
      }
      renderComposerControls();
      return;
    }

    if (action === "toggle-composer-menu") {
      if (!state.composerSettingsOpen) {
        state.composerSettingsOpen = true;
      }
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
      normalizeComposerSettings();
      renderComposerControls();
      return;
    }

    if (action === "select-composer-service-tier") {
      state.composerServiceTier = button.dataset.value || "";
      state.composerMenuOpen = "";
      normalizeComposerSettings();
      renderComposerControls();
      return;
    }

    if (action === "toggle-composer-mode") {
      state.composerMode = state.composerMode === "plan" ? "default" : "plan";
      persistComposerSettings();
      renderComposerControls();
      return;
    }

    if (action === "cancel-ralph-loop") {
      cancelPendingRalphLoop({ disableLoop: true, cancelAutoCompact: true });
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
      if (!state.selectedProjectId || !state.projects.some((project) => project.id === state.selectedProjectId)) {
        state.selectedProjectId = state.projects[0]?.id || "";
      }
      if (state.selectedProjectId) {
        normalizeProjectOpenTabs(state.selectedProjectId);
      }
      syncSelectedProjectThreadTab();
      await loadAllProjectThreads();
      if (state.selectedThreadId) {
        await loadThread(state.selectedThreadId).catch(console.error);
      }
      renderProjects();
      return;
    }

    if (action === "select-project") {
      await switchSelectedProject(button.dataset.id || "");
      return;
    }

    if (action === "refresh-threads") {
      await loadAllProjectThreads();
      renderProjects();
      return;
    }

    if (action === "select-project-tab") {
      const tabId = button.dataset.id || "";
      if (!tabId) {
        return;
      }

      setProjectActiveTabId(state.selectedProjectId, tabId);
      syncSelectedProjectThreadTab();
      state.threadActionMenuOpen = false;
      persistSelection();
      renderThreadHeader();
      renderConversation();
      renderThreadPane();
      if (state.selectedThreadId) {
        await loadThread(state.selectedThreadId).catch(console.error);
      }
      focusActiveThreadPane(projectThreadTab());
      return;
    }

    if (action === "open-terminal-tab") {
      if (!state.selectedProjectId) {
        return;
      }

      openProjectTerminalTab(state.selectedProjectId, { activate: true });
      syncSelectedProjectThreadTab();
      state.threadActionMenuOpen = false;
      persistSelection();
      renderThreadHeader();
      renderThreadPane();
      focusActiveThreadPane("terminal");
      return;
    }

    if (action === "close-project-tab") {
      const tabId = button.dataset.id || "";
      const tab = findProjectTab(state.selectedProjectId, tabId);

      if (!tab) {
        return;
      }

      if (tab.pane === "resource") {
        closeResourceTab(tab.resourceId || "");
      } else {
        closeProjectTab(state.selectedProjectId, tabId, { ensureFallback: true });
        syncSelectedProjectThreadTab();
        persistSelection();
        renderThreadHeader();
        renderConversation();
        renderThreadPane();
        if (state.selectedThreadId) {
          await loadThread(state.selectedThreadId).catch(console.error);
        }
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
      const projectId = button.dataset.projectId || state.selectedProjectId;

      if (projectId) {
        state.selectedProjectId = projectId;
      }

      createProjectDraftTab(state.selectedProjectId, { activate: true });
      state.threadActionMenuOpen = false;
      syncSelectedProjectThreadTab();

      state.threads = state.projectThreads[state.selectedProjectId] || [];
      persistSelection();
      renderProjects();
      renderThreadHeader();
      renderConversation();
      renderComposerControls();
      renderThreadPane();

      if (projectId && !Object.prototype.hasOwnProperty.call(state.projectThreads, projectId)) {
        void loadProjectThreads(projectId).catch((error) => {
          console.error(`Failed to load threads for project ${projectId}`, error);
        });
      }

      return;
    }

    if (action === "select-thread") {
      const threadId = button.dataset.id || "";
      const projectId = button.dataset.projectId || state.selectedProjectId;

      if (!threadId) {
        return;
      }

      if (projectId && projectId !== state.selectedProjectId) {
        state.selectedProjectId = projectId;
        if (!state.projectThreads[projectId]) {
          void loadProjectThreads(projectId).catch((error) => {
            console.error(`Failed to load threads for project ${projectId}`, error);
          });
        }
      }

      openProjectThreadTab(projectId, threadId, { activate: true });
      syncSelectedProjectThreadTab();
      state.threadActionMenuOpen = false;
      persistSelection();
      renderProjects();
      renderThreadHeader();
      renderConversation();
      renderThreadPane();
      await loadThread(threadId);
      return;
    }

    if (action === "rename-thread") {
      const name = window.prompt("Thread name", state.selectedThread?.name || "");
      await performThreadAction(action, { name });
      return;
    }

    if (action === "fork-thread") {
      await performThreadAction(action);
      return;
    }

    if (action === "compact-thread") {
      await performThreadAction(action);
      return;
    }

    if (action === "review-thread") {
      await performThreadAction(action);
      return;
    }

    if (action === "interrupt-thread") {
      await performThreadAction(action);
      return;
    }

    if (action === "archive-thread" || action === "unarchive-thread") {
      await performThreadAction(action);
      return;
    }

    if (action === "respond-command-approval") {
      const requestId = button.dataset.requestId || "";
      const request = state.pendingServerRequests.find((entry) => String(entry?.id) === requestId);
      await respondToPendingServerRequest(request || { id: requestId }, {
        decision: parsePendingDecision(button.dataset.decision),
      });
      return;
    }

    if (action === "respond-file-change-approval") {
      const requestId = button.dataset.requestId || "";
      const request = state.pendingServerRequests.find((entry) => String(entry?.id) === requestId);
      await respondToPendingServerRequest(request || { id: requestId }, {
        decision: button.dataset.decision || "decline",
      });
      return;
    }

    if (action === "respond-permissions-approval") {
      const requestId = button.dataset.requestId || "";
      const request = state.pendingServerRequests.find((entry) => String(entry?.id) === requestId);
      await respondToPendingServerRequest(request || { id: requestId }, {
        permissions: request?.params?.permissions || {},
        scope: button.dataset.scope === "session" ? "session" : "turn",
      });
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
      createProjectDraftTab(created.id, { activate: true });
      syncSelectedProjectThreadTab();
      form.reset();
      elements.projectQuickAddForm.classList.add("hidden");
      persistSelection();
      await loadThreads();
      return;
    }

    if (form === elements.composerForm) {
      await sendConversationMessage(currentComposerInput());

      if (state.composerRalphLoop) {
        persistComposerDraft();
      } else {
        elements.promptInput.value = "";
        clearComposerDraft();
        state.composerAttachments = [];
        renderComposerAttachments();
      }
      return;
    }

    if (form.dataset.action === "respond-tool-request-user-input") {
      const requestId = form.dataset.requestId || "";
      const formData = new FormData(form);
      const request = state.pendingServerRequests.find((entry) => String(entry?.id) === requestId);
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
      return;
    }

  } catch (error) {
    alert(error.message);
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement) || target.dataset.hasOther !== "true") {
    return;
  }

  const otherTarget = document.getElementById(target.dataset.otherTarget || "");
  if (!(otherTarget instanceof HTMLElement)) {
    return;
  }

  otherTarget.classList.toggle("hidden", target.value !== "__other__");
});

function findLatestTurnId(thread) {
  const turns = thread?.turns || [];
  return turns.length > 0 ? turns[turns.length - 1].id : "";
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
  syncModalOpenState();
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
  syncModalOpenState();
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

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
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
  const classNames = ["status-badge"];
  if (tone === "live" || tone === "small" || tone === "sidebar") {
    classNames.push("live");
  }
  if (tone === "small") {
    classNames.push("small");
  }
  if (tone === "sidebar") {
    classNames.push("sidebar");
  }
  const title = statusText ? ` title="${escapeHtml(statusText)}"` : "";
  return `<span class="${classNames.join(" ")}"${title}><span class="status-dot" aria-hidden="true"></span>${escapeHtml(label)}</span>`;
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

function parsePendingDecision(rawDecision) {
  const value = String(rawDecision || "");
  if (!value) {
    return "decline";
  }

  if (value.startsWith("{")) {
    return JSON.parse(value);
  }

  return value;
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
