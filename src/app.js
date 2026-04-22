import "./styles.css";
import { marked } from "marked";
import {
  buildAutoApprovalResult,
  composerApprovalPolicyOverride,
  normalizeCommandApprovalDecisions,
} from "./approval-utils.mjs";
import { createAttachmentId } from "./attachment-utils.mjs";
import { createAppComposer } from "./app-composer.mjs";
import { createAppEvents } from "./app-events.mjs";
import { createAppHostShell } from "./app-host-shell.mjs";
import { createAppImageEditor, createImageEditorState } from "./app-image-editor.mjs";
import { createAppThreadRuntime, findLatestTurnId } from "./app-thread-runtime.mjs";
import { parseLocalFileLinkHref } from "./file-link-utils.mjs";
import {
  formatServiceTierLabel,
  resolveComposerSelection,
  supportedReasoningEffortsForModel,
  supportedServiceTiersForModel,
} from "./model-capabilities.mjs";
import { createConversationUi } from "./conversation-ui.mjs";
import { createHostTabsState } from "./host-tabs-state.mjs";
import { api } from "./pane-bridge.mjs";
import { RALPH_LOOP_DELAY_SECONDS, startRalphLoopCountdown } from "./ralph-loop-countdown.mjs";
import {
  consumeRalphLoopBudget,
  createRalphLoopBudget,
  hasRalphLoopBudgetRemaining,
  findLatestRalphLoopInput,
  normalizeRalphLoopInput,
  normalizeRalphLoopLimit,
} from "./ralph-loop-utils.mjs";
import {
  cleanString,
  describeStatusActivity,
  describeThreadActivity,
  escapeHtml,
  formatStatus,
  isLiveStatus,
  latestTurn,
  oneLine,
  parsePendingDecision,
  relativeTime,
  renderActivityBadge,
} from "./ui-formatters.mjs";

marked.setOptions({
  gfm: true,
  breaks: true,
});

const markdownHtmlCache = new Map();

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
const actions = {};

const hostTabsState = createHostTabsState({
  state,
  cleanString,
  createId: createAttachmentId,
  oneLine,
  projectDisplayName: (...args) => actions.projectDisplayName?.(...args) || "",
  findLatestTurnId,
});
const {
  activeProjectTab,
  activeResource,
  allOpenTabs,
  createProjectDraftTab,
  createResourceTab,
  createThreadTab,
  findOpenTab,
  findProjectTab,
  findResource,
  findThreadSummary,
  initializeProjectTabs,
  normalizeProjectOpenTabs,
  normalizeResourceSelection,
  normalizeSelectedProjectResourceTab,
  normalizeThreadTab,
  openProjectResourceTab,
  openProjectTerminalTab,
  openProjectThreadTab,
  persistedProjectThreadId,
  projectActiveResourceId,
  projectActiveTabId,
  projectOpenTabs,
  projectResources,
  projectTabLabel,
  projectTabTitle,
  projectThreadTab,
  setProjectActiveResource,
  setProjectActiveTabId,
  setProjectThreadTab,
  syncSelectedProjectThreadTab,
  upsertProjectTab,
} = hostTabsState;

const imageEditor = createAppImageEditor({
  state,
  elements,
  actions,
});
const {
  applyImageEditor,
  closeImageEditor,
  handleImageEditorDoubleClick,
  handleImageEditorPointerDown,
  handleImageEditorPointerMove,
  handleImageEditorPointerUp,
  layoutImageEditorCanvas,
  openImageEditor,
  renderImageEditor,
  setImageEditorTool,
  updateImageEditorColor,
} = imageEditor;

const composer = createAppComposer({
  state,
  elements,
  actions,
  api,
  cleanString,
  escapeHtml,
  formatServiceTierLabel,
  oneLine,
  resolveComposerSelection,
  supportedReasoningEffortsForModel,
  supportedServiceTiersForModel,
  composerApprovalPolicyOverride,
  RALPH_LOOP_DELAY_SECONDS,
  startRalphLoopCountdown,
  consumeRalphLoopBudget,
  createRalphLoopBudget,
  findLatestRalphLoopInput,
  hasRalphLoopBudgetRemaining,
  isLiveStatus,
  latestTurn,
  normalizeRalphLoopInput,
  normalizeRalphLoopLimit,
  activeProjectTab,
  createThreadTab,
  openProjectThreadTab,
  replaceProjectTab: (...args) => actions.replaceProjectTab?.(...args),
  syncSelectedProjectThreadTab,
  draftStorageKey: COMPOSER_DRAFT_STORAGE_KEY,
});
const {
  buildComposerViewState,
  cancelPendingRalphLoop,
  clearComposerDraft,
  currentComposerInput,
  currentPendingRalphLoopReplay,
  currentRalphLoopInput,
  maybeRunRalphLoop,
  normalizeComposerSettings,
  persistComposerDraft,
  persistComposerSettings,
  renderComposerControls,
  renderRalphLoopDialog,
  restoreComposerDraft,
  sendConversationMessage,
  setRalphLoopBudget,
  syncConfiguredRalphLoopBudget,
  syncModalOpenState,
  syncPendingRalphLoopReplay,
} = composer;

const threadRuntime = createAppThreadRuntime({
  state,
  elements,
  actions,
  api,
  buildAutoApprovalResult,
  cleanString,
  escapeHtml,
  formatStatus,
  isLiveStatus,
  oneLine,
  renderItem,
  renderMessageContent,
  renderToolCallBody,
});
const {
  appendIndexedDelta,
  applyStreamingNotification,
  ensureSelectedTurn,
  ensureTurnItem,
  getCommandExecutionDisplay,
  getPlanDisplay,
  getReasoningDisplay,
  handleConversationDetailsToggle,
  latestAgentMessageText,
  loadAllProjectThreads,
  loadPendingServerRequests,
  loadProjectThreads,
  loadThread,
  loadThreads,
  maybeAutoApprovePendingRequests,
  pendingServerRequestsForThread,
  removePendingServerRequest,
  renderCollapsibleArticle,
  renderCollapsibleDisplayBody,
  renderFileChangeBody,
  renderMessageItemBody,
  renderSelectedThread,
  respondToPendingServerRequest,
  shouldExpandConversationItem,
  summarizeMessageItem,
  switchSelectedProject,
  syncThreadSummary,
  upsertPendingServerRequest,
} = threadRuntime;

const hostShell = createAppHostShell({
  state,
  elements,
  actions,
  api,
  cleanString,
  describeThreadActivity,
  escapeHtml,
  formatStatus,
  relativeTime,
  renderActivityBadge,
  normalizeRalphLoopLimit,
  activeProjectTab,
  allOpenTabs,
  createProjectDraftTab,
  createResourceTab,
  findOpenTab,
  findProjectTab,
  findResource,
  initializeProjectTabs,
  normalizeProjectOpenTabs,
  normalizeResourceSelection,
  normalizeSelectedProjectResourceTab,
  openProjectResourceTab,
  openProjectTerminalTab,
  openProjectThreadTab,
  persistedProjectThreadId,
  projectActiveResourceId,
  projectActiveTabId,
  projectOpenTabs,
  projectResources,
  projectTabLabel,
  projectTabTitle,
  projectThreadTab,
  setProjectActiveResource,
  setProjectActiveTabId,
  syncSelectedProjectThreadTab,
  upsertProjectTab,
});
const {
  closeProjectTab,
  closeProjectThreadTabs,
  closeResourceTab,
  focusActiveThreadPane,
  handlePaneMessage,
  renderProjects,
  renderThreadActionMenu,
  renderThreadHeader,
  renderThreadPane,
  replaceProjectTab,
  scheduleProjectThreadsReload,
  scheduleProjectsRender,
  selectedProject,
  syncAllPaneFrames,
  projectDisplayName,
  persistSelection,
  performThreadAction,
  openResourceFromFileLink,
} = hostShell;

const appEvents = createAppEvents({
  state,
  elements,
  actions,
  api,
  cleanString,
  normalizeRalphLoopLimit,
  parseLocalFileLinkHref,
  parsePendingDecision,
  minSidebarWidth: MIN_SIDEBAR_WIDTH,
  maxSidebarWidth: MAX_SIDEBAR_WIDTH,
  createProjectDraftTab,
  findProjectTab,
  normalizeProjectOpenTabs,
  openProjectTerminalTab,
  openProjectThreadTab,
  projectThreadTab,
  setProjectActiveTabId,
  syncSelectedProjectThreadTab,
});
const {
  applySidebarLayout,
  connectConversationSocket,
  connectEvents,
  disconnectConversationSocket,
} = appEvents;

Object.assign(actions, {
  applyImageEditor,
  applySidebarLayout,
  applyStreamingNotification,
  buildComposerViewState,
  cancelPendingRalphLoop,
  clearComposerDraft,
  closeImageEditor,
  closeProjectTab,
  closeResourceTab,
  currentComposerInput,
  currentRalphLoopInput,
  focusActiveThreadPane,
  handleImageEditorDoubleClick,
  handleImageEditorPointerDown,
  handleImageEditorPointerMove,
  handleImageEditorPointerUp,
  handlePaneMessage,
  layoutImageEditorCanvas,
  loadAllProjectThreads,
  loadPendingServerRequests,
  loadProjectThreads,
  loadThread,
  loadThreads,
  maybeAutoApprovePendingRequests,
  maybeRunRalphLoop,
  normalizeComposerSettings,
  openImageEditor,
  openResourceFromFileLink,
  performThreadAction,
  persistComposerDraft,
  persistComposerSettings,
  persistSelection,
  projectDisplayName,
  removePendingServerRequest,
  renderComposerAttachments,
  renderComposerControls,
  renderConversation,
  renderProjects,
  renderSelectedThread,
  renderThreadHeader,
  renderThreadPane,
  replaceProjectTab,
  respondToPendingServerRequest,
  scheduleProjectThreadsReload,
  scheduleProjectsRender,
  selectedProject,
  sendConversationMessage,
  setImageEditorTool,
  setRalphLoopBudget,
  switchSelectedProject,
  syncAllPaneFrames,
  syncConfiguredRalphLoopBudget,
  syncModalOpenState,
  syncPendingRalphLoopReplay,
  syncSelectedProjectThreadTab,
  syncThreadSummary,
  scrollConversationToBottom,
  updateImageEditorColor,
  upsertPendingServerRequest,
});

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

function showFatalError(error) {
  document.body.innerHTML = `<pre style="padding:24px">${escapeHtml(error.stack || error.message || String(error))}</pre>`;
}
