export const RALPH_LOOP_DELAY_SECONDS = 15;

export function startRalphLoopCountdown({
  seconds = RALPH_LOOP_DELAY_SECONDS,
  onTick = () => {},
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancelScheduled = (timerId) => clearTimeout(timerId),
} = {}) {
  const totalSeconds = Number.isFinite(seconds)
    ? Math.max(0, Math.floor(seconds))
    : RALPH_LOOP_DELAY_SECONDS;

  let remainingSeconds = totalSeconds;
  let timerId = null;
  let settled = false;
  let resolveDone = () => {};

  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function settle(completed) {
    if (settled) {
      return completed;
    }

    settled = true;

    if (timerId !== null) {
      cancelScheduled(timerId);
      timerId = null;
    }

    resolveDone(completed);
    return completed;
  }

  function scheduleNextTick() {
    if (remainingSeconds <= 0) {
      settle(true);
      return;
    }

    onTick(remainingSeconds);
    timerId = schedule(() => {
      timerId = null;
      remainingSeconds -= 1;
      scheduleNextTick();
    }, 1000);
  }

  scheduleNextTick();

  return {
    done,
    cancel() {
      return settle(false);
    },
    getRemainingSeconds() {
      return remainingSeconds;
    },
  };
}
