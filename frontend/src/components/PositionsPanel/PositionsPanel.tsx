import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { usePositions } from "../../hooks/usePositions";
import type { OpenOrdersApi } from "../../hooks/useOpenOrders";
import {
  closeEverything,
  type OpenPosition,
} from "../../trading/api/positions";
import {
  cancelConditionalOrder,
  type OpenOrder,
  type UpdateReduceOrderResponse,
} from "../../trading/api/orders";
import { getCachedSymbolFilters } from "../../trading/api/exchangeInfo";
import { loadSavedStop, saveStop, type SavedStop } from "../../trading/stopLoss";
import { parseReduceMetadata } from "../../trading/reduceMetadata";
import type { TradeSide } from "../../trading/types";
import {
  areTpSlControlsVisible,
  setTpSlControlsVisible,
  TP_SL_CONTROLS_VISIBILITY_EVENT,
} from "../../trading/tpSlControlsVisibility";
import "./PositionsPanel.css";

type PositionsPanelProps = {
  isOpen: boolean;
  onClose: () => void;
  height: number;
  onHeightChange: (height: number) => void;
  onPositionClosed: (side: TradeSide, symbol: string, price?: number) => void;
  /** Currently selected chart symbol. Rows for other symbols stay visible but static. */
  activeSymbol: string;
  /**
   * Open orders for the Open Orders tab. This should be account-wide
   * (every symbol, not just whichever one happens to be selected on the
   * chart) - see the account-wide useOpenOrders(null) instance in
   * App.tsx - the same way `usePositions` below already covers every
   * symbol's positions, not just one.
   */
  openOrdersApi: OpenOrdersApi;
  focusedOrderId: string | null;
  onFocusOrder: (orderId: string) => void;
  /**
   * Key of the position row currently blinking on the chart (see
   * App.tsx's focusPosition) - built as `${symbol}-${side}` since a
   * position, unlike an order, has no single Binance id to key off of.
   * Null when nothing is focused.
   */
  focusedPositionKey: string | null;
  /** Called when a row in the Positions tab (not Open Orders) is clicked. */
  onFocusPosition: (key: string) => void;
  /**
   * Switches the active chart symbol (same effect as picking it from the
   * Topbar's symbol dropdown). Positions rows use it for whole-row
   * navigation. Open Orders keeps rows for other symbols dimmed/static,
   * but the symbol label itself still uses this callback so it can act as
   * a safe chart-navigation target without enabling the row's actions.
   */
  onSwitchSymbol: (symbol: string) => void;
  protection: {
    symbol: string;
    fullTakeProfitPrice: number | null;
    stopLossPrice: number | null;
  };
};

type PanelTab = "positions" | "open-orders";

// clientOrderId prefix used for the synthetic Open-Orders row that
// represents a locally-tracked full stop-loss (a Binance conditional
// order, not a regular one - see trading/stopLoss.ts). Used to tell a
// synthetic row apart from a real order returned by the backend.
const SYNTHETIC_STOP_CLIENT_ORDER_ID_PREFIX = "fe-sl-full-";

function isSyntheticStopOrder(order: OpenOrder): boolean {
  return (
    order.clientOrderId?.startsWith(SYNTHETIC_STOP_CLIENT_ORDER_ID_PREFIX) ??
    false
  );
}

function isFullTakeProfitOrder(order: OpenOrder): boolean {
  if (!(order.type === "LIMIT" || order.origType === "LIMIT")) {
    return false;
  }

  const isReduce =
    order.reduceOnly || order.clientOrderId?.startsWith("fe-red-") === true;
  if (!isReduce) return false;

  const metadata = parseReduceMetadata(order.clientOrderId);
  return metadata.reducePct === 100 || metadata.remainingPct === 0;
}

function buildSyntheticStopOrder(stop: SavedStop): OpenOrder {
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
function formatSymbolWithSlash(symbol: string): string {
  const match = symbol.match(/^(.*?)(USDT|USDC|BUSD)$/i);
  return match ? `${match[1]}/${match[2].toUpperCase()}` : symbol;
}

function PositionRow({
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

function OpenOrderRow({
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

export default function PositionsPanel({
  isOpen,
  onClose,
  height,
  onHeightChange,
  onPositionClosed,
  activeSymbol,
  openOrdersApi,
  focusedOrderId,
  onFocusOrder,
  focusedPositionKey,
  onFocusPosition,
  onSwitchSymbol,
  protection,
}: PositionsPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>("positions");
  /*
   * FIX: "Close Everything" used to be a single account-wide action -
   * one double-tap button that closed every symbol's positions and
   * cancelled every symbol's orders, no way to scope it down. Now it
   * opens a small menu with two choices instead: the old full-account
   * behavior (still double-tap armed - see isCloseEverythingArmed below,
   * this is the more dangerous of the two options so it keeps the extra
   * confirm step), and a new option scoped to just the active chart's
   * symbol (executes directly - it's the safer, more targeted action,
   * and disabled entirely when there's nothing to close for that symbol
   * - see hasActiveSymbolToClose below).
   */
  const [isCloseEverythingMenuOpen, setIsCloseEverythingMenuOpen] = useState(false);
  const [isCloseEverythingArmed, setIsCloseEverythingArmed] = useState(false);
  const [isClosingEverything, setIsClosingEverything] = useState(false);
  const [closeEverythingError, setCloseEverythingError] = useState<string | null>(null);
  const closeEverythingRootRef = useRef<HTMLDivElement | null>(null);
  const positionsApi = usePositions(isOpen, onPositionClosed);
  const [isResizing, setIsResizing] = useState(false);
  // FEATURE: This counter is only a lightweight render trigger for the shared
  // per-symbol TP/SL visibility preference. The preference itself remains in
  // localStorage so the chart and panel have one source of truth.
  const [, setTpSlVisibilityVersion] = useState(0);

  useEffect(() => {
    const refreshTpSlVisibility = () =>
      setTpSlVisibilityVersion((version) => version + 1);

    window.addEventListener(
      TP_SL_CONTROLS_VISIBILITY_EVENT,
      refreshTpSlVisibility,
    );
    return () =>
      window.removeEventListener(
        TP_SL_CONTROLS_VISIBILITY_EVENT,
        refreshTpSlVisibility,
      );
  }, []);

  /*
   * PositionsPanel is account-wide, so TP values must also be derived from
   * the account-wide open-order list. Previously App supplied only the TP
   * for whichever chart symbol was selected. Switching to ETH therefore
   * made BTC/SOL TP cells disappear even though those orders still existed.
   */
  const fullTakeProfitBySymbol = useMemo<Record<string, number>>(() => {
    const next: Record<string, number> = {};

    for (const order of openOrdersApi.orders) {
      if (!isFullTakeProfitOrder(order)) continue;

      const price = Number(order.price);
      if (!Number.isFinite(price) || price <= 0) continue;

      next[order.symbol.toUpperCase()] = price;
    }

    return next;
  }, [openOrdersApi.orders]);

  // The full stop-loss is a Binance conditional order, tracked locally
  // (see trading/stopLoss.ts) rather than coming back from
  // GET /api/orders/open like regular orders do - so it has to be merged
  // in here rather than arriving through openOrdersApi.
  //
  // FIX: this used to track only ONE saved stop (for whichever symbol
  // was currently selected on the chart), so a user holding positions on
  // several symbols at once would only ever see one symbol's stop-loss
  // in this list - the rest were silently missing, even though they were
  // real, live conditional orders on Binance. Now it builds one synthetic
  // row per OPEN POSITION that has a saved stop, covering every symbol at
  // once - the same way `positionsApi.positions` below already covers
  // every symbol's positions rather than just one.
  const [savedStopsBySymbol, setSavedStopsBySymbol] = useState<
    Record<string, SavedStop>
  >({});
  const [cancellingStopSymbol, setCancellingStopSymbol] = useState<
    string | null
  >(null);
  const [stopCancelError, setStopCancelError] = useState<string | null>(null);

  useEffect(() => {
    const refreshSavedStops = () => {
      const next: Record<string, SavedStop> = {};

      for (const position of positionsApi.positions) {
        const stop = loadSavedStop(position.symbol);
        if (stop) {
          next[position.symbol.toUpperCase()] = stop;
        }
      }

      setSavedStopsBySymbol(next);
    };

    refreshSavedStops();

    window.addEventListener("trading-state-changed", refreshSavedStops);
    window.addEventListener("storage", refreshSavedStops);

    return () => {
      window.removeEventListener("trading-state-changed", refreshSavedStops);
      window.removeEventListener("storage", refreshSavedStops);
    };
  }, [positionsApi.positions]);

  const syntheticStopOrders = useMemo(
    () => Object.values(savedStopsBySymbol).map(buildSyntheticStopOrder),
    [savedStopsBySymbol],
  );

  const combinedOpenOrders = useMemo(
    () => [...openOrdersApi.orders, ...syntheticStopOrders],
    [openOrdersApi.orders, syntheticStopOrders],
  );

  const hasActiveSymbolToClose = useMemo(() => {
    const normalized = activeSymbol.toUpperCase();
    return (
      positionsApi.positions.some(
        (position) => position.symbol.toUpperCase() === normalized,
      ) ||
      combinedOpenOrders.some(
        (order) => order.symbol.toUpperCase() === normalized,
      )
    );
  }, [positionsApi.positions, combinedOpenOrders, activeSymbol]);

  useEffect(() => {
    if (!isCloseEverythingMenuOpen) return;

    const closeMenu = () => {
      setIsCloseEverythingMenuOpen(false);
      setIsCloseEverythingArmed(false);
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (
        closeEverythingRootRef.current &&
        !closeEverythingRootRef.current.contains(event.target as Node)
      ) {
        closeMenu();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isCloseEverythingMenuOpen]);

  const cancelSavedStop = async (symbol: string) => {
    const stop = savedStopsBySymbol[symbol.toUpperCase()];
    if (!stop || cancellingStopSymbol) return;

    setCancellingStopSymbol(stop.symbol.toUpperCase());
    setStopCancelError(null);

    try {
      await cancelConditionalOrder(stop.symbol, stop.algoId);
      saveStop(null, stop.symbol);
      setSavedStopsBySymbol((current) => {
        const next = { ...current };
        delete next[stop.symbol.toUpperCase()];
        return next;
      });
      window.dispatchEvent(new Event("trading-state-changed"));
    } catch (error) {
      setStopCancelError(
        error instanceof Error ? error.message : "Unable to cancel stop loss",
      );
    } finally {
      setCancellingStopSymbol(null);
    }
  };

  const runCloseEverything = async (symbol?: string) => {
    setIsClosingEverything(true);
    setCloseEverythingError(null);

    /*
     * FIX (missing marker on non-active symbols after Close Everything):
     * avg_price comes from the market-close order's own immediate REST
     * response - which, for a market order, can occasionally come back
     * with avgPrice not yet populated (a known Binance timing quirk,
     * more likely to surface when closing several positions back-to-
     * back like this does). When that happened, the ACTIVE symbol's
     * marker still showed up fine, because addMarkerNow silently falls
     * back to this chart's own live price - but appendTradeMarkerForSymbol
     * (used for every OTHER symbol, which has no "this chart's live
     * price" to fall back to) has no such rescue and just skips placing
     * a marker rather than guess. Snapshotting each position's own
     * mark_price right before closing gives every symbol a real,
     * reasonable fallback of its own - not as exact as the true fill
     * price, but far closer than no marker at all, and a market close on
     * a liquid pair rarely slips far from the mark price anyway.
     */
    const markPriceBySymbol = new Map(
      positionsApi.positions.map((item) => [
        item.symbol.toUpperCase(),
        item.mark_price,
      ]),
    );

    try {
      const result = await closeEverything(symbol);

      for (const closedPosition of result.closed_positions) {
        const fallbackPrice = markPriceBySymbol.get(
          closedPosition.symbol.toUpperCase(),
        );

        onPositionClosed(
          closedPosition.side,
          closedPosition.symbol,
          closedPosition.avg_price ??
            (fallbackPrice !== undefined && Number.isFinite(fallbackPrice)
              ? fallbackPrice
              : undefined),
        );
      }

      if (!result.completed) {
        const message = result.errors
          .map((item) => `${item.symbol}: ${item.error}`)
          .join(" · ");
        setCloseEverythingError(
          message || "Close Everything completed with errors",
        );
      }

      await Promise.all([
        positionsApi.refresh(true),
        openOrdersApi.refresh(true),
      ]);

      /*
       * FIX (Positions panel not auto-closing when Close Everything
       * leaves 0 positions): same root cause as the auto-open bug fixed
       * in useTradeMenu.ts - App.tsx's auto-open/close-panel logic only
       * listens for "account-state-changed", but this only ever
       * dispatched "trading-state-changed". Dispatching both means that
       * logic actually gets to re-check whether there's anything left
       * open and close the panel accordingly, instead of never being
       * notified that anything changed.
       */
      window.dispatchEvent(new Event("account-state-changed"));
      window.dispatchEvent(new Event("trading-state-changed"));
    } catch (error) {
      setCloseEverythingError(
        error instanceof Error
          ? error.message
          : "Unable to close all positions and orders",
      );
    } finally {
      setIsClosingEverything(false);
    }
  };

  const handleResizePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (window.matchMedia("(max-width: 720px)").matches || isResizing) return;

    event.preventDefault();
    event.stopPropagation();

    const startY = event.clientY;
    const startHeight = height;

    setIsResizing(true);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      // Click once to pick up the divider, then resize just by moving the
      // pointer. The dock is attached to the bottom edge, so moving up
      // increases its height and moving down makes it shorter.
      onHeightChange(startHeight + (startY - moveEvent.clientY));
    };

    const stopResizing = (finishEvent?: PointerEvent) => {
      if (finishEvent) {
        // The finishing click belongs to the resize interaction; don't also
        // activate whatever control happens to be underneath the pointer.
        finishEvent.preventDefault();
        finishEvent.stopPropagation();
      }

      setIsResizing(false);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", handleFinishPointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };

    const handleFinishPointerDown = (finishEvent: PointerEvent) => {
      stopResizing(finishEvent);
    };

    const handleKeyDown = (keyEvent: globalThis.KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      stopResizing();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("keydown", handleKeyDown);

    // Delay registration so the pointerdown that STARTED resizing cannot also
    // be interpreted as the click that finishes it.
    window.setTimeout(() => {
      window.addEventListener("pointerdown", handleFinishPointerDown, true);
    }, 0);
  };

  return (
    <section
      className={`positions-panel ${isResizing ? "resizing" : ""}`}
      onClick={(event) => event.stopPropagation()}
    >
      {isOpen && (
        <div
          className="positions-resize-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize positions panel"
          title="Click, move, then click again to resize positions panel"
          onPointerDown={handleResizePointerDown}
        />
      )}
      <div className="positions-tabs">
        <button
          className={`positions-tab ${activeTab === "positions" ? "active" : ""}`}
          onClick={() => setActiveTab("positions")}
        >
          Positions ({positionsApi.positions.length})
        </button>

        <button
          className={`positions-tab ${activeTab === "open-orders" ? "active" : ""}`}
          onClick={() => setActiveTab("open-orders")}
        >
          Open Orders ({combinedOpenOrders.length})
        </button>

        <div className="positions-tabs-spacer" />

        <div className="close-everything-group">
          <span>Positions + Orders</span>

          <div className="close-everything-wrap" ref={closeEverythingRootRef}>
            <button
              className="close-everything-button"
              disabled={
                isClosingEverything ||
                (positionsApi.positions.length === 0 &&
                  combinedOpenOrders.length === 0)
              }
              onClick={() =>
                setIsCloseEverythingMenuOpen((open) => {
                  if (open) setIsCloseEverythingArmed(false);
                  return !open;
                })
              }
            >
              {isClosingEverything ? "Closing Everything…" : "Close Everything"}
            </button>

            {isCloseEverythingMenuOpen && (
              <div className="close-everything-menu">
                <button
                  className={`close-everything-option full ${
                    isCloseEverythingArmed ? "armed" : ""
                  }`}
                  onClick={() => {
                    if (!isCloseEverythingArmed) {
                      setIsCloseEverythingArmed(true);
                      window.setTimeout(
                        () => setIsCloseEverythingArmed(false),
                        4_000,
                      );
                      return;
                    }

                    setIsCloseEverythingArmed(false);
                    setIsCloseEverythingMenuOpen(false);
                    void runCloseEverything();
                  }}
                >
                  {isCloseEverythingArmed
                    ? "Confirm Close Everything FULL"
                    : "Close Everything FULL"}
                </button>

                <button
                  className="close-everything-option"
                  disabled={!hasActiveSymbolToClose}
                  title={
                    hasActiveSymbolToClose
                      ? undefined
                      : `Nothing open for ${activeSymbol} right now`
                  }
                  onClick={() => {
                    setIsCloseEverythingMenuOpen(false);
                    void runCloseEverything(activeSymbol);
                  }}
                >
                  Close Everything ({formatSymbolWithSlash(activeSymbol)})
                </button>
              </div>
            )}
          </div>
        </div>

        <button className="positions-close" title="Close panel" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="positions-body">
        {closeEverythingError && (
          <div className="positions-error">{closeEverythingError}</div>
        )}

        {activeTab === "positions" ? (
          <>
            <div className="positions-heading-row">
              <span>Symbol</span>
              <span>Size</span>
              <span>Remaining Size</span>
              <span>Entry Price</span>
              <span>Full TP</span>
              <span>Stop Loss</span>
              <span>TP/SL</span>
              <span>Liquidation Price</span>
              <span>Margin</span>
              <span>Unrealized PNL (ROI)</span>
              <span>Realized PNL</span>
              <span>Close Position</span>
            </div>

            {positionsApi.error && (
              <div className="positions-error">{positionsApi.error}</div>
            )}

            {positionsApi.isLoading && positionsApi.positions.length === 0 ? (
              <div className="positions-empty">Loading open positions…</div>
            ) : positionsApi.positions.length === 0 ? (
              <div className="positions-empty">No open positions</div>
            ) : (
              <div className="positions-list">
                {positionsApi.positions.map((position) => {
                  const positionKey = `${position.symbol}-${position.side}`;

                  return (
                    <PositionRow
                      key={positionKey}
                      position={position}
                      isClosing={positionsApi.closingSymbol === position.symbol}
                      onCloseMarket={() => void positionsApi.closeMarket(position)}
                      fullTakeProfitPrice={
                        position.symbol.toUpperCase() ===
                          protection.symbol.toUpperCase() &&
                        protection.fullTakeProfitPrice !== null
                          ? protection.fullTakeProfitPrice
                          : (fullTakeProfitBySymbol[
                              position.symbol.toUpperCase()
                            ] ?? null)
                      }
                      stopLossPrice={
                        position.symbol.toUpperCase() ===
                        protection.symbol.toUpperCase()
                          ? protection.stopLossPrice
                          : (savedStopsBySymbol[position.symbol.toUpperCase()]
                              ?.triggerPrice ?? null)
                      }
                      areTpSlControlsShown={areTpSlControlsVisible(
                        position.symbol,
                      )}
                      onToggleTpSlControls={() =>
                        setTpSlControlsVisible(
                          position.symbol,
                          !areTpSlControlsVisible(position.symbol),
                        )
                      }
                      isFocused={focusedPositionKey === positionKey}
                      onFocus={() => onFocusPosition(positionKey)}
                      onSwitchSymbol={() => onSwitchSymbol(position.symbol)}
                      isInteractive={
                        position.symbol.toUpperCase() === activeSymbol.toUpperCase()
                      }
                    />
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="open-orders-heading-row">
              <span>Symbol</span>
              <span>Type</span>
              <span>Price</span>
              <span>Status</span>
              <span>Action</span>
            </div>

            {(openOrdersApi.error || stopCancelError) && (
              <div className="positions-error">
                {openOrdersApi.error ?? stopCancelError}
              </div>
            )}

            {openOrdersApi.isLoading && combinedOpenOrders.length === 0 ? (
              <div className="positions-empty">Loading open orders…</div>
            ) : combinedOpenOrders.length === 0 ? (
              <div className="positions-empty">No open orders</div>
            ) : (
              <div className="open-orders-list">
                {combinedOpenOrders.map((order) => {
                  const isStopRow = isSyntheticStopOrder(order);

                  return (
                    <OpenOrderRow
                      key={order.orderId}
                      order={order}
                      position={positionsApi.positions.find(
                        (position) => position.symbol === order.symbol,
                      )}
                      allOrders={combinedOpenOrders}
                      isCancelling={
                        isStopRow
                          ? cancellingStopSymbol === order.symbol.toUpperCase()
                          : openOrdersApi.cancellingOrderId === order.orderId
                      }
                      isUpdating={
                        openOrdersApi.updatingOrderId === order.orderId
                      }
                      isChasing={
                        openOrdersApi.chasingOrderId === order.orderId
                      }
                      onCancel={() =>
                        isStopRow
                          ? void cancelSavedStop(order.symbol)
                          : void openOrdersApi.cancelOrder(order)
                      }
                      onUpdateReduce={(reducePct) =>
                        openOrdersApi.updateReduceOrder(order, reducePct)
                      }
                      onChase={() => openOrdersApi.chaseOrder(order)}
                      isFocused={focusedOrderId === order.orderId}
                      onFocus={() => onFocusOrder(order.orderId)}
                      onSwitchSymbol={() => onSwitchSymbol(order.symbol)}
                      isInteractive={
                        order.symbol.toUpperCase() === activeSymbol.toUpperCase()
                      }
                    />
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
