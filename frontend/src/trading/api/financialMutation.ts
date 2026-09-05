const retryIntents = new Map<string, string>();
const inFlight = new Map<string, Promise<unknown>>();

export function newFinancialIntentId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function financialMutationHeaders(
  intentId: string,
  includeJson = false,
): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Fyxtez-Intent-Id": intentId,
    ...(includeJson ? { "Content-Type": "application/json" } : {}),
  };
}

/**
 * Coalesce an accidental double click while the first request is in flight.
 * If transport fails and the caller retries the exact same action, reuse the
 * intent ID so the backend can replay its durable result instead of submitting
 * a second exchange mutation.
 */
export function runFinancialMutation<T>(
  fingerprint: string,
  execute: (intentId: string) => Promise<T>,
): Promise<T> {
  const active = inFlight.get(fingerprint);
  if (active) return active as Promise<T>;

  const retained = retryIntents.get(fingerprint);
  const intentId = retained ?? newFinancialIntentId();
  retryIntents.set(fingerprint, intentId);

  const request = execute(intentId)
    .then((result) => {
      retryIntents.delete(fingerprint);
      return result;
    })
    .finally(() => {
      if (inFlight.get(fingerprint) === request) inFlight.delete(fingerprint);
    });

  inFlight.set(fingerprint, request);
  return request;
}

export function financialMutationFingerprint(endpoint: string, payload?: unknown): string {
  return payload === undefined ? endpoint : `${endpoint}:${JSON.stringify(payload)}`;
}

/**
 * Drop a retry token after the backend has reconciled and tombstoned an
 * uncertain operation. The next deliberate user action must receive a fresh
 * UUID; the resolved UUID itself remains non-executable on the backend.
 */
export function forgetFinancialIntent(intentId: string): void {
  for (const [fingerprint, retainedIntentId] of retryIntents) {
    if (retainedIntentId === intentId) retryIntents.delete(fingerprint);
  }
}
