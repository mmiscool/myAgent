const IMAGE_ENTRY_TYPES = new Set([
  "image",
  "local_image",
  "localImage",
  "inputImage",
]);

const TEXT_ENTRY_TYPES = new Set([
  "text",
  "inputText",
]);

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedImageEntry(entry) {
  const imageUrl = entry?.url || entry?.imageUrl || entry?.image_url || entry?.data;

  if (!imageUrl) {
    return null;
  }

  return {
    type: "image",
    url: imageUrl,
    name: entry?.name || entry?.alt || "",
  };
}

export function normalizeRalphLoopInput(input = {}) {
  return {
    text: typeof input?.text === "string" ? input.text.trim() : "",
    images: Array.isArray(input?.images)
      ? input.images
        .map((entry) => normalizedImageEntry(entry))
        .filter(Boolean)
      : [],
  };
}

export function normalizeRalphLoopLimit(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }

  return Math.floor(numeric);
}

export function createRalphLoopBudget(limit, threadId = "") {
  const normalizedLimit = normalizeRalphLoopLimit(limit);

  return {
    threadId: cleanString(threadId),
    infinite: normalizedLimit === 0,
    remainingLoops: normalizedLimit === 0 ? 0 : normalizedLimit,
  };
}

export function hasRalphLoopBudgetRemaining(budget, threadId = "") {
  const normalizedThreadId = cleanString(threadId);

  if (!budget || !normalizedThreadId || cleanString(budget.threadId) !== normalizedThreadId) {
    return false;
  }

  return budget.infinite === true || normalizeRalphLoopLimit(budget.remainingLoops) > 0;
}

export function consumeRalphLoopBudget(budget, threadId = "") {
  const normalizedThreadId = cleanString(threadId);

  if (!budget) {
    return null;
  }

  if (!normalizedThreadId || cleanString(budget.threadId) !== normalizedThreadId || budget.infinite === true) {
    return budget;
  }

  return {
    ...budget,
    remainingLoops: Math.max(0, normalizeRalphLoopLimit(budget.remainingLoops) - 1),
  };
}

export function ralphLoopInputFromUserMessage(item) {
  if (!item || item.type !== "userMessage") {
    return null;
  }

  const content = Array.isArray(item.content) ? item.content : [];
  const textParts = [];
  const images = [];

  if (content.length === 0 && typeof item.text === "string" && item.text.trim()) {
    textParts.push(item.text);
  }

  for (const entry of content) {
    if (typeof entry === "string") {
      if (entry.trim()) {
        textParts.push(entry);
      }
      continue;
    }

    if (!entry || typeof entry !== "object") {
      continue;
    }

    if (TEXT_ENTRY_TYPES.has(entry.type) && typeof entry.text === "string" && entry.text.trim()) {
      textParts.push(entry.text);
      continue;
    }

    if (IMAGE_ENTRY_TYPES.has(entry.type)) {
      const image = normalizedImageEntry(entry);
      if (image) {
        images.push(image);
      }
    }
  }

  const normalized = normalizeRalphLoopInput({
    text: textParts.join("\n\n"),
    images,
  });

  if (!normalized.text && normalized.images.length === 0) {
    return null;
  }

  return normalized;
}

export function findLatestRalphLoopInput(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = Array.isArray(turns[turnIndex]?.items) ? turns[turnIndex].items : [];

    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const input = ralphLoopInputFromUserMessage(items[itemIndex]);
      if (input) {
        return input;
      }
    }
  }

  return null;
}
