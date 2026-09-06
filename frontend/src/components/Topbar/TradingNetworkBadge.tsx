type TradingNetworkBadgeProps = {
  network: "mainnet" | "testnet" | null;
};

export default function TradingNetworkBadge({ network }: TradingNetworkBadgeProps) {
  if (!network) {
    return (
      <div
        className="topbar-network-badge unavailable"
        aria-label="Binance account not set"
        title="Binance is not set up · Open Settings → Exchange Connections"
      >
        <span aria-hidden="true" />
        BINANCE · NOT SET
      </div>
    );
  }

  const live = network === "mainnet";
  return (
    <div
      className={`topbar-network-badge ${live ? "live" : "demo"}`}
      aria-label={`Binance ${live ? "live trading" : "practice trading"}`}
      title={live ? "LIVE · real funds and real orders" : "PRACTICE · test funds and test orders"}
    >
      <span aria-hidden="true" />
      BINANCE · {live ? "LIVE" : "PRACTICE"}
    </div>
  );
}
