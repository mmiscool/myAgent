const AUTO_APPROVABLE_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

export function composerApprovalPolicyOverride(projectApprovalPolicy, autoApproveDangerous = false) {
  if (autoApproveDangerous) {
    return "never";
  }

  if (projectApprovalPolicy === "never") {
    return "on-request";
  }

  return undefined;
}

export function isAutoApprovableRequest(request) {
  return AUTO_APPROVABLE_REQUEST_METHODS.has(request?.method);
}

export function normalizeCommandApprovalDecisions(availableDecisions) {
  const normalized = Array.isArray(availableDecisions)
    ? availableDecisions.filter((decision) => isRenderableCommandDecision(decision))
    : [];

  return normalized.length > 0 ? normalized : ["accept", "decline"];
}

export function selectAutoApprovalCommandDecision(availableDecisions) {
  const decisions = normalizeCommandApprovalDecisions(availableDecisions);

  let bestDecision = null;
  let bestPriority = 0;

  for (const decision of decisions) {
    const priority = autoApprovalDecisionPriority(decision);

    if (priority > bestPriority) {
      bestDecision = decision;
      bestPriority = priority;
    }
  }

  return bestDecision;
}

function isRenderableCommandDecision(decision) {
  if (typeof decision === "string") {
    return decision.trim().length > 0;
  }

  return Boolean(decision && typeof decision === "object" && Object.keys(decision).length > 0);
}

export function buildAutoApprovalResult(request) {
  if (!isAutoApprovableRequest(request)) {
    return null;
  }

  if (request.method === "item/commandExecution/requestApproval") {
    const decision = selectAutoApprovalCommandDecision(request.params?.availableDecisions);
    return decision ? { decision } : null;
  }

  if (request.method === "item/fileChange/requestApproval") {
    return { decision: "acceptForSession" };
  }

  if (request.method === "item/permissions/requestApproval") {
    return {
      permissions: request?.params?.permissions || {},
      scope: "session",
    };
  }

  return null;
}

function autoApprovalDecisionPriority(decision) {
  if (decision && typeof decision === "object") {
    if ("acceptWithExecpolicyAmendment" in decision) {
      return 6;
    }

    if ("applyNetworkPolicyAmendment" in decision) {
      return 5;
    }
  }

  if (decision === "acceptForSession") {
    return 4;
  }

  if (decision === "accept") {
    return 3;
  }

  if (typeof decision === "string" && decision.startsWith("accept")) {
    return 2;
  }

  return 0;
}
