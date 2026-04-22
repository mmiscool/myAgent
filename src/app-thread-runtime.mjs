export function findLatestTurnId(thread) {
  const turns = thread?.turns || [];
  return turns.length > 0 ? turns[turns.length - 1].id : "";
}

export function createAppThreadRuntime({
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
}) {
  async function loadThreads() {
    const project = actions.selectedProject?.();

    if (!project) {
      state.threads = [];
      actions.renderProjects?.();
      actions.renderThreadPane?.();
      return;
    }

    const payload = await api(`/api/projects/${encodeURIComponent(project.id)}/threads?archived=${state.archived}`);
    state.threads = payload.data?.data || payload.data?.threads || [];
    state.projectThreads[project.id] = state.threads;

    actions.renderProjects?.();
    actions.renderThreadHeader?.();
    actions.renderConversation?.();
    actions.renderComposerControls?.();
    actions.renderThreadPane?.();
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
        actions.renderComposerControls?.();
      }

      actions.scheduleProjectsRender?.();
    }
  }

  async function loadAllProjectThreads() {
    const projectId = cleanString(state.selectedProjectId);

    if (!projectId) {
      state.threads = [];
      actions.renderProjects?.();
      return;
    }

    await loadProjectThreads(projectId).catch((error) => {
      console.error(`Failed to load threads for project ${projectId}`, error);
    });
    state.threads = state.projectThreads[projectId] || [];
    actions.renderProjects?.();
  }

  async function switchSelectedProject(projectId) {
    const nextProjectId = cleanString(projectId);

    if (nextProjectId === cleanString(state.selectedProjectId) && Object.prototype.hasOwnProperty.call(state.projectThreads, nextProjectId)) {
      state.threadActionMenuOpen = false;
      actions.syncSelectedProjectThreadTab?.();
      actions.persistSelection?.();
      actions.renderProjects?.();
      actions.renderThreadHeader?.();
      actions.renderConversation?.();
      actions.renderComposerControls?.();
      actions.renderThreadPane?.();
      if (state.selectedThreadId) {
        await loadThread(state.selectedThreadId).catch(console.error);
      }
      return;
    }

    state.selectedProjectId = nextProjectId;
    state.threadActionMenuOpen = false;
    actions.syncSelectedProjectThreadTab?.();
    actions.persistSelection?.();
    actions.renderProjects?.();
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
    actions.renderComposerControls?.();
    actions.persistSelection?.();
    actions.renderProjects?.();
    actions.renderThreadHeader?.();
    actions.renderConversation?.();
    actions.renderThreadPane?.();
  }

  function renderSelectedThread() {
    state.currentTurnId = findLatestTurnId(state.selectedThread);
    actions.renderComposerControls?.();
    actions.persistSelection?.();
    actions.renderProjects?.();
    actions.renderThreadHeader?.();
    actions.renderConversation?.();
    actions.renderThreadPane?.();
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
      labels.push(`${fileChangeCount} file change${fileChangeCount === 1 ? "" : "changes"}`);
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
    actions.scrollConversationToBottom?.();
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
      actions.scrollConversationToBottom?.();
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
      actions.cancelPendingRalphLoop?.({ render: false });
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
        void actions.maybeRunRalphLoop?.(threadId, completedTurn.id || turn?.id || "");
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
      actions.scheduleProjectsRender?.();
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

  return {
    appendIndexedDelta,
    applyStreamingNotification,
    ensureSelectedTurn,
    ensureTurnItem,
    findLatestCollapsibleItemId,
    getCommandExecutionDisplay,
    getPlanDisplay,
    getReasoningDisplay,
    handleConversationDetailsToggle,
    isCollapsibleItem,
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
  };
}
