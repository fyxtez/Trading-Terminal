type TradingNetworkBadgeProps = {
  network: "mainnet" | "testnet" | null;
};

export default function TradingNetworkBadge({ network }: TradingNetworkBadgeProps) {
  if (!network) {
    return (
      <div
        className="topbar-network-badge unavailable"
        aria-label="Binance not connected"
        title="NOT CONNECTED · trading is disabled"
      >
        <span aria-hidden="true" />
        NOT CONNECTED
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
      {live ? "LIVE" : "PRACTICE"}
    </div>
  );
}
