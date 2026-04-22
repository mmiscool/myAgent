export function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function relativeTime(unixSeconds) {
  if (!unixSeconds) {
    return "";
  }

  const diffSeconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);

  if (diffSeconds < 60) {
    return "just now";
  }

  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatStatus(status) {
  if (!status) {
    return "unknown";
  }

  if (typeof status === "string") {
    return status;
  }

  if (typeof status === "object" && status.type) {
    return status.type;
  }

  return JSON.stringify(status);
}

export function isLiveStatus(status) {
  const text = formatStatus(status).toLowerCase();
  return text.includes("progress")
    || text.includes("active")
    || text.includes("running")
    || text.includes("working")
    || text.includes("thinking")
    || text.includes("stream")
    || text.includes("respond");
}

export function latestTurn(thread) {
  const turns = thread?.turns || [];
  return turns.length ? turns[turns.length - 1] : null;
}

export function describeStatusActivity(status) {
  const text = formatStatus(status).toLowerCase();
  return text.includes("think") ? "Thinking" : "Working";
}

export function describeThreadActivity(thread) {
  const turn = latestTurn(thread);
  const activeStatus = isLiveStatus(turn?.status) ? turn.status : thread?.status;
  const isWorking = isLiveStatus(activeStatus);

  return {
    isWorking,
    label: isWorking ? describeStatusActivity(activeStatus) : "Idle",
    statusText: formatStatus(activeStatus || thread?.status),
    turnId: turn?.id || "",
  };
}

export function renderActivityBadge(label, statusText = "", tone = "idle") {
  const classNames = ["status-badge"];
  if (tone === "live" || tone === "small" || tone === "sidebar") {
    classNames.push("live");
  }
  if (tone === "small") {
    classNames.push("small");
  }
  if (tone === "sidebar") {
    classNames.push("sidebar");
  }
  const title = statusText ? ` title="${escapeHtml(statusText)}"` : "";
  return `<span class="${classNames.join(" ")}"${title}><span class="status-dot" aria-hidden="true"></span>${escapeHtml(label)}</span>`;
}

export function parsePendingDecision(rawDecision) {
  const value = String(rawDecision || "");
  if (!value) {
    return "decline";
  }

  if (value.startsWith("{")) {
    return JSON.parse(value);
  }

  return value;
}
