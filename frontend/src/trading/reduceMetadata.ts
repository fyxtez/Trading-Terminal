/**
 * Reduce-only limit orders encode their intended reduce percentage (and,
 * for newer orders, the remaining position percentage after they fill)
 * directly into the Binance clientOrderId, since Binance itself has
 * nowhere else to store that metadata. Both the chart (drawing labels /
 * tooltips) and the Open Orders table need to parse it back out, so it
 * lives here once instead of two private copies quietly drifting apart.
 *
 * Formats handled:
 *   fe-red-<reducePct>-l<remainingPct>-...   (current)
 *   fe-red-<reducePct>-...                   (legacy, no remainingPct)
 */
import type { OpenOrder } from "./api/orders";
import type { OpenPosition } from "./api/positions";

export type ReduceMetadata = {
  reducePct?: number;
  remainingPct?: number;
};

/** Display percentages use the current position rather than historical sizing
 * instructions. LEFT assumes limit TPs fill in price order. */
export function getLiveReduceMetadata(
  order: OpenOrder,
  orders: OpenOrder[],
  position: Pick<OpenPosition, "symbol" | "side" | "quantity"> | null | undefined,
): ReduceMetadata {
  if (!position || position.symbol.toUpperCase() !== order.symbol.toUpperCase()) return {};
  const quantity = Math.abs(position.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return {};
  const side = position.side === "LONG" ? "SELL" : "BUY";
  const targets = orders
    .filter(
      (item) =>
        item.symbol.toUpperCase() === position.symbol.toUpperCase() &&
        item.side === side &&
        item.reduceOnly &&
        (item.type === "LIMIT" || item.origType === "LIMIT"),
    )
    .sort(
      (a, b) =>
        (Number(a.price) - Number(b.price)) * (side === "SELL" ? 1 : -1) ||
        a.orderId.localeCompare(b.orderId),
    );
  const index = targets.findIndex((item) => item.orderId === order.orderId);
  if (index < 0) return {};
  const sizes = targets
    .slice(0, index + 1)
    .map((item) => Math.max(0, Number(item.origQty) - Number(item.executedQty || 0)));
  if (sizes.some((size) => !Number.isFinite(size))) return {};
  const percent = (size: number) => Number(((size / quantity) * 100).toFixed(1));
  return {
    reducePct: percent(sizes[index]),
    remainingPct: percent(Math.max(0, quantity - sizes.reduce((sum, size) => sum + size, 0))),
  };
}

export function parseReduceMetadata(clientOrderId?: string | null): ReduceMetadata {
  if (!clientOrderId) return {};

  const match = /^fe-red-(\d{1,3})-l(\d{1,3})-/.exec(clientOrderId);
  if (match) {
    const reducePct = Number(match[1]);
    const remainingPct = Number(match[2]);

    return {
      reducePct:
        Number.isFinite(reducePct) && reducePct >= 1 && reducePct <= 100 ? reducePct : undefined,
      remainingPct:
        Number.isFinite(remainingPct) && remainingPct >= 0 && remainingPct <= 100
          ? remainingPct
          : undefined,
    };
  }

  // Backwards compatibility for reduce orders created by the previous build.
  const legacy = /^fe-red-(\d{1,3})-/.exec(clientOrderId);
  if (!legacy) return {};

  const reducePct = Number(legacy[1]);
  return {
    reducePct:
      Number.isFinite(reducePct) && reducePct >= 1 && reducePct <= 100 ? reducePct : undefined,
  };
}
