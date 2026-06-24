export const STORAGE_KEYS = {
  projectId: "newApp.selectedProjectId",
  threadId: "newApp.selectedThreadId",
  theme: "newApp.theme",
  chatModel: "newApp.chat.model",
  chatEffort: "newApp.chat.effort",
  chatServiceTier: "newApp.chat.serviceTier",
  chatMode: "newApp.chat.mode",
  chatApprovalPolicy: "newApp.chat.approvalPolicy",
  chatSandboxMode: "newApp.chat.sandboxMode",
  chatSummary: "newApp.chat.summary",
  chatPersonality: "newApp.chat.personality",
  shellSidebarCollapsed: "newApp.shell.sidebarCollapsed",
  shellConversationListMode: "newApp.shell.conversationListMode",
};

const THEMES = new Set(["light", "dark"]);
const API_PREFIX = "/new-api";
const WS_PREFIX = "/new-ws";

export function normalizeTheme(value) {
  return THEMES.has(value) ? value : "light";
}

export function currentTheme() {
  return normalizeTheme(localStorage.getItem(STORAGE_KEYS.theme));
}

export function applyTheme(theme = currentTheme()) {
  const normalizedTheme = normalizeTheme(theme);
  document.documentElement.dataset.theme = normalizedTheme;
  document.documentElement.style.colorScheme = normalizedTheme;
  return normalizedTheme;
}

export function saveTheme(theme) {
  const normalizedTheme = applyTheme(theme);
  localStorage.setItem(STORAGE_KEYS.theme, normalizedTheme);
  return normalizedTheme;
}

export function nextTheme(theme = currentTheme()) {
  return normalizeTheme(theme) === "dark" ? "light" : "dark";
}

export function updateThemeToggle(button, theme = currentTheme()) {
  if (!button) {
    return;
  }

  const normalizedTheme = normalizeTheme(theme);
  const isDark = normalizedTheme === "dark";
  button.textContent = isDark ? "☼" : "◐";
  button.title = `Switch to ${isDark ? "light" : "dark"} mode`;
  button.setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} mode`);
  button.setAttribute("aria-pressed", String(isDark));
}

applyTheme();

export function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function oneLine(value, fallback = "") {
  return cleanString(value).replace(/\s+/g, " ") || fallback;
}

export function toArray(value) {
  return Array.isArray(value) ? value : [];
}

export function uniqueStrings(values) {
  const seen = new Set();
  const normalized = [];

  for (const value of values) {
    const text = cleanString(value);
    if (text && !seen.has(text)) {
      seen.add(text);
      normalized.push(text);
    }
  }

  return normalized;
}

function normalizeReasoningOption(entry) {
  if (typeof entry === "string") {
    return cleanString(entry) ? { reasoningEffort: cleanString(entry), description: "" } : null;
  }
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const reasoningEffort = cleanString(
    entry.reasoningEffort || entry.reasoning_effort || entry.value || entry.id || entry.name,
  );
  return reasoningEffort ? { reasoningEffort, description: cleanString(entry.description || entry.label) } : null;
}

function normalizeServiceTierOption(entry) {
  if (typeof entry === "string") {
    return cleanString(entry);
  }
  if (!entry || typeof entry !== "object") {
    return "";
  }
  return cleanString(entry.serviceTier || entry.service_tier || entry.tier || entry.value || entry.id || entry.name);
}

export function defaultReasoningEffortForModel(model) {
  return cleanString(
    model?.defaultReasoningEffort
    || model?.default_reasoning_effort
    || model?.defaultReasoningLevel
    || model?.default_reasoning_level,
  );
}

export function supportedReasoningEffortsForModel(model) {
  const options = [
    model?.supportedReasoningEfforts,
    model?.supported_reasoning_efforts,
    model?.supportedReasoningLevels,
    model?.supported_reasoning_levels,
  ].flatMap((value) => (Array.isArray(value) ? value : []))
    .map(normalizeReasoningOption)
    .filter(Boolean);

  if (options.length > 0) {
    return options;
  }

  const defaultReasoningEffort = defaultReasoningEffortForModel(model);
  return defaultReasoningEffort ? [{ reasoningEffort: defaultReasoningEffort, description: "" }] : [];
}

export function supportedServiceTiersForModel(model, capabilities = {}) {
  return uniqueStrings([
    cleanString(capabilities?.defaultServiceTier),
    ...[
      model?.supportedServiceTiers,
      model?.supported_service_tiers,
      model?.serviceTiers,
      model?.service_tiers,
      capabilities?.serviceTiers,
    ].flatMap((value) => (Array.isArray(value) ? value : [])).map(normalizeServiceTierOption),
  ]);
}

export function resolveComposerModel(models, requestedModelId, fallbackModelId = "") {
  const modelList = toArray(models);
  const requestedId = cleanString(requestedModelId);
  const fallbackId = cleanString(fallbackModelId);

  return modelList.find((model) => model?.id === requestedId)
    || modelList.find((model) => model?.id === fallbackId)
    || modelList.find((model) => model?.isDefault)
    || modelList[0]
    || null;
}

export function formatEffortLabel(effort) {
  return {
    xhigh: "Extra High",
    high: "High",
    medium: "Medium",
    low: "Low",
    minimal: "Minimal",
    none: "None",
  }[effort] || effort;
}

export function formatServiceTierLabel(value) {
  const tier = cleanString(value);
  if (!tier) {
    return "Auto";
  }

  return tier
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function threadTimestamp(thread) {
  const value = thread?.updatedAt ?? thread?.updated_at ?? thread?.createdAt ?? thread?.created_at;
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }

  return number > 100000000000 ? number : number * 1000;
}

export function formatRelativeTime(value) {
  const timestamp = threadTimestamp({ updatedAt: value });
  if (!timestamp) {
    return "";
  }

  const diffSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return "just now";
  }
  if (diffSeconds < 3600) {
    const minutes = Math.round(diffSeconds / 60);
    return `${minutes}m ago`;
  }
  if (diffSeconds < 86400) {
    const hours = Math.round(diffSeconds / 3600);
    return `${hours}h ago`;
  }

  const days = Math.round(diffSeconds / 86400);
  return `${days}d ago`;
}

export function textFromContent(content) {
  if (typeof content === "string") {
    return content;
  }

  return toArray(content).map((entry) => {
    if (typeof entry === "string") {
      return entry;
    }
    if (entry?.type === "text") {
      return entry.text || "";
    }
    return "";
  }).filter(Boolean).join("\n");
}

export function itemText(item) {
  if (!item || typeof item !== "object") {
    return "";
  }

  if (item.text) {
    return item.text;
  }
  if (item.content) {
    return textFromContent(item.content);
  }
  if (item.summary) {
    return toArray(item.summary).join("\n");
  }
  if (item.aggregatedOutput) {
    return item.aggregatedOutput;
  }

  return "";
}

export function latestThreadText(thread) {
  const turns = toArray(thread?.turns);

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = toArray(turns[turnIndex]?.items);
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const text = itemText(items[itemIndex]);
      if (text) {
        return text;
      }
    }
  }

  return cleanString(thread?.preview || thread?.summary || thread?.description);
}

export function threadTitle(thread) {
  return cleanString(thread?.name || thread?.title)
    || oneLine(latestThreadText(thread), `Thread ${String(thread?.id || "").slice(0, 8) || "untitled"}`);
}

export function threadStatusLabel(thread) {
  if (typeof thread?.status === "string") {
    return cleanString(thread.status) || "thread";
  }
  if (thread?.status && typeof thread.status === "object") {
    return cleanString(thread.status.type) || "thread";
  }
  return cleanString(thread?.state) || "thread";
}

export function normalizeThreadList(payload) {
  const data = payload?.data;
  if (Array.isArray(data?.data)) {
    return data.data;
  }
  if (Array.isArray(data?.threads)) {
    return data.threads;
  }
  if (Array.isArray(data)) {
    return data;
  }
  return [];
}

export async function api(path, options = {}) {
  const response = await fetch(`${API_PREFIX}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }

  return payload;
}

export function websocketUrl(pathname) {
  const url = new URL(`${WS_PREFIX}${pathname}`, window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function chatUrl({ projectId = "", threadId = "" } = {}) {
  const url = new URL("/new-app/chat.html", window.location.href);
  if (projectId) {
    url.searchParams.set("projectId", projectId);
  }
  if (threadId) {
    url.searchParams.set("threadId", threadId);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
