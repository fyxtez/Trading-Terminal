/** Keep at least four significant digits for sub-unit prices. Symbol settings
 * remain the minimum precision, and exchange tick sizes are applied separately. */
export function chartPricePrecision(
  configured: number,
  candles: readonly { open: number; high: number; low: number; close: number }[],
): number {
  let smallest = Infinity;
  for (const candle of candles) {
    for (const price of [candle.open, candle.high, candle.low, candle.close]) {
      if (Number.isFinite(price) && price > 0) smallest = Math.min(smallest, price);
    }
  }
  if (smallest >= 1) return configured;
  return Math.max(configured, Math.min(16, 3 - Math.floor(Math.log10(smallest))));
}
