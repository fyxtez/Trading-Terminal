import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionState } from "./useTradingStream";
import {
  getBackendDiagnostics,
  type BackendDiagnostics,
} from "../trading/api/diagnostics";
import {
  SYSTEM_NOTICE_EVENT,
  publishSystemNotice,
  type SystemNotice,
} from "../diagnostics/events";

const DIAGNOSTICS_REFRESH_MS = 5_000;

export type OperationalDiagnostics = {
  isDesktop: boolean;
  backendConnection: ConnectionState;
  marketConnection: ConnectionState;
  frontendStreamConnection: ConnectionState;
  backend: BackendDiagnostics | null;
  isLoading: boolean;
  error: string | null;
  refreshedAt: number | null;
  notice: SystemNotice | null;
  dismissNotice: () => void;
  refresh: () => Promise<void>;
};

export function useOperationalDiagnostics({
  isDesktop,
  backendConnection,
  marketConnection,
  frontendStreamConnection,
}: {
  isDesktop: boolean;
  backendConnection: ConnectionState;
  marketConnection: ConnectionState;
  frontendStreamConnection: ConnectionState;
}): OperationalDiagnostics {
  const [backend, setBackend] = useState<BackendDiagnostics | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<SystemNotice | null>(null);
  const previousNotificationFailuresRef = useRef<number | null>(null);
  const lastNotificationNoticeAtRef = useRef(0);
  const mountedAtRef = useRef(Date.now());

  const refresh = useCallback(async () => {
    if (backendConnection !== "connected") {
      setError("Backend diagnostics unavailable");
      return;
    }

    setIsLoading(true);
    try {
      const next = await getBackendDiagnostics();
      const previousCount = previousNotificationFailuresRef.current;
      if (
        ((previousCount !== null &&
          next.notifications.failureCount > previousCount) ||
          (previousCount === null &&
            next.notifications.failureCount > 0 &&
            (next.notifications.lastFailureAtMs ?? 0) >= mountedAtRef.current)) &&
        next.notifications.lastFailure &&
        Date.now() - lastNotificationNoticeAtRef.current > DIAGNOSTICS_REFRESH_MS * 2
      ) {
        publishSystemNotice({
          kind: "warning",
          title: "Notification delivery failed",
          message: `${next.notifications.lastFailure}. The triggering action still completed.`,
        });
      }
      previousNotificationFailuresRef.current = next.notifications.failureCount;
      setBackend(next);
      setError(null);
      setRefreshedAt(Date.now());
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Diagnostics unavailable",
      );
    } finally {
      setIsLoading(false);
    }
  }, [backendConnection]);

  useEffect(() => {
    const handleNotice = (event: Event) => {
      const nextNotice = (event as CustomEvent<SystemNotice>).detail;
      if (nextNotice.title === "Notification delivery failed") {
        lastNotificationNoticeAtRef.current = Date.now();
      }
      setNotice(nextNotice);
    };
    window.addEventListener(SYSTEM_NOTICE_EVENT, handleNotice);
    return () => window.removeEventListener(SYSTEM_NOTICE_EVENT, handleNotice);
  }, []);

  useEffect(() => {
    if (backendConnection !== "connected") return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), DIAGNOSTICS_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [backendConnection, refresh]);

  return {
    isDesktop,
    backendConnection,
    marketConnection,
    frontendStreamConnection,
    backend,
    isLoading,
    error,
    refreshedAt,
    notice,
    dismissNotice: () => setNotice(null),
    refresh,
  };
}
