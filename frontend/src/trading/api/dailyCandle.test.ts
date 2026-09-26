import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchLatestKline } from "./marketData";
vi.mock("./marketData", () => ({ fetchLatestKline: vi.fn() }));
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.mocked(fetchLatestKline).mockReset();
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
