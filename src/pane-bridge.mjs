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
    return status
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .trim();
  }

  return String(status);
}

export function isLiveStatus(status) {
  const text = formatStatus(status).toLowerCase();
  return text.includes("progress") || text.includes("running") || text.includes("working") || text.includes("thinking");
}

export async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json();

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }

  return payload;
}

export function websocketUrl(pathname) {
  const url = new URL(pathname, window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function createPaneBridge(pane, handlers = {}) {
  const hostOrigin = window.location.origin;

  function send(type, payload = {}) {
    window.parent.postMessage({
      source: "codex-pane",
      pane,
      type,
      payload,
    }, hostOrigin);
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== hostOrigin) {
      return;
    }

    const data = event.data;
    if (!data || data.source !== "codex-host" || data.pane !== pane) {
      return;
    }

    if (data.type === "state") {
      handlers.onState?.(data.payload || {});
      return;
    }

    if (data.type === "focus") {
      handlers.onFocus?.();
      return;
    }

    handlers.onMessage?.(data);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      send("ready");
    }, { once: true });
  } else {
    queueMicrotask(() => {
      send("ready");
    });
  }

  return { send };
}
