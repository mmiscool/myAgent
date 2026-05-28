import { describe, expect, test, vi } from "vitest";
import { JSDOM } from "jsdom";
import { createChatPaneConversation } from "../../src/chat-pane-conversation.mjs";

function createConversationHarness({ approveAllDangerous = true, requestId = 42 } = {}) {
  const state = {
    threadId: "thread-1",
    thread: { id: "thread-1", turns: [] },
    pendingRequests: [{
      id: requestId,
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-1",
        permissions: { sandbox_permissions: "require_escalated" },
      },
    }],
    approveAllDangerous,
    autoApprovalInFlight: new Set(),
  };
  const calls = [];
  const conversation = createChatPaneConversation({
    state,
    elements: { conversation: { innerHTML: "", scrollTop: 0, scrollHeight: 0 } },
    bridge: { send: vi.fn() },
    api: vi.fn(async (path, options) => {
      calls.push({ path, options });
      return { ok: true };
    }),
    buildAutoApprovalResult: () => ({
      permissions: { sandbox_permissions: "require_escalated" },
      scope: "session",
    }),
    renderChatHeader: vi.fn(),
    findLatestTurnId: () => "",
    ensureSelectedTurn: () => ({}),
    ensureTurnItem: () => ({}),
    appendIndexedDelta: vi.fn(),
    syncHostThreadSummary: vi.fn(),
    oneLine: (value) => String(value || "").replace(/\s+/g, " ").trim(),
    escapeHtml: (value) => String(value || ""),
    formatStatus: (value) => String(value || ""),
    isLiveStatus: () => false,
    describeStatusActivity: (value) => String(value || ""),
    describeThreadActivity: () => ({ isWorking: false }),
    renderActivityBadge: (label) => `<span>${label}</span>`,
    renderMessageContent: () => "",
    renderPendingServerRequest: () => "",
    renderToolCallBody: () => "",
  });

  return { calls, conversation, state };
}

describe("chat pane conversation approvals", () => {
  test("auto-approves loaded pending permission requests when enabled", async () => {
    const { calls, conversation, state } = createConversationHarness();

    await conversation.maybeAutoApprovePendingRequests();

    expect(calls).toEqual([{
      path: "/api/server-requests/42/respond",
      options: {
        method: "POST",
        body: {
          result: {
            permissions: { sandbox_permissions: "require_escalated" },
            scope: "session",
          },
        },
      },
    }]);
    expect(state.pendingRequests).toEqual([]);
  });

  test("auto-approves pending requests with numeric zero ids", async () => {
    const { calls, conversation, state } = createConversationHarness({ requestId: 0 });

    await conversation.maybeAutoApprovePendingRequests();

    expect(calls[0]?.path).toBe("/api/server-requests/0/respond");
    expect(state.pendingRequests).toEqual([]);
  });

  test("upserts pending requests with numeric zero ids", () => {
    const { conversation, state } = createConversationHarness({ requestId: 1 });

    conversation.upsertPendingServerRequest({
      id: 0,
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-1",
        permissions: { sandbox_permissions: "require_escalated" },
      },
    });

    expect(state.pendingRequests.some((request) => request.id === 0)).toBe(true);
  });
});

describe("chat pane conversation collapse state", () => {
  test("keeps manually expanded older messages open while collapsing the previous latest message", () => {
    const dom = new JSDOM("<section id=\"conversation\"></section>");
    const previousGlobals = {
      HTMLDetailsElement: globalThis.HTMLDetailsElement,
      requestAnimationFrame: globalThis.requestAnimationFrame,
    };

    globalThis.HTMLDetailsElement = dom.window.HTMLDetailsElement;
    globalThis.requestAnimationFrame = (callback) => callback();

    try {
      const state = {
        threadId: "thread-1",
        thread: {
          id: "thread-1",
          turns: [{
            id: "turn-1",
            status: "completed",
            items: [
              { id: "user-1", type: "userMessage", text: "first user" },
              { id: "agent-1", type: "agentMessage", text: "first agent" },
            ],
          }, {
            id: "turn-2",
            status: "inProgress",
            items: [
              { id: "user-2", type: "userMessage", text: "second user" },
            ],
          }],
        },
        pendingRequests: [],
        autoscroll: true,
      };
      const conversation = createChatPaneConversation({
        state,
        elements: { conversation: dom.window.document.getElementById("conversation") },
        bridge: { send: vi.fn() },
        api: vi.fn(),
        buildAutoApprovalResult: vi.fn(),
        renderChatHeader: vi.fn(),
        findLatestTurnId: () => "",
        ensureSelectedTurn: () => ({}),
        ensureTurnItem: () => ({}),
        appendIndexedDelta: vi.fn(),
        syncHostThreadSummary: vi.fn(),
        oneLine: (value) => String(value || "").replace(/\s+/g, " ").trim(),
        escapeHtml: (value) => String(value || ""),
        formatStatus: (value) => String(value || ""),
        isLiveStatus: () => false,
        describeStatusActivity: (value) => String(value || ""),
        describeThreadActivity: () => ({ isWorking: false }),
        renderActivityBadge: (label) => `<span>${label}</span>`,
        renderMessageContent: (content, text) => `<p>${text}</p>`,
        renderPendingServerRequest: () => "",
        renderToolCallBody: () => "",
      });

      conversation.renderConversation();

      const manuallyExpandedDetails = dom.window.document.querySelector("details[data-item-id='agent-1']");
      manuallyExpandedDetails.open = true;
      conversation.handleConversationDetailsToggle({ target: manuallyExpandedDetails });

      state.thread.turns[1].items.push({ id: "agent-2", type: "agentMessage", text: "second agent" });
      conversation.renderConversation();

      expect(dom.window.document.querySelector("details[data-item-id='agent-1']").open).toBe(true);
      expect(dom.window.document.querySelector("details[data-item-id='user-2']").open).toBe(false);
      expect(dom.window.document.querySelector("article[data-item-id='agent-2'] details")).toBeNull();
    } finally {
      globalThis.HTMLDetailsElement = previousGlobals.HTMLDetailsElement;
      globalThis.requestAnimationFrame = previousGlobals.requestAnimationFrame;
    }
  });
});
