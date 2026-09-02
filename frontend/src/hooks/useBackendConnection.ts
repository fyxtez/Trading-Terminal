import { useCallback, useEffect, useState } from "react";
import { TRADING_API_BASE_URL } from "../config/constants";
import type { ConnectionState } from "./useTradingStream";

const HEALTH_CHECK_INTERVAL_MS = 3_000;
const HEALTH_CHECK_TIMEOUT_MS = 2_000;

export function useBackendConnection(): ConnectionState {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");

  const checkBackend = useCallback(async () => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      HEALTH_CHECK_TIMEOUT_MS,
    );

    try {
      const response = await fetch(
        `${TRADING_API_BASE_URL}/health`,
        {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`Backend health returned ${response.status}`);
      }

      setConnectionState("connected");
    } catch {
      setConnectionState("disconnected");
    } finally {
      window.clearTimeout(timeoutId);
    }
  }, []);

  useEffect(() => {
    setConnectionState("connecting");
    void checkBackend();

    const intervalId = window.setInterval(
      () => void checkBackend(),
      HEALTH_CHECK_INTERVAL_MS,
    );

    return () => {
      window.clearInterval(intervalId);
    };
  }, [checkBackend]);

  return connectionState;
}
