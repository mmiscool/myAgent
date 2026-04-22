export function projectDisplayName(project) {
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

export function optionHtml(value, label, escapeHtml) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
}

export function renderThreadTabs({
  state,
  cleanString,
  escapeHtml,
  projectActiveTabId,
  projectOpenTabs,
  projectTabLabel,
  projectTabTitle,
}) {
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

export function renderThreadActionMenu(state) {
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
