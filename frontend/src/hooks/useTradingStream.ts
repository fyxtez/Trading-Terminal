import { useEffect, useRef, useState } from "react";
import {
  getTradingWebSocketUrl,
  parseTradingStreamEvent,
} from "../trading/events";
import type { OrderExecutedEvent } from "../trading/types";
import { TRADING_API_BASE_URL_CHANGED_EVENT } from "../config/constants";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 15_000;

export type ConnectionState =
  | "connecting"
  | "connected"
  | "disconnected";

type UseTradingStreamOptions = {
  onOrderExecuted: (event: OrderExecutedEvent) => void;
};

export function useTradingStream({
  onOrderExecuted,
}: UseTradingStreamOptions): ConnectionState {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");

  const handlerRef = useRef(onOrderExecuted);
  handlerRef.current = onOrderExecuted;

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let initialConnectTimer: number | null = null;
    let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    let reconnectForBackendChange = false;

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) return;

      setConnectionState("disconnected");

      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, reconnectDelay);

      reconnectDelay = Math.min(
        reconnectDelay * 2,
        MAX_RECONNECT_DELAY_MS,
      );
    };

    const connect = () => {
      if (disposed) return;

      setConnectionState("connecting");
      socket = new WebSocket(getTradingWebSocketUrl());

      socket.addEventListener("open", () => {
        if (disposed) return;

        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        setConnectionState("connected");
        console.log("[trading-ws] connected", socket?.url);
      });

      socket.addEventListener("message", (message) => {
        if (typeof message.data !== "string") return;

        const event = parseTradingStreamEvent(message.data);
        if (!event) {
          console.warn("[trading-ws] invalid event", message.data);
          return;
        }

        if (event.type === "ORDER_EXECUTED") {
          handlerRef.current(event);
          window.dispatchEvent(new Event("orders-state-changed"));
          window.dispatchEvent(new Event("account-state-changed"));
          return;
        }

        if (event.type === "ALERT_TRIGGERED") {
          window.dispatchEvent(
            new CustomEvent("persistent-price-alert-triggered", {
              detail: event,
            }),
          );
          return;
        }

        if (event.type === "SNAPSHOT_REQUIRED") {
          const reason = event.reason.toUpperCase();
          const affectsOrders =
            reason.includes("ORDER") ||
            reason.includes("ALGO") ||
            reason.includes("CLOSE EVERYTHING") ||
            reason.includes("CONNECTED") ||
            reason.includes("LAGGED");
          const affectsAccount =
            reason.includes("ACCOUNT_UPDATE") ||
            reason.includes("POSITION") ||
            reason.includes("CLOSE EVERYTHING") ||
            reason.includes("CONNECTED") ||
            reason.includes("LAGGED");

          if (affectsOrders) window.dispatchEvent(new Event("orders-state-changed"));
          if (affectsAccount) window.dispatchEvent(new Event("account-state-changed"));
        }
      });

      socket.addEventListener("close", (event) => {
        if (disposed) return;

        console.warn(
          "[trading-ws] closed",
          event.code,
          event.reason,
        );

        if (reconnectForBackendChange) {
          reconnectForBackendChange = false;
          reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
          connect();
          return;
        }

        scheduleReconnect();
      });

      socket.addEventListener("error", (event) => {
        if (disposed) return;

        console.error("[trading-ws] error", event);
        setConnectionState("disconnected");
        socket?.close();
      });
    };

    // Defer the first connection by one task. In React StrictMode the first
    // development-only effect mount is immediately cleaned up; delaying socket
    // creation lets that cleanup cancel the timer instead of closing a socket
    // while its handshake is still in progress (the noisy browser warning).
    initialConnectTimer = window.setTimeout(() => {
      initialConnectTimer = null;
      connect();
    }, 0);

    const handleApiBaseUrlChanged = () => {
      if (disposed) return;

      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;

      if (socket && socket.readyState !== WebSocket.CLOSED) {
        reconnectForBackendChange = true;
        socket.close(1000, "API backend changed");
        return;
      }

      connect();
    };

    window.addEventListener(
      TRADING_API_BASE_URL_CHANGED_EVENT,
      handleApiBaseUrlChanged,
    );

    return () => {
      disposed = true;
      window.removeEventListener(
        TRADING_API_BASE_URL_CHANGED_EVENT,
        handleApiBaseUrlChanged,
      );

      if (initialConnectTimer !== null) {
        window.clearTimeout(initialConnectTimer);
      }

      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }

      if (socket?.readyState === WebSocket.OPEN) {
        socket.close(1000, "component unmounted");
      }
    };
  }, []);

  return connectionState;
}

