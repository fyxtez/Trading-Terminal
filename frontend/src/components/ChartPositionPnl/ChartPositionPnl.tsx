import "./ChartPositionPnl.css";

type ChartPositionPnlProps = {
  pnl: number;
  /**
   * "current" is active-symbol UPNL, "realized" is realized PNL
   * belonging only to that open lifecycle, and "total" remains account-wide
   * unrealized PNL. Separate variants prevent ambiguous combined numbers.
   */
  variant?: "current" | "realized" | "total";
};

function formatPnl(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export default function ChartPositionPnl({ pnl, variant = "current" }: ChartPositionPnlProps) {
  const tone = pnl > 0 ? "positive" : pnl < 0 ? "negative" : "neutral";
  const isTotal = variant === "total";
  const isRealized = variant === "realized";
  const title = isTotal
    ? "Total unrealized PNL across all open positions"
    : isRealized
      ? "Realized PNL from partial closes in the current position lifecycle"
      : "Current unrealized position PNL";
  const label = isTotal ? "TOTAL" : isRealized ? "RPNL" : "UPNL";

  return (
    <div
      className={`chart-position-pnl ${tone} chart-position-pnl--${variant}`}
      title={title}
      aria-label={`${title} ${formatPnl(pnl)}`}
    >
      <span>{label}</span>
      <strong>{formatPnl(pnl)}</strong>
    </div>
  );
}
