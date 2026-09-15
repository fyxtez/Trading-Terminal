import {
  ACCOUNT_ENDPOINT,
  CLOSE_POSITION_ENDPOINT,
  POSITION_REALIZED_PNL_ENDPOINT,
  POSITION_INTENT_ENDPOINT,
  TRADING_API_BASE_URL,
} from "../../config/constants";
import type { BinanceOrderResponse, TradeOrderType } from "../types";
import { parseOrderJsonText } from "./safeJson";
import { canUseTradingAccount } from "../../desktop/credentials";
import {
  financialMutationFingerprint,
  financialMutationHeaders,
  runFinancialMutation,
} from "./financialMutation";
import { tradingApiFetch, tradingApiHeaders } from "./http";
import { SnapshotCache, snapshotResponseError } from "./snapshotCache";

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
  intent: "ADD" | "REDUCE";
  orderType?: TradeOrderType;
  price?: number;
  reducePct?: number;
};

export type PositionIntentResponse = {
  intent: "ADD" | "REDUCE";
  order_type?: TradeOrderType;
  side: "BUY" | "SELL";
  submitted_quantity?: number;
  submitted_price?: number;
  closed_quantity?: number;
  remaining_quantity?: number;
  remaining_position_pct?: number;
  reduce_pct?: number;
  warning?: string;
  order?: BinanceOrderResponse;
  close_order?: BinanceOrderResponse;
};

function getHeaders(): Record<string, string> {
  return tradingApiHeaders({
    Accept: "application/json",
    "Content-Type": "application/json",
  });
}

function getMutationHeaders(intentId: string): Record<string, string> {
  return {
    ...getHeaders(),
    ...financialMutationHeaders(intentId, true),
  };
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
  const accountMargin = Math.abs(finite(position.initialMargin ?? position.initial_margin));
  const providedLeverage = finite(position.leverage);
  const derivedMargin = providedLeverage > 0 ? notional / providedLeverage : 0;
  const margin =
    positionMargin > 0 ? positionMargin : accountMargin > 0 ? accountMargin : derivedMargin;
  const unrealizedPnl = finite(position.unrealizedProfit);
  const markPrice = quantity > 0 ? notional / quantity : 0;
  const providedEntry = finite(position.entryPrice ?? position.entry_price);
  const calculatedEntry = markPrice - unrealizedPnl / signedQuantity;
  const liquidation = finite(position.liquidationPrice ?? position.liquidation_price);
  return {
    symbol: position.symbol,
    side: signedQuantity > 0 ? "LONG" : "SHORT",
    leverage:
      providedLeverage > 0
        ? Math.round(providedLeverage)
        : margin > 0
          ? Math.max(1, Math.round(notional / margin))
          : 1,
    quantity,
    // preserve Binance's live absolute notional for the Positions
    // SIZE column; this is more accurate than recomputing margin × leverage.
    size: notional,
    entry_price: providedEntry > 0 ? providedEntry : calculatedEntry,
    mark_price: markPrice,
    liquidation_price: liquidation > 0 ? liquidation : null,
    margin,
    unrealized_pnl: unrealizedPnl,
    // filled after account parsing by the separate userTrades lookup;
    // null explicitly means the backend could not prove the lifecycle boundary.
    realized_pnl: null,
    roi_pct: margin > 0 ? (unrealizedPnl / margin) * 100 : 0,
  };
}

const positionsCache = new SnapshotCache<OpenPosition[]>(3_500);
const realizedPnlCache = new SnapshotCache<{ key: string; payload: RealizedPnlResponse }>(60_000);

async function getRealizedPositionPnl(
  positions: OpenPosition[],
): Promise<RealizedPnlResponse | null> {
  if (!positions.length) {
    realizedPnlCache.invalidate();
    return null;
  }
  // Price/PNL ticks do not change a position's fill history. Refresh that
  // expensive enrichment when exposure changes, or once a minute as a backup.
  const key = positions
    .map(
      (position) =>
        `${position.symbol}:${position.side}:${position.quantity}:${position.entry_price}`,
    )
    .sort()
    .join("|");
  if (realizedPnlCache.peek()?.key !== key) realizedPnlCache.invalidate();
  try {
    const result = await realizedPnlCache.get(async () => {
      const response = await tradingApiFetch(
        `${TRADING_API_BASE_URL}${POSITION_REALIZED_PNL_ENDPOINT}`,
        { method: "GET", headers: getHeaders(), cache: "no-store" },
      );
      if (!response.ok) throw snapshotResponseError(response, await readError(response));
      return { key, payload: (await response.json()) as RealizedPnlResponse };
    });
    return result.payload;
  } catch {
    // History is display-only. Failure must not hide a live position.
    return null;
  }
}

export function invalidatePositionsCache(): void {
  positionsCache.invalidate();
  realizedPnlCache.invalidate();
}

export async function getPositions(signal?: AbortSignal, force = false): Promise<OpenPosition[]> {
  if (!canUseTradingAccount()) return [];
  return positionsCache.get(
    async () => {
      const response = await tradingApiFetch(`${TRADING_API_BASE_URL}${ACCOUNT_ENDPOINT}`, {
        method: "GET",
        headers: getHeaders(),
        cache: "no-store",
      });
      if (!response.ok) throw snapshotResponseError(response, await readError(response));
      const account = (await response.json()) as AccountResponse;
      const positions = (account.positions ?? [])
        .map(mapPosition)
        .filter((position): position is OpenPosition => position !== null);

      // Do not issue another positionRisk/history request when the account
      // read failed or confirmed that the account is flat.
      const realized = await getRealizedPositionPnl(positions);
      if (realized) {
        for (const position of positions) {
          const match = (realized.positions ?? []).find(
            (item) =>
              item.symbol.toUpperCase() === position.symbol.toUpperCase() &&
              (item.position_side === "BOTH" || item.position_side === position.side),
          );
          if (
            match?.complete &&
            match.realized_pnl !== null &&
            Number.isFinite(match.realized_pnl)
          ) {
            position.realized_pnl = match.realized_pnl;
          }
        }
      }
      return positions;
    },
    force,
    signal,
  );
}

export async function executePositionIntent(
  request: PositionIntentRequest,
  signal?: AbortSignal,
): Promise<PositionIntentResponse> {
  if (!canUseTradingAccount()) throw new Error("Connect Binance in Settings to trade");
  const payload = {
    symbol: request.symbol.toUpperCase(),
    intent: request.intent,
    order_type: request.orderType,
    price: request.price,
    reduce_pct: request.reducePct,
  };
  return runFinancialMutation(
    financialMutationFingerprint(POSITION_INTENT_ENDPOINT, payload),
    async (intentId) => {
      const response = await tradingApiFetch(`${TRADING_API_BASE_URL}${POSITION_INTENT_ENDPOINT}`, {
        method: "POST",
        headers: getMutationHeaders(intentId),
        body: JSON.stringify(payload),
        signal,
      });
      if (!response.ok) throw new Error(await readError(response));
      invalidatePositionsCache();
      return parseOrderJsonText(await response.text()) as PositionIntentResponse;
    },
  );
}

export async function closePositionMarket(
  symbol: string,
  signal?: AbortSignal,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const payload = { symbol: symbol.toUpperCase() };
  return runFinancialMutation(
    financialMutationFingerprint(CLOSE_POSITION_ENDPOINT, payload),
    async (intentId) => {
      const response = await tradingApiFetch(`${TRADING_API_BASE_URL}${CLOSE_POSITION_ENDPOINT}`, {
        method: "POST",
        headers: getMutationHeaders(intentId),
        body: JSON.stringify(payload),
        signal,
      });
      if (!response.ok) throw new Error(await readError(response));
      invalidatePositionsCache();
      return parseOrderJsonText(await response.text());
    },
  );
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
  const endpoint = "/api/account/close-everything";
  const payload = symbol ? { symbol } : {};
  return runFinancialMutation(financialMutationFingerprint(endpoint, payload), async (intentId) => {
    const response = await tradingApiFetch(`${TRADING_API_BASE_URL}${endpoint}`, {
      method: "POST",
      headers: getMutationHeaders(intentId),
      // Always send a real JSON object; omitting `symbol` retains the
      // original full-account close behavior.
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) throw new Error(await readError(response));
    invalidatePositionsCache();
    return parseOrderJsonText(await response.text()) as CloseEverythingResponse;
  });
}
