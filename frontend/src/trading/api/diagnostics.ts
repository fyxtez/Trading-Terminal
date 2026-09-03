import { TRADING_API_BASE_URL, TRADING_API_TOKEN } from "../../config/constants";

export type ServiceDiagnostic = {
  status: "connecting" | "connected" | "degraded" | "disabled";
  lastSuccessAtMs: number | null;
  lastEventAtMs: number | null;
  lastError: string | null;
};

export type BackendDiagnostics = {
  startedAtMs: number;
  exchange: ServiceDiagnostic;
  userStream: ServiceDiagnostic;
  reconciliation: {
    status: "pending" | "healthy" | "drift-repaired" | "degraded" | "disabled";
    lastSuccessAtMs: number | null;
    lastDriftAtMs: number | null;
    driftCount: number;
    lastComponent: string | null;
    lastError: string | null;
  };
  requests: {
    rejectedCount: number;
    duplicateCount: number;
    lastRejectedAtMs: number | null;
    lastDuplicateAtMs: number | null;
    lastRejection: string | null;
  };
  notifications: {
    failureCount: number;
    lastFailureAtMs: number | null;
    lastFailure: string | null;
  };
};

export async function getBackendDiagnostics(signal?: AbortSignal): Promise<BackendDiagnostics> {
  const response = await fetch(`${TRADING_API_BASE_URL}/api/diagnostics`, {
    headers: { Authorization: `Bearer ${TRADING_API_TOKEN}` },
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    throw new Error(`Diagnostics returned HTTP ${response.status}`);
  }

  return response.json() as Promise<BackendDiagnostics>;
}
