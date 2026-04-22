export function createHostTabsState({
  state,
  cleanString,
  createId,
  oneLine,
  projectDisplayName,
  findLatestTurnId,
}) {
  function fileNameFromPath(pathname) {
    const value = String(pathname || "").replace(/[\\/]+$/g, "");
    return value.split(/[\\/]/).filter(Boolean).at(-1) || value || "file";
  }

  function normalizeResourceSelection(position = {}) {
    const line = Number(position.line) || 0;
    const column = Number(position.column) || 0;
    return line > 0 || column > 0
      ? { line: Math.max(1, line || 1), column: Math.max(1, column || 1) }
      : null;
  }

  function createResourceTab(pathname, position = {}) {
    return {
      id: createId(),
      projectId: cleanString(position.projectId),
      path: pathname,
      name: fileNameFromPath(pathname),
      pendingSelection: normalizeResourceSelection(position),
    };
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

  function allProjectResources() {
    return Object.values(state.resourceTabsByProjectId)
      .flatMap((resources) => Array.isArray(resources) ? resources : []);
  }

  function activeResource(projectId = state.selectedProjectId) {
    const activeId = projectActiveResourceId(projectId);
    return projectResources(projectId).find((resource) => resource.id === activeId) || null;
  }

  function findResource(resourceId) {
    return allProjectResources().find((resource) => resource.id === resourceId) || null;
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

  return {
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
  };
}
