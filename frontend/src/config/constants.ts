import type { UTCTimestamp } from "lightweight-charts";

/** Market-data/execution venue attached to each chart symbol. */
export type ExchangeSource = "binance" | "mexc";
export type MarketKind = "crypto" | "traditional";

export type SymbolConfig = {
  symbol: string;
  source: ExchangeSource;
  /** Exchange-native contract symbol used by the public market-data API. */
  sourceSymbol: string;
  /** Only Binance-backed chart symbols can execute orders for now. */
  executionEnabled: boolean;
  /** Cosmetic chart-axis precision; exchange filters still govern real orders. */
  chartDecimals: number;
  /** Protected majors cannot be removed from the backend registry. */
  protected?: boolean;
  /** Backend-derived asset class used for categories and safe icon handling. */
  marketKind?: MarketKind;
  /**
   * True only for the synthesized placeholder getSymbolConfig() returns
   * when a symbol isn't in the currently-connected backend's registry
   * (see getSymbolConfig below). Lets the UI (see
   * UnregisteredSymbolBanner) tell "not confirmed by this backend yet"
   * apart from a normal, fully-registered symbol.
   */
  unconfirmed?: boolean;
};

/** Built-in fallback registry used until /api/symbols is loaded. */
export let SYMBOL_CONFIGS: readonly SymbolConfig[] = [
  { symbol: "BTCUSDT", source: "binance", sourceSymbol: "BTCUSDT", executionEnabled: true, chartDecimals: 0, protected: true },
  { symbol: "ETHUSDT", source: "binance", sourceSymbol: "ETHUSDT", executionEnabled: true, chartDecimals: 0, protected: true },
  { symbol: "SOLUSDT", source: "binance", sourceSymbol: "SOLUSDT", executionEnabled: true, chartDecimals: 2, protected: true },
  { symbol: "XRPUSDT", source: "binance", sourceSymbol: "XRPUSDT", executionEnabled: true, chartDecimals: 4, protected: true },
  // FIX: Binance USD-M Futures now lists PLUMEUSDT and ZECUSDT, so route
  // both fallback configs through Binance and enable the same order path used
  // by the other Binance-backed symbols instead of leaving them MEXC/view-only.
  { symbol: "PLUMEUSDT", source: "binance", sourceSymbol: "PLUMEUSDT", executionEnabled: true, chartDecimals: 5 },
  { symbol: "ZECUSDT", source: "binance", sourceSymbol: "ZECUSDT", executionEnabled: true, chartDecimals: 2 },
  { symbol: "XAUUSDT", source: "binance", sourceSymbol: "XAUUSDT", executionEnabled: true, chartDecimals: 2, marketKind: "traditional" },
  { symbol: "XAGUSDT", source: "binance", sourceSymbol: "XAGUSDT", executionEnabled: true, chartDecimals: 2, marketKind: "traditional" },
];

// Keep the last known config for symbols that have just been removed from the
// backend registry. React may still render the old active symbol/tab for one
// render while state updates propagate. Without this cache, that transient
// render throws `Unsupported chart symbol` and crashes the whole app.
const KNOWN_SYMBOL_CONFIGS = new Map<string, SymbolConfig>(
  SYMBOL_CONFIGS.map((config) => [config.symbol, config]),
);

export type TradingSymbol = string;
export const DEFAULT_SYMBOL: TradingSymbol = "BTCUSDT";

export function replaceSymbolConfigs(configs: readonly SymbolConfig[]): void {
  SYMBOL_CONFIGS = [...configs];
  for (const config of configs) {
    KNOWN_SYMBOL_CONFIGS.set(config.symbol.toUpperCase(), config);
  }
}

export function getAvailableSymbols(): readonly TradingSymbol[] {
  return SYMBOL_CONFIGS.map((config) => config.symbol);
}

export function getSymbolConfig(symbol: string): SymbolConfig {
  const normalized = symbol.toUpperCase();
  const config =
    SYMBOL_CONFIGS.find((candidate) => candidate.symbol === normalized) ??
    KNOWN_SYMBOL_CONFIGS.get(normalized);

  if (config) return config;

  // FIX: this used to throw here, which crashed the whole app (no error
  // boundary) any time a symbol from an optimistically-restored tab/active
  // symbol (see useChartTabs/useSymbol - they now trust localStorage
  // immediately rather than waiting on the backend) hadn't been confirmed
  // by the backend registry yet - e.g. right after reload, before the
  // registry fetch resolves, or while the backend is briefly unreachable.
  // That's not actually "unsupported", just "not confirmed yet". Synthesize
  // a conservative, view-only placeholder instead: once the registry
  // genuinely loads, replaceSymbolConfigs() overwrites this entry with the
  // real config, and every consumer re-reads getSymbolConfig() fresh on
  // its next render, so this self-corrects with no special-casing needed
  // anywhere else.
  const placeholder: SymbolConfig = {
    symbol: normalized,
    source: "binance",
    sourceSymbol: normalized,
    executionEnabled: false,
    chartDecimals: 2,
    unconfirmed: true,
  };
  KNOWN_SYMBOL_CONFIGS.set(normalized, placeholder);
  return placeholder;
}

/**
 * True when `symbol` is only known through the placeholder getSymbolConfig()
 * synthesizes for a symbol the currently-connected backend hasn't confirmed
 * (see the comment above). Drives UnregisteredSymbolBanner.
 */
export const isSymbolUnconfirmed = (symbol: string): boolean =>
  getSymbolConfig(symbol).unconfirmed === true;

export const isExecutionEnabledForSymbol = (symbol: string): boolean =>
  getSymbolConfig(symbol).executionEnabled;

export const getChartDisplayDecimals = (symbol: string): number =>
  getSymbolConfig(symbol).chartDecimals;

export const DEFAULT_LINE_COLOR = "#60a5fa";
export const DEFAULT_BOX_COLOR = "#a78bfa";

/**
 * Drawings and trade markers are persisted PER SYMBOL, so switching from
 * BTC to SOL shows SOL's own saved drawings/markers instead of BTC's,
 * and saving while on SOL never overwrites BTC's data. These used to be
 * flat constants built once from a single hardcoded SYMBOL
 * (`drawings-${SYMBOL}`) - they're functions now so every symbol gets
 * its own key. See hooks/useDrawings.ts and hooks/useTradeMarkers.ts.
 */
export const drawingsStorageKey = (symbol: string): string =>
  `drawings-${symbol.toUpperCase()}`;

export const drawingSetsStorageKey = (symbol: string): string =>
  `drawing-sets-${symbol.toUpperCase()}`;

export const activeDrawingSetStorageKey = (symbol: string): string =>
  `active-drawing-set-${symbol.toUpperCase()}`;

export const tradeMarkersStorageKey = (symbol: string): string =>
  `trade-markers-v2-${symbol.toUpperCase()}`;

export const priceAlertsStorageKey = (symbol: string): string =>
  `price-alerts-${symbol.toUpperCase()}`;

/**
 * Used only for non-persistent, browser-owned alerts. Persistent alerts
 * are monitored and delivered by the backend.
 */
export const PENDING_LIMIT_LONG_COLOR = "#34d399";
export const PENDING_LIMIT_SHORT_COLOR = "#f04562";

export const LOCAL_TRADING_API_BASE_URL =
  import.meta.env.VITE_TRADING_LOCAL_API_URL ?? "http://127.0.0.1:8657";

export const REMOTE_TRADING_API_BASE_URL =
  import.meta.env.VITE_TRADING_API_URL ?? "https://terminal.fyxtez.com";

/** Current API target. It is intentionally remote-by-default. */
export let TRADING_API_BASE_URL = REMOTE_TRADING_API_BASE_URL;

export const TRADING_API_BASE_URL_CHANGED_EVENT =
  "trading-api-base-url-changed";

let tradingApiInitialization: Promise<string> | null = null;

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function selectTradingApiBaseUrl(nextUrl: string): string {
  const normalized = normalizeBaseUrl(nextUrl);
  if (normalized === TRADING_API_BASE_URL) return normalized;

  const previousUrl = TRADING_API_BASE_URL;
  TRADING_API_BASE_URL = normalized;
  console.info(
    `[trading-api] switched ${previousUrl} -> ${TRADING_API_BASE_URL}`,
  );
  window.dispatchEvent(
    new CustomEvent(TRADING_API_BASE_URL_CHANGED_EVENT, {
      detail: { previousUrl, nextUrl: TRADING_API_BASE_URL },
    }),
  );
  return normalized;
}

/**
 * Keep backend selection deterministic.
 *
 * FIX: the previous implementation auto-probed 127.0.0.1 and could race with
 * history/BFCache resume logic: one path selected the remote server and a later
 * local probe switched the whole app back to localhost. That is exactly why a
 * history restore failed while a hard reload worked. We no longer auto-select
 * localhost at runtime. The app always uses VITE_TRADING_API_URL (or the hosted
 * terminal default). Local development can still opt in explicitly by setting
 * VITE_TRADING_API_URL=http://127.0.0.1:8657 when starting/building the frontend.
 */
export function refreshTradingApiBaseUrl(): Promise<string> {
  return Promise.resolve(
    selectTradingApiBaseUrl(normalizeBaseUrl(REMOTE_TRADING_API_BASE_URL)),
  );
}

/** Select the configured backend once at app startup. */
export function initializeTradingApiBaseUrl(): Promise<string> {
  if (!tradingApiInitialization) {
    tradingApiInitialization = refreshTradingApiBaseUrl();
  }

  return tradingApiInitialization;
}

/**
 * Re-assert the configured backend after Chromium/Brave restores the page from
 * history/BFCache.
 */
export function refreshTradingApiBaseUrlAfterResume(): Promise<string> {
  // FIX: do this synchronously before returning the resolved Promise so resumed
  // hooks cannot send even one REST/WS request to a stale localhost module value.
  selectTradingApiBaseUrl(REMOTE_TRADING_API_BASE_URL);
  return Promise.resolve(TRADING_API_BASE_URL);
}

export const ACCOUNT_ENDPOINT = "/api/account";
// FEATURE: separate fill-history endpoint keeps current-position realized PNL
// distinct from Binance's account snapshot, which only contains unrealized PNL.
export const POSITION_REALIZED_PNL_ENDPOINT = "/api/positions/realized-pnl";
export const MARKET_ORDER_ENDPOINT = "/api/orders/market";
export const AUTO_MARKET_ORDER_ENDPOINT = "/api/orders/auto-market";
export const LIMIT_ORDER_ENDPOINT = "/api/orders/limit";
export const CLOSE_POSITION_ENDPOINT = "/api/orders/close-position";
export const POSITION_INTENT_ENDPOINT = "/api/positions/intent";
export const AVAILABLE_BALANCE_ENDPOINT = "/api/balance";
export const SIZING_ENDPOINT = "/api/sizing";
export const TRADING_WEBSOCKET_ENDPOINT = "/api/ws/trading";

/** Backend-persisted price alerts. */
export const PRICE_ALERTS_ENDPOINT = "/api/alerts";

/**
 * Manual LIMIT/MARKET/ADD orders in the trade menu have no quantity
 * input of their own - the app picks a default order size by targeting
 * this notional (in USDT), then rounds it to the selected symbol's own
 * step size and bumps it up if needed to clear that symbol's exchange
 * minimum notional (see computeDefaultOrderQuantity in
 * trading/api/exchangeInfo.ts, and where it's used in useTradeMenu.ts).
 *
 * This replaces the old DEFAULT_ORDER_QUANTITY = 0.001 (i.e. "always
 * trade 0.001 BTC"), which was fine for BTC alone (~$65 notional at the
 * time) but meaningless once other symbols were added: 0.001 ETH is
 * under $2, 0.001 SOL under $1, 0.001 XRP under a cent - all well under
 * Binance's $20 minimum notional. That's exactly the "-4164: Order's
 * notional must be no smaller than 20" rejection this replaces.
 */
export const DEFAULT_ORDER_NOTIONAL_USDT = 50;
export const DEFAULT_LEVERAGE = 2;

// "12h" added between "4h" and "1d" - Binance's futures kline endpoint
// accepts "12h" as a real interval string, so (same as "1w" before it)
// this slots straight into fetchKlines/fetchLatestKline/buildMarketStreamUrl
// in trading/api/marketData.ts with no changes needed there, and flows
// through Topbar's interval button row automatically since that's
// generated from this same array.
export const intervals = [
  "1m",
  "5m",
  "15m",
  "1h",
  "4h",
  "12h",
  "1d",
  "1w",
  "1M",
] as const;
export type Interval = (typeof intervals)[number];

/**
 * FIX (1M support): a calendar month isn't a fixed duration (28-31 days),
 * so "1M" here is a 30-day APPROXIMATION - this whole lookup table is
 * fundamentally a "fixed duration per interval" model, which is exactly
 * true for every other interval but never exactly true for a month.
 * Deliberately still using an approximation instead of restructuring
 * this into a real calendar-aware function, because everywhere this
 * table actually gets read only tolerates approximate values fine
 * (pagination chunking math in marketData.ts, the future-time-scale
 * cosmetic placeholder space, chart snap-to-grid tolerance, the
 * boundary-poke timer that schedules an extra poll near candle close -
 * all self-correct via their own existing safety nets or just don't need
 * day-level precision to begin with). The one place that DOES need to be
 * exactly right - the countdown badge you actually look at when a 1M
 * chart is active - does NOT use this table; see its own real
 * calendar-month math in useCandleCountdown.ts. Same reasoning applies
 * to alignTimeToInterval below, which also has its own real month-aware
 * case rather than using this approximation.
 */
export const intervalMs: Record<Interval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
  "1M": 30 * 24 * 60 * 60_000,
};

export const intervalSeconds: Record<Interval, number> = {
  "1m": 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "12h": 12 * 60 * 60,
  "1d": 24 * 60 * 60,
  "1w": 7 * 24 * 60 * 60,
  "1M": 30 * 24 * 60 * 60,
};

/**
 * Floors a UTC timestamp down to the most recent Monday 00:00 UTC - the
 * actual boundary Binance's own "1w" klines open on.
 *
 * A plain `Math.floor(seconds / (7*86400)) * (7*86400)` (the same
 * approach every other interval uses below) does NOT land on Mondays:
 * it aligns to whatever day of the week 1 Jan 1970 00:00 UTC was, which
 * is a Thursday, not a Monday. Every "1w" boundary computed that way
 * would be off from Binance's real weekly candle open by 3 days. This
 * reads the actual UTC calendar day instead of relying on epoch
 * arithmetic, so it's correct regardless of what day the epoch itself
 * happened to fall on.
 */
const alignToMondayUtc = (timeSeconds: number): number => {
  const daySeconds = 24 * 60 * 60;
  const startOfDay = Math.floor(timeSeconds / daySeconds) * daySeconds;

  // getUTCDay(): Sunday = 0, Monday = 1, ..., Saturday = 6. Converting to
  // "days since Monday" (Monday = 0, ..., Sunday = 6) makes the offset a
  // simple subtraction from the start of today.
  const dayOfWeek = new Date(startOfDay * 1000).getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;

  return startOfDay - daysSinceMonday * daySeconds;
};

/**
 * Floors a UTC timestamp down to the 1st of its own UTC calendar month,
 * 00:00:00 - the real boundary Binance's "1M" klines open on. Unlike
 * every other interval, a month genuinely isn't a fixed duration (28-31
 * days depending on the month, plus leap years), so this can't be a
 * simple floor-division the way alignToMondayUtc or the generic path
 * below are - it has to go through actual calendar arithmetic.
 * `Date.UTC` correctly overflows month 12 into next year on its own, so
 * December's "next month" naturally becomes January of the following
 * year with no special-casing needed here.
 */
const alignToMonthStartUtc = (timeSeconds: number): number => {
  const date = new Date(timeSeconds * 1000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0) / 1000;
};

export const alignTimeToInterval = (
  time: UTCTimestamp,
  selectedInterval: Interval,
): UTCTimestamp => {
  if (selectedInterval === "1w") {
    return alignToMondayUtc(Number(time)) as UTCTimestamp;
  }

  if (selectedInterval === "1M") {
    return alignToMonthStartUtc(Number(time)) as UTCTimestamp;
  }

  const seconds = intervalSeconds[selectedInterval];

  return (Math.floor(Number(time) / seconds) * seconds) as UTCTimestamp;
};

/**
 * FEATURE: future X-axis room scales with the selected timeframe. Short
 * intervals use a smaller real-time horizon to avoid tens of thousands of
 * invisible points, while 4h/daily/weekly charts expose months or years for
 * forward drawings and planning instead of stopping after the old 10 days.
 */
export const FUTURE_BUFFER_DAYS: Record<Interval, number> = {
  "1m": 2,
  "5m": 7,
  "15m": 30,
  "1h": 90,
  "4h": 365,
  "12h": 730,
  "1d": 5 * 365,
  "1w": 10 * 365,
  "1M": 20 * 365,
};

/**
 * Converts the timeframe-specific future horizon into invisible time points
 * for useMarketData.ts's future series. At least one bar is always returned.
 */
export const getFutureBarsForInterval = (selectedInterval: Interval): number => {
  const secondsPerDay = 24 * 60 * 60;
  const barsPerDay = secondsPerDay / intervalSeconds[selectedInterval];

  return Math.max(1, Math.round(barsPerDay * FUTURE_BUFFER_DAYS[selectedInterval]));
};
