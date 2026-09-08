/** Runs visual updates only while visible, restarting after browser suspension. */
export function startPacedLoop(callback: () => void, framesPerSecond = 0): () => void {
  let frameId: number | null = null;
  let stopped = false;
  let previousTime = 0;
  const minFrameTime = framesPerSecond > 0 ? 1000 / framesPerSecond : 0;

  const schedule = () => {
    if (!stopped && !document.hidden && frameId === null) {
      frameId = window.requestAnimationFrame(tick);
    }
  };
  const tick = (time: number) => {
    frameId = null;
    if (stopped || document.hidden) return;
    try {
      if (minFrameTime === 0 || previousTime === 0 || time - previousTime >= minFrameTime) {
        previousTime = time;
        callback();
      }
    } finally {
      // Keep the loop alive even if an overlay throws during a chart transition.
      schedule();
    }
  };
  const resume = () => {
    if (frameId !== null) window.cancelAnimationFrame(frameId);
    frameId = null;
    previousTime = 0;
    schedule();
  };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("pageshow", resume);
  window.addEventListener("focus", resume);
  schedule();

  return () => {
    stopped = true;
    if (frameId !== null) window.cancelAnimationFrame(frameId);
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("pageshow", resume);
    window.removeEventListener("focus", resume);
  };
}
