/**
 * The full stop-loss (STOP_MARKET, closePosition) is a Binance
 * "conditional" order rather than a regular LIMIT/MARKET one - it's
 * placed via /api/orders/stop-market and cancelled via
 * /api/orders/algo/{symbol}/{algoId}, a separate code path from
 * /api/orders/open (which only ever returns regular orders). Binance
 * itself counts a working stop-loss as an open order; our own Open
 * Orders tab must therefore track it separately and merge it in - see
 * PositionsPanel.tsx.
 *
 * This module is shared so both PositionBracketOverlay (which writes it,
 * right after a successful placement) and PositionsPanel (which needs to
 * read it, to include it in the Open Orders list/count) stay in sync
 * against the exact same storage key and shape instead of two copies
 * quietly drifting apart.
 *
 * FIX: `symbol` used to default to DEFAULT_SYMBOL ("BTCUSDT") when a
 * caller forgot to pass it explicitly. That silent fallback is exactly
 * what let PositionBracketOverlay's `saveStop(null)` call (clearing the
 * stop on position close) quietly clear/act on the WRONG symbol's saved
 * stop for every symbol other than BTCUSDT - it happened to "work" only
 * because BTCUSDT is also the default. `symbol` is now a required
 * parameter for both save and load, so a stray caller like that one is a
 * compile error instead of a silent per-symbol data bug.
 */
export type SavedStop = {
  symbol: string;
  side: "BUY" | "SELL";
  triggerPrice: number;
  /** Kept as a string, not number - see safeJson.ts's parseOrderJsonText. */
  algoId: string;
};

const STOP_STORAGE_PREFIX = "fyxtez:full-stop:";

export function stopStorageKey(symbol: string): string {
  return `${STOP_STORAGE_PREFIX}${symbol.toUpperCase()}`;
}

export function loadSavedStop(symbol: string): SavedStop | null {
  try {
    const raw = localStorage.getItem(stopStorageKey(symbol));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as SavedStop;
    if (
      parsed.symbol !== symbol.toUpperCase() ||
      !Number.isFinite(parsed.triggerPrice) ||
      typeof parsed.algoId !== "string" ||
      parsed.algoId.length === 0
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function saveStop(stop: SavedStop | null, symbol: string): void {
  if (!stop) {
    localStorage.removeItem(stopStorageKey(symbol));
    return;
  }

  localStorage.setItem(stopStorageKey(stop.symbol), JSON.stringify(stop));
}
