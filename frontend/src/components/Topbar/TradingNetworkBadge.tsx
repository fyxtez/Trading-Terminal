type TradingNetworkBadgeProps = {
  onClick?: () => void;
  network: "mainnet" | "testnet" | null;
};

export default function TradingNetworkBadge({ network, onClick }: TradingNetworkBadgeProps) {
  if (!network) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="topbar-network-badge unavailable"
        aria-label="Binance account not set"
        title="Set up Binance network and API keys"
      >
        <span aria-hidden="true" />
        BINANCE · NOT SET
      </button>
    );
  }

  const live = network === "mainnet";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`topbar-network-badge ${live ? "live" : "demo"}`}
      aria-label={`Binance ${live ? "live trading" : "practice trading"}`}
      title={`${live ? "LIVE · real funds and real orders" : "PRACTICE · test funds and test orders"} · Manage network and API keys`}
    >
      <span aria-hidden="true" />
      BINANCE · {live ? "LIVE" : "PRACTICE"}
    </button>
  );
}
