import type { OperationalDiagnostics } from "../../hooks/useOperationalDiagnostics";
import LoadingIndicator from "../LoadingIndicator/LoadingIndicator";

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
  const backend = diagnostics.backend;
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
    {
      label: "Notification delivery",
      status: (backend?.notifications.failureCount ?? 0) > 0 ? "attention" : "healthy",
      detail: backend?.notifications.lastFailure
        ? `${backend.notifications.failureCount} failure(s) · ${backend.notifications.lastFailure}`
        : "No delivery failures since backend start",
    },
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
