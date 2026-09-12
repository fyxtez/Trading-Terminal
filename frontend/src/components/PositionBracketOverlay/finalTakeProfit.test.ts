import { expect, it } from "vitest";
import type { OpenOrder } from "../../trading/api/orders";
import type { OpenPosition } from "../../trading/api/positions";
import { finalTakeProfitRemainder } from "./finalTakeProfit";
const position = { symbol: "BTCUSDT", side: "LONG", quantity: 0.11 } as OpenPosition;
const order = (qty: string, executed = "0") =>
  ({
    symbol: "BTCUSDT",
    side: "SELL",
    reduceOnly: true,
    origQty: qty,
    executedQty: executed,
  }) as OpenOrder;
it("shows the unreserved remainder after partial take-profits", () => {
  expect(finalTakeProfitRemainder(position, [])).toBe(100);
  expect(finalTakeProfitRemainder(position, [order("0.05")])).toBeCloseTo(54.54545);
  expect(finalTakeProfitRemainder(position, [order("0.05"), order("0.012")])).toBeCloseTo(43.63636);
  expect(finalTakeProfitRemainder(position, [order("0.11")])).toBe(0);
});
it("accounts for filled quantities and excludes other symbols, sides and entry orders", () => {
  expect(
    finalTakeProfitRemainder(position, [
      order("0.05", "0.02"),
      { ...order("1"), symbol: "ETHUSDT" },
      { ...order("1"), side: "BUY" },
      { ...order("1"), reduceOnly: false },
    ]),
  ).toBeCloseTo(72.72727);
});
it("does not claim a quantity when the snapshot is invalid", () => {
  expect(finalTakeProfitRemainder(position, [order("bad")])).toBeNull();
});
