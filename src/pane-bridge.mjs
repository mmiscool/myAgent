export {
  cleanString,
  escapeHtml,
  oneLine,
  relativeTime,
  formatStatus,
  isLiveStatus,
} from "./ui-formatters.mjs";

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
