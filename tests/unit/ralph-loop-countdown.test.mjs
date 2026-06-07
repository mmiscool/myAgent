import { describe, expect, test, vi } from "vitest";
import { RALPH_LOOP_DELAY_SECONDS, startRalphLoopCountdown } from "../../src/ralph-loop-countdown.mjs";

describe("ralph loop countdown", () => {
  test("defaults to a 15-second countdown", () => {
    expect(RALPH_LOOP_DELAY_SECONDS).toBe(15);
  });

  test("emits each second and resolves when the countdown completes", async () => {
    vi.useFakeTimers();

    const ticks = [];
    const countdown = startRalphLoopCountdown({
      seconds: 3,
      onTick: (remainingSeconds) => {
        ticks.push(remainingSeconds);
      },
    });

    await vi.advanceTimersByTimeAsync(3000);

    await expect(countdown.done).resolves.toBe(true);
    expect(ticks).toEqual([3, 2, 1]);

    vi.useRealTimers();
  });

  test("resolves false and stops emitting after cancellation", async () => {
    vi.useFakeTimers();

    const ticks = [];
    const countdown = startRalphLoopCountdown({
      seconds: 5,
      onTick: (remainingSeconds) => {
        ticks.push(remainingSeconds);
      },
    });

    await vi.advanceTimersByTimeAsync(1000);
    countdown.cancel();
    await vi.advanceTimersByTimeAsync(5000);

    await expect(countdown.done).resolves.toBe(false);
    expect(ticks).toEqual([5, 4]);

    vi.useRealTimers();
  });
});
