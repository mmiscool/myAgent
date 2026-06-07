import { describe, expect, test, vi } from "vitest";
import { InputNormalizer, normalizeCanvasCoordinates } from "../../packages/input-normalizer/index.mjs";

describe("input normalizer", () => {
  test("maps scaled canvas coordinates back to remote space", () => {
    const renderer = {
      mapCanvasPointToRemote(clientX, clientY) {
        return {
          x: Math.round(clientX / 2),
          y: Math.round(clientY / 2),
        };
      },
    };

    const point = normalizeCanvasCoordinates(renderer, { clientX: 100, clientY: 50 });
    expect(point).toEqual({ x: 50, y: 25 });
  });

  test("batches input events", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const normalizer = new InputNormalizer({
      renderer: {
        mapCanvasPointToRemote(clientX, clientY) {
          return { x: clientX, y: clientY };
        },
      },
      send,
    });

    normalizer.queue({ kind: "pointerMove", x: 1, y: 2 });
    normalizer.queue({ kind: "pointerMove", x: 2, y: 3 });

    await vi.advanceTimersByTimeAsync(9);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toHaveLength(2);
    vi.useRealTimers();
  });
});
