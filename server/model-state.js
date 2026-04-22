function createModelStateHelpers({
  bridge,
  cleanString,
  loadModelCapabilitiesModule,
}) {
  async function getConfigState() {
    try {
      return { ok: true, data: await bridge.request("config/read", {}) };
    } catch (error) {
      return { ok: false, error: error.message, data: null };
    }
  }

  async function getModels() {
    try {
      const [result, configState, modelCapabilities] = await Promise.all([
        bridge.request("model/list", { includeHidden: false }),
        getConfigState(),
        loadModelCapabilitiesModule(),
      ]);
      const data = result.data || result.models || [];
      const defaultServiceTier = cleanString(configState.data?.config?.service_tier);

      return {
        ok: true,
        data,
        capabilities: {
          defaultServiceTier,
          serviceTiers: modelCapabilities.collectSupportedServiceTiers(data, { defaultServiceTier }),
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: error.message,
        data: [],
        capabilities: { defaultServiceTier: "", serviceTiers: [] },
      };
    }
  }

  return {
    getModels,
  };
}

module.exports = {
  createModelStateHelpers,
};
