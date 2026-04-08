import { describe, expect, test } from "vitest";
import {
  collectSupportedServiceTiers,
  defaultReasoningEffortForModel,
  formatServiceTierLabel,
  resolveComposerSelection,
  supportedReasoningEffortValuesForModel,
  supportedServiceTiersForModel,
} from "../../src/model-capabilities.mjs";

describe("model capabilities", () => {
  test("uses live reasoning metadata without falling back to a static effort list", () => {
    const model = {
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "high" },
      ],
      defaultReasoningEffort: "high",
    };

    expect(supportedReasoningEffortValuesForModel(model)).toEqual(["low", "high"]);
    expect(defaultReasoningEffortForModel(model)).toBe("high");
  });

  test("collects dynamic service tiers from catalog and config", () => {
    const models = [
      { supportedServiceTiers: [{ serviceTier: "fast" }] },
      { serviceTiers: ["priority"] },
    ];

    expect(collectSupportedServiceTiers(models, { defaultServiceTier: "fast" })).toEqual([
      "fast",
      "priority",
    ]);
    expect(supportedServiceTiersForModel(null, { defaultServiceTier: "priority" })).toEqual(["priority"]);
  });

  test("normalizes model, effort, and service tier to supported values", () => {
    const models = [
      {
        id: "gpt-5.4",
        isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
        ],
        defaultReasoningEffort: "medium",
        supportedServiceTiers: [{ serviceTier: "fast" }],
      },
      {
        id: "gpt-5.4-mini",
        supportedReasoningEfforts: [{ reasoningEffort: "low" }],
        defaultReasoningEffort: "low",
      },
    ];

    expect(resolveComposerSelection({
      models,
      requestedModelId: "missing",
      fallbackModelId: "",
      requestedEffort: "xhigh",
      requestedServiceTier: "priority",
      capabilities: { serviceTiers: [], defaultServiceTier: "" },
    })).toMatchObject({
      modelId: "gpt-5.4",
      effort: "medium",
      serviceTier: "",
    });
  });

  test("formats service tier labels for display", () => {
    expect(formatServiceTierLabel("fast")).toBe("Fast");
    expect(formatServiceTierLabel("priority_queue")).toBe("Priority Queue");
    expect(formatServiceTierLabel("")).toBe("Auto");
  });
});
