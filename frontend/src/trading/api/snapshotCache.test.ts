import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("shares one fresh follow-up after trade events arrive during a passive read", async () => {
  const { SnapshotCache } = await import("./snapshotCache");
  const cache = new SnapshotCache<string[]>(3500);
  const first = deferred<string[]>();
  const latest = deferred<string[]>();
  const passiveLoad = vi.fn(() => first.promise);
  const forcedLoad = vi.fn(() => latest.promise);
  const passive = cache.get(passiveLoad);
  const forcedA = cache.get(forcedLoad, true);
  const forcedB = cache.get(forcedLoad, true);
  first.resolve(["before-fill"]);
  expect(await passive).toEqual(["before-fill"]);
  await vi.advanceTimersByTimeAsync(0);
  expect(passiveLoad).toHaveBeenCalledOnce();
  expect(forcedLoad).toHaveBeenCalledOnce();
  latest.resolve(["after-fill"]);
  expect(await forcedA).toEqual(["after-fill"]);
  expect(await forcedB).toEqual(["after-fill"]);
});

it("does not repopulate an invalidated cache when an older response arrives late", async () => {
  const { SnapshotCache } = await import("./snapshotCache");
  const cache = new SnapshotCache<string[]>(3500);
  const old = deferred<string[]>();
  const pending = cache.get(() => old.promise);
  cache.invalidate();
  expect(await cache.get(async () => ["new"])).toEqual(["new"]);
  old.resolve(["old"]);
  await pending;
  const unnecessary = vi.fn(async () => ["unexpected"]);
  expect(await cache.get(unnecessary)).toEqual(["new"]);
  expect(unnecessary).not.toHaveBeenCalled();
});

it("backs off failed reads together and resets backoff after recovery", async () => {
  const { SnapshotCache } = await import("./snapshotCache");
  const cache = new SnapshotCache<string[]>(3500);
  const load = vi.fn().mockRejectedValue(new Error("unavailable"));
  await expect(cache.get(load)).rejects.toMatchObject({ retryAt: Date.now() + 4000 });
  await expect(cache.get(load, true)).rejects.toThrow("unavailable");
  expect(load).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(4000);
  await expect(cache.get(load)).rejects.toMatchObject({ retryAt: Date.now() + 8000 });
  await vi.advanceTimersByTimeAsync(8000);
  load.mockResolvedValueOnce(["recovered"]);
  expect(await cache.get(load)).toEqual(["recovered"]);
  await expect(cache.get(load, true)).rejects.toMatchObject({ retryAt: Date.now() + 4000 });
});

it("rejects old account data for every waiter after the connection changes", async () => {
  const { SnapshotCache } = await import("./snapshotCache");
  const cache = new SnapshotCache<string[]>(3500);
  const old = deferred<string[]>();
  const first = cache.get(() => old.promise);
  const second = cache.get(() => old.promise);
  const firstRejected = expect(first).rejects.toThrow("connection changed");
  const secondRejected = expect(second).rejects.toThrow("connection changed");
  window.dispatchEvent(new Event("trading-api-base-url-changed"));
  old.resolve(["previous-account"]);
  await Promise.all([firstRejected, secondRejected]);
  expect(await cache.get(async () => ["new-account"])).toEqual(["new-account"]);
});

it("does not let a late old-credential rejection block the new connection", async () => {
  const { SnapshotCache, snapshotResponseError } = await import("./snapshotCache");
  const cache = new SnapshotCache<string[]>(3500);
  const old = deferred<Response>();
  const first = cache.get(async () => {
    const response = await old.promise;
    throw snapshotResponseError(response, "Binance API error -2015: Invalid key");
  });
  const rejected = expect(first).rejects.toThrow("-2015");
  await vi.advanceTimersByTimeAsync(0);
  window.dispatchEvent(new Event("fyxtez:desktop-credentials-changed"));
  old.resolve(new Response("", { status: 422 }));
  await rejected;
  expect(await cache.get(async () => ["new-account"])).toEqual(["new-account"]);
});
