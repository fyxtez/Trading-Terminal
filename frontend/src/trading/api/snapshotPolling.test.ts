import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("./http", () => ({ tradingApiFetch: fetchMock, tradingApiHeaders: () => ({}) }));
vi.mock("../../desktop/credentials", () => ({
  canUseTradingAccount: () => true,
  DESKTOP_CREDENTIALS_CHANGED_EVENT: "fyxtez:desktop-credentials-changed",
}));

const json = (body: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const order = (symbol: string, orderId = "9007199254740993") => ({
  symbol,
  orderId,
  status: "NEW",
  price: "100",
  origQty: "1",
  executedQty: "0",
});
const account = (quantity = 1) => ({
  positions: quantity
    ? [
        {
          symbol: "BTCUSDT",
          positionAmt: String(quantity),
          entryPrice: "100",
          notional: String(quantity * 100),
          unrealizedProfit: "5",
          initialMargin: "10",
          liquidationPrice: "90",
        },
      ]
    : [],
});
const history = {
  positions: [{ symbol: "BTCUSDT", position_side: "BOTH", complete: true, realized_pnl: 7 }],
};
const callsTo = (path: string) =>
  fetchMock.mock.calls.filter(([url]) => new URL(url).pathname === path);

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
  fetchMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Binance snapshot request budget", () => {
  it("uses two global sweeps per minute and shares reads across panes/panels", async () => {
    const { getOpenOrders, watchOpenOrdersSymbol } = await import("./orders");
    const { getPositions } = await import("./positions");
    watchOpenOrdersSymbol("BTCUSDT");
    watchOpenOrdersSymbol("BTCUSDT");
    fetchMock.mockImplementation(async (url: string) =>
      json(url.includes("/api/account") ? account(0) : []),
    );

    for (let tick = 0; tick < 15; tick += 1) {
      if (tick) await vi.advanceTimersByTimeAsync(4_000);
      await Promise.all([
        getOpenOrders(),
        getOpenOrders(),
        getOpenOrders(),
        getPositions(),
        getPositions(),
        getPositions(),
      ]);
    }
    const orders = callsTo("/api/orders/open");
    const global = orders.filter(([url]) => !new URL(url).searchParams.has("symbol"));
    expect(global).toHaveLength(2);
    expect(orders.length - global.length).toBe(13);
    // 93 weight instead of 15 * 40 = 600 for this quiet one-symbol case.
    expect(global.length * 40 + orders.length - global.length).toBe(93);
    expect(callsTo("/api/account")).toHaveLength(15);
    expect(callsTo("/api/positions/realized-pnl")).toHaveLength(0);
  });

  it("keeps watched and off-screen existing orders fresh, and discovers new symbols", async () => {
    const { getOpenOrders, watchOpenOrdersSymbol } = await import("./orders");
    const stopWatching = watchOpenOrdersSymbol("BTCUSDT");
    fetchMock.mockResolvedValueOnce(json([order("ETHUSDT")]));
    expect(await getOpenOrders()).toEqual([order("ETHUSDT")]);
    await vi.advanceTimersByTimeAsync(4_000);
    fetchMock.mockImplementation(async (url: string) =>
      json(new URL(url).searchParams.get("symbol") === "BTCUSDT" ? [order("BTCUSDT")] : []),
    );
    expect(await getOpenOrders()).toEqual([order("BTCUSDT")]);
    expect(
      fetchMock.mock.calls
        .slice(1)
        .map(([url]) => new URL(url).searchParams.get("symbol"))
        .sort(),
    ).toEqual(["BTCUSDT", "ETHUSDT"]);
    stopWatching();
    await vi.advanceTimersByTimeAsync(28_000);
    fetchMock.mockResolvedValueOnce(json([order("SOLUSDT")]));
    expect(await getOpenOrders()).toEqual([order("SOLUSDT")]);
    expect(new URL(fetchMock.mock.lastCall![0]).search).toBe("");
  });

  it("forces a global reconciliation after an order event without losing large IDs", async () => {
    const { getOpenOrders } = await import("./orders");
    fetchMock.mockResolvedValueOnce(json([]));
    await getOpenOrders();
    fetchMock.mockResolvedValueOnce(
      new Response('[{"symbol":"SOLUSDT","orderId":9007199254740993,"status":"NEW"}]'),
    );
    const [first, second] = await Promise.all([
      getOpenOrders(undefined, undefined, true),
      getOpenOrders(undefined, undefined, true),
    ]);
    expect(first[0].orderId).toBe("9007199254740993");
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains existing orders when a symbol read fails, then recovers", async () => {
    const { getOpenOrders } = await import("./orders");
    fetchMock.mockResolvedValueOnce(json([order("ETHUSDT")]));
    await getOpenOrders();
    await vi.advanceTimersByTimeAsync(4_000);
    fetchMock.mockResolvedValue(json({ error: "unavailable" }, 502));
    await expect(getOpenOrders()).rejects.toThrow("unavailable");
    await expect(getOpenOrders()).rejects.toThrow("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_000);
    fetchMock.mockResolvedValue(json([order("ETHUSDT")]));
    expect(await getOpenOrders()).toEqual([order("ETHUSDT")]);
    expect(new URL(fetchMock.mock.lastCall![0]).searchParams.get("symbol")).toBe("ETHUSDT");
  });

  it("does not fetch fill history when flat or after an unsuccessful account read", async () => {
    const { getPositions } = await import("./positions");
    fetchMock.mockResolvedValueOnce(json(account(0)));
    expect(await getPositions()).toEqual([]);
    fetchMock.mockResolvedValueOnce(json({ error: "unavailable" }, 502));
    await expect(getPositions(undefined, true)).rejects.toThrow("unavailable");
    expect(fetchMock.mock.calls.every(([url]) => new URL(url).pathname === "/api/account")).toBe(
      true,
    );
  });

  it("reuses fill history through price/forced refreshes and reloads it when exposure changes", async () => {
    const { getPositions } = await import("./positions");
    let quantity = 1;
    fetchMock.mockImplementation(async (url: string) =>
      json(new URL(url).pathname === "/api/account" ? account(quantity) : history),
    );
    for (let tick = 0; tick < 4; tick += 1) {
      const result = await getPositions(undefined, true);
      expect(result[0]).toMatchObject({ realized_pnl: 7, liquidation_price: 90 });
      await vi.advanceTimersByTimeAsync(4_000);
    }
    expect(fetchMock).toHaveBeenCalledTimes(5); // four account reads, one history
    quantity = 2;
    expect((await getPositions(undefined, true))[0].quantity).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(60_000);
    await getPositions(undefined, true);
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });

  it("shares one account read when another consumer cancels its own wait", async () => {
    const { getPositions } = await import("./positions");
    let finish!: (response: Response) => void;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    );
    const controller = new AbortController();
    const cancelled = getPositions(controller.signal);
    const another = getPositions();
    const rejected = expect(cancelled).rejects.toThrow("Abort");
    controller.abort(new Error("Aborted component"));
    await rejected;
    finish(json(account(0)));
    expect(await another).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("recovery without retry storms", () => {
  it("pauses all account readers after -2015 and resumes when credentials change", async () => {
    const { getOpenOrders } = await import("./orders");
    const { getPositions } = await import("./positions");
    fetchMock.mockResolvedValueOnce(
      json({ error: "Binance API error -2015: Invalid API-key, IP, or permissions" }, 422),
    );
    await expect(getOpenOrders()).rejects.toThrow("-2015");
    await expect(getPositions(undefined, true)).rejects.toThrow("-2015");
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(getOpenOrders(undefined, undefined, true)).rejects.toThrow("-2015");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("fyxtez:desktop-credentials-changed"));
    fetchMock.mockResolvedValue(json(account(0)));
    expect(await getPositions()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("automatically retries after an access rejection cooldown expires", async () => {
    const { getPositions } = await import("./positions");
    fetchMock.mockResolvedValueOnce(json({ error: "Binance API error -2015: Invalid IP" }, 422));
    await expect(getPositions()).rejects.toThrow("-2015");
    await vi.advanceTimersByTimeAsync(60_000);
    fetchMock.mockResolvedValueOnce(json(account(0)));
    expect(await getPositions()).toEqual([]);
  });

  it("shares Retry-After between account reads and prices in both directions", async () => {
    const { getPositions } = await import("./positions");
    const { fetchBinanceKlineData } = await import("./binanceMarketData");
    const prices = vi.fn();
    vi.stubGlobal("fetch", prices);
    fetchMock.mockResolvedValueOnce(
      json({ error: "Too many requests" }, 429, { "Retry-After": "12" }),
    );
    await expect(getPositions()).rejects.toMatchObject({ retryAt: Date.now() + 12_000 });
    const params = new URLSearchParams({ symbol: "BTCUSDT", limit: "1" });
    await expect(fetchBinanceKlineData(params)).rejects.toMatchObject({ status: 429 });
    expect(prices).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(12_000);
    prices.mockResolvedValueOnce(json({ msg: "Too many requests" }, 429, { "Retry-After": "20" }));
    await expect(fetchBinanceKlineData(params)).rejects.toMatchObject({
      retryAt: Date.now() + 20_000,
    });
    await expect(getPositions(undefined, true)).rejects.toMatchObject({
      retryAt: Date.now() + 20_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    fetchMock.mockResolvedValueOnce(json(account(0)));
    expect(await getPositions()).toEqual([]);
  });

  it("recognizes rate limits from older backends and plain-text HTTP failures", async () => {
    const { getOpenOrders } = await import("./orders");
    const { getPositions } = await import("./positions");
    fetchMock.mockResolvedValueOnce(
      json({ error: "Binance API error -1003: Too many requests" }, 422),
    );
    await expect(getOpenOrders()).rejects.toMatchObject({ retryAt: Date.now() + 60_000 });
    await expect(getPositions()).rejects.toThrow("limited");
    await vi.advanceTimersByTimeAsync(60_000);
    fetchMock.mockResolvedValueOnce(
      new Response("busy", { status: 429, headers: { "Retry-After": "10" } }),
    );
    await expect(getOpenOrders()).rejects.toMatchObject({ retryAt: Date.now() + 10_000 });
  });
});
