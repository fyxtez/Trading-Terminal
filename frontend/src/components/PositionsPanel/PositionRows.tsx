import { useMemo, useState } from "react";
import type { OpenPosition } from "../../trading/api/positions";
import type {
  OpenOrder,
  UpdateReduceOrderResponse,
} from "../../trading/api/orders";
import { getCachedSymbolFilters } from "../../trading/api/exchangeInfo";
import type { SavedStop } from "../../trading/stopLoss";
import { parseReduceMetadata } from "../../trading/reduceMetadata";

// clientOrderId prefix used for the synthetic Open-Orders row that
// represents a locally-tracked full stop-loss (a Binance conditional
// order, not a regular one - see trading/stopLoss.ts). Used to tell a
// synthetic row apart from a real order returned by the backend.
const SYNTHETIC_STOP_CLIENT_ORDER_ID_PREFIX = "fe-sl-full-";

export function isSyntheticStopOrder(order: OpenOrder): boolean {
  return (
    order.clientOrderId?.startsWith(SYNTHETIC_STOP_CLIENT_ORDER_ID_PREFIX) ??
    false
  );
}

export function isFullTakeProfitOrder(order: OpenOrder): boolean {
  if (!(order.type === "LIMIT" || order.origType === "LIMIT")) {
    return false;
  }

  const isReduce =
    order.reduceOnly || order.clientOrderId?.startsWith("fe-red-") === true;
  if (!isReduce) return false;

  const metadata = parseReduceMetadata(order.clientOrderId);
  return metadata.reducePct === 100 || metadata.remainingPct === 0;
}

export function buildSyntheticStopOrder(stop: SavedStop): OpenOrder {
  const nowMs = Date.now();

  return {
    // Real Binance order IDs are purely-numeric strings; prefixing with
    // non-numeric characters keeps this guaranteed distinct from any
    // real orderId so it can never collide with one.
    orderId: `synthetic-stop-${stop.algoId}`,
    clientOrderId: `${SYNTHETIC_STOP_CLIENT_ORDER_ID_PREFIX}${stop.algoId}`,
    symbol: stop.symbol,
    side: stop.side,
    type: "STOP_MARKET",
    origType: "STOP_MARKET",
    status: "NEW",
    price: stop.triggerPrice.toString(),
    origQty: "0",
    timeInForce: "GTC",
    executedQty: "0",
    avgPrice: "0",
    time: nowMs,
    updateTime: nowMs,
    reduceOnly: true,
  };
}

/**
 * Formats a price using the SPECIFIC symbol's own real tick precision
 * (see trading/api/exchangeInfo.ts), falling back to 2 decimals if that
 * symbol's filters haven't been cached yet. This used to be one shared
 * Intl.NumberFormat fixed at 1 decimal for every row regardless of
 * symbol - fine for BTC, but a symbol needing more precision (XRP, for
 * instance) had every price in this table rounded down to a single
 * decimal, making distinct prices indistinguishable from each other.
 * Positions/orders in this panel can span several different symbols at
 * once, so this has to be resolved per-row rather than once globally.
 */
function formatPriceForSymbol(value: number, symbol: string): string {
  const precision = getCachedSymbolFilters(symbol)?.pricePrecision;

  if (precision === undefined) {
    // FIX: Positions can contain symbols that have never been opened on the
    // chart, so their exchange filters may not be cached yet. Falling back to
    // two decimals turned prices such as PUMP 0.0029797 into a misleading 0.00.
    // Until the exact tick precision is known, preserve useful significant
    // decimals instead of fabricating a zero-looking price.
    return value.toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 8,
    });
  }

  return value.toLocaleString("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

const moneyFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const quantityFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 8,
});

function baseAsset(symbol: string): string {
  return symbol.replace(/(?:USDT|USDC|BUSD)$/i, "") || symbol;
}

/** "BTCUSDT" -> "BTC/USDT" for display only - API calls still use the plain symbol. */
export function formatSymbolWithSlash(symbol: string): string {
  const match = symbol.match(/^(.*?)(USDT|USDC|BUSD)$/i);
  return match ? `${match[1]}/${match[2].toUpperCase()}` : symbol;
}

export function PositionRow({
  position,
  isClosing,
  onCloseMarket,
  fullTakeProfitPrice,
  stopLossPrice,
  areTpSlControlsShown,
  onToggleTpSlControls,
  isFocused,
  onFocus,
  onSwitchSymbol,
  isInteractive,
}: {
  position: OpenPosition;
  isClosing: boolean;
  onCloseMarket: () => void;
  fullTakeProfitPrice: number | null;
  stopLossPrice: number | null;
  areTpSlControlsShown: boolean;
  onToggleTpSlControls: () => void;
  isFocused: boolean;
  onFocus: () => void;
  onSwitchSymbol: () => void;
  isInteractive: boolean;
}) {
  const isPositive = position.unrealized_pnl >= 0;
  const realizedTone = position.realized_pnl === null
    ? ""
    : position.realized_pnl >= 0 ? "positive" : "negative";

  // Unlike Open Orders rows, a Positions row is always clickable - if
  // it's not for the currently active chart symbol, clicking it first
  // switches the chart over to that symbol (same as picking it from the
  // Topbar dropdown), then highlights the position exactly like an
  // already-active row would. So there's no "inactive" visual state
  // here at all; every row behaves like a real chart control.
  const handleRowActivate = () => {
    if (!isInteractive) {
      onSwitchSymbol();
    }
    onFocus();
  };

  return (
    <div
      className={`position-row focusable-order-row ${
        isFocused ? "focused-order-row" : ""
      }`}
      role="button"
      tabIndex={0}
      onClick={handleRowActivate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleRowActivate();
        }
      }}
      title={
        isInteractive
          ? "Click row to highlight this position on the chart"
          : `Click row to switch to ${position.symbol} and highlight this position`
      }
    >
      <div className="position-symbol-cell">
        <strong>{position.symbol}</strong>
        <div>
          <span className={`position-side ${position.side.toLowerCase()}`}>
            {position.side}
          </span>
          <span className="position-leverage">{position.leverage}x</span>
        </div>
      </div>

      <div className="position-value">
        <span>Size</span>
        {/* FEATURE: SIZE is the current position notional, which tracks mark
            price and is therefore more precise than margin × leverage. */}
        <strong>{moneyFormatter.format(position.size)} USDT</strong>
      </div>

      <div className="position-value">
        <span>Remaining Size</span>
        <strong>
          {quantityFormatter.format(position.quantity)} {baseAsset(position.symbol)}
        </strong>
      </div>

      <div className="position-value">
        <span>Entry</span>
        <strong>{formatPriceForSymbol(position.entry_price, position.symbol)}</strong>
      </div>

      <div className="position-value position-protection-value take-profit">
        <span>Full TP</span>
        <strong>
          {fullTakeProfitPrice === null
            ? "—"
            : formatPriceForSymbol(fullTakeProfitPrice, position.symbol)}
        </strong>
      </div>

      <div className="position-value position-protection-value stop-loss">
        <span>Stop Loss</span>
        <strong>
          {stopLossPrice === null
            ? "—"
            : formatPriceForSymbol(stopLossPrice, position.symbol)}
        </strong>
      </div>

      {/* TP/SL visibility belongs directly beside the Stop Loss column.
          This is intentionally NOT placed at the far-right end of the row: the
          control should be visible exactly where the user manages TP/SL state. */}
      <div className="position-tpsl-visibility-cell">
        <button
          className="position-tpsl-visibility"
          onClick={(event) => {
            event.stopPropagation();
            onToggleTpSlControls();
          }}
          title={`${areTpSlControlsShown ? "Hide" : "Show"} TP/SL chart controls for ${position.symbol}`}
        >
          {areTpSlControlsShown ? "Hide" : "Show"}
        </button>
      </div>

      <div className="position-value">
        <span>Liquidation</span>
        <strong className="liquidation-value">
          {position.liquidation_price === null
            ? "—"
            : formatPriceForSymbol(position.liquidation_price, position.symbol)}
        </strong>
      </div>

      <div className="position-value">
        <span>Margin</span>
        <strong>{moneyFormatter.format(position.margin)} USDT</strong>
      </div>

      <div className="position-value">
        <span>Unrealized PNL (ROI)</span>
        <strong className={isPositive ? "positive" : "negative"}>
          {moneyFormatter.format(position.unrealized_pnl)} USDT
          <small>{position.roi_pct.toFixed(2)}%</small>
        </strong>
      </div>

      <div className="position-value">
        <span>Realized PNL</span>
        {/* FEATURE: show only realized PNL proven to belong to this open
            position lifecycle; incomplete Binance history is rendered as —. */}
        <strong className={realizedTone}>
          {position.realized_pnl === null
            ? "—"
            : `${moneyFormatter.format(position.realized_pnl)} USDT`}
        </strong>
      </div>

      <div className="position-close-cell">
        <button
          className="position-market-close"
          disabled={isClosing || !isInteractive}
          onClick={(event) => {
            event.stopPropagation();
            onCloseMarket();
          }}
        >
          {isClosing ? "Closing…" : "Market"}
        </button>
      </div>

    </div>
  );
}

export function OpenOrderRow({
  order,
  position,
  allOrders,
  isCancelling,
  isUpdating,
  isChasing,
  onCancel,
  onUpdateReduce,
  onChase,
  isFocused,
  onFocus,
  onSwitchSymbol,
  isInteractive,
}: {
  order: OpenOrder;
  position: OpenPosition | undefined;
  allOrders: OpenOrder[];
  isCancelling: boolean;
  isUpdating: boolean;
  isChasing: boolean;
  onCancel: () => void;
  onUpdateReduce: (
    reducePct: number,
  ) => Promise<UpdateReduceOrderResponse | undefined>;
  onChase: () => Promise<unknown>;
  isFocused: boolean;
  onFocus: () => void;
  onSwitchSymbol: () => void;
  isInteractive: boolean;
}) {
  const sideClass = order.side === "BUY" ? "long" : "short";
  const [isEditingReduce, setIsEditingReduce] = useState(false);
  const [reducePct, setReducePct] = useState(100);
  /**
   * FIX (confusing mismatched percentages after editing a reduce order):
   * when a requested reduce % computes to a quantity below the
   * exchange's minimum order size, the backend silently bumps the
   * quantity up to that minimum instead of rejecting it - which can make
   * the resulting percentage look completely disconnected from what was
   * actually requested (e.g. asking for 1% and ending up with a order
   * that's labeled 16%). The backend already returns both
   * requested_reduce_pct and the actual reduce_pct; this just surfaces
   * that instead of silently applying the swap with no explanation.
   */
  const [reduceBumpNotice, setReduceBumpNotice] = useState<string | null>(null);
  const isStopRow = isSyntheticStopOrder(order);

  const isReduceLimit =
    order.reduceOnly &&
    (order.type === "LIMIT" || order.origType === "LIMIT");

  const reduceMath = useMemo(() => {
    if (!isReduceLimit || !position) {
      return {
        availableBefore: 0,
        currentQuantity: 0,
        remainingAfter: 0,
        initialPct: 100,
      };
    }

    const otherReserved = allOrders
      .filter(
        (item) =>
          item.orderId !== order.orderId &&
          item.symbol === order.symbol &&
          item.side === order.side &&
          item.reduceOnly,
      )
      .reduce((sum, item) => {
        const remaining = Math.max(
          0,
          Number(item.origQty) - Number(item.executedQty || 0),
        );
        return sum + (Number.isFinite(remaining) ? remaining : 0);
      }, 0);

    const currentQuantity = Math.max(
      0,
      Number(order.origQty) - Number(order.executedQty || 0),
    );
    const availableBefore = Math.max(
      currentQuantity,
      position.quantity - otherReserved,
    );
    const initialPct =
      availableBefore > 0
        ? Math.max(
            1,
            Math.min(100, Math.round((currentQuantity / availableBefore) * 100)),
          )
        : 100;

    return {
      availableBefore,
      currentQuantity,
      remainingAfter: Math.max(0, availableBefore - currentQuantity),
      initialPct,
    };
  }, [allOrders, isReduceLimit, order, position]);

  const openEditor = () => {
    onFocus();
    setReducePct(reduceMath.initialPct);
    setIsEditingReduce(true);
  };

  const estimatedQuantity =
    reduceMath.availableBefore * (reducePct / 100);
  const estimatedRemaining = Math.max(
    0,
    reduceMath.availableBefore - estimatedQuantity,
  );

  const reduceDetailText = useMemo(() => {
    if (!isReduceLimit) return null;

    const meta = parseReduceMetadata(order.clientOrderId);
    const quantityText = quantityFormatter.format(Number(order.origQty));
    const asset = baseAsset(order.symbol);
    const pctText = meta.reducePct != null ? `${meta.reducePct}%` : "REDUCE";
    const leftText =
      meta.remainingPct == null
        ? ""
        : ` · LEFT ${Math.max(0, meta.remainingPct)}%`;

    return `${pctText} · ${quantityText}${asset ? ` ${asset}` : ""}${leftText}`;
  }, [isReduceLimit, order.clientOrderId, order.origQty, order.symbol]);

  return (
    <>
      <div
        className={`open-order-row ${
          isInteractive ? "focusable-order-row" : "inactive-symbol-row"
        } ${isFocused ? "focused-order-row" : ""}`}
        role={isInteractive ? "button" : undefined}
        tabIndex={isInteractive ? 0 : undefined}
        onClick={isInteractive ? onFocus : undefined}
        onKeyDown={
          isInteractive
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onFocus();
                }
              }
            : undefined
        }
        title={
          isInteractive
            ? "Click row to highlight this order on the chart"
            : "Switch to this symbol to interact with the order"
        }
      >
        <div className="open-order-symbol-cell">
          <div className="open-order-symbol-top">
            {/*
             * FEATURE: keep the symbol navigable even when this Open Orders
             * row belongs to another chart symbol and is intentionally dimmed.
             * Stopping propagation prevents the symbol click from also firing
             * the row's focus/highlight action when the order is already active.
             */}
            <button
              type="button"
              className="open-order-symbol-link"
              onClick={(event) => {
                event.stopPropagation();
                onSwitchSymbol();
              }}
              title={`Open ${formatSymbolWithSlash(order.symbol)} chart`}
            >
              {formatSymbolWithSlash(order.symbol)}
            </button>
            <span className={`position-side ${sideClass}`}>{order.side}</span>
            {isReduceLimit && (
              <span className="open-order-reduce-badge">REDUCE</span>
            )}
            {isStopRow && (
              <span className="open-order-reduce-badge">FULL SL</span>
            )}
          </div>

          {reduceDetailText && (
            <div className="open-order-reduce-detail">{reduceDetailText}</div>
          )}
        </div>

        <div className="open-order-value">
          <strong>{order.type || order.origType}</strong>
        </div>

        <div className="open-order-value">
          <strong>{formatPriceForSymbol(Number(order.price), order.symbol)}</strong>
        </div>

        <div className="open-order-value">
          <strong className="open-order-status">{order.status}</strong>
        </div>

        <div className="open-order-action-cell">
          {!isReduceLimit &&
            !isStopRow &&
            (order.type === "LIMIT" || order.origType === "LIMIT") && (
              <button
                className="open-order-chase"
                disabled={!isInteractive || isChasing || isCancelling || isUpdating}
                onClick={(event) => {
                  event.stopPropagation();
                  void onChase();
                }}
              >
                {isChasing ? "Chasing…" : "Chase"}
              </button>
            )}

          {isReduceLimit && (
            <button
              className="open-order-edit"
              disabled={!isInteractive || isUpdating || isCancelling || !position}
              onClick={(event) => {
                event.stopPropagation();
                openEditor();
              }}
            >
              {isUpdating ? "Updating…" : "Edit Reduce"}
            </button>
          )}

          <button
            className="open-order-cancel"
            disabled={!isInteractive || isCancelling || isUpdating || isChasing}
            onClick={(event) => {
              event.stopPropagation();
              onCancel();
            }}
          >
            {isCancelling ? "Cancelling…" : "Cancel"}
          </button>

          <span
            className="open-order-focus-cue"
            aria-hidden="true"
            title="Click row to highlight this order on the chart"
          >
            ›
          </span>
        </div>
      </div>

      {isInteractive && isReduceLimit && isEditingReduce && (
        <div className="reduce-order-editor">
          <div className="reduce-order-editor-copy">
            <strong>Update Limit Reduce</strong>
            <span>
              {quantityFormatter.format(reduceMath.availableBefore)}{" "}
              {baseAsset(order.symbol)} available after other TPs
            </span>
          </div>

          <div className="reduce-order-editor-summary">
            <div>
              <span>Reduce</span>
              <strong>{reducePct}%</strong>
            </div>
            <div>
              <span>Order size</span>
              <strong>
                {quantityFormatter.format(estimatedQuantity)}{" "}
                {baseAsset(order.symbol)}
              </strong>
            </div>
            <div>
              <span>Left unreserved</span>
              <strong>
                {quantityFormatter.format(estimatedRemaining)}{" "}
                {baseAsset(order.symbol)}
              </strong>
            </div>
          </div>

          <input
            className="reduce-order-editor-slider"
            type="range"
            min="1"
            max="100"
            step="1"
            value={reducePct}
            disabled={isUpdating}
            onChange={(event) => setReducePct(Number(event.target.value))}
          />

          <div className="reduce-order-editor-actions">
            <button
              className="reduce-order-editor-cancel"
              disabled={isUpdating}
              onClick={() => setIsEditingReduce(false)}
            >
              Keep Current
            </button>

            <button
              className="reduce-order-editor-save"
              disabled={isUpdating}
              onClick={() => {
                void onUpdateReduce(reducePct)
                  .then((result) => {
                    const requested = result?.requested_reduce_pct;
                    const actual = result?.reduce_pct;

                    if (
                      requested !== undefined &&
                      actual !== undefined &&
                      Math.round(requested) !== Math.round(actual)
                    ) {
                      setReduceBumpNotice(
                        `Requested ${Math.round(requested)}% was below the exchange's minimum order size, so it was bumped up to ${Math.round(actual)}%.`,
                      );
                      window.setTimeout(
                        () => setReduceBumpNotice(null),
                        8_000,
                      );
                    }

                    setIsEditingReduce(false);
                  })
                  .catch(() => {
                    /*
                     * FIX: this had no .catch() at all - useOpenOrders.ts's
                     * updateReduceOrder deliberately re-throws after
                     * setting its own `error` state (see its own comment),
                     * expecting the caller to decide what to do with the
                     * UI on failure. Nothing here was catching that
                     * re-throw, so any failure - including the very
                     * ordinary "this order doesn't exist anymore" case
                     * (order already replaced/filled elsewhere) - surfaced
                     * as an unhandled promise rejection in the console
                     * instead of just leaving the editor open. The error
                     * message itself is already shown via
                     * openOrdersApi.error (rendered elsewhere in this
                     * panel) and the hook already triggers its own
                     * refresh() on failure, so there's nothing extra to
                     * do here beyond not closing the editor and not
                     * leaving the rejection unhandled.
                     */
                  });
              }}
            >
              {isUpdating ? "Updating…" : `Set Reduce to ${reducePct}%`}
            </button>
          </div>
        </div>
      )}

      {reduceBumpNotice && (
        <p className="reduce-bump-notice">{reduceBumpNotice}</p>
      )}
    </>
  );
}

