import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  symbols: ["BTCUSDT"],
  listSymbols: vi.fn(),
}));
vi.mock("../config/constants", () => ({
  DEFAULT_SYMBOL: "BTCUSDT",
  SYMBOL_CONFIGS: [],
  getAvailableSymbols: () => mocks.symbols,
  replaceSymbolConfigs: (configs: { symbol: string }[]) => {
    mocks.symbols = configs.map((entry) => entry.symbol);
  },
}));
vi.mock("../config/symbols", () => ({
  getSymbolInfo: (symbol: string) => ({ label: symbol.replace(/USDT$/, "") }),
  refreshSymbolMetadata: () => Promise.resolve(),
}));
vi.mock("../trading/api/symbols", () => ({ listSymbols: mocks.listSymbols }));

import { useSymbol } from "./useSymbol";

const btc = { symbol: "BTC", data_source: "binance", market_symbol: "BTCUSDT" };

describe("notification symbol links", () => {
  beforeEach(() => {
    mocks.symbols = ["BTCUSDT"];
    mocks.listSymbols.mockReset();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it.each(["/1000PEPE", "/1000PEPEUSDT"])(
    "keeps %s through asynchronous registry loading",
    async (path) => {
      let resolveRegistry!: (value: (typeof btc)[]) => void;
      mocks.listSymbols.mockReturnValue(
        new Promise((resolve) => {
          resolveRegistry = resolve;
        }),
      );
      localStorage.setItem("fyxtez:current-symbol", "BTCUSDT");
      window.history.replaceState(null, "", path);
      const { result } = renderHook(() => useSymbol());
      expect(result.current.symbol).toBe("1000PEPEUSDT");
      expect(result.current.registryReady).toBe(false);
      await act(async () =>
        resolveRegistry([
          btc,
          { symbol: "1000PEPE", data_source: "binance", market_symbol: "1000PEPEUSDT" },
        ]),
      );
      expect(result.current.registryReady).toBe(true);
      expect(result.current.symbol).toBe("1000PEPEUSDT");
    },
  );

  it("falls back when the server does not register the linked symbol", async () => {
    mocks.listSymbols.mockResolvedValue([btc]);
    window.history.replaceState(null, "", "/REMOVED");
    const { result } = renderHook(() => useSymbol());
    await waitFor(() => expect(result.current.registryReady).toBe(true));
    expect(result.current.symbol).toBe("BTCUSDT");
    expect(window.location.pathname).toBe("/BTC");
  });
});
