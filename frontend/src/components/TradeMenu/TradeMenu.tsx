import { useEffect, useState } from "react";
import { getSymbolInfo } from "../../config/symbols";
import type { PendingTradeAction } from "../../hooks/useTradeMenu";
import type { ConnectionState } from "../../hooks/useTradingStream";
import type { PositionSide } from "../../trading/api/positions";
import type { TradeMenuState, TradeOrderType, TradeSide } from "../../trading/types";
import "../../styles/floatingPanel.css";
import "./TradeMenu.css";

type TradeMenuProps = {
  /**
   * The currently active trading symbol (e.g. "BTCUSDT", "XRPUSDT").
   * Used purely for display - to show the real base-asset ticker ("SOL",
   * "XRP", ...) instead of a hardcoded "BTC" in the quantity labels
   * below. The trade itself is always submitted for whichever symbol the
   * hooks in useTradeMenu.ts were called with.
   */
  symbol: string;
  /**
   * Decimal precision for this symbol's real tick size (see
   * trading/api/exchangeInfo.ts). Every price shown below uses this
   * instead of a flat 1 decimal place, which made a symbol needing more
   * precision (XRP, for instance) show the same rounded price across a
   * wide band of actual values.
   */
  pricePrecision: number;
  tradeMenu: TradeMenuState;
  isSubmittingTrade: boolean;
  pendingTradeAction: PendingTradeAction;
  availableBalance: number | null;
  /** Backend margin fraction used by AUTO MARKET, e.g. 0.02 for 2%. */
  marginPct: number | null;
  isLoadingBalance: boolean;
  balanceError: string | null;
  positionSide: PositionSide | null;
  positionQuantity: number;
  /**
   * How much of positionQuantity is already reserved by other reduce-only
   * orders (an existing TP/SL limit, a previous partial reduce, etc.) -
   * see its computation in useTradeMenu.ts for the full reasoning. Used
   * so the reduce slider works against what's actually still available,
   * not the raw position size.
   */
  reservedReduceQuantity: number;
  isLoadingPosition: boolean;
  reducePct: number;
  onReducePctChange: (value: number) => void;
  onClose: () => void;
  onSubmit: (orderType: TradeOrderType, side: TradeSide) => void;
  onAutoMarket: (side: TradeSide) => void;
  onAdd: (orderType: TradeOrderType) => void;
  onReduce: (orderType: TradeOrderType) => void;
  onReverse: () => void;
  /**
   * Backend REST API health (see useBackendConnection in App.tsx). Every
   * control below that would submit a real order to the backend is
   * disabled while this isn't "connected" - placing an order against a
   * backend that's known to be down just produces a failed request and a
   * confusing error toast, so it's better to make that state visible up
   * front instead. Navigation-only controls (Back, ×) stay enabled since
   * they never touch the network.
   */
  backendConnection: ConnectionState;
  /** Current leverage value, live while dragging (see useTradeMenu.ts). */
  leverage: number;
  /** Slider ceiling, sourced from Settings' "Maximum leverage" field. */
  maxLeverage: number;
  /** True while the just-released leverage value is being sent to the backend. */
  isUpdatingLeverage: boolean;
  leverageError: string | null;
  /** Called on every slider move - local/live, no network request. */
  onLeverageChange: (value: number) => void;
  /** Called once the slider is released - this is what hits the backend. */
  onLeverageCommit: (value: number) => void;
};

type PositionAction = "ADD" | "REDUCE" | null;

const balanceFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export default function TradeMenu(props: TradeMenuProps) {
  const [selectedOrderType, setSelectedOrderType] = useState<TradeOrderType | "AUTO_MARKET" | null>(
    null,
  );

  // Which position-management submenu is open (ADD / REDUCE), or null for
  // the top-level ADD | REDUCE | MARKET REVERSE menu. See the positionSide
  // branch below.
  const [activeAction, setActiveAction] = useState<PositionAction>(null);

  const {
    symbol,
    pricePrecision,
    tradeMenu,
    isSubmittingTrade,
    pendingTradeAction,
    availableBalance,
    marginPct,
    isLoadingBalance,
    balanceError,
    positionSide,
    positionQuantity,
    reservedReduceQuantity,
    isLoadingPosition,
    reducePct,
    onReducePctChange,
    onClose,
    onSubmit,
    onAutoMarket,
    onAdd,
    onReduce,
    onReverse,
    backendConnection,
    leverage,
    maxLeverage,
    isUpdatingLeverage,
    leverageError,
    onLeverageChange,
    onLeverageCommit,
  } = props;

  // Real base-asset ticker for the active symbol ("BTC", "SOL", "ETH",
  // "XRP", ...) instead of a hardcoded "BTC" string - see getSymbolInfo
  // in config/symbols.ts.
  const baseAssetLabel = getSymbolInfo(symbol).label;

  const isBackendConnected = backendConnection === "connected";
  // Every order-submitting control shares this same disabled condition.
  const isTradingDisabled = isSubmittingTrade || !isBackendConnected;
  const isLeverageDisabled = isTradingDisabled || isUpdatingLeverage;

  useEffect(() => {
    setSelectedOrderType(null);
    setActiveAction(null);
  }, [tradeMenu.x, tradeMenu.y, tradeMenu.selectedPrice, tradeMenu.marketPrice]);

  const balanceText = isLoadingBalance
    ? "Loading…"
    : balanceError
      ? "Unavailable"
      : availableBalance !== null
        ? `${balanceFormatter.format(availableBalance)} USDT`
        : "—";

  const opposite = positionSide === "LONG" ? "SHORT" : "LONG";
  const isTradingStateReady = !isLoadingPosition;
  const noPosition = isTradingStateReady && positionSide === null;
  /*
   * * see reservedReduceQuantity's own comment in useTradeMenu.ts. The
   * slider needs to work against what's actually still reducible - the
   * raw position size minus whatever other reduce-only orders already
   * claim - not the full position, or dragging to e.g. 50% could ask
   * for far more than the backend will actually have room for.
   */
  const availableToReduceQuantity = Math.max(0, positionQuantity - reservedReduceQuantity);
  const reducedQuantity = availableToReduceQuantity * (reducePct / 100);
  const remainingQuantity = Math.max(0, availableToReduceQuantity - reducedQuantity);
  const quantityFormatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 8,
  });

  return (
    <div
      className="trade-menu"
      style={{ left: tradeMenu.x, top: tradeMenu.y }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="trade-menu-header">
        <div className="trade-menu-heading">
          <div
            className={`trade-position-badge ${
              isLoadingPosition ? "loading" : positionSide ? positionSide.toLowerCase() : "flat"
            }`}
          >
            <span className="trade-position-dot" />
            {isLoadingPosition
              ? "LOADING POSITION"
              : positionSide
                ? `${positionSide} OPEN · ${quantityFormatter.format(positionQuantity)} ${baseAssetLabel}`
                : "NO OPEN POSITION"}
          </div>
        </div>
        <button className="trade-menu-close" disabled={isSubmittingTrade} onClick={onClose}>
          ×
        </button>
      </div>

      <div className={`trade-balance ${balanceError ? "trade-balance-error" : ""}`}>
        <span>Available balance</span>
        <strong>{balanceText}</strong>
      </div>

      {!isBackendConnected && (
        <div className="trade-backend-warning">
          Backend disconnected — trading actions are disabled until it reconnects.
        </div>
      )}

      {!isTradingStateReady ? (
        <div className="trade-menu-loading-body" aria-label="Loading trading state">
          <div className="trade-menu-loading-line wide" />
          <div className="trade-menu-loading-actions">
            <div />
            <div />
          </div>
          <div className="trade-menu-loading-divider" />
          <div className="trade-menu-loading-line" />
          <div className="trade-menu-loading-actions compact">
            <div />
            <div />
          </div>
        </div>
      ) : noPosition ? (
        selectedOrderType === null ? (
          <section className="trade-step">
            {/*
             * Leverage applies to whichever of LIMIT/MARKET the user
             * picks below - it's set here, up front, rather than per
             * order type, since it's really an account/symbol-level
             * setting (Binance's own leverage), not something meaningfully
             * different between a limit and a market entry. AUTO MARKET
             * is unaffected - it derives its own leverage from the chosen
             * stop distance instead (see submitAutoMarket).
             */}
            <div className="trade-leverage-card">
              <div className="trade-leverage-header">
                <span>Leverage</span>
                <strong>{leverage}×</strong>
              </div>

              <input
                className="trade-leverage-slider"
                type="range"
                min={2}
                max={Math.max(2, maxLeverage)}
                step={1}
                value={leverage}
                disabled={isLeverageDisabled}
                onChange={(event) => onLeverageChange(Number(event.target.value))}
                onMouseUp={(event) =>
                  onLeverageCommit(Number((event.target as HTMLInputElement).value))
                }
                onTouchEnd={(event) =>
                  onLeverageCommit(Number((event.target as HTMLInputElement).value))
                }
                onKeyUp={(event) =>
                  onLeverageCommit(Number((event.target as HTMLInputElement).value))
                }
              />

              <div className="trade-leverage-labels">
                <span>2×</span>
                <span>{Math.max(2, maxLeverage)}×</span>
              </div>

              {(isUpdatingLeverage || leverageError) && (
                <div className={`trade-leverage-status ${leverageError ? "error" : ""}`}>
                  {isUpdatingLeverage ? "Updating leverage…" : leverageError}
                </div>
              )}
            </div>

            <div className="trade-step-copy">
              <strong>Choose order type</strong>
            </div>

            <div className="trade-order-type-grid">
              <button
                className="trade-order-type-button"
                disabled={isTradingDisabled}
                onClick={() => setSelectedOrderType("LIMIT")}
              >
                <span className="trade-order-type-icon">LMT</span>
                <strong>LIMIT ORDER</strong>
                <small>{tradeMenu.selectedPrice.toFixed(pricePrecision)}</small>
              </button>

              <button
                className="trade-order-type-button"
                disabled={isTradingDisabled}
                onClick={() => setSelectedOrderType("MARKET")}
              >
                <span className="trade-order-type-icon">MKT</span>
                <strong>MARKET ORDER</strong>
                <small>{tradeMenu.marketPrice.toFixed(pricePrecision)}</small>
              </button>

              <button
                className="trade-order-type-button trade-auto-market-button"
                disabled={isTradingDisabled}
                onClick={() => setSelectedOrderType("AUTO_MARKET")}
              >
                <span className="trade-order-type-icon">AUTO</span>
                <strong>AUTO MARKET</strong>
                <small>
                  {/* this used to claim 1% even when AUTO MARKET used the
                      persisted backend setting (for example 2%). */}
                  {marginPct === null
                    ? "Configured margin"
                    : `${(marginPct * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}% margin`}
                  {" · leverage from stop"}
                </small>
              </button>
            </div>
          </section>
        ) : (
          <section className="trade-step">
            <div className="trade-direction-header">
              <div className="trade-step-copy compact">
                <strong>
                  {selectedOrderType === "AUTO_MARKET"
                    ? "AUTO MARKET"
                    : `${selectedOrderType} ORDER`}
                </strong>
                <span>
                  {selectedOrderType === "LIMIT"
                    ? `Selected price · ${tradeMenu.selectedPrice.toFixed(pricePrecision)} · ${leverage}× leverage`
                    : selectedOrderType === "AUTO_MARKET"
                      ? "Choose direction, then drag the stop on chart"
                      : `Current price · ${tradeMenu.marketPrice.toFixed(pricePrecision)} · ${leverage}× leverage`}
                </span>
              </div>
            </div>

            <div className="trade-action-row trade-direction-actions">
              <button
                className="trade-action trade-long"
                disabled={isTradingDisabled}
                onClick={() =>
                  selectedOrderType === "AUTO_MARKET"
                    ? onAutoMarket("BUY")
                    : onSubmit(selectedOrderType, "BUY")
                }
              >
                {pendingTradeAction ===
                (selectedOrderType === "AUTO_MARKET"
                  ? "AUTO_MARKET_BUY"
                  : `${selectedOrderType}_BUY`)
                  ? "Submitting…"
                  : "LONG"}
              </button>

              <button
                className="trade-action trade-short"
                disabled={isTradingDisabled}
                onClick={() =>
                  selectedOrderType === "AUTO_MARKET"
                    ? onAutoMarket("SELL")
                    : onSubmit(selectedOrderType, "SELL")
                }
              >
                {pendingTradeAction ===
                (selectedOrderType === "AUTO_MARKET"
                  ? "AUTO_MARKET_SELL"
                  : `${selectedOrderType}_SELL`)
                  ? "Submitting…"
                  : "SHORT"}
              </button>
            </div>

            <button
              className="trade-step-back"
              disabled={isSubmittingTrade}
              onClick={() => setSelectedOrderType(null)}
            >
              ← BACK
            </button>
          </section>
        )
      ) : positionSide ? (
        activeAction === "ADD" ? (
          <section className="trade-step">
            <div className="trade-direction-header">
              <div className="trade-step-copy compact">
                <strong>ADD TO {positionSide}</strong>
              </div>
            </div>

            <div className="trade-action-row">
              <button
                className="trade-action trade-secondary"
                disabled={isTradingDisabled}
                onClick={() => onAdd("LIMIT")}
              >
                {pendingTradeAction === "LIMIT_ADD" ? "Submitting…" : "LIMIT ADD"}
              </button>
              <button
                className="trade-action trade-secondary"
                disabled={isTradingDisabled}
                onClick={() => onAdd("MARKET")}
              >
                {pendingTradeAction === "MARKET_ADD" ? "Submitting…" : "MARKET ADD"}
              </button>
            </div>

            <button
              className="trade-step-back"
              disabled={isSubmittingTrade}
              onClick={() => setActiveAction(null)}
            >
              ← BACK
            </button>
          </section>
        ) : activeAction === "REDUCE" ? (
          <section className="trade-step">
            <div className="trade-direction-header">
              <div className="trade-step-copy compact">
                <strong>REDUCE {positionSide}</strong>
              </div>
            </div>

            <section className="trade-manage-card">
              <div className="trade-manage-header">
                <span>Reduce current {positionSide}</span>
                <strong>{reducePct}%</strong>
              </div>

              <div className="trade-position-breakdown">
                <div>
                  <span>
                    {reservedReduceQuantity > 0 ? "Available to reduce" : "Current position"}
                  </span>
                  <strong>
                    {quantityFormatter.format(availableToReduceQuantity)} {baseAssetLabel}
                  </strong>
                </div>
                <div>
                  <span>Close now</span>
                  <strong className="reduce-quantity">
                    {quantityFormatter.format(reducedQuantity)} {baseAssetLabel}
                  </strong>
                </div>
                <div>
                  <span>Remaining</span>
                  <strong>
                    {quantityFormatter.format(remainingQuantity)} {baseAssetLabel}
                  </strong>
                </div>
              </div>

              {reservedReduceQuantity > 0 && (
                <p className="trade-reduce-reserved-note">
                  {quantityFormatter.format(reservedReduceQuantity)} {baseAssetLabel} of your{" "}
                  {quantityFormatter.format(positionQuantity)} {baseAssetLabel} position is already
                  reserved by other reduce orders (TP/SL/existing reduces).
                </p>
              )}

              <input
                className="trade-reduce-slider"
                type="range"
                min="1"
                max="100"
                step="1"
                value={reducePct}
                disabled={isTradingDisabled}
                onChange={(event) => onReducePctChange(Number(event.target.value))}
              />
              <div className="trade-slider-labels">
                <span>1%</span>
                <span>50%</span>
                <span>100%</span>
              </div>
              <div className="trade-reduce-actions">
                <button
                  className="trade-action trade-reduce-button trade-limit-reduce"
                  disabled={isTradingDisabled}
                  onClick={() => onReduce("LIMIT")}
                >
                  {pendingTradeAction === "LIMIT_REDUCE"
                    ? "Submitting…"
                    : `LIMIT REDUCE @ ${tradeMenu.selectedPrice.toFixed(pricePrecision)}`}
                </button>

                <button
                  className="trade-action trade-reduce-button"
                  disabled={isTradingDisabled}
                  onClick={() => onReduce("MARKET")}
                >
                  {pendingTradeAction === "MARKET_REDUCE"
                    ? "Reducing…"
                    : reducePct === 100
                      ? `CLOSE FULL ${positionSide} NOW`
                      : `MARKET REDUCE ${quantityFormatter.format(reducedQuantity)} ${baseAssetLabel}`}
                </button>
              </div>
            </section>

            <button
              className="trade-step-back"
              disabled={isSubmittingTrade}
              onClick={() => setActiveAction(null)}
            >
              ← BACK
            </button>
          </section>
        ) : (
          <section className="trade-step">
            <div className="trade-action-row">
              <button
                className="trade-action trade-secondary"
                disabled={isSubmittingTrade}
                onClick={() => setActiveAction("ADD")}
              >
                ADD
              </button>
              <button
                className="trade-action trade-secondary"
                disabled={isSubmittingTrade}
                onClick={() => setActiveAction("REDUCE")}
              >
                REDUCE
              </button>
            </div>

            {/*
             * TEMPORARILY DISABLED: unconditionally disabled (not just
             * while submitting or disconnected) pending some known issues
             * being fixed later. Left visible rather than removed so it's
             * clear this is a deliberate, temporary state rather than a
             * missing feature - remove the `disabled` override and title
             * once those issues are resolved.
             */}
            <button
              className="trade-action trade-reverse-market"
              disabled
              title="Market reverse is temporarily disabled"
              onClick={onReverse}
            >
              {`MARKET REVERSE TO ${opposite}`}
            </button>
          </section>
        )
      ) : null}
    </div>
  );
}
