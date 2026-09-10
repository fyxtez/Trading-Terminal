import { getSymbolFilters, roundToStep } from "./exchangeInfo";
import type { TradeSide } from "../types";
import { SIZING_ENDPOINT, TRADING_API_BASE_URL } from "../../config/constants";
import {
  financialMutationFingerprint,
  financialMutationHeaders,
  runFinancialMutation,
} from "./financialMutation";
import { tradingApiFetch, tradingApiHeaders } from "./http";

export type SizingConfig = {
  margin_pct: number;
  max_leverage: number;
};

function getHeaders(includeJson = false): Record<string, string> {
  return tradingApiHeaders({
    Accept: "application/json",
    ...(includeJson ? { "Content-Type": "application/json" } : {}),
  });
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();

    if (typeof body?.error === "string") {
      return body.error;
    }

    if (typeof body?.message === "string") {
      return body.message;
    }
  } catch {
    // Ignore invalid JSON and use the status fallback.
  }

  return `Sizing request failed with status ${response.status}`;
}

function validateSizing(value: unknown): SizingConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error("Backend returned an invalid sizing response");
  }

  const body = value as Record<string, unknown>;
  const marginPct = Number(body.margin_pct);
  const maxLeverage = Number(body.max_leverage);

  if (!Number.isFinite(marginPct) || !Number.isFinite(maxLeverage)) {
    throw new Error("Backend returned invalid sizing values");
  }

  return {
    margin_pct: marginPct,
    max_leverage: maxLeverage,
  };
}

export async function getSizing(signal?: AbortSignal): Promise<SizingConfig> {
  const response = await tradingApiFetch(`${TRADING_API_BASE_URL}${SIZING_ENDPOINT}`, {
    method: "GET",
    headers: getHeaders(),
    signal,
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return validateSizing(await response.json());
}

export async function updateSizing(
  sizing: SizingConfig,
  signal?: AbortSignal,
): Promise<SizingConfig> {
  return runFinancialMutation(
    financialMutationFingerprint(SIZING_ENDPOINT, sizing),
    async (intentId) => {
      const response = await tradingApiFetch(`${TRADING_API_BASE_URL}${SIZING_ENDPOINT}`, {
        method: "PUT",
        headers: {
          ...getHeaders(true),
          ...financialMutationHeaders(intentId, true),
        },
        body: JSON.stringify(sizing),
        signal,
      });

      if (!response.ok) throw new Error(await readError(response));
      return validateSizing(await response.json());
    },
  );
}

/** Read the backend's automatic leverage without changing the account or placing an order. */
export async function getAutoMarketLeverage(
  symbol: string,
  side: TradeSide,
  stopLoss: number,
  signal: AbortSignal,
): Promise<number> {
  const filters = await getSymbolFilters(symbol);
  signal.throwIfAborted();
  const query = new URLSearchParams({
    side,
    stop_loss: String(roundToStep(stopLoss, filters.tickSize)),
  });
  const response = await tradingApiFetch(
    `${TRADING_API_BASE_URL}${SIZING_ENDPOINT}/preview/${encodeURIComponent(symbol)}?${query}`,
    { headers: getHeaders(), signal },
  );
  if (!response.ok) throw new Error(await readError(response));
  const body = await response.json();
  if (!Number.isInteger(body.leverage) || body.leverage < 1) {
    throw new Error("Backend returned invalid automatic leverage");
  }
  return body.leverage;
}
