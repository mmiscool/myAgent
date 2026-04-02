import { describe, expect, test } from "vitest";
import {
  buildAutoApprovalResult,
  composerApprovalPolicyOverride,
  isAutoApprovableRequest,
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

  test("does not auto-approve unrelated requests", () => {
    expect(buildAutoApprovalResult({
      method: "item/tool/requestUserInput",
      params: {},
    })).toBeNull();
  });
});
