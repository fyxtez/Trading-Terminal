import { getBinanceCooldown, recordBinanceCooldown } from "./binanceRateLimit";

export class MarketDataError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAt?: number,
  ) {
    super(message);
    this.name = "MarketDataError";
  }
}

export async function fetchBinanceKlineData(
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<unknown[][]> {
  if (signal?.aborted) throw signal.reason;
  const cooldown = getBinanceCooldown();
  if (cooldown) {
    throw new MarketDataError(
      `Binance has limited price updates for this IP (${cooldown.status}). Waiting before retrying automatically.`,
      cooldown.status,
      cooldown.retryAt,
    );
  }

  let response: Response;
  try {
    response = await fetch(`https://fapi.binance.com/fapi/v1/klines?${params}`, {
      signal: signal ?? AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "TimeoutError")) {
      throw error;
    }
    throw new MarketDataError(
      "Cannot reach Binance prices. Check your connection; retrying automatically.",
    );
  }

  if (!response.ok) {
    let exchangeMessage = "";
    try {
      const body = (await response.json()) as { msg?: unknown };
      if (typeof body?.msg === "string") exchangeMessage = body.msg;
    } catch {
      // HTTP status still identifies the failure if the body is not JSON.
    }
    if (signal?.aborted) throw signal.reason;

    if (response.status === 429 || response.status === 418) {
      const pause = recordBinanceCooldown(
        response.status,
        response.headers.get("retry-after"),
        exchangeMessage,
      );
      throw new MarketDataError(
        response.status === 429
          ? "Binance has limited price updates for this IP (429). Waiting before retrying automatically."
          : "Binance has temporarily blocked price updates for this IP (418). Waiting before retrying automatically.",
        pause.status,
        pause.retryAt,
      );
    }

    throw new MarketDataError(
      response.status === 403 || response.status === 451
        ? `Binance blocked price access from this connection (${response.status}).`
        : response.status >= 500
          ? `Binance's price service is unavailable (${response.status}). Reconnecting automatically.`
          : `Binance could not load these prices (${response.status}).`,
      response.status,
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof DOMException && error.name === "TimeoutError") throw error;
    throw new MarketDataError("Binance sent unreadable price data. Retrying automatically.");
  }
  if (!Array.isArray(data) || !data.every((row) => Array.isArray(row))) {
    throw new MarketDataError("Binance sent invalid price data. Retrying automatically.");
  }
  return data;
}
