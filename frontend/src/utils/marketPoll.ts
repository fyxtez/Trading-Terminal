/** Single-flight polling with cancellation and request deadlines. */
export function startMarketPoll(
  callback: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
  timeoutMs = 15_000,
  onError?: (error: unknown) => void,
) {
  let stopped = false;
  let active: AbortController | null = null;
  let deadline: number | null = null;
  let failures = 0;
  let nextAttemptAt = 0;

  const failed = (error: unknown) => {
    failures += 1;
    const retryAt =
      error && typeof error === "object" && "retryAt" in error && typeof error.retryAt === "number"
        ? error.retryAt
        : 0;
    nextAttemptAt = Math.max(
      Date.now() + Math.min(intervalMs * 2 ** Math.min(failures, 5), 30_000),
      Number.isFinite(retryAt) ? retryAt : 0,
    );
    if (onError) onError(error);
    else console.error("Market polling failed", error);
  };

  const cancel = () => {
    active?.abort();
    active = null;
    if (deadline !== null) window.clearTimeout(deadline);
    deadline = null;
  };
  const poll = async () => {
    if (stopped || active || Date.now() < nextAttemptAt) return;
    const controller = new AbortController();
    active = controller;
    deadline = window.setTimeout(() => {
      if (active !== controller) return;
      const error = new DOMException("Price update deadline exceeded", "TimeoutError");
      controller.abort(error);
      active = null;
      deadline = null;
      failed(error);
    }, timeoutMs);
    try {
      await callback(controller.signal);
      if (!controller.signal.aborted) {
        failures = 0;
        nextAttemptAt = 0;
      }
    } catch (error) {
      if (!controller.signal.aborted) failed(error);
    } finally {
      if (active === controller) {
        active = null;
        if (deadline !== null) window.clearTimeout(deadline);
        deadline = null;
      }
    }
  };
  const timer = window.setInterval(() => void poll(), intervalMs);
  // Resume promptly after a network change without bypassing a rate-limit
  // cooldown or starting a second request while the current one is active.
  const resume = () => void poll();
  window.addEventListener("online", resume);
  void poll();
  return {
    poll,
    stop: () => {
      stopped = true;
      cancel();
      window.clearInterval(timer);
      window.removeEventListener("online", resume);
    },
  };
}
