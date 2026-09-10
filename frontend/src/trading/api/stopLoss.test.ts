import { beforeEach, expect, it, vi } from "vitest";
import { getFullStopLoss } from "./orders";
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("./http", () => ({ tradingApiFetch: fetchMock, tradingApiHeaders: () => ({}) }));
const jsonResponse = (body: string, init: ResponseInit = {}) =>
  new Response(body, { ...init, headers: { "content-type": "application/json" } });
beforeEach(() => fetchMock.mockReset());
it("recovers the live stop ID without losing integer precision", async () => {
  fetchMock.mockResolvedValue(
    jsonResponse(
      '[{"symbol":"BTCUSDT","side":"BUY","orderType":"STOP_MARKET","positionSide":"BOTH","closePosition":true,"algoId":9007199254740993,"triggerPrice":"77735.1"}]',
    ),
  );
  expect(await getFullStopLoss("BTCUSDT", "BUY")).toEqual({
    symbol: "BTCUSDT",
    side: "BUY",
    algoId: "9007199254740993",
    triggerPrice: 77735.1,
  });
});
it("does not mistake take-profit or another position's stop for this stop", async () => {
  fetchMock.mockResolvedValue(
    jsonResponse(
      JSON.stringify([
        { symbol: "BTCUSDT", side: "BUY", orderType: "TAKE_PROFIT_MARKET", closePosition: true },
        { symbol: "ETHUSDT", side: "BUY", orderType: "STOP_MARKET", closePosition: true },
        { symbol: "BTCUSDT", side: "SELL", orderType: "STOP_MARKET", closePosition: true },
      ]),
    ),
  );
  expect(await getFullStopLoss("BTCUSDT", "BUY")).toBeNull();
});
it("a failed exchange read cannot be interpreted as a cancelled stop", async () => {
  fetchMock.mockResolvedValue(jsonResponse('{"error":"unavailable"}', { status: 502 }));
  await expect(getFullStopLoss("BTCUSDT", "BUY")).rejects.toThrow();
});
