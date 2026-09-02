import {
  PRICE_ALERTS_ENDPOINT,
  TRADING_API_BASE_URL,
  TRADING_API_TOKEN,
} from "../../config/constants";
import type { PriceAlert } from "../../types/alert";

type BackendPriceAlert = {
  id: string;
  symbol: string;
  price: number;
  side: PriceAlert["side"];
  pattern: PriceAlert["pattern"] | null;
  additionalInfo: string | null;
  crossing: "CROSS_UP" | "CROSS_DOWN";
  createdAt: number;
};

// FEATURE: account-wide alert views need the symbol that the chart-scoped
// PriceAlert intentionally omits, so retain it only in the list-all shape.
export type ListedPriceAlert = PriceAlert & { symbol: string };

function headers(json = false): HeadersInit {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    Authorization: `Bearer ${TRADING_API_TOKEN}`,
  };
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      body && typeof body.error === "string"
        ? body.error
        : `Request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}

function fromBackend(alert: BackendPriceAlert): PriceAlert {
  return {
    id: alert.id,
    price: alert.price,
    side: alert.side,
    pattern: alert.pattern ?? "none",
    additionalInfo: alert.additionalInfo ?? "",
    createdAt: alert.createdAt,
    locked: false,
    hidden: false,
  };
}

function fromBackendWithSymbol(alert: BackendPriceAlert): ListedPriceAlert {
  return { ...fromBackend(alert), symbol: alert.symbol.toUpperCase() };
}

function crossingFor(alert: Pick<PriceAlert, "side">): "CROSS_UP" | "CROSS_DOWN" {
  return alert.side === "SHORT" ? "CROSS_UP" : "CROSS_DOWN";
}

export async function listPersistentPriceAlerts(
  symbol: string,
): Promise<PriceAlert[]> {
  const query = new URLSearchParams({ symbol: symbol.toUpperCase() });
  const response = await fetch(
    `${TRADING_API_BASE_URL}${PRICE_ALERTS_ENDPOINT}?${query}`,
    { headers: headers() },
  );
  return (await parseResponse<BackendPriceAlert[]>(response)).map(fromBackend);
}

/** FEATURE: omit the symbol filter to use the backend's existing account-wide list endpoint. */
export async function listAllPersistentPriceAlerts(): Promise<ListedPriceAlert[]> {
  const response = await fetch(
    `${TRADING_API_BASE_URL}${PRICE_ALERTS_ENDPOINT}`,
    { headers: headers() },
  );
  return (await parseResponse<BackendPriceAlert[]>(response)).map(fromBackendWithSymbol);
}

export async function createPersistentPriceAlert(
  symbol: string,
  alert: PriceAlert,
): Promise<PriceAlert> {
  const response = await fetch(
    `${TRADING_API_BASE_URL}${PRICE_ALERTS_ENDPOINT}`,
    {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({
        symbol: symbol.toUpperCase(),
        price: alert.price,
        side: alert.side,
        pattern: alert.pattern,
        // FEATURE: send optional alert context to the persistent monitor so
        // it can include the same note even when this browser is closed.
        additionalInfo: alert.additionalInfo.trim() || null,
        crossing: crossingFor(alert),
      }),
    },
  );
  const created = fromBackend(await parseResponse<BackendPriceAlert>(response));

  // Locking and dimming are local presentation state, so the backend does not
  // return them. Keep the state chosen at creation instead of resetting a new
  // alert to unlocked and fully visible as soon as persistence completes.
  return {
    ...created,
    locked: alert.locked,
    hidden: alert.hidden,
  };
}

export async function updatePersistentPriceAlert(
  alert: PriceAlert,
): Promise<PriceAlert> {
  const response = await fetch(
    `${TRADING_API_BASE_URL}${PRICE_ALERTS_ENDPOINT}/${alert.id}`,
    {
      method: "PUT",
      headers: headers(true),
      body: JSON.stringify({
        price: alert.price,
        side: alert.side,
        pattern: alert.pattern,
        additionalInfo: alert.additionalInfo.trim() || null,
        crossing: crossingFor(alert),
      }),
    },
  );
  return fromBackend(await parseResponse<BackendPriceAlert>(response));
}

export async function cancelPersistentPriceAlert(alertId: string): Promise<void> {
  const response = await fetch(
    `${TRADING_API_BASE_URL}${PRICE_ALERTS_ENDPOINT}/${alertId}`,
    { method: "DELETE", headers: headers() },
  );
  await parseResponse<void>(response);
}
