export type SymbolFilters = {
  tickSize: number;
  pricePrecision: number;
  stepSize: number;
  quantityPrecision: number;
  /** Binance's LOT_SIZE.minQty for this symbol. */
  minQty: number;
  /** Binance's MIN_NOTIONAL.notional (or legacy .minNotional) for this symbol. */
  minNotional: number;
};

/**
 * Number of decimal places implied by a step/tick value, derived from
 * the PARSED float's own canonical string form (not the raw string
 * Binance sends, which is often zero-padded like "0.10000000" and
 * would otherwise be miscounted as 8 decimals instead of 1).
 */
function decimalsFromStep(step: number): number {
  const stepString = step.toString();

  if (stepString.includes("e-")) {
    const [, exponent] = stepString.split("e-");
    return Number(exponent);
  }

  const decimalIndex = stepString.indexOf(".");

  return decimalIndex === -1 ? 0 : stepString.length - decimalIndex - 1;
}

/** Rounds a value to the NEAREST multiple of `step`, formatted cleanly. */
export function roundToStep(value: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return value;

  const rounded = Math.round(value / step) * step;
  const decimals = decimalsFromStep(step);

  // toFixed() avoids floating-point noise like 64065.79999999999.
  return Number(rounded.toFixed(decimals));
}

/**
 * Rounds a value UP to the next multiple of `step`. Unlike roundToStep,
 * this never returns a value smaller than `value` - used by
 * computeDefaultOrderQuantity below to guarantee a computed quantity
 * actually clears an exchange minimum instead of rounding back below it.
 */
function ceilToStep(value: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return value;

  const result = Math.ceil(value / step) * step;
  const decimals = decimalsFromStep(step);

  return Number(result.toFixed(decimals));
}

type ExchangeInfoSymbol = {
  symbol: string;
  filters: Array<{ filterType: string; [key: string]: unknown }>;
};

type ExchangeInfoResponse = {
  symbols?: ExchangeInfoSymbol[];
};

/*
 * FIX (the actual root cause of "XRP prices only show 1 decimal" and
 * "SL/TP can't be placed precisely"): Binance's USDⓈ-M FUTURES
 * exchangeInfo endpoint - unlike the Spot API - does NOT support a
 * ?symbol= filter. It silently ignores the query string and always
 * returns every symbol on the exchange. The previous version of this
 * file requested `?symbol=${symbol}` and then just read `symbols[0]` -
 * which is whatever Binance happens to list first (almost certainly
 * BTCUSDT), REGARDLESS of which symbol was actually requested. That
 * meant every symbol other than BTC was silently using BTC's own tick
 * size (0.1, i.e. exactly 1 decimal), step size, min_qty, and
 * min_notional this entire time - not just for display, but for the
 * actual roundToStep() calls used when submitting SL/TP/limit prices,
 * which is why those could only ever land on 0.1 increments for XRP no
 * matter how precisely you tried to place them.
 *
 * The fix: fetch the FULL exchangeInfo once (cached below, since it's a
 * large payload and every symbol's data lives in the same response
 * anyway - no reason to re-download it per symbol), then look up the
 * SPECIFIC symbol being asked about by its own `symbol` field.
 */
let exchangeInfoPromise: Promise<ExchangeInfoResponse> | null = null;

async function fetchExchangeInfo(): Promise<ExchangeInfoResponse> {
  if (exchangeInfoPromise) {
    return exchangeInfoPromise;
  }

  exchangeInfoPromise = fetch("https://fapi.binance.com/fapi/v1/exchangeInfo")
    .then((response) => {
      if (!response.ok) {
        throw new Error(`exchangeInfo request failed: ${response.status}`);
      }
      return response.json() as Promise<ExchangeInfoResponse>;
    })
    .catch((error) => {
      // Let a later call retry instead of caching a permanent failure.
      exchangeInfoPromise = null;
      throw error;
    });

  return exchangeInfoPromise;
}

async function fetchSymbolFilters(symbol: string): Promise<SymbolFilters> {
  const upperSymbol = symbol.toUpperCase();
  const data = await fetchExchangeInfo();
  const symbolInfo = (data.symbols ?? []).find(
    (item) => item.symbol === upperSymbol,
  );

  if (!symbolInfo) {
    throw new Error(`No exchange info returned for ${symbol}`);
  }

  const filters: Array<{ filterType: string; [key: string]: unknown }> =
    symbolInfo.filters ?? [];

  const priceFilter = filters.find(
    (filter) => filter.filterType === "PRICE_FILTER",
  );
  const lotSizeFilter = filters.find(
    (filter) => filter.filterType === "LOT_SIZE",
  );
  const minNotionalFilter = filters.find(
    (filter) => filter.filterType === "MIN_NOTIONAL",
  );

  const tickSize = Number(priceFilter?.tickSize ?? "0.1");
  const stepSize = Number(lotSizeFilter?.stepSize ?? "0.001");
  const rawMinQty = Number(lotSizeFilter?.minQty ?? stepSize);
  // Binance futures uses "notional" on newer symbols and "minNotional" on
  // some older ones - mirror the same fallback the backend already uses
  // (see parse_exchange_filters in binance.rs).
  const rawMinNotional = Number(
    minNotionalFilter?.notional ?? minNotionalFilter?.minNotional ?? "0",
  );

  return {
    tickSize,
    pricePrecision: decimalsFromStep(tickSize),
    stepSize,
    quantityPrecision: decimalsFromStep(stepSize),
    minQty: Number.isFinite(rawMinQty) && rawMinQty > 0 ? rawMinQty : stepSize,
    minNotional: Number.isFinite(rawMinNotional) ? rawMinNotional : 0,
  };
}

/*
 * PER-SYMBOL cache (keyed by uppercased symbol), for the tab's lifetime.
 */
const filterPromises = new Map<string, Promise<SymbolFilters>>();
const resolvedFilters = new Map<string, SymbolFilters>();

/**
 * Cached (in-memory, for the tab's lifetime) tick/step size for the
 * given symbol, fetched once from Binance's public exchangeInfo
 * endpoint. Hardcoding a decimal precision breaks silently the moment a
 * symbol's real tick size differs - the backend then rejects the order
 * with API error -1111 ("Precision is over the maximum defined for this
 * asset").
 */
export function getSymbolFilters(symbol: string): Promise<SymbolFilters> {
  const key = symbol.toUpperCase();
  const existing = filterPromises.get(key);

  if (existing) {
    return existing;
  }

  const promise = fetchSymbolFilters(key)
    .then((filters) => {
      resolvedFilters.set(key, filters);
      return filters;
    })
    .catch((error) => {
      // Let a later call retry instead of caching a permanent failure.
      filterPromises.delete(key);
      throw error;
    });

  filterPromises.set(key, promise);
  return promise;
}

/** Synchronous best-effort read for UI display before the fetch resolves. */
export function getCachedSymbolFilters(symbol: string): SymbolFilters | null {
  return resolvedFilters.get(symbol.toUpperCase()) ?? null;
}

/**
 * Computes a valid default order quantity for a manual (no user-entered
 * size) LIMIT/MARKET/ADD order: target roughly `targetNotional` USDT of
 * the symbol at `price`, rounded to its tradeable step size, then bumped
 * up if that would land below the symbol's own exchange minimums
 * (min_qty and min_notional) instead of getting rejected by Binance
 * after the round trip.
 *
 * This is what replaced the old flat "always send 0.001" quantity - see
 * DEFAULT_ORDER_NOTIONAL_USDT in config/constants.ts for why that broke
 * for any symbol priced far from BTC.
 */
export function computeDefaultOrderQuantity(
  price: number,
  filters: SymbolFilters,
  targetNotional: number,
): number {
  if (!Number.isFinite(price) || price <= 0) {
    return filters.minQty;
  }

  let quantity = roundToStep(targetNotional / price, filters.stepSize);

  if (quantity < filters.minQty) {
    quantity = filters.minQty;
  }

  const requiredNotional = Math.max(filters.minNotional, filters.minQty * price);

  if (quantity * price < requiredNotional) {
    // Step UP (not just to the nearest step) here - rounding to the
    // nearest step could round back down below the minimum this exists
    // to clear, recreating the exact rejection this function prevents.
    quantity = ceilToStep(requiredNotional / price, filters.stepSize);
  }

  return quantity;
}
