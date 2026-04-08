function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values) {
  const seen = new Set();
  const normalized = [];

  for (const value of values) {
    const text = cleanString(value);
    if (!text || seen.has(text)) {
      continue;
    }

    seen.add(text);
    normalized.push(text);
  }

  return normalized;
}

function normalizeReasoningOption(entry) {
  if (typeof entry === "string") {
    const reasoningEffort = cleanString(entry);
    return reasoningEffort ? { reasoningEffort, description: "" } : null;
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const reasoningEffort = cleanString(
    entry.reasoningEffort
    || entry.reasoning_effort
    || entry.value
    || entry.id
    || entry.name,
  );

  if (!reasoningEffort) {
    return null;
  }

  return {
    reasoningEffort,
    description: cleanString(entry.description || entry.label),
  };
}

function normalizeServiceTierOption(entry) {
  if (typeof entry === "string") {
    return cleanString(entry);
  }

  if (!entry || typeof entry !== "object") {
    return "";
  }

  return cleanString(
    entry.serviceTier
    || entry.service_tier
    || entry.tier
    || entry.value
    || entry.id
    || entry.name,
  );
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
  const candidates = [
    model?.supportedReasoningEfforts,
    model?.supported_reasoning_efforts,
    model?.supportedReasoningLevels,
    model?.supported_reasoning_levels,
  ];
  const options = candidates
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .map(normalizeReasoningOption)
    .filter(Boolean);

  if (options.length > 0) {
    return options;
  }

  const defaultReasoningEffort = defaultReasoningEffortForModel(model);
  return defaultReasoningEffort
    ? [{ reasoningEffort: defaultReasoningEffort, description: "" }]
    : [];
}

export function supportedReasoningEffortValuesForModel(model) {
  return supportedReasoningEffortsForModel(model).map((entry) => entry.reasoningEffort);
}

export function supportedServiceTiersForModel(model, capabilities = {}) {
  const candidates = [
    model?.supportedServiceTiers,
    model?.supported_service_tiers,
    model?.serviceTiers,
    model?.service_tiers,
    capabilities?.serviceTiers,
  ];
  const configuredServiceTier = cleanString(capabilities?.defaultServiceTier);

  return uniqueStrings([
    configuredServiceTier,
    ...candidates
      .flatMap((value) => (Array.isArray(value) ? value : []))
      .map(normalizeServiceTierOption),
  ]);
}

export function collectSupportedServiceTiers(models, capabilities = {}) {
  const modelList = Array.isArray(models) ? models : [];

  return uniqueStrings([
    cleanString(capabilities?.defaultServiceTier),
    ...modelList.flatMap((model) => supportedServiceTiersForModel(model)),
    ...supportedServiceTiersForModel(null, capabilities),
  ]);
}

export function resolveComposerModel(models, requestedModelId, fallbackModelId = "") {
  const modelList = Array.isArray(models) ? models : [];
  const requestedId = cleanString(requestedModelId);
  const fallbackId = cleanString(fallbackModelId);

  return modelList.find((model) => model?.id === requestedId)
    || modelList.find((model) => model?.id === fallbackId)
    || modelList.find((model) => model?.isDefault)
    || modelList[0]
    || null;
}

export function resolveComposerSelection({
  models,
  requestedModelId,
  fallbackModelId,
  requestedEffort,
  requestedServiceTier,
  capabilities,
}) {
  const model = resolveComposerModel(models, requestedModelId, fallbackModelId);
  const supportedEfforts = supportedReasoningEffortValuesForModel(model);
  const defaultEffort = defaultReasoningEffortForModel(model);
  const supportedServiceTiers = supportedServiceTiersForModel(model, capabilities);
  let effort = cleanString(requestedEffort);
  let serviceTier = cleanString(requestedServiceTier);

  if (supportedEfforts.length > 0) {
    if (!supportedEfforts.includes(effort)) {
      effort = supportedEfforts.includes(defaultEffort) ? defaultEffort : supportedEfforts[0];
    }
  } else {
    effort = defaultEffort;
  }

  if (!supportedServiceTiers.includes(serviceTier)) {
    serviceTier = "";
  }

  return {
    model,
    modelId: cleanString(model?.id || model?.model),
    effort,
    serviceTier,
    supportedEfforts,
    supportedServiceTiers,
  };
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
