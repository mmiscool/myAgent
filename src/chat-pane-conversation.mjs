export function createChatPaneConversation({
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
}) {
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

    const itemId = String(details.dataset.itemId || "").trim();
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

  function renderConversation() {
    const thread = state.thread;
    const pendingNewThread = state.pendingNewThread;
    const pendingRalphLoopReplay = state.pendingRalphLoopReplay && state.pendingRalphLoopReplay.threadId === state.threadId
      ? state.pendingRalphLoopReplay
      : null;

    renderChatHeader();

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

  return {
    applyStreamingNotification,
    handleConversationDetailsToggle,
    latestAgentMessageText,
    maybeAutoApprovePendingRequests,
    removePendingServerRequest,
    renderConversation,
    respondToPendingServerRequest,
    upsertPendingServerRequest,
  };
}
