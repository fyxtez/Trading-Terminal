import {
  AUTO_MARKET_ORDER_ENDPOINT,
  LIMIT_ORDER_ENDPOINT,
  MARKET_ORDER_ENDPOINT,
  TRADING_API_BASE_URL,
  TRADING_API_TOKEN,
} from "../../config/constants";
import type {
  AutoMarketOrderRequest,
  AutoMarketOrderResponse,
  LimitOrderRequest,
  MarketOrderRequest,
  ModifyLimitOrderRequest,
  ModifyLimitOrderResponse,
  RepriceReduceOrderResponse,
  OrderSide,
  PlaceLimitOrderResponse,
  PlaceMarketOrderResponse,
} from "../types";
import { parseOrderJsonText } from "./safeJson";
import { canUseTradingAccount } from "../../desktop/credentials";

async function parseTradingResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type");
  const isJson = contentType?.includes("application/json") ?? false;

  // FIX (the actual cause behind every "-2011 Unknown order sent"/"order
  // not found" mystery in this app): see parseOrderJsonText's own big
  // comment - plain `response.json()` silently corrupts large Binance
  // order ids via JS's IEEE-754 number type.
  const body: any = isJson
    ? await parseOrderJsonText(await response.text())
    : { error: await response.text() };

  if (!response.ok) {
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : `Request failed with status ${response.status}`,
    );
  }

  return body as T;
}

async function postBinanceOrder<T>(
  endpoint: string,
  payload: unknown,
): Promise<T> {
  if (!canUseTradingAccount()) throw new Error("Connect Binance in Settings to trade");

  const response = await fetch(`${TRADING_API_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TRADING_API_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  return parseTradingResponse<T>(response);
}

export type PlaceMarketOrderInput = {
  symbol: string;
  side: OrderSide;
  leverage?: number;
};

export async function placeMarketOrder({
  symbol,
  side,
  leverage = 2,
}: PlaceMarketOrderInput): Promise<PlaceMarketOrderResponse> {
  const payload: MarketOrderRequest = {
    symbol: symbol.toUpperCase(),
    side,
    // FIX: manual entries previously sent a fixed-$50 quantity with
    // auto_size=false, bypassing Settings -> Margin percentage. Let the
    // backend use its authoritative balance/config snapshot so the selected
    // percentage means the same thing for MARKET, LIMIT, and AUTO MARKET.
    quantity: null,
    auto_size: true,
    stop_loss: null,
    leverage,
    reduce_only: false,
    client_order_id: `fe-market-${Date.now()}`,
  };

  return postBinanceOrder<PlaceMarketOrderResponse>(MARKET_ORDER_ENDPOINT, payload);
}

export type PlaceLimitOrderInput = {
  symbol: string;
  side: OrderSide;
  price: number;
  leverage?: number;
};

export async function placeLimitOrder({
  symbol,
  side,
  price,
  leverage = 2,
}: PlaceLimitOrderInput): Promise<PlaceLimitOrderResponse> {
  const payload: LimitOrderRequest = {
    symbol: symbol.toUpperCase(),
    side,
    price,
    // FIX: LIMIT entries use the same configured-margin backend path as
    // MARKET entries; their rounded limit price becomes the sizing reference.
    quantity: null,
    auto_size: true,
    stop_loss: null,
    leverage,
    reduce_only: false,
    time_in_force: "GTC",
    client_order_id:
      side === "BUY"
        ? `fe-entry-long-${Date.now()}`
        : `fe-entry-short-${Date.now()}`,
  };

  return postBinanceOrder<PlaceLimitOrderResponse>(LIMIT_ORDER_ENDPOINT, payload);
}


export type PlaceAutoMarketOrderInput = {
  symbol: string;
  side: OrderSide;
  stopLoss: number;
};

export async function placeAutoMarketOrder({
  symbol,
  side,
  stopLoss,
}: PlaceAutoMarketOrderInput): Promise<AutoMarketOrderResponse> {
  const payload: AutoMarketOrderRequest = {
    symbol: symbol.toUpperCase(),
    side,
    stop_loss: stopLoss,
  };

  return postBinanceOrder<AutoMarketOrderResponse>(
    AUTO_MARKET_ORDER_ENDPOINT,
    payload,
  );
}


export async function modifyLimitOrder(
  symbol: string,
  orderId: string,
  payload: ModifyLimitOrderRequest,
): Promise<ModifyLimitOrderResponse> {
  const response = await fetch(
    `${TRADING_API_BASE_URL}/api/orders/${encodeURIComponent(symbol.toUpperCase())}/${orderId}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TRADING_API_TOKEN}`,
      },
      body: JSON.stringify(payload),
    },
  );

  return parseTradingResponse<ModifyLimitOrderResponse>(response);
}

export async function repriceReduceOrder(
  symbol: string,
  orderId: string,
  payload: {
    price: number;
    client_order_id?: string;
    reduce_pct?: number;
  },
): Promise<RepriceReduceOrderResponse> {
  const response = await fetch(
    `${TRADING_API_BASE_URL}/api/orders/${encodeURIComponent(symbol.toUpperCase())}/${orderId}/reprice-reduce`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TRADING_API_TOKEN}`,
      },
      body: JSON.stringify(payload),
    },
  );

  const result = await parseTradingResponse<RepriceReduceOrderResponse>(response);
  invalidateOpenOrdersCache();
  return result;
}

export async function cancelOrder(
  symbol: string,
  orderId: string,
): Promise<unknown> {
  const response = await fetch(
    `${TRADING_API_BASE_URL}/api/orders/${encodeURIComponent(symbol.toUpperCase())}/${orderId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${TRADING_API_TOKEN}`,
      },
    },
  );

  const result = await parseTradingResponse<unknown>(response);
  invalidateOpenOrdersCache();
  return result;
}



export type OpenOrder = {
  /** Kept as a string, not number - see safeJson.ts's parseOrderJsonText. */
  orderId: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: string;
  origType: string;
  status: string;
  price: string;
  origQty: string;
  timeInForce: "GTC" | "IOC" | "FOK" | "GTX";
  executedQty: string;
  avgPrice: string;
  time: number;
  updateTime: number;
  reduceOnly: boolean;
};

/**
 * Fetches open orders. Pass a symbol to get just that symbol's orders
 * (used for the chart's own order-line rendering, which only ever cares
 * about the symbol currently on screen); omit it to get every open order
 * across the whole account (used by PositionsPanel's Open Orders tab,
 * which - like the Positions tab - should reflect the whole account, not
 * just whichever symbol happens to be selected on the chart right now).
 */
/*
 * FIX (redundant polling): same reasoning as POSITIONS_CACHE_TTL_MS in
 * positions.ts - widened from 1.5s so the self-heal poll in
 * useOpenOrders.ts (every 4s) actually benefits from this cache instead
 * of mostly missing it. Event-driven refreshes still pass force=true to
 * bypass this explicitly when they need a guaranteed-fresh answer.
 */
const OPEN_ORDERS_CACHE_TTL_MS = 3_500;
const openOrdersCache = new Map<string, { at: number; orders: OpenOrder[] }>();
const openOrdersInFlight = new Map<string, Promise<OpenOrder[]>>();

export function invalidateOpenOrdersCache(): void {
  openOrdersCache.clear();
}

export async function getOpenOrders(
  symbol?: string,
  signal?: AbortSignal,
  force = false,
): Promise<OpenOrder[]> {
  if (!canUseTradingAccount()) return [];

  const normalizedSymbol = symbol?.toUpperCase();
  const key = normalizedSymbol ?? "*";
  const cached = openOrdersCache.get(key);

  if (!force && cached && Date.now() - cached.at < OPEN_ORDERS_CACHE_TTL_MS) {
    return cached.orders;
  }

  // Never allow several React consumers/events to stack identical Binance
  // open-order requests while an earlier one is still pending.
  if (!signal) {
    const existing = openOrdersInFlight.get(key);
    if (existing) return existing;
  }

  const request = (async () => {
    const url = normalizedSymbol
      ? `${TRADING_API_BASE_URL}/api/orders/open?symbol=${encodeURIComponent(normalizedSymbol)}`
      : `${TRADING_API_BASE_URL}/api/orders/open`;

    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${TRADING_API_TOKEN}` },
      signal,
    });

    const orders = (await parseTradingResponse<OpenOrder[]>(response)).filter(
      (order) => order.status === "NEW" || order.status === "PARTIALLY_FILLED",
    );

    openOrdersCache.set(key, { at: Date.now(), orders });
    return orders;
  })();

  if (signal) return request;

  openOrdersInFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (openOrdersInFlight.get(key) === request) openOrdersInFlight.delete(key);
  }
}



export type UpdateReduceOrderResponse = {
  /** Kept as strings, not numbers - see safeJson.ts's parseOrderJsonText. */
  old_order_id: string;
  requested_reduce_pct?: number;
  reduce_pct: number;
  submitted_quantity: number;
  submitted_price: number;
  remaining_quantity: number;
  remaining_position_pct: number;
  order: {
    orderId?: string;
    clientOrderId?: string;
  };
};

export async function updateReduceOrder(
  symbol: string,
  orderId: string,
  reducePct: number,
): Promise<UpdateReduceOrderResponse> {
  const response = await fetch(
    `${TRADING_API_BASE_URL}/api/orders/${encodeURIComponent(symbol.toUpperCase())}/${orderId}/reduce`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TRADING_API_TOKEN}`,
      },
      body: JSON.stringify({ reduce_pct: reducePct }),
    },
  );

  const result = await parseTradingResponse<UpdateReduceOrderResponse>(response);
  invalidateOpenOrdersCache();
  return result;
}


export type ChaseLimitOrderResponse = {
  /** Kept as strings, not numbers - see safeJson.ts's parseOrderJsonText. */
  chased_order_id: string;
  side: OrderSide;
  remaining_quantity: number;
  market_order: {
    orderId?: string;
    symbol?: string;
    status?: string;
    avgPrice?: string;
    price?: string;
    executedQty?: string;
    origQty?: string;
    updateTime?: number | null;
    transactTime?: number | null;
  };
};

export async function chaseLimitOrder(
  symbol: string,
  orderId: string,
): Promise<ChaseLimitOrderResponse> {
  const response = await fetch(
    `${TRADING_API_BASE_URL}/api/orders/${encodeURIComponent(symbol.toUpperCase())}/${orderId}/chase`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TRADING_API_TOKEN}`,
      },
    },
  );

  const result = await parseTradingResponse<ChaseLimitOrderResponse>(response);
  invalidateOpenOrdersCache();
  return result;
}


export type FullStopLossResponse = {
  symbol: string;
  side: OrderSide;
  trigger_price: number;
  close_position: true;
  algo: {
    /** Kept as a string, not number - see safeJson.ts's parseOrderJsonText. */
    algoId?: string | null;
    clientAlgoId?: string | null;
    algoStatus?: string | null;
    symbol?: string | null;
  };
};

export async function placeFullStopLoss(input: {
  symbol: string;
  side: OrderSide;
  triggerPrice: number;
}): Promise<FullStopLossResponse> {
  return postBinanceOrder<FullStopLossResponse>(
    "/api/orders/stop-market",
    {
      symbol: input.symbol.toUpperCase(),
      side: input.side,
      trigger_price: input.triggerPrice,
      quantity: null,
      close_position: true,
      // FIX: our candles and stop-loss line are based on Binance contract/last price.
      // Triggering the protective stop from MARK_PRICE could leave the visible price
      // below the stop while Binance still considered the stop untouched, so use the
      // same CONTRACT_PRICE source that the trader actually sees on the chart.
      working_type: "CONTRACT_PRICE",
      client_algo_id: `fe-sl-full-${Date.now()}`,
    },
  );
}

export async function cancelConditionalOrder(
  symbol: string,
  algoId: string,
): Promise<unknown> {
  const response = await fetch(
    `${TRADING_API_BASE_URL}/api/orders/algo/${encodeURIComponent(
      symbol.toUpperCase(),
    )}/${algoId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${TRADING_API_TOKEN}`,
      },
    },
  );

  return parseTradingResponse<unknown>(response);
}
