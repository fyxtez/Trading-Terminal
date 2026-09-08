/** Single-flight polling with cancellation and request deadlines. */
export function startMarketPoll(
  callback: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
  timeoutMs = 15_000,
) {
  let stopped = false;
  let active: AbortController | null = null;
  let deadline: number | null = null;

  const cancel = () => {
    active?.abort();
    active = null;
    if (deadline !== null) window.clearTimeout(deadline);
    deadline = null;
  };
  const poll = async () => {
    if (stopped || active) return;
    const controller = new AbortController();
    active = controller;
    deadline = window.setTimeout(() => {
      if (active === controller) cancel();
    }, timeoutMs);
    try {
      await callback(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) console.error("Market polling failed", error);
    } finally {
      if (active === controller) {
        active = null;
        if (deadline !== null) window.clearTimeout(deadline);
        deadline = null;
      }
    }
  };
  const timer = window.setInterval(() => void poll(), intervalMs);
  void poll();
  return {
    poll,
    stop: () => {
      stopped = true;
      cancel();
      window.clearInterval(timer);
    },
  };
}
