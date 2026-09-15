import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: native.invoke }));

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  localStorage.clear();
  native.invoke.mockResolvedValue({
    apiBaseUrl: "https://terminal.fyxtez.com",
    apiToken: "device-token",
    generation: 1,
    remote: true,
    scope: "remote:server:account:mainnet",
  });
});

describe("remote native connection", () => {
  it("uses the selected backend for prices and never sends its token to another origin", async () => {
    const config = await import("../../config/constants");
    await config.initializeTradingApiBaseUrl();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify([[1, "123"]]), { status: 200 }));
    const { fetchBinanceKlineData } = await import("./binanceMarketData");
    await fetchBinanceKlineData(
      new URLSearchParams({ symbol: "BTCUSDT", interval: "1m", limit: "1" }),
    );
    expect(fetch.mock.calls[0][0]).toBe(
      "https://terminal.fyxtez.com/api/market-data/binance/klines?symbol=BTCUSDT&interval=1m&limit=1",
    );
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("Authorization")).toBe(
      "Bearer device-token",
    );
    expect(fetch.mock.calls[0][1]?.redirect).toBe("error");
    const { tradingApiFetch } = await import("./http");
    await expect(tradingApiFetch("https://example.com/api/account")).rejects.toThrow(
      "outside the selected server",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reuses an uncertain intent after restarting the client and isolates another account", async () => {
    const config = await import("../../config/constants");
    await config.initializeTradingApiBaseUrl();
    const first = await import("./financialMutation");
    let originalId = "";
    await expect(
      first.runFinancialMutation(
        first.financialMutationFingerprint("/api/orders/limit", { price: 10 }),
        async (id) => {
          originalId = id;
          throw new TypeError("Connection lost");
        },
      ),
    ).rejects.toThrow("Connection lost");
    vi.resetModules();
    await (await import("../../config/constants")).initializeTradingApiBaseUrl();
    const restarted = await import("./financialMutation");
    await restarted.runFinancialMutation(
      restarted.financialMutationFingerprint("/api/orders/limit", { price: 10 }),
      async (id) => {
        expect(id).toBe(originalId);
      },
    );
    vi.resetModules();
    native.invoke.mockResolvedValue({
      apiBaseUrl: "https://terminal.fyxtez.com",
      apiToken: "another-token",
      generation: 1,
      remote: true,
      scope: "remote:server:another-account:mainnet",
    });
    const otherConfig = await import("../../config/constants");
    await otherConfig.initializeTradingApiBaseUrl();
    const other = await import("./financialMutation");
    await other.runFinancialMutation(
      other.financialMutationFingerprint("/api/orders/limit", { price: 10 }),
      async (id) => expect(id).not.toBe(originalId),
    );
    expect(otherConfig.drawingsStorageKey("BTCUSDT")).toContain("another-account");
    expect(otherConfig.scopedStorageKey("fyxtez:drawing-sync-pending:BTCUSDT")).toContain(
      "another-account",
    );
  });
});
