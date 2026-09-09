import { describe, expect, it, vi } from "vitest";
import { getAutoMarketLeverage } from "./sizing";
import { tradingApiFetch } from "./http";

vi.mock("./http", () => ({
  tradingApiFetch: vi.fn(),
  tradingApiHeaders: (headers: Record<string, string>) => headers,
}));
vi.mock("./exchangeInfo", () => ({
  getSymbolFilters: async () => ({ tickSize: 0.01 }),
  roundToStep: (value: number, step: number) => Math.round(value / step) * step,
}));

describe("Auto Market leverage preview", () => {
  it("reads backend leverage using the order's rounded stop without overriding leverage", async () => {
    vi.mocked(tradingApiFetch).mockResolvedValue(new Response(JSON.stringify({ leverage: 7 })));
    const signal = new AbortController().signal;
    expect(await getAutoMarketLeverage("SOLUSDT", "BUY", 56.654, signal)).toBe(7);
    const [input, init] = vi.mocked(tradingApiFetch).mock.calls[0]!;
    const url = new URL(String(input), "http://localhost");
    expect(url.pathname).toBe("/api/sizing/preview/SOLUSDT");
    expect(url.searchParams.get("side")).toBe("BUY");
    expect(Number(url.searchParams.get("stop_loss"))).toBeCloseTo(56.65);
    expect(url.searchParams.has("leverage")).toBe(false);
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.signal).toBe(signal);
  });

  it("rejects an unavailable or invalid preview instead of inventing leverage", async () => {
    vi.mocked(tradingApiFetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "Invalid stop" }), { status: 400 }),
    );
    await expect(
      getAutoMarketLeverage("SOLUSDT", "SELL", 56, new AbortController().signal),
    ).rejects.toThrow("Invalid stop");
    vi.mocked(tradingApiFetch).mockResolvedValue(new Response(JSON.stringify({ leverage: 0 })));
    await expect(
      getAutoMarketLeverage("SOLUSDT", "SELL", 56, new AbortController().signal),
    ).rejects.toThrow("invalid automatic leverage");
  });
});
