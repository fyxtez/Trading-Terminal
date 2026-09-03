import {
  TRADING_API_BASE_URL,
  TRADING_API_TOKEN,
  TRADING_WEBSOCKET_ENDPOINT,
} from "../config/constants";
import type { TradingStreamEvent } from "./types";
import { parseOrderJsonText } from "./api/safeJson";

function websocketBaseUrl(httpUrl: string): string {
  const parsed = new URL(httpUrl, window.location.href);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.toString().replace(/\/$/, "");
}

export async function getAuthenticatedTradingWebSocketUrl(): Promise<string> {
  const response = await fetch(`${TRADING_API_BASE_URL}/api/auth/ws-ticket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TRADING_API_TOKEN}` },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`WebSocket ticket request failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { ticket?: unknown };
  if (typeof body.ticket !== "string" || !body.ticket) {
    throw new Error("WebSocket ticket response is invalid");
  }
  const url = new URL(`${websocketBaseUrl(TRADING_API_BASE_URL)}${TRADING_WEBSOCKET_ENDPOINT}`);
  url.searchParams.set("ticket", body.ticket);
  return url.toString();
}

export function parseTradingStreamEvent(raw: string): TradingStreamEvent | null {
  try {
    // this used to be a plain JSON.parse(raw), which silently
    // corrupts order_id in ORDER_EXECUTED events the exact same way
    // every other place in this app was hit by it - see
    // parseOrderJsonText's own comment for the full story. This is a
    // live push event carrying a fill's order_id in real time, so it's
    // just as exposed as any HTTP response.
    const event = parseOrderJsonText(raw) as Partial<TradingStreamEvent>;
    if (typeof event !== "object" || event === null || typeof event.type !== "string") {
      return null;
    }
    return event as TradingStreamEvent;
  } catch {
    return null;
  }
}
