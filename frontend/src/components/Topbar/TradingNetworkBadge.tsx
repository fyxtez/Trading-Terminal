type TradingNetworkBadgeProps = {
  network: "mainnet" | "testnet" | null;
};

export default function TradingNetworkBadge({ network }: TradingNetworkBadgeProps) {
  if (!network) {
    return (
      <div
        className="topbar-network-badge unavailable"
        aria-label="Binance not connected"
        title="NO BINANCE · private trading is disabled"
      >
        <span aria-hidden="true" />
        NO BINANCE
      </div>
    );
  }

  const live = network === "mainnet";
  return (
    <div
      className={`topbar-network-badge ${live ? "live" : "demo"}`}
      aria-label={`Binance ${live ? "Live Mainnet" : "Demo Testnet"}`}
      title={
        live
          ? "LIVE · Binance Mainnet · real funds and real orders"
          : "DEMO · Binance Testnet · test funds and test orders"
      }
    >
      <span aria-hidden="true" />
      {live ? "LIVE" : "DEMO"}
    </div>
  );
}
