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

function supportedServiceTiersForModel(model, capabilities = {}) {
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
