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
