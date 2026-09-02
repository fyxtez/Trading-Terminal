import type { UTCTimestamp } from "lightweight-charts";

export type OrderSide = "BUY" | "SELL";

// Kept as an alias: the trade menu UI thinks in terms of "which side did
// the trader click", which is exactly what the backend's `side` field is.
export type TradeSide = OrderSide;
export type TradeOrderType = "MARKET" | "LIMIT";

export interface MarketOrderRequest {
  symbol: string;
  side: OrderSide;
  quantity: number | null;
  auto_size: boolean;
  stop_loss: number | null;
  leverage: number | null;
  reduce_only: boolean;
  client_order_id: string | null;
}


export interface AutoMarketOrderRequest {
  symbol: string;
  side: OrderSide;
  stop_loss: number;
}

export type AutoMarketOrderResponse = {
  symbol: string;
  side: OrderSide;
  stop_loss: number;
  entry_reference_price: number;
  stop_distance: number;
  stop_distance_pct: number;
  margin_pct: number;
  margin_used: number;
  theoretical_max_leverage: number;
  safe_stop_leverage: number;
  exchange_max_leverage: number;
  applied_leverage: number;
  submitted_quantity: number;
  notional: number;
  estimated_loss_at_stop: number;
  client_order_id: string;
  stop_order_created: boolean;
  order: BinanceOrderResponse;
};

export interface LimitOrderRequest {
  symbol: string;
  side: OrderSide;
  price: number;
  quantity: number | null;
  auto_size: boolean;
  stop_loss: number | null;
  leverage: number | null;
  reduce_only: boolean;
  time_in_force: "GTC" | "IOC" | "FOK" | "GTX";
  client_order_id: string | null;
}

export type BinanceOrderResponse = {
  /** Kept as a string, not number - see safeJson.ts's parseOrderJsonText. */
  orderId: string | null;
  symbol: string | null;
  status: string | null;
  clientOrderId: string | null;
  price: string | null;
  avgPrice: string | null;
  origQty: string | null;
  executedQty: string | null;
  updateTime?: number | null;
  transactTime?: number | null;
};

export type PlaceMarketOrderResponse = {
  submitted_quantity: number;
  applied_leverage: number | null;
  sizing: unknown;
  order: BinanceOrderResponse;
};

export type PlaceLimitOrderResponse = {
  submitted_quantity: number;
  submitted_price: number;
  applied_leverage: number | null;
  // FEATURE: backend-projected isolated liquidation for a resting entry LIMIT.
  // Binance has no official liquidationPrice until the order actually fills.
  estimated_liquidation_price: number | null;
  sizing: unknown;
  order: BinanceOrderResponse;
};

export type ModifyLimitOrderRequest = {
  side: OrderSide;
  quantity: number;
  price: number;
  time_in_force: "GTC" | "IOC" | "FOK" | "GTX";
};

export type ModifyLimitOrderResponse = {
  submitted_quantity: number;
  submitted_price: number;
  order: BinanceOrderResponse;
};

export type RepriceReduceOrderResponse = ModifyLimitOrderResponse & {
  old_order_id: string;
};

export type PendingLimitOrder = {
  orderId: string;
  clientOrderId: string | null;
  symbol: string;
  side: TradeSide;
  price: number;
  quantity: number;
  timeInForce: "GTC" | "IOC" | "FOK" | "GTX";
  intent?: "ENTRY" | "ADD" | "REDUCE";
  reducePct?: number;
  remainingPct?: number;
  // FEATURE: carry the pre-fill liquidation estimate into the chart order line.
  estimatedLiquidationPrice?: number;
};

export type MarketOrderFill = {
  id?: string;
  /**
   * Which symbol this fill actually belongs to (e.g. "BTCUSDT"). REQUIRED
   * as of this fix - see the comment on `addMarker` in
   * hooks/useTradeMarkers.ts for why. Every call site must supply the
   * real symbol the fill happened on, NOT assume it matches whatever the
   * chart currently shows - the whole point of this field is to let
   * addMarker verify that itself instead of trusting the caller.
   */
  symbol: string;
  side: TradeSide;
  /** Unix timestamp in seconds. */
  time: number;
  price: number;
};

export type TradeMenuState = {
  x: number;
  y: number;
  selectedPrice: number;
  marketPrice: number;
};

export type TradeToastState = {
  kind: "success" | "error" | "pending";
  message: string;
};

/**
 * A persistent "B" / "S" fill marker for a filled MARKET order.
 *
 * `time` is the exchange fill timestamp in Unix seconds and keeps the marker
 * aligned across chart timeframes. `createdAt` is wall-clock time in Unix
 * milliseconds and is used only for the fixed three-day retention period.
 *
 * `createdAt` is optional so markers saved by older app versions can still be
 * loaded and migrated using their fill timestamp.
 */
export type TradeMarker = {
  id: string;
  time: UTCTimestamp;
  price: number;
  side: TradeSide;
  createdAt?: number;
};



export type OrderExecutedEvent = {
  type: "ORDER_EXECUTED";
  event_id: string;
  symbol: string;
  side: TradeSide;
  order_type: string;
  order_status: string;
  /** Kept as a string, not number - see safeJson.ts's parseOrderJsonText. */
  order_id: string;
  trade_id: number | null;
  price: number;
  quantity: number;
  accumulated_quantity: number;
  event_time: number;
  transaction_time: number | null;
  reduce_only: boolean;
};


export type AlertTriggeredEvent = {
  type: "ALERT_TRIGGERED";
  id: string;
  symbol: string;
  price: number;
  trigger_price: number;
  side: "LONG" | "SHORT";
  pattern: string | null;
  triggered_at: number;
};

export type TradingStreamEvent =
  | OrderExecutedEvent
  | AlertTriggeredEvent
  | { type: "SNAPSHOT_REQUIRED"; reason: string }
  | { type: "STREAM_STATUS"; connected: boolean; message: string };
