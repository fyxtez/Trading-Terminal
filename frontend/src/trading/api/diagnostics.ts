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

export type UnresolvedFinancialIntent = {
  intentId: string;
  method: string;
  path: string;
  createdAtMs: number;
  ageMs: number;
};

export type OperationSafetyStatus = {
  blocksNewExposure: boolean;
  confirmationPhrase: string;
  unresolved: UnresolvedFinancialIntent[];
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

export async function getOperationSafetyStatus(
  signal?: AbortSignal,
): Promise<OperationSafetyStatus> {
  const response = await fetch(`${TRADING_API_BASE_URL}/api/operation-safety/unresolved`, {
    headers: { Authorization: `Bearer ${TRADING_API_TOKEN}` },
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    throw new Error(`Operation safety status returned HTTP ${response.status}`);
  }

  return response.json() as Promise<OperationSafetyStatus>;
}

export async function resolveUnresolvedFinancialIntent(
  intentId: string,
  confirmation: string,
): Promise<void> {
  const response = await fetch(
    `${TRADING_API_BASE_URL}/api/operation-safety/unresolved/${encodeURIComponent(intentId)}/resolve`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TRADING_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirmation }),
    },
  );

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(
      typeof payload?.error === "string"
        ? payload.error
        : `Intent recovery returned HTTP ${response.status}`,
    );
  }
}
