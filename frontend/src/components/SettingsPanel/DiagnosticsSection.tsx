import { useState } from "react";
import type { OperationalDiagnostics } from "../../hooks/useOperationalDiagnostics";
import LoadingIndicator from "../LoadingIndicator/LoadingIndicator";
import { EXTERNAL_NOTIFICATION_CONNECTIONS_ENABLED } from "../../config/features";
import { userFacingError } from "../../utils/userFacingError";

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

function statusLabel(status: string): string {
  if (["connected", "healthy", "browser-mode"].includes(status)) return "READY";
  if (status === "connecting") return "CONNECTING";
  if (status === "disabled") return "NOT IN USE";
  if (["attention", "drift-repaired"].includes(status)) return "CHECK";
  if (["degraded", "disconnected", "unavailable"].includes(status)) return "NOT READY";
  return "WAITING";
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
  const appStatus = diagnostics.isDesktop ? diagnostics.backendConnection : "browser-mode";
  const userStreamStatus =
    diagnostics.frontendStreamConnection === "disabled"
      ? "disabled"
      : (backend?.userStream.status ?? diagnostics.frontendStreamConnection);

  const rows = [
    {
      label: "Fyxtez",
      status: appStatus,
      detail: diagnostics.error
        ? userFacingError(diagnostics.error, "Fyxtez needs attention.")
        : diagnostics.backendConnection === "connected"
          ? "The app is ready"
          : "The app is trying to reconnect",
    },
    {
      label: "Binance trading",
      status: backend?.exchange.status ?? "unavailable",
      detail: backend?.exchange.lastError
        ? userFacingError(backend.exchange.lastError, "Could not reach Binance.")
        : `Last checked ${relativeTime(backend?.exchange.lastSuccessAtMs ?? null)}`,
    },
    {
      label: "Live prices",
      status: diagnostics.marketConnection,
      detail:
        diagnostics.marketConnection === "connected"
          ? "The chart is receiving current prices"
          : "The chart may be showing the last known price",
    },
    {
      label: "Account updates",
      status: userStreamStatus,
      detail: backend?.userStream.lastError
        ? userFacingError(backend.userStream.lastError, "Account updates are delayed.")
        : `Last update ${relativeTime(backend?.userStream.lastEventAtMs ?? null)}`,
    },
    {
      label: "Binance account check",
      status: backend?.reconciliation.status ?? "unavailable",
      detail: backend?.reconciliation.lastError
        ? userFacingError(backend.reconciliation.lastError, "Could not check your Binance account.")
        : `${backend?.reconciliation.driftCount ?? 0} automatic correction(s) · last checked ${relativeTime(backend?.reconciliation.lastSuccessAtMs ?? null)}`,
    },
    {
      label: "Blocked actions",
      status: (backend?.requests.rejectedCount ?? 0) > 0 ? "attention" : "healthy",
      detail: `${backend?.requests.rejectedCount ?? 0} blocked since Fyxtez started${backend?.requests.lastRejection ? ` · ${userFacingError(backend.requests.lastRejection, "See Binance for details.")}` : ""}`,
    },
    {
      label: "Repeated actions",
      status: (backend?.requests.duplicateCount ?? 0) > 0 ? "degraded" : "healthy",
      detail: `${backend?.requests.duplicateCount ?? 0} safely prevented since Fyxtez started`,
    },
    ...(EXTERNAL_NOTIFICATION_CONNECTIONS_ENABLED
      ? [
          {
            label: "Notification delivery",
            status: (backend?.notifications.failureCount ?? 0) > 0 ? "attention" : "healthy",
            detail: backend?.notifications.lastFailure
              ? `${backend.notifications.failureCount} problem(s) · ${userFacingError(backend.notifications.lastFailure, "Notification could not be delivered.")}`
              : "No delivery problems since Fyxtez started",
          },
        ]
      : []),
  ];

  return (
    <section className="settings-section settings-diagnostics">
      <div className="settings-section-heading settings-section-heading-with-action">
        <div>
          <h3>App status</h3>
          {expanded && <p>Check whether prices, trading and account updates are working.</p>}
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
                  <strong>CHECK A PREVIOUS ACTION</strong>
                  <span>Opening or adding to positions is paused</span>
                </div>
                <b>{operationSafety.unresolved.length}</b>
              </div>
              <p>
                Fyxtez lost the connection before it could confirm whether Binance completed a
                previous action. You can still cancel orders, reduce risk, use a stop loss or close
                positions.
              </p>
              {operationSafety.unresolved.map((intent) => {
                const confirmation = confirmations[intent.intentId] ?? "";
                const resolving = diagnostics.resolvingIntentId === intent.intentId;
                return (
                  <div className="settings-intent-recovery-item" key={intent.intentId}>
                    <div>
                      <strong>Action started {relativeTime(intent.createdAtMs)}</strong>
                    </div>
                    <ol>
                      <li>Check Positions, Open Orders and Order History in Binance.</li>
                      <li>
                        Type <kbd>{operationSafety.confirmationPhrase}</kbd> below.
                      </li>
                    </ol>
                    <input
                      type="text"
                      value={confirmation}
                      autoComplete="off"
                      spellCheck={false}
                      aria-label={`Confirmation for the action started ${relativeTime(intent.createdAtMs)}`}
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
                      {resolving ? "CHECKING BINANCE…" : "I CHECKED BINANCE — CONTINUE"}
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
                <LoadingIndicator variant="inline" label="Checking app status" />
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
                  <b className={statusClass(row.status)}>{statusLabel(row.status)}</b>
                  <small title={row.detail}>{row.detail}</small>
                </div>
              </div>
            ))}
          </div>
          <p className="settings-diagnostics-note">
            These counts restart when Fyxtez closes. Your Binance keys and private information are
            never shown here.
          </p>
        </>
      )}
    </section>
  );
}
