import { describe, expect, test } from "vitest";
import {
  buildAutoApprovalResult,
  composerApprovalPolicyOverride,
  isAutoApprovableRequest,
  normalizeCommandApprovalDecisions,
  selectAutoApprovalCommandDecision,
} from "../../src/approval-utils.mjs";

describe("approval utils", () => {
  test("keeps composer approval requests enabled for projects configured as never", () => {
    expect(composerApprovalPolicyOverride("never")).toBe("on-request");
    expect(composerApprovalPolicyOverride("on-request")).toBeUndefined();
    expect(composerApprovalPolicyOverride("on-request", true)).toBe("never");
  });

  test("recognizes dangerous approval requests", () => {
    expect(isAutoApprovableRequest({ method: "item/commandExecution/requestApproval" })).toBe(true);
    expect(isAutoApprovableRequest({ method: "item/tool/requestUserInput" })).toBe(false);
  });

  test("prefers policy amendment approval over other command approvals when available", () => {
    const decision = { acceptWithExecpolicyAmendment: { sandbox_permissions: "require_escalated" } };

    expect(selectAutoApprovalCommandDecision(["decline", "accept", "acceptForSession", decision])).toEqual(decision);
  });

  test("falls back to policy-amendment approval for commands", () => {
    const decision = { acceptWithExecpolicyAmendment: { sandbox_permissions: "require_escalated" } };

    expect(selectAutoApprovalCommandDecision(["decline", decision])).toEqual(decision);
    expect(buildAutoApprovalResult({
      method: "item/commandExecution/requestApproval",
      params: { availableDecisions: ["decline", decision] },
    })).toEqual({ decision });
  });

  test("sanitizes malformed command approval decisions", () => {
    expect(normalizeCommandApprovalDecisions(["", "accept"])).toEqual(["accept"]);
    expect(normalizeCommandApprovalDecisions([null, undefined, ""])).toEqual(["accept", "decline"]);
    expect(normalizeCommandApprovalDecisions([{}])).toEqual(["accept", "decline"]);
  });

  test("builds session-scoped auto-approval results for file changes and permissions", () => {
    expect(buildAutoApprovalResult({
      method: "item/fileChange/requestApproval",
      params: {},
    })).toEqual({ decision: "acceptForSession" });

    expect(buildAutoApprovalResult({
      method: "item/permissions/requestApproval",
      params: { permissions: { sandbox_permissions: "require_escalated" } },
    })).toEqual({
      permissions: { sandbox_permissions: "require_escalated" },
      scope: "session",
    });
  });

  test("auto-approves Codex MCP approval elicitations with empty content", () => {
    const request = {
      method: "mcpServer/elicitation/request",
      params: {
        _meta: {
          codex_approval_kind: "mcp_tool_call",
        },
        requestedSchema: {
          type: "object",
          properties: {},
        },
      },
    };

    expect(isAutoApprovableRequest(request)).toBe(true);
    expect(buildAutoApprovalResult(request)).toEqual({
      action: "accept",
      content: {},
    });
  });

  test("auto-approves Codex MCP tool-call elicitations with tool metadata", () => {
    const request = {
      id: 0,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "playwright",
        mode: "form",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          tool_description: "Navigate to a URL",
          tool_params: {
            url: "http://localhost:5174/",
          },
        },
        message: "Tool call needs your approval.",
        requestedSchema: {
          type: "object",
          properties: {},
        },
      },
    };

    expect(isAutoApprovableRequest(request)).toBe(true);
    expect(buildAutoApprovalResult(request)).toEqual({
      action: "accept",
      content: {},
    });
  });

  test("does not auto-approve ordinary MCP elicitations", () => {
    expect(buildAutoApprovalResult({
      method: "mcpServer/elicitation/request",
      params: {
        message: "What is your email?",
        requestedSchema: {
          type: "object",
          properties: {
            email: { type: "string" },
          },
        },
      },
    })).toBeNull();
  });

  test("does not auto-approve unrelated requests", () => {
    expect(buildAutoApprovalResult({
      method: "item/tool/requestUserInput",
      params: {},
    })).toBeNull();
  });
});
