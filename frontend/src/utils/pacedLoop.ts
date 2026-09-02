/**
 * Runs coordinate/render updates synchronized with the browser's paint loop.
 *
 * In the foreground this follows the monitor refresh rate through
 * requestAnimationFrame, keeping chart overlays visually locked to the chart.
 *
 * Background tabs are heavily throttled to avoid wasting GPU/CPU.
 */
export function startPacedLoop(
  callback: () => void,
  framesPerSecond = 0,
): () => void {
  let frameId: number | null = null;
  let timeoutId: number | null = null;
  let stopped = false;
  let previousTime = 0;

  const minFrameTime =
    framesPerSecond > 0 ? 1000 / framesPerSecond : 0;

  const schedule = () => {
    if (stopped) return;

    if (document.hidden) {
      timeoutId = window.setTimeout(() => {
        if (stopped) return;

        callback();
        schedule();
      }, 500);

      return;
    }

    frameId = window.requestAnimationFrame(tick);
  };

  const tick = (time: number) => {
    if (stopped) return;

    if (
      minFrameTime === 0 ||
      previousTime === 0 ||
      time - previousTime >= minFrameTime
    ) {
      previousTime = time;
      callback();
    }

    schedule();
  };

  schedule();

  return () => {
    stopped = true;

    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
    }

    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  };
}