import { useState } from "react";
import type { DesktopCredentialsContextValue } from "../DesktopSetupGate/DesktopCredentialsContext";
import LoadingIndicator from "../LoadingIndicator/LoadingIndicator";
import { EXTERNAL_NOTIFICATION_CONNECTIONS_ENABLED } from "../../config/features";
import { userFacingError } from "../../utils/userFacingError";

type ExchangeConnectionsSectionProps = {
  credentials: DesktopCredentialsContextValue;
  isExpanded: boolean;
  forceExpanded?: boolean;
  onToggle: () => void;
};

export function ExchangeConnectionsSection({
  credentials,
  isExpanded,
  forceExpanded = false,
  onToggle,
}: ExchangeConnectionsSectionProps) {
  const [disconnectConfirmationOpen, setDisconnectConfirmationOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const connections = [
    [
      "Binance",
      "binance",
      credentials.status.binanceConfigured,
      credentials.status.binanceNetwork?.toUpperCase(),
    ],
    ...(EXTERNAL_NOTIFICATION_CONNECTIONS_ENABLED
      ? ([
          ["ntfy", "ntfy", credentials.status.ntfyConfigured, undefined],
          ["Telegram", "telegram", credentials.status.telegramConfigured, undefined],
        ] as const)
      : []),
  ] as const satisfies ReadonlyArray<
    readonly [string, "binance" | "ntfy" | "telegram", boolean, string | undefined]
  >;
  const hasMissingConnection = connections.some(([, , configured]) => !configured);

  const confirmDisconnect = () => {
    setDisconnecting(true);
    setDisconnectError(null);
    void credentials
      .disconnectBinance()
      .then(() => setDisconnectConfirmationOpen(false))
      .catch((reason: unknown) => {
        setDisconnectError(userFacingError(reason, "Terminal could not disconnect Binance."));
      })
      .finally(() => setDisconnecting(false));
  };

  return (
    <section className="settings-section settings-desktop-connections">
      <div className="settings-section-heading settings-section-heading-with-action">
        <h3>Exchange Connections</h3>
        <button
          type="button"
          className="settings-section-visibility-button"
          aria-expanded={forceExpanded || isExpanded}
          onClick={onToggle}
        >
          {forceExpanded ? "MATCH" : isExpanded ? "HIDE" : "SHOW"}
        </button>
      </div>
      {(forceExpanded || isExpanded) &&
        (credentials.isDesktop ? (
          <>
            <div className="settings-connection-statuses">
              {connections.map(([label, connection, configured, detail]) => (
                <div className={configured ? "connected" : ""} key={connection}>
                  <div className="settings-connection-heading">
                    <span>{label}</span>
                    <b>{configured ? `CONNECTED${detail ? ` · ${detail}` : ""}` : "NOT SET"}</b>
                  </div>
                  <div className="settings-connection-actions">
                    <button type="button" onClick={() => credentials.openSetup(connection)}>
                      {configured ? "EDIT" : "CONNECT"}
                    </button>
                    {connection === "binance" && configured && (
                      <button
                        className="danger"
                        type="button"
                        disabled={disconnecting}
                        onClick={() => {
                          setDisconnectError(null);
                          setDisconnectConfirmationOpen(true);
                        }}
                      >
                        DISCONNECT
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {disconnectConfirmationOpen && (
              <div
                className="settings-disconnect-confirmation"
                role="group"
                aria-label="Confirm Binance disconnect"
              >
                <div>
                  <strong>Disconnect Binance?</strong>
                  <span>
                    Trading will be disabled immediately. Your charts, drawings and settings will
                    stay available.
                  </span>
                </div>
                {disconnectError && (
                  <div className="settings-disconnect-error" role="alert">
                    {disconnectError}
                  </div>
                )}
                <div className="settings-disconnect-actions">
                  <button
                    type="button"
                    disabled={disconnecting}
                    onClick={() => {
                      setDisconnectError(null);
                      setDisconnectConfirmationOpen(false);
                    }}
                  >
                    CANCEL
                  </button>
                  <button
                    className="danger"
                    type="button"
                    disabled={disconnecting}
                    onClick={confirmDisconnect}
                  >
                    {disconnecting ? "DISCONNECTING…" : "CONFIRM DISCONNECT"}
                  </button>
                </div>
              </div>
            )}
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
        ) : credentials.runtimeMode === "local-browser" ? (
          <div
            className={`settings-browser-connection-note ${credentials.status.binanceConfigured ? "connected" : ""}`}
          >
            <div className="settings-connection-heading">
              <span>Binance</span>
              <b>
                {credentials.status.binanceConfigured
                  ? `CONNECTED${credentials.status.binanceNetwork ? ` · ${credentials.status.binanceNetwork.toUpperCase()}` : ""}`
                  : "NOT SET"}
              </b>
            </div>
            <p>
              {credentials.status.binanceConfigured
                ? "Trading is handled securely by Terminal on this computer. Open the installed app to replace or remove your Binance keys."
                : "Open the installed Terminal app and use Settings → Exchange Connections to connect Binance."}
            </p>
            <small>Binance keys are not exposed to the browser interface.</small>
          </div>
        ) : (
          <div className="settings-browser-connection-note">
            <div className="settings-connection-heading">
              <span>Binance</span>
              <b>INSTALLED APP ONLY</b>
            </div>
            <p>
              This browser window is for charts only. Open the installed Linux or Android app, then
              use Settings → Exchange Connections to connect Binance and trade.
            </p>
          </div>
        ))}
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
