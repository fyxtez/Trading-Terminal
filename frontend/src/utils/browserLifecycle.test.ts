import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPacedLoop } from "./pacedLoop";
import { startMarketPoll } from "./marketPoll";

let hidden = false;
const cleanup: Array<() => void> = [];
function visibility(value: boolean) {
  hidden = value;
  document.dispatchEvent(new Event("visibilitychange"));
}
beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
});
afterEach(() => {
  cleanup.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("background polling", () => {
  it("keeps polling hidden tabs without overlapping requests and cancels on cleanup", async () => {
    const signals: AbortSignal[] = [];
    const finish: Array<() => void> = [];
    const callback = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<void>((resolve) => finish.push(resolve));
    });
    const loop = startMarketPoll(callback, 1000);
    cleanup.push(loop.stop);
    await vi.advanceTimersByTimeAsync(5000);
    expect(callback).toHaveBeenCalledTimes(1);
    visibility(true);
    expect(signals[0].aborted).toBe(false);
    finish[0]();
    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledTimes(2);
    visibility(false);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
    await loop.poll();
    expect(callback).toHaveBeenCalledTimes(2);
    loop.stop();
    expect(signals[1].aborted).toBe(true);
    finish[1]();
    await vi.advanceTimersByTimeAsync(5000);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases timed-out requests and ignores late completion from the previous request", async () => {
    const signals: AbortSignal[] = [];
    const resolve: Array<() => void> = [];
    const loop = startMarketPoll(
      (signal) => {
        signals.push(signal);
        return new Promise<void>((done) => resolve.push(done));
      },
      1000,
      2000,
    );
    cleanup.push(loop.stop);
    await vi.advanceTimersByTimeAsync(3000);
    expect(signals[0].aborted).toBe(true);
    expect(signals).toHaveLength(2);
    resolve[0]();
    await Promise.resolve();
    await loop.poll();
    expect(signals).toHaveLength(2);
  });
});

describe("render loop", () => {
  it("pauses hidden frames and restarts without duplicate frames or leaked listeners", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.set(++next, cb);
      return next;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    const callback = vi.fn();
    const stop = startPacedLoop(callback);
    cleanup.push(stop);
    expect(frames.size).toBe(1);
    visibility(true);
    expect(frames.size).toBe(0);
    vi.advanceTimersByTime(3_600_000);
    expect(callback).not.toHaveBeenCalled();
    visibility(false);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
    expect(frames.size).toBe(1);
    const [id, tick] = [...frames.entries()][0];
    frames.delete(id);
    tick(100);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(1);
    stop();
    visibility(false);
    expect(frames.size).toBe(0);
  });

  it("schedules another frame even when an overlay throws", () => {
    let tick: FrameRequestCallback = () => {};
    const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      tick = cb;
      return 1;
    });
    cleanup.push(
      startPacedLoop(() => {
        throw new Error("overlay failed");
      }),
    );
    expect(() => tick(16)).toThrow("overlay failed");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
