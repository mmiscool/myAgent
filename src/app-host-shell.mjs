import {
  optionHtml,
  projectDisplayName,
  renderThreadActionMenu,
  renderThreadTabs,
} from "./app-host-shell-markup.mjs";

export function createAppHostShell({
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
}) {
  let projectThreadsRenderScheduled = false;
  let projectThreadsReloadTimer = null;
  let projectThreadsReloadInFlight = false;
  let projectThreadsReloadQueued = false;
  const paneFrameEntries = new Map();

  function persistSelection() {
    localStorage.setItem("selectedProjectId", state.selectedProjectId || "");
    localStorage.setItem("selectedThreadId", persistedProjectThreadId() || "");
    localStorage.setItem("activeThreadTab", projectThreadTab() || state.activeThreadTab || "chat");
    localStorage.setItem("sidebarCollapsed", String(state.sidebarCollapsed));
    localStorage.setItem("autoscroll", String(state.autoscroll));
    localStorage.setItem("sidebarWidth", String(state.sidebarWidth));
    actions.persistComposerSettings?.();
  }

  function selectedProject() {
    return state.projects.find((project) => project.id === state.selectedProjectId) || null;
  }

  function isSelectedThreadLoading() {
    return Boolean(state.selectedThreadId) && state.selectedThread?.id !== state.selectedThreadId;
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
        ? projects.map((entry) => optionHtml(entry.id, projectDisplayName(entry), escapeHtml)).join("")
        : optionHtml("", "No projects", escapeHtml);
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
            ${renderThreadTabs({
              state,
              cleanString,
              escapeHtml,
              projectActiveTabId,
              projectOpenTabs,
              projectTabLabel,
              projectTabTitle,
            })}
            ${chatTab ? "" : renderThreadActionMenu(state)}
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
          ${renderThreadTabs({
            state,
            cleanString,
            escapeHtml,
            projectActiveTabId,
            projectOpenTabs,
            projectTabLabel,
            projectTabTitle,
          })}
          ${chatTab ? "" : renderThreadActionMenu(state)}
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
    actions.syncPendingRalphLoopReplay?.();
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
      await actions.loadAllProjectThreads?.();
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
    const composerView = actions.buildComposerViewState?.() || {};

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

    actions.syncThreadSummary?.(thread);
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
      await actions.loadThread?.(state.selectedThreadId);
      await actions.loadAllProjectThreads?.();
      renderProjects();
      return;
    }

    if (action === "fork-thread") {
      state.threadActionMenuOpen = false;
      await api(`/api/threads/${encodeURIComponent(state.selectedThreadId)}/fork`, { method: "POST", body: {} });
      await actions.loadAllProjectThreads?.();
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
      await actions.loadAllProjectThreads?.();
      closeProjectThreadTabs(state.selectedProjectId, archivedThreadId);
      syncSelectedProjectThreadTab();
      persistSelection();
      renderProjects();
      renderThreadHeader();
      actions.renderConversation?.();
      renderThreadPane();
      if (state.selectedThreadId) {
        await actions.loadThread?.(state.selectedThreadId).catch(console.error);
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
      void actions.loadAllProjectThreads?.().catch(console.error);
      return;
    }

    if (pane === "chat" && data.type === "send-message") {
      void actions.sendConversationMessage?.(data.payload || {}).then(() => {
        if (state.composerRalphLoop) {
          actions.persistComposerDraft?.();
        } else {
          elements.promptInput.value = "";
          actions.clearComposerDraft?.();
          state.composerAttachments = [];
        }
        actions.renderComposerAttachments?.();
        syncAllPaneFrames();
      }).catch((error) => {
        alert(error.message);
      });
      return;
    }

    if (pane === "chat" && data.type === "composer-draft") {
      elements.promptInput.value = String(data.payload?.text || "");
      actions.persistComposerDraft?.();
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
      actions.renderComposerAttachments?.();
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
          actions.cancelPendingRalphLoop?.({ cancelAutoCompact: true });
        } else if (state.selectedThreadId && actions.currentRalphLoopInput?.(state.selectedThreadId)) {
          actions.setRalphLoopBudget?.(state.selectedThreadId);
        }
      } else if (key === "ralphLoopLimit") {
        state.composerRalphLoopLimit = normalizeRalphLoopLimit(value);
        actions.syncConfiguredRalphLoopBudget?.();
      } else if (key === "model") {
        state.composerModel = cleanString(value);
      } else if (key === "effort") {
        state.composerEffort = cleanString(value);
      } else if (key === "serviceTier") {
        state.composerServiceTier = cleanString(value);
      } else if (key === "mode") {
        state.composerMode = value === "plan" ? "plan" : "default";
      }

      actions.normalizeComposerSettings?.();
      actions.persistComposerSettings?.();
      actions.renderComposerControls?.();
      return;
    }

    if (pane === "chat" && data.type === "open-composer-attachment") {
      void actions.openImageEditor?.(cleanString(data.payload?.id)).catch(console.error);
      return;
    }

    if (pane === "chat" && data.type === "remove-composer-attachment") {
      state.composerAttachments = state.composerAttachments.filter((attachment) => attachment.id !== cleanString(data.payload?.id));
      actions.renderComposerAttachments?.();
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

  return {
    closeProjectTab,
    closeProjectThreadTabs,
    closeResourceTab,
    focusActiveThreadPane,
    handlePaneMessage,
    initializeProjectTabs,
    openResourceFromFileLink,
    performThreadAction,
    persistSelection,
    projectDisplayName,
    renderProjects,
    renderThreadActionMenu,
    renderThreadHeader,
    renderThreadPane,
    replaceProjectTab,
    scheduleProjectThreadsReload,
    scheduleProjectsRender,
    selectedProject,
    syncAllPaneFrames,
  };
}
