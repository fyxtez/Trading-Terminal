import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CandlestickData, UTCTimestamp } from "lightweight-charts";
import { fetchKlines, fetchLatestKline } from "../trading/api/marketData";
import { MarketDataError } from "../trading/api/binanceMarketData";
import { useChartRefs } from "./useChartRefs";
import { useMarketData } from "./useMarketData";

vi.mock("../trading/api/marketData", async (original) => ({
  ...(await original<typeof import("../trading/api/marketData")>()),
  fetchKlines: vi.fn(),
  fetchLatestKline: vi.fn(),
}));
vi.mock("../trading/api/exchangeInfo", () => ({
  getSymbolFilters: async () => ({ pricePrecision: 1, tickSize: 0.1 }),
}));

const candle: CandlestickData = {
  time: (Date.UTC(2026, 8, 15, 12) / 1000) as UTCTimestamp,
  open: 100,
  high: 110,
  low: 90,
  close: 105,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T12:00:01Z"));
  localStorage.clear();
  vi.mocked(fetchKlines).mockReset().mockResolvedValue([candle]);
  vi.mocked(fetchLatestKline).mockReset().mockResolvedValue(candle);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
});

function renderMarket() {
  return renderHook(() => {
    const refs = useChartRefs();
    return { refs, market: useMarketData(refs, "BTCUSDT") };
  });
}

describe("live price recovery", () => {
  it("automatically retries a failed initial load after the exchange cooldown", async () => {
    vi.mocked(fetchKlines).mockRejectedValueOnce(
      new MarketDataError("Binance has limited price updates (429).", 429, Date.now() + 10_000),
    );
    const hook = renderMarket();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(fetchKlines).toHaveBeenCalledTimes(1);
    expect(fetchLatestKline).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(fetchKlines).toHaveBeenCalledTimes(2);
    expect(hook.result.current.market.marketConnection).toBe("connected");
    expect(hook.result.current.market.marketDataError).toBeNull();
    hook.unmount();
    // The deferred chart paint from the just-completed load checks the
    // cancelled flag when its animation frame runs.
    await vi.advanceTimersByTimeAsync(32);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a scheduled initial retry when the chart is closed", async () => {
    vi.mocked(fetchKlines).mockRejectedValue(new Error("Failed to fetch"));
    const hook = renderMarket();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    hook.unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchKlines).toHaveBeenCalledTimes(1);
    expect(fetchLatestKline).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows the rate-limit reason, retains the chart on retry, and clears the error after recovery", async () => {
    vi.mocked(fetchLatestKline).mockRejectedValueOnce(
      new MarketDataError(
        "Binance has limited price updates for this IP (429).",
        429,
        Date.now() + 10_000,
      ),
    );
    const hook = renderMarket();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(hook.result.current.market.marketConnection).toBe("disconnected");
    expect(hook.result.current.market.marketDataError).toContain("429");
    expect(hook.result.current.refs.loadedCandlesRef.current).toEqual([candle]);

    await act(async () => {
      hook.result.current.market.retryMarketData();
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(fetchKlines).toHaveBeenCalledTimes(1);
    expect(fetchLatestKline).toHaveBeenCalledTimes(1);
    expect(hook.result.current.market.isChartLoading).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchLatestKline).toHaveBeenCalledTimes(2);
    expect(hook.result.current.market.marketConnection).toBe("connected");
    expect(hook.result.current.market.marketDataError).toBeNull();
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks a timed-out quote as disconnected and ignores its late completion", async () => {
    let complete: ((value: CandlestickData) => void) | undefined;
    vi.mocked(fetchLatestKline).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const hook = renderMarket();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_001);
    });
    expect(hook.result.current.market.marketConnection).toBe("disconnected");
    expect(hook.result.current.market.marketDataError).toContain("took too long");
    expect(fetchLatestKline).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(hook.result.current.market.marketConnection).toBe("connected");
    await act(async () => {
      complete?.({ ...candle, close: 999 });
    });
    expect(hook.result.current.market.lastPrice).toBe(105);
    hook.unmount();
  });

  it("does not report a successful live connection for an empty quote", async () => {
    vi.mocked(fetchLatestKline).mockResolvedValueOnce(null);
    const hook = renderMarket();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(hook.result.current.market.marketConnection).toBe("disconnected");
    expect(hook.result.current.market.marketDataError).toContain("No recent prices");
    hook.unmount();
  });
});
