import type { TradeToastState } from "../../trading/types";
import "./TradeToast.css";

type TradeToastProps = {
  tradeToast: TradeToastState;
  onDismiss: () => void;
};

export default function TradeToast({ tradeToast, onDismiss }: TradeToastProps) {
  return (
    <div
      className={`trade-toast ${tradeToast.kind}`}
      onClick={(event) => {
        event.stopPropagation();
        onDismiss();
      }}
    >
      {tradeToast.message}
    </div>
  );
}
