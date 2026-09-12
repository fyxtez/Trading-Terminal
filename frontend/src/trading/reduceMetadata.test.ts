import { expect, it } from "vitest";
import type { OpenOrder } from "./api/orders";
import { getLiveReduceMetadata } from "./reduceMetadata";
import { getPendingOrderLabelText } from "../hooks/useDrawingCanvas/pendingOrderLayout";

const position = { symbol: "BTCUSDT", side: "LONG" as const, quantity: 0.11 };
const order = (id: string, quantity: string, price: string): OpenOrder => ({
  orderId: id,
  clientOrderId: "fe-red-100-l0-old",
  symbol: "BTCUSDT",
  side: "SELL",
  type: "LIMIT",
  origType: "LIMIT",
  status: "NEW",
  price,
  origQty: quantity,
  executedQty: "0",
  reduceOnly: true,
  timeInForce: "GTC",
  avgPrice: "0",
  time: 0,
  updateTime: 0,
});
const near = order("1", "0.015", "78000");
const far = order("2", "0.045", "79000");

it("uses current BTC size and price-ordered fills rather than historical 100% metadata", () => {
  expect(getLiveReduceMetadata(near, [far, near], position)).toEqual({
    reducePct: 13.6,
    remainingPct: 86.4,
  });
  expect(getLiveReduceMetadata(far, [far, near], position)).toEqual({
    reducePct: 40.9,
    remainingPct: 45.5,
  });
});

it("includes other targets, independent of their creation order", () => {
  const first = order("3", "0.05", "77500");
  expect(getLiveReduceMetadata(far, [far, near, first], position)).toEqual({
    reducePct: 40.9,
    remainingPct: 0,
  });
});

it("updates after fills and additions without counting the filled quantity twice", () => {
  const partial = { ...near, executedQty: "0.005" };
  expect(getLiveReduceMetadata(partial, [partial, far], { ...position, quantity: 0.105 })).toEqual({
    reducePct: 9.5,
    remainingPct: 90.5,
  });
  expect(getLiveReduceMetadata(far, [near, far], { ...position, quantity: 0.22 })).toEqual({
    reducePct: 20.5,
    remainingPct: 72.7,
  });
});

it("reverses target order for shorts and excludes unrelated orders", () => {
  const shortNear = { ...far, side: "BUY" as const };
  const shortFar = { ...near, side: "BUY" as const };
  const unrelated = [near, { ...near, symbol: "ETHUSDT" }, { ...shortFar, reduceOnly: false }];
  expect(
    getLiveReduceMetadata(shortFar, [shortFar, shortNear, ...unrelated], {
      ...position,
      side: "SHORT",
    }),
  ).toEqual({ reducePct: 13.6, remainingPct: 45.5 });
});

it("does not invent percentages without a matching valid position", () => {
  expect(getLiveReduceMetadata(far, [far], null)).toEqual({});
  expect(getLiveReduceMetadata(far, [far], { ...position, symbol: "ETHUSDT" })).toEqual({});
  expect(getLiveReduceMetadata(far, [far], { ...position, quantity: 0 })).toEqual({});
});

it("renders live percentages without reusing historical sizing metadata", () => {
  const drawing = {
    id: "order-2",
    type: "horizontal" as const,
    price: 79000,
    color: "yellow",
    orderIntent: "REDUCE" as const,
    orderQuantity: 0.045,
    orderSymbol: "BTCUSDT",
    orderReducePct: 100,
    orderRemainingPct: 0,
    orderDisplayReduce: getLiveReduceMetadata(far, [near, far], position),
  };
  expect(getPendingOrderLabelText(drawing, 1)).toBe("TP 40.9% · 0.045 BTC · LEFT 45.5%");
  expect(getPendingOrderLabelText({ ...drawing, orderDisplayReduce: undefined }, 1)).toBe(
    "TP · 0.045 BTC",
  );
});
