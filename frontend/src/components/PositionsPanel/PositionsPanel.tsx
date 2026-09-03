import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { usePositions } from "../../hooks/usePositions";
import { useMobileBackDismissal } from "../../hooks/useAndroidBackNavigation";
import type { OpenOrdersApi } from "../../hooks/useOpenOrders";
import { closeEverything } from "../../trading/api/positions";
import { cancelConditionalOrder } from "../../trading/api/orders";
import { loadSavedStop, saveStop, type SavedStop } from "../../trading/stopLoss";
import type { TradeSide } from "../../trading/types";
import {
  areTpSlControlsVisible,
  setTpSlControlsVisible,
  TP_SL_CONTROLS_VISIBILITY_EVENT,
} from "../../trading/tpSlControlsVisibility";
import {
  OpenOrderRow,
  PositionRow,
  buildSyntheticStopOrder,
  formatSymbolWithSlash,
  isFullTakeProfitOrder,
  isSyntheticStopOrder,
} from "./PositionRows";
import LoadingIndicator from "../LoadingIndicator/LoadingIndicator";
import "./PositionsPanel.css";
import "./PositionRows.css";

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
   * "Close Everything" used to be a single account-wide action -
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
  // This counter is only a lightweight render trigger for the shared
  // per-symbol TP/SL visibility preference. The preference itself remains in
  // localStorage so the chart and panel have one source of truth.
  const [, setTpSlVisibilityVersion] = useState(0);

  useMobileBackDismissal(isCloseEverythingMenuOpen, () => {
    setIsCloseEverythingMenuOpen(false);
    setIsCloseEverythingArmed(false);
    setCloseEverythingError(null);
  });

  useEffect(() => {
    const refreshTpSlVisibility = () => setTpSlVisibilityVersion((version) => version + 1);

    window.addEventListener(TP_SL_CONTROLS_VISIBILITY_EVENT, refreshTpSlVisibility);
    return () => window.removeEventListener(TP_SL_CONTROLS_VISIBILITY_EVENT, refreshTpSlVisibility);
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
  // this used to track only ONE saved stop (for whichever symbol
  // was currently selected on the chart), so a user holding positions on
  // several symbols at once would only ever see one symbol's stop-loss
  // in this list - the rest were silently missing, even though they were
  // real, live conditional orders on Binance. Now it builds one synthetic
  // row per OPEN POSITION that has a saved stop, covering every symbol at
  // once - the same way `positionsApi.positions` below already covers
  // every symbol's positions rather than just one.
  const [savedStopsBySymbol, setSavedStopsBySymbol] = useState<Record<string, SavedStop>>({});
  const [cancellingStopSymbol, setCancellingStopSymbol] = useState<string | null>(null);
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
      positionsApi.positions.some((position) => position.symbol.toUpperCase() === normalized) ||
      combinedOpenOrders.some((order) => order.symbol.toUpperCase() === normalized)
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
      setStopCancelError(error instanceof Error ? error.message : "Unable to cancel stop loss");
    } finally {
      setCancellingStopSymbol(null);
    }
  };

  const runCloseEverything = async (symbol?: string) => {
    setIsClosingEverything(true);
    setCloseEverythingError(null);

    /*
     * * avg_price comes from the market-close order's own immediate REST
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
      positionsApi.positions.map((item) => [item.symbol.toUpperCase(), item.mark_price]),
    );

    try {
      const result = await closeEverything(symbol);

      for (const closedPosition of result.closed_positions) {
        const fallbackPrice = markPriceBySymbol.get(closedPosition.symbol.toUpperCase());

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
        const message = result.errors.map((item) => `${item.symbol}: ${item.error}`).join(" · ");
        setCloseEverythingError(message || "Close Everything completed with errors");
      }

      await Promise.all([positionsApi.refresh(true), openOrdersApi.refresh(true)]);

      /*
       * same root cause as the auto-open bug fixed
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
        error instanceof Error ? error.message : "Unable to close all positions and orders",
      );
    } finally {
      setIsClosingEverything(false);
    }
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
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
                (positionsApi.positions.length === 0 && combinedOpenOrders.length === 0)
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
                      window.setTimeout(() => setIsCloseEverythingArmed(false), 4_000);
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
        {closeEverythingError && <div className="positions-error">{closeEverythingError}</div>}

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

            {positionsApi.error && <div className="positions-error">{positionsApi.error}</div>}

            {positionsApi.isLoading && positionsApi.positions.length === 0 ? (
              <div className="positions-empty">
                <LoadingIndicator label="Loading open positions" />
              </div>
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
                        position.symbol.toUpperCase() === protection.symbol.toUpperCase() &&
                        protection.fullTakeProfitPrice !== null
                          ? protection.fullTakeProfitPrice
                          : (fullTakeProfitBySymbol[position.symbol.toUpperCase()] ?? null)
                      }
                      stopLossPrice={
                        position.symbol.toUpperCase() === protection.symbol.toUpperCase()
                          ? protection.stopLossPrice
                          : (savedStopsBySymbol[position.symbol.toUpperCase()]?.triggerPrice ??
                            null)
                      }
                      areTpSlControlsShown={areTpSlControlsVisible(position.symbol)}
                      onToggleTpSlControls={() =>
                        setTpSlControlsVisible(
                          position.symbol,
                          !areTpSlControlsVisible(position.symbol),
                        )
                      }
                      isFocused={focusedPositionKey === positionKey}
                      onFocus={() => onFocusPosition(positionKey)}
                      onSwitchSymbol={() => onSwitchSymbol(position.symbol)}
                      isInteractive={position.symbol.toUpperCase() === activeSymbol.toUpperCase()}
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
              <div className="positions-error">{openOrdersApi.error ?? stopCancelError}</div>
            )}

            {openOrdersApi.isLoading && combinedOpenOrders.length === 0 ? (
              <div className="positions-empty">
                <LoadingIndicator label="Loading open orders" />
              </div>
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
                      isUpdating={openOrdersApi.updatingOrderId === order.orderId}
                      isChasing={openOrdersApi.chasingOrderId === order.orderId}
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
                      isInteractive={order.symbol.toUpperCase() === activeSymbol.toUpperCase()}
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
