import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchLatestKline, fetchOlderKlines } from "./marketData";
vi.mock("./marketData", () => ({ fetchLatestKline: vi.fn(), fetchOlderKlines: vi.fn() }));
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.mocked(fetchLatestKline).mockReset();
  vi.mocked(fetchOlderKlines).mockReset();
});
afterEach(() => vi.useRealTimers());
const candle = { time: 1 as never, open: 100, high: 110, low: 90, close: 105 };

it("bounds 100 simultaneous or remounted daily readers to one request per second", async () => {
  vi.mocked(fetchLatestKline).mockResolvedValue(candle);
  const { getDailyCandle } = await import("./dailyCandle");
  await Promise.all(Array.from({ length: 100 }, () => getDailyCandle("BTCUSDT")));
  expect(fetchLatestKline).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(999);
  await getDailyCandle("btcusdt");
  expect(fetchLatestKline).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await getDailyCandle("BTCUSDT");
  expect(fetchLatestKline).toHaveBeenCalledTimes(2);
  await getDailyCandle("ETHUSDT");
  expect(fetchLatestKline).toHaveBeenCalledTimes(3);
});

it("keeps a shared request alive when a chart unmounts and reuses it on remount", async () => {
  let finish: (value: typeof candle) => void = () => {};
  vi.mocked(fetchLatestKline).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { getDailyCandle } = await import("./dailyCandle");
  const controller = new AbortController();
  const oldReader = getDailyCandle("BTCUSDT", controller.signal);
  const rejected = expect(oldReader).rejects.toThrow();
  controller.abort();
  await rejected;
  const newReader = getDailyCandle("BTCUSDT");
  finish(candle);
  expect(await newReader).toEqual(candle);
  expect(fetchLatestKline).toHaveBeenCalledTimes(1);
});

it("backs off repeated failed readers instead of flooding the server", async () => {
  vi.mocked(fetchLatestKline).mockRejectedValue(new Error("offline"));
  const { getDailyCandle } = await import("./dailyCandle");
  await Promise.allSettled(Array.from({ length: 100 }, () => getDailyCandle("BTCUSDT")));
  await expect(getDailyCandle("BTCUSDT")).rejects.toThrow("offline");
  expect(fetchLatestKline).toHaveBeenCalledTimes(1);
});

it("shares yesterday reads and switches to the newly completed day at UTC midnight", async () => {
  vi.setSystemTime(new Date("2026-09-26T23:59:59Z"));
  const day = Date.parse("2026-09-26T00:00:00Z") / 1000;
  const previous = { ...candle, time: (day - 86400) as never };
  vi.mocked(fetchOlderKlines).mockResolvedValue([previous]);
  const { getYesterdayDailyCandle } = await import("./dailyCandle");
  const results = await Promise.all(
    Array.from({ length: 100 }, () => getYesterdayDailyCandle("btcusdt")),
  );
  expect(results.every((value) => value === previous)).toBe(true);
  expect(fetchOlderKlines).toHaveBeenCalledTimes(1);
  expect(fetchOlderKlines).toHaveBeenCalledWith("1d", "BTCUSDT", day * 1000, 1);
  vi.setSystemTime(new Date("2026-09-27T00:00:00Z"));
  const completed = { ...candle, time: day as never };
  vi.mocked(fetchOlderKlines).mockResolvedValue([completed]);
  expect(await getYesterdayDailyCandle("BTCUSDT")).toEqual(completed);
  expect(fetchOlderKlines).toHaveBeenCalledTimes(2);
});

it("does not substitute an older trading day when yesterday has no data", async () => {
  vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
  vi.mocked(fetchOlderKlines).mockResolvedValue([candle]);
  const { getYesterdayDailyCandle } = await import("./dailyCandle");
  expect(await getYesterdayDailyCandle("BTCUSDT")).toBeNull();
});
