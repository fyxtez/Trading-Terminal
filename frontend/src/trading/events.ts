import {
  TRADING_API_BASE_URL,
  TRADING_WEBSOCKET_ENDPOINT,
} from "../config/constants";
import type { TradingStreamEvent } from "./types";
import { parseOrderJsonText } from "./api/safeJson";

function websocketBaseUrl(httpUrl: string): string {
  const parsed = new URL(httpUrl, window.location.href);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.toString().replace(/\/$/, "");
}

export function getTradingWebSocketUrl(): string {
  const token = import.meta.env.VITE_TRADING_API_TOKEN ?? "";
  const url = new URL(
    `${websocketBaseUrl(TRADING_API_BASE_URL)}${TRADING_WEBSOCKET_ENDPOINT}`,
  );
  url.searchParams.set("token", token);
  return url.toString();
}

export function parseTradingStreamEvent(raw: string): TradingStreamEvent | null {
  try {
    // FIX: this used to be a plain JSON.parse(raw), which silently
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
