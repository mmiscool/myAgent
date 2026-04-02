const DEFAULT_OLLAMA_BASE_URL = normalizeBaseUrl(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434");
const DEFAULT_DESKTOP_VISION_MODEL = cleanString(process.env.DESKTOP_VISION_MODEL) || "llava-phi3:latest";

const MODEL_READY_PROMISES = new Map();

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toInteger(value) {
  const number = toNumber(value);
  return number === null ? null : Math.round(number);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeBaseUrl(value) {
  const normalized = cleanString(value);
  return (normalized || "http://127.0.0.1:11434").replace(/\/+$/, "");
}

function summarizePayloadError(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  return cleanString(payload.error)
    || cleanString(payload.message)
    || cleanString(payload.status)
    || "";
}

function extractBase64Image(dataUrl) {
  const text = cleanString(dataUrl);
  if (!text) {
    throw new Error("Screenshot image data is required");
  }

  const match = text.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
  if (match) {
    return match[1];
  }

  return text;
}

function buildVisionPrompt({ goal, width, height, maxTargets }) {
  const lines = [
    "Analyze this Linux desktop screenshot and identify visible UI elements that can be clicked or focused.",
    "Return JSON only that matches the provided schema.",
    "Use image pixel coordinates relative to the top-left corner of the full screenshot.",
    "Only include targets that are visibly present and reasonably actionable.",
    "Prioritize buttons, links, tabs, text fields, menus, list rows, icons, launchers, and window controls.",
    "Do not invent hidden controls or off-screen elements.",
    `Screen size: ${width}x${height}.`,
    `Limit the response to at most ${maxTargets} clickable targets.`,
  ];

  if (goal) {
    lines.push(`Goal: ${goal}`);
    lines.push("Rank goal-relevant targets first.");
  }

  return lines.join("\n");
}

function buildVisionSchema(maxTargets) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "targets"],
    properties: {
      summary: { type: "string" },
      uncertainty: { type: "string" },
      targets: {
        type: "array",
        maxItems: maxTargets,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "kind", "confidence", "x", "y", "width", "height"],
          properties: {
            label: { type: "string" },
            kind: { type: "string" },
            description: { type: "string" },
            confidence: { type: "number" },
            x: { type: "integer" },
            y: { type: "integer" },
            width: { type: "integer" },
            height: { type: "integer" },
          },
        },
      },
    },
  };
}

function buildTargetId(index) {
  return `target-${index + 1}`;
}

function readBoundsTarget(value) {
  return value && typeof value === "object" ? value : {};
}

function parseBounds(rawTarget) {
  const target = readBoundsTarget(rawTarget);
  const bounds = readBoundsTarget(target.bounds);

  const x = toInteger(bounds.x ?? target.x ?? target.left);
  const y = toInteger(bounds.y ?? target.y ?? target.top);
  const width = toInteger(bounds.width ?? target.width ?? target.w);
  const height = toInteger(bounds.height ?? target.height ?? target.h);

  return { x, y, width, height };
}

function normalizeClickableTargets(rawTargets, screenWidth, screenHeight, maxTargets = 12) {
  const widthLimit = Math.max(1, toInteger(screenWidth) || 1);
  const heightLimit = Math.max(1, toInteger(screenHeight) || 1);
  const limit = clamp(toInteger(maxTargets) || 12, 1, 25);
  const source = Array.isArray(rawTargets) ? rawTargets : [];
  const normalized = [];

  for (const rawTarget of source) {
    if (normalized.length >= limit || !rawTarget || typeof rawTarget !== "object") {
      continue;
    }

    const label = cleanString(rawTarget.label)
      || cleanString(rawTarget.text)
      || cleanString(rawTarget.name)
      || cleanString(rawTarget.description)
      || cleanString(rawTarget.kind)
      || cleanString(rawTarget.type);
    const kind = cleanString(rawTarget.kind) || cleanString(rawTarget.type) || "control";
    const description = cleanString(rawTarget.description) || cleanString(rawTarget.hint) || "";
    const confidence = clamp(toNumber(rawTarget.confidence) ?? 0.5, 0, 1);
    const bounds = parseBounds(rawTarget);

    if ([bounds.x, bounds.y, bounds.width, bounds.height].some((value) => value === null)) {
      continue;
    }

    const x = clamp(bounds.x, 0, widthLimit - 1);
    const y = clamp(bounds.y, 0, heightLimit - 1);
    const width = clamp(bounds.width, 1, widthLimit - x);
    const height = clamp(bounds.height, 1, heightLimit - y);

    normalized.push({
      targetId: buildTargetId(normalized.length),
      label,
      kind,
      description,
      confidence,
      bounds: { x, y, width, height },
      center: {
        x: x + Math.floor(width / 2),
        y: y + Math.floor(height / 2),
      },
    });
  }

  return normalized;
}

function extractJsonText(text) {
  const source = cleanString(text);
  if (!source) {
    return "";
  }

  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    return fenced[1].trim();
  }

  return source;
}

function parseModelJson(text) {
  const source = extractJsonText(text);
  if (!source) {
    throw new Error("Ollama returned an empty response");
  }

  try {
    return JSON.parse(source);
  } catch {
    const objectMatch = source.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      return JSON.parse(objectMatch[0]);
    }
    throw new Error("Ollama returned invalid JSON for desktop vision");
  }
}

async function postOllamaJson(baseUrl, endpoint, body, fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch is not available for Ollama desktop vision requests");
  }

  let response;

  try {
    response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Unable to reach Ollama at ${normalizeBaseUrl(baseUrl)}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const rawText = await response.text();
  let payload = null;

  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = summarizePayloadError(payload) || rawText || `HTTP ${response.status}`;
    const error = new Error(`Ollama ${endpoint} failed (${response.status}): ${detail}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function isModelMissingError(error) {
  const text = `${error?.message || ""} ${summarizePayloadError(error?.payload)}`.toLowerCase();
  return text.includes("not found") || text.includes("pull") || text.includes("no such file");
}

function ensureVisionCapability(model, payload) {
  const capabilities = Array.isArray(payload?.capabilities) ? payload.capabilities : [];

  if (capabilities.length > 0 && !capabilities.includes("vision")) {
    throw new Error(`Ollama model ${JSON.stringify(model)} does not advertise vision support`);
  }
}

async function ensureOllamaVisionModel({ model, baseUrl, autoPullModel = true, fetch = globalThis.fetch } = {}) {
  const resolvedModel = cleanString(model) || DEFAULT_DESKTOP_VISION_MODEL;
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl || DEFAULT_OLLAMA_BASE_URL);
  const cacheKey = `${resolvedBaseUrl}::${resolvedModel}`;
  const existing = MODEL_READY_PROMISES.get(cacheKey);

  if (existing) {
    return existing;
  }

  const pending = (async () => {
    try {
      const show = await postOllamaJson(resolvedBaseUrl, "/api/show", {
        model: resolvedModel,
      }, fetch);
      ensureVisionCapability(resolvedModel, show);
      return { model: resolvedModel, baseUrl: resolvedBaseUrl, pulled: false, capabilities: show.capabilities || [] };
    } catch (error) {
      if (!autoPullModel || !isModelMissingError(error)) {
        throw error;
      }

      await postOllamaJson(resolvedBaseUrl, "/api/pull", {
        model: resolvedModel,
        stream: false,
      }, fetch);

      const show = await postOllamaJson(resolvedBaseUrl, "/api/show", {
        model: resolvedModel,
      }, fetch);
      ensureVisionCapability(resolvedModel, show);
      return { model: resolvedModel, baseUrl: resolvedBaseUrl, pulled: true, capabilities: show.capabilities || [] };
    }
  })();

  MODEL_READY_PROMISES.set(cacheKey, pending);

  try {
    return await pending;
  } catch (error) {
    MODEL_READY_PROMISES.delete(cacheKey);
    throw error;
  }
}

async function analyzeDesktopScreenshot(screenshot, options = {}) {
  const resolvedModel = cleanString(options.model) || DEFAULT_DESKTOP_VISION_MODEL;
  const resolvedBaseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_OLLAMA_BASE_URL);
  const fetchImpl = options.fetch || globalThis.fetch;
  const goal = cleanString(options.goal);
  const width = Math.max(1, toInteger(screenshot?.width) || 1);
  const height = Math.max(1, toInteger(screenshot?.height) || 1);
  const maxTargets = clamp(toInteger(options.maxTargets) || 12, 1, 25);

  const modelState = await ensureOllamaVisionModel({
    model: resolvedModel,
    baseUrl: resolvedBaseUrl,
    autoPullModel: options.autoPullModel !== false,
    fetch: fetchImpl,
  });

  const payload = await postOllamaJson(resolvedBaseUrl, "/api/chat", {
    model: resolvedModel,
    stream: false,
    format: buildVisionSchema(maxTargets),
    options: {
      temperature: 0,
    },
    messages: [
      {
        role: "user",
        content: buildVisionPrompt({ goal, width, height, maxTargets }),
        images: [extractBase64Image(screenshot?.dataUrl)],
      },
    ],
  }, fetchImpl);

  const parsed = parseModelJson(payload?.message?.content);
  const targets = normalizeClickableTargets(parsed.targets || parsed.clickableTargets, width, height, maxTargets);

  return {
    baseUrl: resolvedBaseUrl,
    model: payload?.model || modelState.model,
    pulledModel: Boolean(modelState.pulled),
    summary: cleanString(parsed.summary) || "Local desktop vision completed.",
    uncertainty: cleanString(parsed.uncertainty) || "",
    goal,
    targets,
    usage: {
      promptEvalCount: toInteger(payload?.prompt_eval_count),
      evalCount: toInteger(payload?.eval_count),
      totalDuration: toInteger(payload?.total_duration),
    },
    raw: parsed,
  };
}

function resetDesktopVisionModelCache() {
  MODEL_READY_PROMISES.clear();
}

module.exports = {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_DESKTOP_VISION_MODEL,
  analyzeDesktopScreenshot,
  ensureOllamaVisionModel,
  extractBase64Image,
  normalizeClickableTargets,
  resetDesktopVisionModelCache,
};
