import { SIZING_ENDPOINT, TRADING_API_BASE_URL, TRADING_API_TOKEN } from "../../config/constants";

export type SizingConfig = {
  margin_pct: number;
  leverage_safety: number;
  max_leverage: number;
};

function getHeaders(includeJson = false): HeadersInit {
  if (!TRADING_API_TOKEN) {
    throw new Error("Trading API token is missing");
  }

  return {
    Accept: "application/json",
    Authorization: `Bearer ${TRADING_API_TOKEN}`,
    ...(includeJson ? { "Content-Type": "application/json" } : {}),
  };
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
  const leverageSafety = Number(body.leverage_safety);
  const maxLeverage = Number(body.max_leverage);

  if (
    !Number.isFinite(marginPct) ||
    !Number.isFinite(leverageSafety) ||
    !Number.isFinite(maxLeverage)
  ) {
    throw new Error("Backend returned invalid sizing values");
  }

  return {
    margin_pct: marginPct,
    leverage_safety: leverageSafety,
    max_leverage: maxLeverage,
  };
}

export async function getSizing(signal?: AbortSignal): Promise<SizingConfig> {
  const response = await fetch(`${TRADING_API_BASE_URL}${SIZING_ENDPOINT}`, {
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
  const response = await fetch(`${TRADING_API_BASE_URL}${SIZING_ENDPOINT}`, {
    method: "PUT",
    headers: getHeaders(true),
    body: JSON.stringify(sizing),
    signal,
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return validateSizing(await response.json());
}
