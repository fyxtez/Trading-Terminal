import {
  ACCOUNT_ENDPOINT,
  CLOSE_POSITION_ENDPOINT,
  POSITION_REALIZED_PNL_ENDPOINT,
  POSITION_INTENT_ENDPOINT,
  TRADING_API_BASE_URL,
  TRADING_API_TOKEN,
} from "../../config/constants";
import type { BinanceOrderResponse, TradeOrderType } from "../types";
import { parseOrderJsonText } from "./safeJson";
import { canUseTradingAccount } from "../../desktop/credentials";

export type PositionSide = "LONG" | "SHORT";

export type OpenPosition = {
  symbol: string;
  side: PositionSide;
  leverage: number;
  quantity: number;
  size: number;
  entry_price: number;
  mark_price: number;
  liquidation_price: number | null;
  margin: number;
  unrealized_pnl: number;
  realized_pnl: number | null;
  roi_pct: number;
};

type AccountPosition = {
  entryPrice?: string | null;
  entry_price?: string | null;
  initialMargin?: string | null;
  initial_margin?: string | null;
  positionInitialMargin?: string | null;
  position_initial_margin?: string | null;
  notional: string;
  positionAmt: string;
  symbol: string;
  unrealizedProfit: string;
  liquidationPrice?: string | null;
  liquidation_price?: string | null;
  leverage?: string | number | null;
};

type AccountResponse = { positions?: AccountPosition[] };
type RealizedPositionPnl = {
  symbol: string;
  position_side: "BOTH" | PositionSide;
  realized_pnl: number | null;
  complete: boolean;
};
type RealizedPnlResponse = { positions?: RealizedPositionPnl[] };
type ErrorResponse = { error?: unknown; message?: unknown };

export type PositionIntentRequest = {
  symbol: string;
  intent: "ADD" | "REDUCE" | "REVERSE";
  orderType?: TradeOrderType;
  price?: number;
  leverage?: number;
  reducePct?: number;
};

export type PositionIntentResponse = {
  intent: "ADD" | "REDUCE" | "REVERSE";
  order_type?: TradeOrderType;
  side: "BUY" | "SELL";
  submitted_quantity?: number;
  submitted_price?: number;
  closed_quantity?: number;
  opened_quantity?: number;
  remaining_quantity?: number;
  remaining_position_pct?: number;
  reduce_pct?: number;
  warning?: string;
  order?: BinanceOrderResponse;
  close_order?: BinanceOrderResponse;
  open_order?: BinanceOrderResponse;
};

function getHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (TRADING_API_TOKEN) {
    headers.Authorization = `Bearer ${TRADING_API_TOKEN}`;
  }
  return headers;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as ErrorResponse;
    if (typeof body.error === "string" && body.error.trim()) return body.error;
    if (typeof body.message === "string" && body.message.trim()) return body.message;
  } catch {}
  return `Request failed with HTTP ${response.status}`;
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/*
 * Binance can leave a floating-point "dust" remainder after a position is
 * fully closed (e.g. a 100% reduce-only fill leaving positionAmt at
 * something like 0.0000000000003 instead of an exact 0). That's still
 * technically > 0, so a naive `quantity <= 0` check treats it as a real,
 * still-open position - which is what let a closed position keep showing
 * up everywhere downstream (chart TP/SL zone, Positions tab, Open Orders)
 * even after Binance itself reported the position and its orders as gone.
 * Set comfortably below the smallest realistic order size (this app's own
 * default order size is 0.001 BTC) so no real position is ever mistaken
 * for dust, while any leftover from float rounding reliably is.
 */
const MIN_POSITION_QUANTITY = 1e-6;

function mapPosition(position: AccountPosition): OpenPosition | null {
  const signedQuantity = finite(position.positionAmt);
  const quantity = Math.abs(signedQuantity);
  if (quantity <= MIN_POSITION_QUANTITY) return null;
  const notional = Math.abs(finite(position.notional));
  const positionMargin = Math.abs(
    finite(position.positionInitialMargin ?? position.position_initial_margin),
  );
  const accountMargin = Math.abs(
    finite(position.initialMargin ?? position.initial_margin),
  );
  const providedLeverage = finite(position.leverage);
  const derivedMargin = providedLeverage > 0 ? notional / providedLeverage : 0;
  const margin =
    positionMargin > 0
      ? positionMargin
      : accountMargin > 0
        ? accountMargin
        : derivedMargin;
  const unrealizedPnl = finite(position.unrealizedProfit);
  const markPrice = quantity > 0 ? notional / quantity : 0;
  const providedEntry = finite(position.entryPrice ?? position.entry_price);
  const calculatedEntry = markPrice - unrealizedPnl / signedQuantity;
  const liquidation = finite(
    position.liquidationPrice ?? position.liquidation_price,
  );
  return {
    symbol: position.symbol,
    side: signedQuantity > 0 ? "LONG" : "SHORT",
    leverage: providedLeverage > 0 ? Math.round(providedLeverage) : margin > 0 ? Math.max(1, Math.round(notional / margin)) : 1,
    quantity,
    // FEATURE: preserve Binance's live absolute notional for the Positions
    // SIZE column; this is more accurate than recomputing margin × leverage.
    size: notional,
    entry_price: providedEntry > 0 ? providedEntry : calculatedEntry,
    mark_price: markPrice,
    liquidation_price: liquidation > 0 ? liquidation : null,
    margin,
    unrealized_pnl: unrealizedPnl,
    // FEATURE: filled after account parsing by the separate userTrades lookup;
    // null explicitly means the backend could not prove the lifecycle boundary.
    realized_pnl: null,
    roi_pct: margin > 0 ? (unrealizedPnl / margin) * 100 : 0,
  };
}

/*
 * FIX (redundant polling): usePositions.ts, useChartPositionPnl.ts, and
 * PositionBracketOverlay.tsx each run their own independent 4-second
 * self-heal poll against this same endpoint, unsynchronized with each
 * other (each starts whenever its own component happened to mount). At
 * the old 1-second TTL, those three staggered timers mostly missed this
 * cache and fired close to 3x the intended request rate. Widening it to
 * 3.5s means the passive self-heal polls now actually share one
 * request most of the time. Event-driven refreshes (the ones that fire
 * right after an action - closing a position, etc. - and need to
 * confirm the real state right now) explicitly pass force=true from
 * their own call sites specifically to bypass this cache, so this
 * widening only affects the passive background polling, not anything
 * that needs a guaranteed-fresh answer.
 */
const POSITIONS_CACHE_TTL_MS = 3_500;
const REALIZED_PNL_CACHE_TTL_MS = 15_000;
let cachedPositions: OpenPosition[] | null = null;
let cachedPositionsAt = 0;
let positionsInFlight: Promise<OpenPosition[]> | null = null;
let cachedRealizedPnl: RealizedPnlResponse | null = null;
let cachedRealizedPnlAt = 0;
let realizedPnlInFlight: Promise<RealizedPnlResponse | null> | null = null;
let realizedPnlRetryAfter = 0;

async function getRealizedPositionPnl(
  signal?: AbortSignal,
  force = false,
): Promise<RealizedPnlResponse | null> {
  const now = Date.now();
  // FIX: an older/not-yet-restarted backend returns 404 for the new endpoint.
  // Back off instead of filling DevTools and server logs every four seconds.
  if (now < realizedPnlRetryAfter) return null;
  if (!force && cachedRealizedPnl && now - cachedRealizedPnlAt < REALIZED_PNL_CACHE_TTL_MS) {
    return cachedRealizedPnl;
  }
  if (!signal && realizedPnlInFlight) return realizedPnlInFlight;

  // FIX: userTrades is materially heavier than account state. Cache this
  // enrichment independently so the 4s position self-heal does not repeatedly
  // reconstruct unchanged lifecycles; forced trade events still bypass it.
  const request = (async () => {
    try {
      const response = await fetch(
        `${TRADING_API_BASE_URL}${POSITION_REALIZED_PNL_ENDPOINT}`,
        { method: "GET", headers: getHeaders(), signal, cache: "no-store" },
      );
      if (!response.ok) {
        realizedPnlRetryAfter = Date.now() + (response.status === 404 ? 60_000 : 15_000);
        return null;
      }
      realizedPnlRetryAfter = 0;
      const payload = (await response.json()) as RealizedPnlResponse;
      cachedRealizedPnl = payload;
      cachedRealizedPnlAt = Date.now();
      return payload;
    } catch {
      return null;
    }
  })();

  if (signal) return request;
  realizedPnlInFlight = request;
  try {
    return await request;
  } finally {
    if (realizedPnlInFlight === request) realizedPnlInFlight = null;
  }
}

export function invalidatePositionsCache(): void {
  cachedPositions = null;
  cachedPositionsAt = 0;
  // FIX: fills that changed position size may also have realized PNL, so the
  // lifecycle cache must be invalidated together with the account snapshot.
  cachedRealizedPnl = null;
  cachedRealizedPnlAt = 0;
}

export async function getPositions(
  signal?: AbortSignal,
  force = false,
): Promise<OpenPosition[]> {
  if (!canUseTradingAccount()) return [];

  const now = Date.now();

  if (
    !force &&
    cachedPositions !== null &&
    now - cachedPositionsAt < POSITIONS_CACHE_TTL_MS
  ) {
    return cachedPositions;
  }

  // Every mounted consumer reads the same account endpoint. Share one request
  // instead of allowing the chart badge, bracket overlay, panel, and App to
  // create parallel /api/account calls for the same browser event.
  if (!signal && positionsInFlight) {
    return positionsInFlight;
  }

  const request = (async () => {
    // FIX: enrichment is shared and cosmetic; one component unmounting must
    // not abort the realized request used by every other positions consumer.
    const realizedRequest = getRealizedPositionPnl(undefined, force);
    const response = await fetch(`${TRADING_API_BASE_URL}${ACCOUNT_ENDPOINT}`, {
      method: "GET",
      headers: getHeaders(),
      signal,
      // FIX: account/position state is safety-critical live exchange state. Even
      // when our own small JS cache is explicitly bypassed, the browser/proxy
      // must never satisfy this request from an HTTP cache.
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await readError(response));
    const account = (await response.json()) as AccountResponse;
    const positions = (account.positions ?? [])
      .map(mapPosition)
      .filter((position): position is OpenPosition => position !== null);

    // FIX: realized PNL is enrichment, not a prerequisite for safety-critical
    // position rendering. A history failure leaves `—` instead of hiding rows.
    const realized = await realizedRequest;
    if (realized) {
      for (const position of positions) {
        const match = (realized.positions ?? []).find(
          (item) => item.symbol.toUpperCase() === position.symbol.toUpperCase()
            && (item.position_side === "BOTH" || item.position_side === position.side),
        );
        if (match?.complete && match.realized_pnl !== null && Number.isFinite(match.realized_pnl)) {
          position.realized_pnl = match.realized_pnl;
        }
      }
    }

    cachedPositions = positions;
    cachedPositionsAt = Date.now();
    return positions;
  })();

  if (signal) return request;

  positionsInFlight = request;
  try {
    return await request;
  } finally {
    if (positionsInFlight === request) positionsInFlight = null;
  }
}

export async function executePositionIntent(
  request: PositionIntentRequest,
  signal?: AbortSignal,
): Promise<PositionIntentResponse> {
  if (!canUseTradingAccount()) throw new Error("Connect Binance in Settings to trade");

  const response = await fetch(`${TRADING_API_BASE_URL}${POSITION_INTENT_ENDPOINT}`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      symbol: request.symbol.toUpperCase(),
      intent: request.intent,
      order_type: request.orderType,
      price: request.price,
      leverage: request.leverage,
      reduce_pct: request.reducePct,
    }),
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  invalidatePositionsCache();
  return parseOrderJsonText(await response.text()) as PositionIntentResponse;
}

export async function closePositionMarket(
  symbol: string,
  signal?: AbortSignal,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const response = await fetch(`${TRADING_API_BASE_URL}${CLOSE_POSITION_ENDPOINT}`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ symbol: symbol.toUpperCase() }),
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  invalidatePositionsCache();
  return parseOrderJsonText(await response.text());
}



export type CloseEverythingResponse = {
  completed: boolean;
  cancelled_symbols: string[];
  closed_positions: Array<{
    symbol: string;
    closed_quantity: number;
    side: "BUY" | "SELL";
    /** Real fill price for this specific closed position - null if Binance
     *  didn't return a usable avgPrice for some reason. Used to place an
     *  accurate trade marker even for a symbol that isn't the currently
     *  active chart - see appendTradeMarkerForSymbol in tradeMarkers.ts. */
    avg_price: number | null;
  }>;
  errors: Array<{
    stage: string;
    symbol: string;
    error: string;
  }>;
};

export async function closeEverything(
  symbol?: string,
  signal?: AbortSignal,
): Promise<CloseEverythingResponse> {
  const response = await fetch(
    `${TRADING_API_BASE_URL}/api/account/close-everything`,
    {
      method: "POST",
      headers: getHeaders(),
      // FIX: the backend now takes a Json<CloseEverythingRequest> extractor
      // (added to support scoping this down to one symbol - see its own
      // comment in api.rs) instead of no body at all, so a request with no
      // body/wrong content-type would now fail JSON extraction outright
      // regardless of what's being closed. Always send a real (possibly
      // empty) JSON object; omitting `symbol` entirely still means the
      // original full-account behavior.
      body: JSON.stringify(symbol ? { symbol } : {}),
      signal,
    },
  );

  if (!response.ok) throw new Error(await readError(response));
  invalidatePositionsCache();
  return parseOrderJsonText(await response.text()) as CloseEverythingResponse;
}
