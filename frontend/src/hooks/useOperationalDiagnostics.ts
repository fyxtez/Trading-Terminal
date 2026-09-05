import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionState } from "./useTradingStream";
import {
  getBackendDiagnostics,
  getOperationSafetyStatus,
  resolveUnresolvedFinancialIntent,
  type BackendDiagnostics,
  type OperationSafetyStatus,
} from "../trading/api/diagnostics";
import { forgetFinancialIntent } from "../trading/api/financialMutation";
import { SYSTEM_NOTICE_EVENT, publishSystemNotice, type SystemNotice } from "../diagnostics/events";

const DIAGNOSTICS_REFRESH_MS = 5_000;

export type OperationalDiagnostics = {
  isDesktop: boolean;
  backendConnection: ConnectionState;
  marketConnection: ConnectionState;
  frontendStreamConnection: ConnectionState;
  backend: BackendDiagnostics | null;
  operationSafety: OperationSafetyStatus | null;
  isLoading: boolean;
  error: string | null;
  refreshedAt: number | null;
  notice: SystemNotice | null;
  resolvingIntentId: string | null;
  resolutionError: string | null;
  dismissNotice: () => void;
  refresh: () => Promise<void>;
  resolveIntent: (intentId: string, confirmation: string) => Promise<void>;
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
  const [operationSafety, setOperationSafety] = useState<OperationSafetyStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<SystemNotice | null>(null);
  const [resolvingIntentId, setResolvingIntentId] = useState<string | null>(null);
  const [resolutionError, setResolutionError] = useState<string | null>(null);
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
      const [next, nextOperationSafety] = await Promise.all([
        getBackendDiagnostics(),
        getOperationSafetyStatus(),
      ]);
      const previousCount = previousNotificationFailuresRef.current;
      if (
        ((previousCount !== null && next.notifications.failureCount > previousCount) ||
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
      setOperationSafety(nextOperationSafety);
      setError(null);
      setRefreshedAt(Date.now());
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Diagnostics unavailable");
    } finally {
      setIsLoading(false);
    }
  }, [backendConnection]);

  const resolveIntent = useCallback(
    async (intentId: string, confirmation: string) => {
      setResolvingIntentId(intentId);
      setResolutionError(null);
      try {
        await resolveUnresolvedFinancialIntent(intentId, confirmation);
        forgetFinancialIntent(intentId);
        publishSystemNotice({
          kind: "success",
          title: "Uncertain operation resolved",
          message: "Binance state was refreshed. No order was replayed.",
        });
        await refresh();
      } catch (resolveError) {
        setResolutionError(
          resolveError instanceof Error ? resolveError.message : "Unable to resolve operation",
        );
        throw resolveError;
      } finally {
        setResolvingIntentId(null);
      }
    },
    [refresh],
  );

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
    operationSafety,
    isLoading,
    error,
    refreshedAt,
    notice,
    resolvingIntentId,
    resolutionError,
    dismissNotice: () => setNotice(null),
    refresh,
    resolveIntent,
  };
}
