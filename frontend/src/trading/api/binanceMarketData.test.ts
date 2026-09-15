import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prices = [[1_800_000_000_000, "100", "110", "90", "105"]];
const params = new URLSearchParams({ symbol: "BTCUSDT", interval: "1m", limit: "1" });

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Binance price access", () => {
  it("shares a 429 cooldown across symbols and resumes after Retry-After", async () => {
    const { fetchBinanceKlineData } = await import("./binanceMarketData");
    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ code: -1003, msg: "Too many requests" }), {
        status: 429,
        headers: { "Retry-After": "12" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const retryAt = Date.now() + 12_000;
    await expect(fetchBinanceKlineData(params)).rejects.toMatchObject({ status: 429, retryAt });
    const anotherMarket = new URLSearchParams({ symbol: "ETHUSDT", interval: "1h", limit: "1500" });
    await expect(fetchBinanceKlineData(anotherMarket)).rejects.toMatchObject({ retryAt });
    await vi.advanceTimersByTimeAsync(11_999);
    await expect(fetchBinanceKlineData(params)).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(prices)));
    await vi.advanceTimersByTimeAsync(1);
    await expect(fetchBinanceKlineData(params)).resolves.toEqual(prices);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("honors a ban deadline in the body when Retry-After is not exposed", async () => {
    const { fetchBinanceKlineData } = await import("./binanceMarketData");
    const retryAt = Date.now() + 600_000;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ msg: `IP banned until ${retryAt}.` }), { status: 418 }),
        ),
    );
    await expect(fetchBinanceKlineData(params)).rejects.toMatchObject({ status: 418, retryAt });
  });

  it("backs off for a minute when a 429 has no usable body or Retry-After", async () => {
    const { fetchBinanceKlineData } = await import("./binanceMarketData");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("busy", { status: 429 })));
    await expect(fetchBinanceKlineData(params)).rejects.toMatchObject({
      status: 429,
      retryAt: Date.now() + 60_000,
    });
  });

  it("accepts a Retry-After HTTP date", async () => {
    const { fetchBinanceKlineData } = await import("./binanceMarketData");
    const retryAt = Date.now() + 90_000;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("", {
          status: 429,
          headers: { "Retry-After": new Date(retryAt).toUTCString() },
        }),
      ),
    );
    await expect(fetchBinanceKlineData(params)).rejects.toMatchObject({ retryAt });
  });

  it.each([403, 451, 503])("keeps the HTTP %i reason visible", async (status) => {
    const { fetchBinanceKlineData } = await import("./binanceMarketData");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status })));
    await expect(fetchBinanceKlineData(params)).rejects.toThrow(String(status));
  });

  it("explains transport failure and rejects invalid price data", async () => {
    const { fetchBinanceKlineData } = await import("./binanceMarketData");
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetcher);
    await expect(fetchBinanceKlineData(params)).rejects.toThrow("Cannot reach Binance prices");
    fetcher.mockResolvedValueOnce(new Response("{}"));
    await expect(fetchBinanceKlineData(params)).rejects.toThrow("invalid price data");
  });
});
