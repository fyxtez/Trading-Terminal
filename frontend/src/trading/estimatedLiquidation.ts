import type { OrderSide } from "./types";

/**
 * FEATURE: frontend fallback for pending LIMIT liquidation preview.
 * The backend's Binance-bracket-aware estimate remains authoritative, but an
 * already-resting order (or an older backend response) may not carry that
 * transient field. In that degraded case we still show an EST. LIQ guide by
 * using the leverage bankruptcy distance; the EST. prefix makes clear that it
 * is a projection and not Binance's official post-fill liquidationPrice.
 */
export function estimatePendingLimitLiquidation(
  entryPrice: number,
  leverage: number,
  side: OrderSide,
): number | undefined {
  if (
    !Number.isFinite(entryPrice) ||
    entryPrice <= 0 ||
    !Number.isFinite(leverage) ||
    leverage <= 1
  ) {
    return undefined;
  }

  const distance = 1 / leverage;
  const estimate =
    side === "BUY"
      ? entryPrice * (1 - distance)
      : entryPrice * (1 + distance);

  return Number.isFinite(estimate) && estimate > 0 ? estimate : undefined;
}
