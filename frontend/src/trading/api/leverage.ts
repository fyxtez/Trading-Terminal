import { TRADING_API_BASE_URL } from "../../config/constants";

const API_TOKEN = import.meta.env.VITE_TRADING_API_TOKEN;

function authHeaders(includeJson = false): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${API_TOKEN}`,
    ...(includeJson ? { "Content-Type": "application/json" } : {}),
  };
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();

    if (typeof body?.error === "string") {
      return body.error;
    }
  } catch {
    // Ignore invalid JSON and use the status fallback below.
  }

  return `Request failed with status ${response.status}`;
}

/**
 * Whatever Binance's own POST /fapi/v1/leverage returns, passed straight
 * through by the backend's `set_leverage` handler (see api.rs) - shaped
 * like { symbol, leverage, maxNotionalValue }. Loosely typed since this
 * app only cares whether the request succeeded, not the exact fields.
 */
export type SetLeverageResponse = {
  symbol?: string;
  leverage?: number;
  maxNotionalValue?: string;
  [key: string]: unknown;
};

/**
 * POST /api/leverage - sets the account's leverage for `symbol` on
 * Binance. Called once the user releases the leverage slider (see
 * commitLeverage in useTradeMenu.ts); the value it sets is what a
 * subsequent LIMIT/MARKET entry order actually trades at.
 */
export async function updateLeverage(
  symbol: string,
  leverage: number,
): Promise<SetLeverageResponse> {
  const response = await fetch(`${TRADING_API_BASE_URL}/api/leverage`, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({
      symbol: symbol.toUpperCase(),
      leverage: Math.round(leverage),
    }),
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (await response.json()) as SetLeverageResponse;
}

export type CurrentLeverageResponse = {
  symbol: string;
  leverage: number;
};

/**
 * GET /api/leverage/current/{symbol} - reads the leverage currently
 * configured on Binance for this symbol.
 */
export async function getCurrentLeverage(
  symbol: string,
): Promise<CurrentLeverageResponse> {
  const response = await fetch(
    `${TRADING_API_BASE_URL}/api/leverage/current/${encodeURIComponent(symbol.toUpperCase())}`,
    {
      method: "GET",
      headers: authHeaders(),
    },
  );

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (await response.json()) as CurrentLeverageResponse;
}

export type MaxLeverageResponse = {
  symbol: string;
  max_leverage: number;
};

/**
 * GET /api/leverage/max/{symbol} - Binance's own exchange-side leverage
 * cap for this symbol (from the cached leverage-bracket data - see
 * BinanceClient::max_leverage in binance.rs). This is distinct from the
 * "Maximum leverage" field in Settings (MarginSizingConfig.max_leverage):
 * that one is a personal risk cap the user configured, this one is what
 * the exchange itself will actually allow. The leverage slider's real
 * ceiling is whichever of the two is lower - see useTradeMenu.ts.
 */
export async function getMaxLeverage(
  symbol: string,
): Promise<MaxLeverageResponse> {
  const response = await fetch(
    `${TRADING_API_BASE_URL}/api/leverage/max/${encodeURIComponent(symbol.toUpperCase())}`,
    {
      method: "GET",
      headers: authHeaders(),
    },
  );

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (await response.json()) as MaxLeverageResponse;
}
