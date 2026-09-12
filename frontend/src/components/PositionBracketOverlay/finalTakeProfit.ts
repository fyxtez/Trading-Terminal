import type { OpenOrder } from "../../trading/api/orders";
import type { OpenPosition } from "../../trading/api/positions";

/** Unreserved position size, matching the backend's LIMIT REDUCE calculation. */
export function finalTakeProfitRemainder(
  position: OpenPosition,
  orders: OpenOrder[],
): number | null {
  const quantity = Math.abs(position.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const side = position.side === "LONG" ? "SELL" : "BUY";
  let reserved = 0;
  for (const order of orders) {
    if (
      order.symbol.toUpperCase() !== position.symbol.toUpperCase() ||
      order.side !== side ||
      !order.reduceOnly
    )
      continue;
    const original = Number(order.origQty),
      executed = Number(order.executedQty);
    if (!Number.isFinite(original) || !Number.isFinite(executed)) return null;
    reserved += Math.max(0, original - executed);
  }
  return Math.max(0, Math.min(100, ((quantity - reserved) / quantity) * 100));
}
