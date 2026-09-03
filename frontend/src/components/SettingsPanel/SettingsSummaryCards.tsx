import type { DesktopCredentialsContextValue } from "../DesktopSetupGate/DesktopCredentialsContext";
import LoadingIndicator from "../LoadingIndicator/LoadingIndicator";

type DesktopConnectionsSectionProps = {
  credentials: DesktopCredentialsContextValue;
  isExpanded: boolean;
  forceExpanded?: boolean;
  onToggle: () => void;
};

export function DesktopConnectionsSection({
  credentials,
  isExpanded,
  forceExpanded = false,
  onToggle,
}: DesktopConnectionsSectionProps) {
  const connections = [
    [
      "Binance",
      "binance",
      credentials.status.binanceConfigured,
      credentials.status.binanceNetwork?.toUpperCase(),
    ],
    ["ntfy", "ntfy", credentials.status.ntfyConfigured, undefined],
    ["Telegram", "telegram", credentials.status.telegramConfigured, undefined],
  ] as const;
  const hasMissingConnection = connections.some(([, , configured]) => !configured);

  return (
    <section className="settings-section settings-desktop-connections">
      <div className="settings-section-heading settings-section-heading-with-action">
        <h3>Third-Party Connections</h3>
        <button
          type="button"
          className="settings-section-visibility-button"
          aria-expanded={forceExpanded || isExpanded}
          onClick={onToggle}
        >
          {forceExpanded ? "MATCH" : isExpanded ? "HIDE" : "SHOW"}
        </button>
      </div>
      {(forceExpanded || isExpanded) && (
        <>
          <div className="settings-connection-statuses">
            {connections.map(([label, connection, configured, detail]) => (
              <div className={configured ? "connected" : ""} key={connection}>
                <span>{label}</span>
                <div>
                  <b>{configured ? `CONNECTED${detail ? ` · ${detail}` : ""}` : "NOT SET"}</b>
                  <button type="button" onClick={() => credentials.openSetup(connection)}>
                    {configured ? "EDIT" : "CONNECT"}
                  </button>
                </div>
              </div>
            ))}
          </div>
          {hasMissingConnection && (
            <button
              type="button"
              className="settings-manage-connections"
              onClick={() => credentials.openSetup()}
            >
              SET UP MISSING CONNECTIONS
            </button>
          )}
        </>
      )}
    </section>
  );
}

const balanceFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

type AvailableBalanceCardProps = {
  availableBalance: number | null;
  error: string | null;
  isLoading: boolean;
};

export function AvailableBalanceCard({
  availableBalance,
  error,
  isLoading,
}: AvailableBalanceCardProps) {
  return (
    <section className="settings-balance-card" aria-label="Available balance">
      <div className="settings-balance-copy">
        <span className="settings-balance-label">Available balance</span>
        <small>USDT futures wallet</small>
      </div>

      <div className="settings-balance-value">
        {isLoading ? (
          <LoadingIndicator variant="inline" label="Loading balance" />
        ) : (
          <strong className={error ? "error" : ""}>
            {error
              ? "Unavailable"
              : availableBalance !== null
                ? balanceFormatter.format(availableBalance)
                : "—"}
          </strong>
        )}

        {!isLoading && !error && <span className="settings-balance-unit">USDT</span>}
      </div>
    </section>
  );
}
