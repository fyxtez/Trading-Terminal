import { TRADING_API_BASE_URL, TRADING_API_TOKEN } from "../../config/constants";

export type BackendSymbol = {
  symbol: string;
  display_symbol: string;
  market_symbol: string;
  data_source: "binance" | "mexc";
  /** Optional while rolling out against an older backend deployment. */
  market_kind?: "crypto" | "traditional";
  protected: boolean;
};

export type BackendIcon = {
  symbol: string;
  /** Path (relative to the backend origin) to the cached image bytes. */
  url: string;
  /** Where the backend originally downloaded the icon from - debugging only. */
  source_url: string;
  cached_at_ms: number;
};

type ListSymbolsResponse = { symbols: BackendSymbol[] };
type AddSymbolResponse = { created: boolean; symbol: BackendSymbol; icon: BackendIcon | null };
type DeleteSymbolResponse = { deleted: boolean; symbol: BackendSymbol };
type ListIconsResponse = { count: number; icons: BackendIcon[] };

function headers(json = false): HeadersInit {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(TRADING_API_TOKEN ? { Authorization: `Bearer ${TRADING_API_TOKEN}` } : {}),
  };
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      body && typeof body.error === "string"
        ? body.error
        : body && typeof body.message === "string"
          ? body.message
          : `Request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export async function listSymbols(): Promise<BackendSymbol[]> {
  const response = await fetch(`${TRADING_API_BASE_URL}/api/symbols`, {
    headers: headers(),
    cache: "no-store",
  });
  return (await parseResponse<ListSymbolsResponse>(response)).symbols;
}

export async function addSymbol(symbol: string): Promise<AddSymbolResponse> {
  const response = await fetch(`${TRADING_API_BASE_URL}/api/symbols`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ symbol }),
  });
  return parseResponse<AddSymbolResponse>(response);
}

export async function deleteSymbol(symbol: string): Promise<DeleteSymbolResponse> {
  const response = await fetch(
    `${TRADING_API_BASE_URL}/api/symbols/${encodeURIComponent(symbol)}`,
    { method: "DELETE", headers: headers() },
  );
  return parseResponse<DeleteSymbolResponse>(response);
}

/**
 * Full symbol -> icon map the backend currently has cached (pre-seeded
 * majors + whatever's been added on demand). Regular header-authenticated
 * fetch - unlike iconImageUrl below, this isn't loaded via `<img src>` so
 * it doesn't need the query-token workaround.
 */
export async function listIcons(): Promise<ListIconsResponse> {
  const response = await fetch(`${TRADING_API_BASE_URL}/api/icons`, {
    headers: headers(),
    cache: "no-store",
  });
  return parseResponse<ListIconsResponse>(response);
}

/** Fetches protected icon bytes with a bearer header and returns a local blob
 * URL. The service capability therefore never appears in an image URL. */
export async function fetchIconImageUrl(symbol: string, cachedAtMs?: number): Promise<string> {
  const url = new URL(`${TRADING_API_BASE_URL}/api/icons/${encodeURIComponent(symbol)}/image`);
  if (cachedAtMs !== undefined) {
    url.searchParams.set("v", String(cachedAtMs));
  }
  const response = await fetch(url, {
    headers: headers(),
    cache: "force-cache",
  });
  if (!response.ok) {
    throw new Error(`Icon request failed with HTTP ${response.status}`);
  }
  return URL.createObjectURL(await response.blob());
}
