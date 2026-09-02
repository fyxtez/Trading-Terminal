import type { DesktopCredentialsContextValue } from "../DesktopSetupGate/DesktopCredentialsContext";

type DesktopConnectionsSectionProps = {
  credentials: DesktopCredentialsContextValue;
};

export function DesktopConnectionsSection({
  credentials,
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
  const hasMissingConnection = connections.some(
    ([, , configured]) => !configured,
  );

  return (
    <section className="settings-section settings-desktop-connections">
      <div className="settings-section-heading">
        <h3>Desktop connections</h3>
        <p>Credentials stored securely on this computer.</p>
      </div>
      <div className="settings-connection-statuses">
        {connections.map(([label, connection, configured, detail]) => (
          <div className={configured ? "connected" : ""} key={connection}>
            <span>{label}</span>
            <div>
              <b>
                {configured
                  ? `CONNECTED${detail ? ` · ${detail}` : ""}`
                  : "NOT SET"}
              </b>
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
        <strong className={error ? "error" : ""}>
          {isLoading
            ? "Loading…"
            : error
              ? "Unavailable"
              : availableBalance !== null
                ? balanceFormatter.format(availableBalance)
                : "—"}
        </strong>

        {!isLoading && !error && (
          <span className="settings-balance-unit">USDT</span>
        )}
      </div>
    </section>
  );
}
