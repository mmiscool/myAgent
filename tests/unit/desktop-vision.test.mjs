import { afterEach, describe, expect, test, vi } from "vitest";
import desktopVisionModule from "../../desktop-vision.js";

const {
  analyzeDesktopScreenshot,
  normalizeClickableTargets,
  resetDesktopVisionModelCache,
} = desktopVisionModule;

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

afterEach(() => {
  resetDesktopVisionModelCache();
  vi.restoreAllMocks();
});

describe("desktop vision", () => {
  test("normalizes clickable targets into bounded click centers", () => {
    const targets = normalizeClickableTargets([
      {
        label: "Save",
        kind: "button",
        confidence: 1.2,
        x: -10,
        y: 12,
        width: 80,
        height: 30,
      },
      {
        type: "window-control",
        description: "Close window",
        confidence: 0.25,
        bounds: {
          x: 190,
          y: 95,
          width: 25,
          height: 12,
        },
      },
      {
        label: "Missing bounds",
      },
    ], 200, 100, 5);

    expect(targets).toEqual([
      {
        targetId: "target-1",
        label: "Save",
        kind: "button",
        description: "",
        confidence: 1,
        bounds: {
          x: 0,
          y: 12,
          width: 80,
          height: 30,
        },
        center: {
          x: 40,
          y: 27,
        },
      },
      {
        targetId: "target-2",
        label: "Close window",
        kind: "window-control",
        description: "Close window",
        confidence: 0.25,
        bounds: {
          x: 190,
          y: 95,
          width: 10,
          height: 5,
        },
        center: {
          x: 195,
          y: 97,
        },
      },
    ]);
  });

  test("auto-pulls the local Phi vision model and returns normalized targets", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(404, {
        error: "model 'llava-phi3:latest' not found, try pulling it first",
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        status: "success",
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        capabilities: ["completion", "vision"],
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        model: "llava-phi3:latest",
        prompt_eval_count: 321,
        eval_count: 45,
        total_duration: 999,
        message: {
          content: JSON.stringify({
            summary: "A settings dialog is open.",
            uncertainty: "Window controls are small.",
            targets: [
              {
                label: "Apply",
                kind: "button",
                description: "Primary action button",
                confidence: 0.93,
                x: 410,
                y: 550,
                width: 96,
                height: 30,
              },
              {
                label: "Close",
                kind: "button",
                confidence: 0.7,
                bounds: {
                  x: 748,
                  y: 16,
                  width: 30,
                  height: 30,
                },
              },
            ],
          }),
        },
      }));

    const result = await analyzeDesktopScreenshot({
      width: 800,
      height: 600,
      dataUrl: "data:image/png;base64,AAAA",
    }, {
      fetch: fetchMock,
      baseUrl: "http://127.0.0.1:11434",
      model: "llava-phi3:latest",
      goal: "find the apply button",
      maxTargets: 10,
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/show");
    expect(fetchMock.mock.calls[1][0]).toBe("http://127.0.0.1:11434/api/pull");
    expect(fetchMock.mock.calls[2][0]).toBe("http://127.0.0.1:11434/api/show");
    expect(fetchMock.mock.calls[3][0]).toBe("http://127.0.0.1:11434/api/chat");

    const chatBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(chatBody.messages[0].images).toEqual(["AAAA"]);
    expect(chatBody.messages[0].content).toContain("Goal: find the apply button");

    expect(result).toMatchObject({
      model: "llava-phi3:latest",
      pulledModel: true,
      summary: "A settings dialog is open.",
      uncertainty: "Window controls are small.",
      goal: "find the apply button",
      usage: {
        promptEvalCount: 321,
        evalCount: 45,
        totalDuration: 999,
      },
    });

    expect(result.targets).toEqual([
      {
        targetId: "target-1",
        label: "Apply",
        kind: "button",
        description: "Primary action button",
        confidence: 0.93,
        bounds: {
          x: 410,
          y: 550,
          width: 96,
          height: 30,
        },
        center: {
          x: 458,
          y: 565,
        },
      },
      {
        targetId: "target-2",
        label: "Close",
        kind: "button",
        description: "",
        confidence: 0.7,
        bounds: {
          x: 748,
          y: 16,
          width: 30,
          height: 30,
        },
        center: {
          x: 763,
          y: 31,
        },
      },
    ]);
  });
});
