import { createAttachmentId, guessImageExtension, readFileAsDataUrl } from "./attachment-utils.mjs";

export function createAppEvents({
  state,
  elements,
  actions,
  api,
  cleanString,
  normalizeRalphLoopLimit,
  parseLocalFileLinkHref,
  parsePendingDecision,
  minSidebarWidth,
  maxSidebarWidth,
  createProjectDraftTab,
  findProjectTab,
  normalizeProjectOpenTabs,
  openProjectTerminalTab,
  openProjectThreadTab,
  projectThreadTab,
  setProjectActiveTabId,
  syncSelectedProjectThreadTab,
}) {
  let conversationSocket = null;
  let conversationSocketRetryTimer = null;
  let conversationSocketShouldReconnect = true;
  let sidebarResizeState = null;

  function connectEvents() {
    window.addEventListener("message", actions.handlePaneMessage);
    elements.sidebarResizeHandle.addEventListener("pointerdown", startSidebarResize);
    elements.sidebarResizeHandle.addEventListener("dblclick", handleSidebarResizeDoubleClick);
    elements.sidebarResizeHandle.addEventListener("keydown", handleSidebarResizeKeydown);
    window.addEventListener("pointermove", handleSidebarResizePointerMove);
    window.addEventListener("pointerup", stopSidebarResize);
    window.addEventListener("pointercancel", stopSidebarResize);

    elements.promptInput.addEventListener("paste", handleComposerPaste);
    elements.promptInput.addEventListener("input", () => {
      actions.persistComposerDraft?.();
    });
    elements.projectSelect?.addEventListener("change", async (event) => {
      try {
        await actions.switchSelectedProject?.(event.target.value);
      } catch (error) {
        alert(error.message);
      }
    });
    elements.autoscrollToggle.addEventListener("change", (event) => {
      state.autoscroll = event.target.checked;
      actions.persistSelection?.();
      actions.syncAllPaneFrames?.();
    });
    elements.approveAllDangerousToggle.addEventListener("change", (event) => {
      state.composerApproveAllDangerous = event.target.checked;
      actions.persistSelection?.();
      actions.syncAllPaneFrames?.();
    });
    elements.ralphLoopToggle.addEventListener("change", (event) => {
      state.composerRalphLoop = event.target.checked;
      if (!state.composerRalphLoop) {
        actions.cancelPendingRalphLoop?.({ cancelAutoCompact: true });
      } else if (state.selectedThreadId && actions.currentRalphLoopInput?.(state.selectedThreadId)) {
        actions.setRalphLoopBudget?.(state.selectedThreadId);
      }
    });
    elements.ralphLoopLimitInput.addEventListener("change", (event) => {
      const nextLimit = normalizeRalphLoopLimit(event.target.value);
      state.composerRalphLoopLimit = nextLimit;
      event.target.value = String(nextLimit);
      actions.syncConfiguredRalphLoopBudget?.();
      actions.persistSelection?.();
      actions.syncAllPaneFrames?.();
    });
    elements.imageEditorOverlayCanvas.addEventListener("pointerdown", actions.handleImageEditorPointerDown);
    elements.imageEditorOverlayCanvas.addEventListener("pointermove", actions.handleImageEditorPointerMove);
    elements.imageEditorOverlayCanvas.addEventListener("dblclick", actions.handleImageEditorDoubleClick);
    window.addEventListener("pointerup", actions.handleImageEditorPointerUp);
    window.addEventListener("resize", () => {
      if (window.innerWidth > 980) {
        actions.applySidebarLayout?.();
      }

      if (state.imageEditor.open) {
        actions.layoutImageEditorCanvas?.();
        actions.renderImageEditor?.();
      }
    });
    elements.imageEditorColor.addEventListener("input", (event) => {
      actions.updateImageEditorColor?.(event.target.value);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.threadActionMenuOpen) {
        state.threadActionMenuOpen = false;
        actions.renderThreadHeader?.();
        return;
      }

      if (event.key === "Escape" && state.composerMenuOpen) {
        state.composerMenuOpen = "";
        actions.renderComposerControls?.();
        return;
      }

      if (event.key === "Escape" && state.composerSettingsOpen) {
        state.composerSettingsOpen = false;
        state.composerMenuOpen = "";
        actions.renderComposerControls?.();
        return;
      }

      if (event.key === "Escape" && state.imageEditor.open) {
        actions.closeImageEditor?.();
        return;
      }

      if (event.key === "Escape" && state.ralphLoopPendingReplay) {
        actions.cancelPendingRalphLoop?.({ disableLoop: true, cancelAutoCompact: true });
      }
    });

    window.addEventListener("beforeunload", disconnectConversationSocket);
  }

  function clampSidebarWidth(width) {
    return Math.min(maxSidebarWidth, Math.max(minSidebarWidth, Math.round(width)));
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
    actions.persistSelection?.();
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
    actions.persistSelection?.();
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
      nextWidth = minSidebarWidth;
    } else if (event.key === "End") {
      nextWidth = maxSidebarWidth;
    } else {
      return;
    }

    event.preventDefault();
    state.sidebarWidth = clampSidebarWidth(nextWidth);
    applySidebarLayout();
    actions.persistSelection?.();
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
        await actions.loadPendingServerRequests?.();
        actions.renderProjects?.();
        actions.renderSelectedThread?.();
        void actions.maybeAutoApprovePendingRequests?.();
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
        actions.upsertPendingServerRequest?.(payload.request);
        void actions.maybeAutoApprovePendingRequests?.([payload.request]);

        if (payload.request?.params?.threadId === state.selectedThreadId) {
          actions.renderSelectedThread?.();
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
          actions.removePendingServerRequest?.(message.params.requestId);
        }

        if (threadId && threadId === state.selectedThreadId) {
          const handledLive = actions.applyStreamingNotification?.(message);

          if (!handledLive) {
            await actions.loadThread?.(state.selectedThreadId).catch(console.error);
          }
        }

        if (method.startsWith("thread/")) {
          actions.scheduleProjectThreadsReload?.();
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
      actions.closeImageEditor?.();
      return;
    }

    const anchor = event.target.closest(".message-body a[href]");
    if (anchor instanceof HTMLAnchorElement) {
      const fileReference = parseLocalFileLinkHref(anchor.getAttribute("href"));

      if (fileReference) {
        event.preventDefault();
        await actions.openResourceFromFileLink?.(fileReference);
        return;
      }
    }

    if (state.threadActionMenuOpen && !event.target.closest(".thread-action-menu")) {
      state.threadActionMenuOpen = false;
      actions.renderThreadHeader?.();
    }

    if (state.composerMenuOpen && !event.target.closest(".composer-settings")) {
      state.composerMenuOpen = "";
      actions.renderComposerControls?.();
    }

    if (state.composerSettingsOpen && !event.target.closest(".composer-settings")) {
      state.composerSettingsOpen = false;
      state.composerMenuOpen = "";
      actions.renderComposerControls?.();
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
        actions.renderThreadHeader?.();
        return;
      }

      if (action === "toggle-composer-settings") {
        state.composerSettingsOpen = !state.composerSettingsOpen;
        if (!state.composerSettingsOpen) {
          state.composerMenuOpen = "";
        }
        actions.renderComposerControls?.();
        return;
      }

      if (action === "toggle-composer-menu") {
        if (!state.composerSettingsOpen) {
          state.composerSettingsOpen = true;
        }
        const nextMenu = button.dataset.menu === "effort" ? "effort" : "model";
        state.composerMenuOpen = state.composerMenuOpen === nextMenu ? "" : nextMenu;
        actions.renderComposerControls?.();
        return;
      }

      if (action === "select-composer-model") {
        state.composerModel = button.dataset.value || "";
        state.composerMenuOpen = "";
        actions.normalizeComposerSettings?.();
        actions.renderComposerControls?.();
        return;
      }

      if (action === "select-composer-effort") {
        state.composerEffort = button.dataset.value || "";
        state.composerMenuOpen = "";
        actions.normalizeComposerSettings?.();
        actions.renderComposerControls?.();
        return;
      }

      if (action === "select-composer-service-tier") {
        state.composerServiceTier = button.dataset.value || "";
        state.composerMenuOpen = "";
        actions.normalizeComposerSettings?.();
        actions.renderComposerControls?.();
        return;
      }

      if (action === "toggle-composer-mode") {
        state.composerMode = state.composerMode === "plan" ? "default" : "plan";
        actions.persistComposerSettings?.();
        actions.renderComposerControls?.();
        return;
      }

      if (action === "cancel-ralph-loop") {
        actions.cancelPendingRalphLoop?.({ disableLoop: true, cancelAutoCompact: true });
        return;
      }

      if (action === "open-composer-attachment") {
        await actions.openImageEditor?.(button.dataset.id);
        return;
      }

      if (action === "remove-composer-attachment") {
        state.composerAttachments = state.composerAttachments.filter((attachment) => attachment.id !== button.dataset.id);
        actions.renderComposerAttachments?.();
        return;
      }

      if (action === "editor-tool") {
        actions.setImageEditorTool?.(button.dataset.tool);
        return;
      }

      if (action === "close-image-editor") {
        actions.closeImageEditor?.();
        return;
      }

      if (action === "apply-image-editor") {
        await actions.applyImageEditor?.();
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
        await actions.loadAllProjectThreads?.();
        if (state.selectedThreadId) {
          await actions.loadThread?.(state.selectedThreadId).catch(console.error);
        }
        actions.renderProjects?.();
        return;
      }

      if (action === "select-project") {
        await actions.switchSelectedProject?.(button.dataset.id || "");
        return;
      }

      if (action === "refresh-threads") {
        await actions.loadAllProjectThreads?.();
        actions.renderProjects?.();
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
        actions.persistSelection?.();
        actions.renderThreadHeader?.();
        actions.renderConversation?.();
        actions.renderThreadPane?.();
        if (state.selectedThreadId) {
          await actions.loadThread?.(state.selectedThreadId).catch(console.error);
        }
        actions.focusActiveThreadPane?.(projectThreadTab());
        return;
      }

      if (action === "open-terminal-tab") {
        if (!state.selectedProjectId) {
          return;
        }

        openProjectTerminalTab(state.selectedProjectId, { activate: true });
        syncSelectedProjectThreadTab();
        state.threadActionMenuOpen = false;
        actions.persistSelection?.();
        actions.renderThreadHeader?.();
        actions.renderThreadPane?.();
        actions.focusActiveThreadPane?.("terminal");
        return;
      }

      if (action === "close-project-tab") {
        const tabId = button.dataset.id || "";
        const tab = findProjectTab(state.selectedProjectId, tabId);

        if (!tab) {
          return;
        }

        if (tab.pane === "resource") {
          actions.closeResourceTab?.(tab.resourceId || "");
        } else {
          actions.closeProjectTab?.(state.selectedProjectId, tabId, { ensureFallback: true });
          syncSelectedProjectThreadTab();
          actions.persistSelection?.();
          actions.renderThreadHeader?.();
          actions.renderConversation?.();
          actions.renderThreadPane?.();
          if (state.selectedThreadId) {
            await actions.loadThread?.(state.selectedThreadId).catch(console.error);
          }
        }
        return;
      }

      if (action === "toggle-archived") {
        state.archived = !state.archived;
        state.threadActionMenuOpen = false;
        await actions.loadAllProjectThreads?.();
        actions.renderProjects?.();
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
        actions.persistSelection?.();
        actions.renderProjects?.();
        actions.renderThreadHeader?.();
        actions.renderConversation?.();
        actions.renderComposerControls?.();
        actions.renderThreadPane?.();

        if (projectId && !Object.prototype.hasOwnProperty.call(state.projectThreads, projectId)) {
          void actions.loadProjectThreads?.(projectId).catch((error) => {
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
            void actions.loadProjectThreads?.(projectId).catch((error) => {
              console.error(`Failed to load threads for project ${projectId}`, error);
            });
          }
        }

        openProjectThreadTab(projectId, threadId, { activate: true });
        syncSelectedProjectThreadTab();
        state.threadActionMenuOpen = false;
        actions.persistSelection?.();
        actions.renderProjects?.();
        actions.renderThreadHeader?.();
        actions.renderConversation?.();
        actions.renderThreadPane?.();
        await actions.loadThread?.(threadId);
        return;
      }

      if (action === "rename-thread") {
        const name = window.prompt("Thread name", state.selectedThread?.name || "");
        await actions.performThreadAction?.(action, { name });
        return;
      }

      if (action === "fork-thread" || action === "compact-thread" || action === "review-thread" || action === "interrupt-thread") {
        await actions.performThreadAction?.(action);
        return;
      }

      if (action === "archive-thread" || action === "unarchive-thread") {
        await actions.performThreadAction?.(action);
        return;
      }

      if (action === "respond-command-approval") {
        const requestId = button.dataset.requestId || "";
        const request = state.pendingServerRequests.find((entry) => String(entry?.id) === requestId);
        await actions.respondToPendingServerRequest?.(request || { id: requestId }, {
          decision: parsePendingDecision(button.dataset.decision),
        });
        return;
      }

      if (action === "respond-file-change-approval") {
        const requestId = button.dataset.requestId || "";
        const request = state.pendingServerRequests.find((entry) => String(entry?.id) === requestId);
        await actions.respondToPendingServerRequest?.(request || { id: requestId }, {
          decision: button.dataset.decision || "decline",
        });
        return;
      }

      if (action === "respond-permissions-approval") {
        const requestId = button.dataset.requestId || "";
        const request = state.pendingServerRequests.find((entry) => String(entry?.id) === requestId);
        await actions.respondToPendingServerRequest?.(request || { id: requestId }, {
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
        actions.persistSelection?.();
        await actions.loadThreads?.();
        return;
      }

      if (form === elements.composerForm) {
        await actions.sendConversationMessage?.(actions.currentComposerInput?.());

        if (state.composerRalphLoop) {
          actions.persistComposerDraft?.();
        } else {
          elements.promptInput.value = "";
          actions.clearComposerDraft?.();
          state.composerAttachments = [];
          actions.renderComposerAttachments?.();
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

        await actions.respondToPendingServerRequest?.(request || { id: requestId }, { answers });
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
    actions.renderComposerAttachments?.();
  }

  return {
    applySidebarLayout,
    connectConversationSocket,
    connectEvents,
    disconnectConversationSocket,
  };
}
