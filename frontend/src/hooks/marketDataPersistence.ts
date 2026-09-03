import type { CandlestickData } from "lightweight-charts";
import { intervals, type Interval } from "../config/constants";

const INTERVAL_STORAGE_KEY = "fyxtez:chart-intervals-by-symbol";
const VIEWPORT_STORAGE_KEY = "fyxtez:chart-viewports-by-symbol-interval";

export type SavedChartViewport = {
  /** Visible logical range relative to the latest loaded candle. */
  xFromOffset: number;
  xToOffset: number;
  /** Exact visible price range. */
  yFrom: number;
  yTo: number;
};

type SavedChartViewports = Record<string, SavedChartViewport>;
type SavedIntervalsBySymbol = Record<string, Interval>;

function normalizeSymbolKey(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function viewportStorageId(symbol: string, interval: Interval): string {
  return `${normalizeSymbolKey(symbol)}:${interval}`;
}

function loadSavedViewports(): SavedChartViewports {
  try {
    const raw = localStorage.getItem(VIEWPORT_STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const valid: SavedChartViewports = {};

    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;

      const candidate = value as Partial<SavedChartViewport>;
      const numbers = [candidate.xFromOffset, candidate.xToOffset, candidate.yFrom, candidate.yTo];

      if (numbers.every((number) => typeof number === "number" && Number.isFinite(number))) {
        const viewport = candidate as SavedChartViewport;
        if (viewport.xToOffset > viewport.xFromOffset && viewport.yTo > viewport.yFrom) {
          valid[key] = viewport;
        }
      }
    }

    return valid;
  } catch {
    return {};
  }
}

export function loadSavedViewport(symbol: string, interval: Interval): SavedChartViewport | null {
  return loadSavedViewports()[viewportStorageId(symbol, interval)] ?? null;
}

export function saveViewportToStorage(
  symbol: string,
  interval: Interval,
  viewport: SavedChartViewport,
): void {
  try {
    const saved = loadSavedViewports();
    saved[viewportStorageId(symbol, interval)] = viewport;
    localStorage.setItem(VIEWPORT_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Viewport persistence is a convenience only; chart interactions must keep working.
  }
}

export function savedViewportShowsCandles(
  viewport: SavedChartViewport,
  candles: CandlestickData[],
): boolean {
  const lastIndex = candles.length - 1;
  if (lastIndex < 0) return false;

  const visibleFrom = lastIndex + viewport.xFromOffset;
  const visibleTo = lastIndex + viewport.xToOffset;
  const firstCandleIndex = Math.max(0, Math.ceil(visibleFrom));
  const lastCandleIndex = Math.min(lastIndex, Math.floor(visibleTo));

  if (firstCandleIndex > lastCandleIndex) return false;

  // A persisted Y range can become stale while a symbol is hidden, and a
  // persisted X range can point entirely into empty future space. Restore it
  // only when at least one candle in the X window intersects the saved price.
  return candles
    .slice(firstCandleIndex, lastCandleIndex + 1)
    .some((candle) => candle.high >= viewport.yFrom && candle.low <= viewport.yTo);
}

function loadSavedIntervals(): SavedIntervalsBySymbol {
  try {
    const saved = localStorage.getItem(INTERVAL_STORAGE_KEY);
    if (!saved) return {};

    const parsed = JSON.parse(saved) as Record<string, unknown>;
    const valid: SavedIntervalsBySymbol = {};

    for (const [savedSymbol, value] of Object.entries(parsed)) {
      if (typeof value === "string" && intervals.includes(value as Interval)) {
        valid[normalizeSymbolKey(savedSymbol)] = value as Interval;
      }
    }

    return valid;
  } catch {
    // localStorage can be unavailable/corrupt in restricted browser contexts.
    return {};
  }
}

export function loadSavedInterval(symbol: string): Interval {
  return loadSavedIntervals()[normalizeSymbolKey(symbol)] ?? "1m";
}

export function saveInterval(symbol: string, interval: Interval): void {
  try {
    const saved = loadSavedIntervals();
    saved[normalizeSymbolKey(symbol)] = interval;
    localStorage.setItem(INTERVAL_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // The chart still works; this preference simply will not persist.
  }
}
