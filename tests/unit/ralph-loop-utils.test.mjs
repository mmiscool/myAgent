import { describe, expect, test } from "vitest";
import {
  consumeRalphLoopBudget,
  createRalphLoopBudget,
  findLatestRalphLoopInput,
  hasRalphLoopBudgetRemaining,
  normalizeRalphLoopInput,
  normalizeRalphLoopLimit,
  ralphLoopInputFromUserMessage,
} from "../../src/ralph-loop-utils.mjs";

describe("ralph loop utils", () => {
  test("normalizes replay input and drops invalid images", () => {
    expect(normalizeRalphLoopInput({
      text: "  repeat me  ",
      images: [
        { type: "image", url: "https://example.com/one.png", name: "one" },
        { type: "image" },
      ],
    })).toEqual({
      text: "repeat me",
      images: [
        { type: "image", url: "https://example.com/one.png", name: "one" },
      ],
    });
  });

  test("extracts text and images from a user message item", () => {
    expect(ralphLoopInputFromUserMessage({
      type: "userMessage",
      content: [
        { type: "inputText", text: "run it again" },
        { type: "image", url: "data:image/png;base64,abc", name: "shot.png" },
      ],
    })).toEqual({
      text: "run it again",
      images: [
        { type: "image", url: "data:image/png;base64,abc", name: "shot.png" },
      ],
    });
  });

  test("falls back to item.text when structured content is missing", () => {
    expect(ralphLoopInputFromUserMessage({
      type: "userMessage",
      text: "  loop this  ",
    })).toEqual({
      text: "loop this",
      images: [],
    });
  });

  test("normalizes the Ralph loop limit and treats zero as infinite", () => {
    expect(normalizeRalphLoopLimit(3.9)).toBe(3);
    expect(normalizeRalphLoopLimit("2")).toBe(2);
    expect(normalizeRalphLoopLimit(-1)).toBe(0);
    expect(normalizeRalphLoopLimit("")).toBe(0);
  });

  test("tracks finite Ralph loop budgets by thread", () => {
    const budget = createRalphLoopBudget(2, "thread-1");

    expect(hasRalphLoopBudgetRemaining(budget, "thread-1")).toBe(true);

    const afterFirstLoop = consumeRalphLoopBudget(budget, "thread-1");
    expect(afterFirstLoop).toEqual({
      threadId: "thread-1",
      infinite: false,
      remainingLoops: 1,
    });

    const afterSecondLoop = consumeRalphLoopBudget(afterFirstLoop, "thread-1");
    expect(hasRalphLoopBudgetRemaining(afterSecondLoop, "thread-1")).toBe(false);
    expect(afterSecondLoop).toEqual({
      threadId: "thread-1",
      infinite: false,
      remainingLoops: 0,
    });
  });

  test("keeps infinite Ralph loop budgets available", () => {
    const budget = createRalphLoopBudget(0, "thread-1");

    expect(hasRalphLoopBudgetRemaining(budget, "thread-1")).toBe(true);
    expect(consumeRalphLoopBudget(budget, "thread-1")).toEqual({
      threadId: "thread-1",
      infinite: true,
      remainingLoops: 0,
    });
  });

  test("finds the latest user message across turns", () => {
    expect(findLatestRalphLoopInput({
      turns: [
        {
          items: [
            { type: "userMessage", text: "first" },
            { type: "agentMessage", text: "done" },
          ],
        },
        {
          items: [
            { type: "userMessage", content: [{ type: "inputText", text: "second" }] },
            { type: "agentMessage", text: "done again" },
          ],
        },
      ],
    })).toEqual({
      text: "second",
      images: [],
    });
  });
});
