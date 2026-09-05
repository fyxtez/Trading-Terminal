import { useState } from "react";
import type { OperationalDiagnostics } from "../../hooks/useOperationalDiagnostics";
import LoadingIndicator from "../LoadingIndicator/LoadingIndicator";
import { EXTERNAL_NOTIFICATION_CONNECTIONS_ENABLED } from "../../config/features";

type DiagnosticsSectionProps = {
  diagnostics: OperationalDiagnostics;
  isExpanded: boolean;
  forceExpanded?: boolean;
  onToggle: () => void;
};

function relativeTime(timestamp: number | null): string {
  if (!timestamp) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function statusClass(status: string): "healthy" | "warning" | "error" | "idle" {
  if (["connected", "healthy"].includes(status)) return "healthy";
  if (["degraded", "disconnected"].includes(status)) return "error";
  if (["drift-repaired", "attention"].includes(status)) return "warning";
  return "idle";
}

export default function DiagnosticsSection({
  diagnostics,
  isExpanded,
  forceExpanded = false,
  onToggle,
}: DiagnosticsSectionProps) {
  const [confirmations, setConfirmations] = useState<Record<string, string>>({});
  const backend = diagnostics.backend;
  const operationSafety = diagnostics.operationSafety;
  const expanded = forceExpanded || isExpanded;
  const sidecarStatus = diagnostics.isDesktop ? diagnostics.backendConnection : "browser-mode";
  const userStreamStatus =
    diagnostics.frontendStreamConnection === "disabled"
      ? "disabled"
      : (backend?.userStream.status ?? diagnostics.frontendStreamConnection);

  const rows = [
    {
      label: diagnostics.isDesktop ? "Sidecar / backend" : "Backend",
      status: sidecarStatus,
      detail: diagnostics.error ?? `REST health ${diagnostics.backendConnection}`,
    },
    {
      label: "Exchange connectivity",
      status: backend?.exchange.status ?? "unavailable",
      detail:
        backend?.exchange.lastError ??
        `Last success ${relativeTime(backend?.exchange.lastSuccessAtMs ?? null)}`,
    },
    {
      label: "Market data",
      status: diagnostics.marketConnection,
      detail:
        diagnostics.marketConnection === "connected"
          ? "Live candle polling is current"
          : "Chart may be showing the last known candle",
    },
    {
      label: "User stream",
      status: userStreamStatus,
      detail:
        backend?.userStream.lastError ??
        `Last backend stream event ${relativeTime(backend?.userStream.lastEventAtMs ?? null)}`,
    },
    {
      label: "Reconciliation",
      status: backend?.reconciliation.status ?? "unavailable",
      detail:
        backend?.reconciliation.lastError ??
        `${backend?.reconciliation.driftCount ?? 0} cache drift repair(s) · last check ${relativeTime(backend?.reconciliation.lastSuccessAtMs ?? null)}`,
    },
    {
      label: "Rejected requests",
      status: (backend?.requests.rejectedCount ?? 0) > 0 ? "attention" : "healthy",
      detail: `${backend?.requests.rejectedCount ?? 0} since backend start${backend?.requests.lastRejection ? ` · ${backend.requests.lastRejection}` : ""}`,
    },
    {
      label: "Duplicate requests",
      status: (backend?.requests.duplicateCount ?? 0) > 0 ? "degraded" : "healthy",
      detail: `${backend?.requests.duplicateCount ?? 0} detected since backend start`,
    },
    ...(EXTERNAL_NOTIFICATION_CONNECTIONS_ENABLED
      ? [
          {
            label: "Notification delivery",
            status: (backend?.notifications.failureCount ?? 0) > 0 ? "attention" : "healthy",
            detail: backend?.notifications.lastFailure
              ? `${backend.notifications.failureCount} failure(s) · ${backend.notifications.lastFailure}`
              : "No delivery failures since backend start",
          },
        ]
      : []),
  ];

  return (
    <section className="settings-section settings-diagnostics">
      <div className="settings-section-heading settings-section-heading-with-action">
        <div>
          <h3>Diagnostics</h3>
          {expanded && <p>Runtime health and safe operational counters.</p>}
        </div>
        <button
          type="button"
          className="settings-section-visibility-button"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {forceExpanded ? "MATCH" : isExpanded ? "HIDE" : "SHOW"}
        </button>
      </div>

      {expanded && (
        <>
          {operationSafety?.blocksNewExposure && (
            <div className="settings-intent-recovery" role="status">
              <div className="settings-intent-recovery-heading">
                <div>
                  <strong>UNCERTAIN OPERATION</strong>
                  <span>New entries and ADD are blocked</span>
                </div>
                <b>{operationSafety.unresolved.length}</b>
              </div>
              <p>
                A previous backend run stopped before it could save the final result. Cancel,
                Reduce, Stop Loss, Close Position and Close Everything remain available.
              </p>
              {operationSafety.unresolved.map((intent) => {
                const confirmation = confirmations[intent.intentId] ?? "";
                const resolving = diagnostics.resolvingIntentId === intent.intentId;
                return (
                  <div className="settings-intent-recovery-item" key={intent.intentId}>
                    <div>
                      <code>
                        {intent.method} {intent.path}
                      </code>
                      <small>
                        Recorded {relativeTime(intent.createdAtMs)} · ID{" "}
                        {intent.intentId.slice(0, 8)}
                      </small>
                    </div>
                    <ol>
                      <li>Check Binance Positions, Open Orders and Order History.</li>
                      <li>
                        Type <kbd>{operationSafety.confirmationPhrase}</kbd> below.
                      </li>
                    </ol>
                    <input
                      type="text"
                      value={confirmation}
                      autoComplete="off"
                      spellCheck={false}
                      aria-label={`Confirmation for uncertain operation ${intent.intentId}`}
                      placeholder={operationSafety.confirmationPhrase}
                      onChange={(event) =>
                        setConfirmations((current) => ({
                          ...current,
                          [intent.intentId]: event.target.value,
                        }))
                      }
                    />
                    <button
                      type="button"
                      disabled={
                        resolving || confirmation.trim() !== operationSafety.confirmationPhrase
                      }
                      onClick={() => {
                        void diagnostics
                          .resolveIntent(intent.intentId, confirmation)
                          .then(() =>
                            setConfirmations((current) => {
                              const next = { ...current };
                              delete next[intent.intentId];
                              return next;
                            }),
                          )
                          .catch(() => undefined);
                      }}
                    >
                      {resolving ? "REFRESHING BINANCE…" : "RECONCILE & RESOLVE"}
                    </button>
                  </div>
                );
              })}
              {diagnostics.resolutionError && (
                <p className="settings-intent-recovery-error" role="alert">
                  {diagnostics.resolutionError}
                </p>
              )}
            </div>
          )}
          <div className="settings-diagnostics-toolbar">
            <small>
              {diagnostics.isLoading && !backend ? (
                <LoadingIndicator variant="inline" label="Loading diagnostics" />
              ) : (
                `Updated ${relativeTime(diagnostics.refreshedAt)}`
              )}
            </small>
            <button type="button" onClick={() => void diagnostics.refresh()}>
              REFRESH
            </button>
          </div>
          <div className="settings-diagnostics-list">
            {rows.map((row) => (
              <div key={row.label}>
                <span>{row.label}</span>
                <div>
                  <b className={statusClass(row.status)}>{row.status.toUpperCase()}</b>
                  <small title={row.detail}>{row.detail}</small>
                </div>
              </div>
            ))}
          </div>
          <p className="settings-diagnostics-note">
            Counters reset with the backend. Secrets, request bodies and private URLs are never
            included.
          </p>
        </>
      )}
    </section>
  );
}
