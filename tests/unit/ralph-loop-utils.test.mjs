import { describe, expect, test } from "vitest";
import {
  findLatestRalphLoopInput,
  normalizeRalphLoopInput,
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
