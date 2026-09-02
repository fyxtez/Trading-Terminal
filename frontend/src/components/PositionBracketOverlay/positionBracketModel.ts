import type { UTCTimestamp } from "lightweight-charts";
import type { OpenPosition } from "../../trading/api/positions";

export type ZonePad = {
  rightSeconds: number | null;
};

export const STOP_LABEL_COLLISION_THRESHOLD_PX = 34;
export const BREAK_EVEN_SNAP_THRESHOLD_PX = 8;

export function priceBoundaryEpsilon(pricePrecision: number): number {
  return 10 ** -Math.max(0, pricePrecision);
}

export const OPTIMISTIC_TAKE_PROFIT_TIMEOUT_MS = 8_000;
export const MESSAGE_AUTO_DISMISS_MS = 4_000;
const DEFAULT_BRACKET_DISTANCE_PCT = 0.005;
export const DEFAULT_ZONE_RIGHT_PAD_PX = 220;
export const ZONE_EDGE_HANDLE_WIDTH_PX = 6;
export const ENTRY_MARKER_LOOKBACK_SECONDS = 120;

const POSITION_ANCHOR_STORAGE_PREFIX = "fyxtez:position-anchor-v2:";
const POSITION_ZONE_PAD_STORAGE_PREFIX = "fyxtez:position-zone-pad-v1:";

type SavedPositionAnchor = {
  symbol: string;
  side: "LONG" | "SHORT";
  time: number;
};

type SavedPositionZonePad = {
  symbol: string;
  side: "LONG" | "SHORT";
  anchorTime: number;
  rightSeconds: number;
};

function positionAnchorStorageKey(symbol: string): string {
  return `${POSITION_ANCHOR_STORAGE_PREFIX}${symbol.toUpperCase()}`;
}

export function loadPositionAnchor(
  symbol: string,
  side: "LONG" | "SHORT",
): UTCTimestamp | null {
  try {
    const raw = localStorage.getItem(positionAnchorStorageKey(symbol));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<SavedPositionAnchor>;
    const time = Number(parsed.time);
    if (
      parsed.symbol !== symbol.toUpperCase() ||
      parsed.side !== side ||
      !Number.isFinite(time) ||
      time <= 0
    ) {
      return null;
    }

    return time as UTCTimestamp;
  } catch {
    return null;
  }
}

export function savePositionAnchor(
  symbol: string,
  side: "LONG" | "SHORT",
  time: UTCTimestamp,
): void {
  const value: SavedPositionAnchor = {
    symbol: symbol.toUpperCase(),
    side,
    time: Number(time),
  };
  localStorage.setItem(positionAnchorStorageKey(symbol), JSON.stringify(value));
}

export function clearPositionAnchor(symbol: string): void {
  localStorage.removeItem(positionAnchorStorageKey(symbol));
}

function positionZonePadStorageKey(symbol: string): string {
  return `${POSITION_ZONE_PAD_STORAGE_PREFIX}${symbol.toUpperCase()}`;
}

export function loadPositionZonePad(
  symbol: string,
  side: "LONG" | "SHORT",
  anchorTime: UTCTimestamp | null,
): ZonePad | null {
  if (anchorTime == null) return null;

  try {
    const raw = localStorage.getItem(positionZonePadStorageKey(symbol));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<SavedPositionZonePad>;
    const savedAnchorTime = Number(parsed.anchorTime);
    const rightSeconds = Number(parsed.rightSeconds);
    if (
      parsed.symbol !== symbol.toUpperCase() ||
      parsed.side !== side ||
      savedAnchorTime !== Number(anchorTime) ||
      !Number.isFinite(rightSeconds) ||
      rightSeconds < 0
    ) {
      return null;
    }

    return { rightSeconds };
  } catch {
    return null;
  }
}

export function savePositionZonePad(
  symbol: string,
  side: "LONG" | "SHORT",
  anchorTime: UTCTimestamp | null,
  rightSeconds: number | null,
): void {
  if (
    anchorTime == null ||
    rightSeconds == null ||
    !Number.isFinite(rightSeconds)
  ) {
    return;
  }

  const value: SavedPositionZonePad = {
    symbol: symbol.toUpperCase(),
    side,
    anchorTime: Number(anchorTime),
    rightSeconds,
  };
  localStorage.setItem(
    positionZonePadStorageKey(symbol),
    JSON.stringify(value),
  );
}

export function clearPositionZonePad(symbol: string): void {
  localStorage.removeItem(positionZonePadStorageKey(symbol));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getDefaultBracketPrices(position: OpenPosition): {
  takeProfit: number;
  stopLoss: number;
} {
  const distance = position.entry_price * DEFAULT_BRACKET_DISTANCE_PCT;
  return position.side === "LONG"
    ? {
        takeProfit: position.entry_price + distance,
        stopLoss: position.entry_price - distance,
      }
    : {
        takeProfit: position.entry_price - distance,
        stopLoss: position.entry_price + distance,
      };
}

export function formatRMultiple(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—R";
  const rounded = value
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1");
  return `${rounded}R`;
}
