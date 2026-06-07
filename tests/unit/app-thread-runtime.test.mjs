import { describe, expect, test, vi } from "vitest";
import { createAppThreadRuntime } from "../../src/app-thread-runtime.mjs";

function createRuntimeHarness({ requestId = 0 } = {}) {
  const state = {
    selectedThreadId: "different-thread",
    pendingServerRequests: [{
      id: requestId,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
        },
      },
    }],
    composerApproveAllDangerous: true,
    autoApprovalInFlight: new Set(),
  };
  const calls = [];
  const runtime = createAppThreadRuntime({
    state,
    elements: { conversation: { innerHTML: "", scrollTop: 0, scrollHeight: 0 } },
    actions: {},
    api: vi.fn(async (path, options) => {
      calls.push({ path, options });
      return { ok: true };
    }),
    buildAutoApprovalResult: () => ({
      action: "accept",
      content: {},
    }),
    cleanString: (value) => String(value || "").trim(),
    escapeHtml: (value) => String(value || ""),
    formatStatus: (value) => String(value || ""),
    isLiveStatus: () => false,
    oneLine: (value) => String(value || "").replace(/\s+/g, " ").trim(),
    renderItem: () => "",
    renderMessageContent: () => "",
    renderToolCallBody: () => "",
  });

  return { calls, runtime, state };
}

describe("app thread runtime approvals", () => {
  test("auto-approves pending server requests with numeric zero ids", async () => {
    const { calls, runtime, state } = createRuntimeHarness({ requestId: 0 });

    await runtime.maybeAutoApprovePendingRequests();

    expect(calls[0]?.path).toBe("/api/server-requests/0/respond");
    expect(state.pendingServerRequests).toEqual([]);
  });

  test("upserts pending server requests with numeric zero ids", () => {
    const { runtime, state } = createRuntimeHarness({ requestId: 1 });

    runtime.upsertPendingServerRequest({
      id: 0,
      method: "mcpServer/elicitation/request",
      params: { threadId: "thread-1" },
    });

    expect(state.pendingServerRequests.some((request) => request.id === 0)).toBe(true);
  });
});

describe("app thread runtime collapse state", () => {
  test("expands older items that were manually expanded", () => {
    const { runtime, state } = createRuntimeHarness();

    expect(runtime.shouldExpandConversationItem("agent-1", "agent-2")).toBe(false);

    state.manuallyExpandedConversationItemIds = new Set(["agent-1"]);

    expect(runtime.shouldExpandConversationItem("agent-1", "agent-2")).toBe(true);
    expect(runtime.shouldExpandConversationItem("agent-2", "agent-2")).toBe(true);
  });
});
