import type { UTCTimestamp } from "lightweight-charts";
import type { TradeMarker } from "../trading/types";
import { tradeMarkersStorageKey } from "../config/constants";

export const TRADE_MARKER_LIFETIME_MS = 3 * 24 * 60 * 60 * 1000;

function getTradeMarkerCreatedAt(marker: TradeMarker): number | null {
  if (
    typeof marker.createdAt === "number" &&
    Number.isFinite(marker.createdAt) &&
    marker.createdAt > 0
  ) {
    return marker.createdAt;
  }

  /*
   * Backward compatibility for markers saved before `createdAt` existed.
   * Their exchange fill time is stored in Unix seconds.
   */
  const fillTimeMs = Number(marker.time) * 1000;

  return Number.isFinite(fillTimeMs) && fillTimeMs > 0
    ? fillTimeMs
    : null;
}

function isValidTradeMarker(value: unknown): value is TradeMarker {
  if (typeof value !== "object" || value === null) return false;

  const marker = value as Partial<TradeMarker>;

  return (
    typeof marker.id === "string" &&
    marker.id.length > 0 &&
    Number.isFinite(Number(marker.time)) &&
    Number.isFinite(marker.price) &&
    (marker.side === "BUY" || marker.side === "SELL")
  );
}

export function filterActiveTradeMarkers(
  markers: TradeMarker[],
  now = Date.now(),
): TradeMarker[] {
  return markers
    .filter(isValidTradeMarker)
    .filter((marker) => {
      const createdAt = getTradeMarkerCreatedAt(marker);

      return (
        createdAt !== null &&
        createdAt <= now &&
        now - createdAt < TRADE_MARKER_LIFETIME_MS
      );
    })
    .map((marker) => ({
      ...marker,
      // Migrate old stored markers the next time localStorage is saved.
      createdAt: getTradeMarkerCreatedAt(marker) ?? undefined,
    }));
}

export function millisecondsUntilNextTradeMarkerExpiry(
  markers: TradeMarker[],
  now = Date.now(),
): number | null {
  let earliestExpiry: number | null = null;

  for (const marker of markers) {
    const createdAt = getTradeMarkerCreatedAt(marker);

    if (createdAt === null) continue;

    const expiresAt = createdAt + TRADE_MARKER_LIFETIME_MS;

    if (earliestExpiry === null || expiresAt < earliestExpiry) {
      earliestExpiry = expiresAt;
    }
  }

  if (earliestExpiry === null) return null;

  // Browsers clamp very large delays; three days is safely below that limit.
  return Math.max(0, earliestExpiry - now + 1);
}

export function loadStoredTradeMarkers(storageKey: string): TradeMarker[] {
  try {
    const raw = localStorage.getItem(storageKey);

    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    return parsed.filter(isValidTradeMarker);
  } catch (error) {
    console.error("Failed to load trade markers", error);
    return [];
  }
}

export function saveTradeMarkers(storageKey: string, markers: TradeMarker[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(markers));
  } catch (error) {
    console.error("Failed to save trade markers", error);
  }
}

/**
 * Records a marker for `symbol` directly in its own localStorage-backed
 * marker list, regardless of which symbol's chart is currently on screen.
 *
 * FIX: useTradeMarkers.ts's addMarkerNow only ever writes into whichever
 * symbol its own hook instance is bound to - the chart's *currently
 * displayed* symbol. So closing a position for a symbol you weren't
 * actively looking at (e.g. an ETH position closed via "Close Everything
 * FULL" while the BTC chart was open) never got a marker recorded at all,
 * anywhere: addMarkerNow can't write for the not-currently-active symbol,
 * and the guard in App.tsx correctly refuses to call it with the wrong
 * symbol in the first place (calling it anyway would have mislabeled the
 * fill as having happened on the wrong chart).
 *
 * This writes straight to storage instead of through the live hook, so it
 * works for any symbol at any time. useTradeMarkers already re-reads
 * storage every time its own symbol changes (see its `loadMarkers` effect
 * keyed on `normalizedSymbol`), so switching the chart to `symbol` later
 * picks this up automatically - no live/in-memory update needed here.
 */
export function appendTradeMarkerForSymbol(
  symbol: string,
  fill: { id?: string; time: number; price: number; side: TradeMarker["side"] },
): void {
  if (!Number.isFinite(fill.time) || !Number.isFinite(fill.price)) return;

  const storageKey = tradeMarkersStorageKey(symbol.toUpperCase());
  const existing = filterActiveTradeMarkers(loadStoredTradeMarkers(storageKey));
  const id = fill.id ?? crypto.randomUUID();

  if (existing.some((marker) => marker.id === id)) return;

  const next = filterActiveTradeMarkers([
    ...existing,
    {
      id,
      time: fill.time as UTCTimestamp,
      price: fill.price,
      side: fill.side,
      createdAt: Date.now(),
    },
  ]);

  saveTradeMarkers(storageKey, next);
}
