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
export type ReduceMetadata = {
  reducePct?: number;
  remainingPct?: number;
};

export function parseReduceMetadata(
  clientOrderId?: string | null,
): ReduceMetadata {
  if (!clientOrderId) return {};

  const match = /^fe-red-(\d{1,3})-l(\d{1,3})-/.exec(clientOrderId);
  if (match) {
    const reducePct = Number(match[1]);
    const remainingPct = Number(match[2]);

    return {
      reducePct:
        Number.isFinite(reducePct) && reducePct >= 1 && reducePct <= 100
          ? reducePct
          : undefined,
      remainingPct:
        Number.isFinite(remainingPct) &&
        remainingPct >= 0 &&
        remainingPct <= 100
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
      Number.isFinite(reducePct) && reducePct >= 1 && reducePct <= 100
        ? reducePct
        : undefined,
  };
}
