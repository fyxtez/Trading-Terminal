import { useEffect, useRef, useState } from "react";
import { DEFAULT_LEVERAGE } from "../config/constants";
import { getAvailableBalance } from "../trading/api/account";
import { estimatePendingLimitLiquidation } from "../trading/estimatedLiquidation";
import {
  placeAutoMarketOrder,
  placeFullStopLoss,
  placeLimitOrder,
  placeMarketOrder,
  getOpenOrders,
} from "../trading/api/orders";
import { executePositionIntent, getPositions, type PositionSide } from "../trading/api/positions";
import { getCachedSymbolFilters, getSymbolFilters, roundToStep } from "../trading/api/exchangeInfo";
import { getSizing } from "../trading/api/sizing";
import { getCurrentLeverage, getMaxLeverage, updateLeverage } from "../trading/api/leverage";
import { saveStop } from "../trading/stopLoss";
import type { ConnectionState } from "./useTradingStream";
import type {
  BinanceOrderResponse,
  MarketOrderFill,
  PendingLimitOrder,
  TradeMenuState,
  TradeOrderType,
  TradeSide,
  TradeToastState,
} from "../trading/types";

export type PendingTradeAction =
  | "LIMIT_BUY"
  | "LIMIT_SELL"
  | "MARKET_BUY"
  | "MARKET_SELL"
  | "LIMIT_ADD"
  | "MARKET_ADD"
  | "LIMIT_REDUCE"
  | "MARKET_REDUCE"
  | "MARKET_REVERSE"
  | "AUTO_MARKET_BUY"
  | "AUTO_MARKET_SELL"
  | null;

export type AutoMarketDraft = {
  side: TradeSide;
  stopLoss: number;
};

const TOAST_LIFETIME_MS = { success: 4000, error: 6000 } as const;
/*
 * this used to dispatch ONLY "trading-state-changed". That's
 * exactly what useOpenOrders.ts listens for, but the auto-open-panel
 * logic in App.tsx (which already has a well-built retry loop
 * specifically for "a market order just filled but the position
 * snapshot hasn't caught up yet") only listens for
 * "account-state-changed" - a different event. So opening a market
 * position, or an AUTO MARKET order filling, correctly updated the
 * account but never actually triggered the code that was supposed to
 * open the panel for it. Dispatching both here means every trade
 * action (market, limit, auto market, reduce, whichever of this
 * function's 6 call sites) reaches whichever listener actually cares,
 * instead of every call site needing to individually know which event
 * name its own particular action happens to require.
 */
const dispatchTradingStateChanged = () => {
  window.dispatchEvent(new Event("trading-state-changed"));
  window.dispatchEvent(new Event("account-state-changed"));
};

// Fallback ceiling for the leverage slider until the real caps (sizing
// config + exchange max - see below) have loaded. Kept well above
// DEFAULT_LEVERAGE so the slider isn't visually collapsed to a single
// notch during that brief window.
const FALLBACK_MAX_LEVERAGE = 20;

function clampLeverage(value: number, max: number): number {
  return Math.max(2, Math.min(max, Math.round(value)));
}

/**
 * `symbol` is the currently active trading symbol (e.g. "BTCUSDT",
 * "SOLUSDT") - EVERY order placed, every position/leverage lookup, and
 * every saved stop-loss below uses this value instead of a hardcoded
 * constant. This is the fix for "make sure requests to backend send the
 * right symbol": there is no longer any code path in this file that can
 * send BTCUSDT while the user is actually looking at XRP.
 */
export function useTradeMenu(
  symbol: string,
  onLimitOrderPlaced: (order: PendingLimitOrder) => void,
  onMarketOrderFilled: (fill: MarketOrderFill) => void,
  /**
   * Backend REST connection health (see useBackendConnection in App.tsx).
   * Only used to re-trigger the balance/position/sizing fetch below when
   * the backend comes back up while the trade menu happens to be open.
   */
  backendConnection?: ConnectionState,
  executionEnabled: boolean = true,
) {
  const [tradeMenu, setTradeMenu] = useState<TradeMenuState | null>(null);
  const [pendingTradeAction, setPendingTradeAction] = useState<PendingTradeAction>(null);
  const [tradeToast, setTradeToast] = useState<TradeToastState | null>(null);
  const [availableBalance, setAvailableBalance] = useState<number | null>(null);
  const [balanceRevision, setBalanceRevision] = useState(0);
  // keep the backend's persisted margin fraction alongside the balance
  // so AUTO MARKET can display the value it actually uses instead of the old
  // hardcoded "1%" label.
  const [marginPct, setMarginPct] = useState<number | null>(null);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [positionSide, setPositionSide] = useState<PositionSide | null>(null);
  const [positionQuantity, setPositionQuantity] = useState(0);
  /**
   * How much of positionQuantity is already reserved by OTHER reduce-only
   * orders (TP/SL limit reduces already resting on the book) - see the
   * comment on availableToReduceQuantity below for why this exists.
   */
  const [reservedReduceQuantity, setReservedReduceQuantity] = useState(0);
  const [isLoadingPosition, setIsLoadingPosition] = useState(false);
  const tradeStateRequestIdRef = useRef(0);
  const [reducePct, setReducePct] = useState(100);
  const [autoMarketDraft, setAutoMarketDraft] = useState<AutoMarketDraft | null>(null);
  const isSubmittingTrade = pendingTradeAction !== null;

  // --- Leverage slider (LIMIT/MARKET entry orders) ------------------------
  const [leverage, setLeverageState] = useState(DEFAULT_LEVERAGE);
  const [maxLeverage, setMaxLeverage] = useState(FALLBACK_MAX_LEVERAGE);
  const [isUpdatingLeverage, setIsUpdatingLeverage] = useState(false);
  const [leverageError, setLeverageError] = useState<string | null>(null);
  const leverageRequestIdRef = useRef(0);

  // --- Reset when the active symbol changes -------------------------------
  //
  // Everything above is scoped to whichever symbol was selected when it
  // was fetched/set. Switching symbols mid-flow (menu open, or an AUTO
  // MARKET stop being dragged) must not let a BTC price/leverage/position
  // silently carry over and get submitted against the newly-selected
  // symbol - close/clear it instead.
  const previousSymbolRef = useRef(symbol);

  useEffect(() => {
    if (previousSymbolRef.current === symbol) return;
    previousSymbolRef.current = symbol;

    tradeStateRequestIdRef.current += 1;
    setTradeMenu(null);
    setAutoMarketDraft(null);
    setPendingTradeAction(null);
    setReducePct(100);
    setPositionSide(null);
    setPositionQuantity(0);
    setReservedReduceQuantity(0);
    setAvailableBalance(null);
    setMarginPct(null);
    setBalanceError(null);
    setIsLoadingBalance(false);
    setIsLoadingPosition(false);
    setLeverageState(DEFAULT_LEVERAGE);
    setLeverageError(null);
  }, [symbol]);

  useEffect(() => {
    if (executionEnabled) void getSymbolFilters(symbol);
  }, [symbol, executionEnabled]);

  useEffect(() => {
    let refreshTimer: number | null = null;

    const handleAccountStateChanged = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);

      /*
       * * ACCOUNT_UPDATE reaches the browser before the backend's debounced REST
       * reconciliation has populated availableBalance (Binance's push payload
       * only contains walletBalance). Wait slightly longer than that backend
       * debounce, then re-run the trade-state fetch below. Coalescing bursts
       * also avoids issuing several identical balance requests for one transfer.
       */
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        setBalanceRevision((revision) => revision + 1);
      }, 250);
    };

    window.addEventListener("account-state-changed", handleAccountStateChanged);
    return () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      window.removeEventListener("account-state-changed", handleAccountStateChanged);
    };
  }, []);
  useEffect(() => {
    if (!tradeToast || tradeToast.kind === "pending") return;
    const timer = window.setTimeout(() => setTradeToast(null), TOAST_LIFETIME_MS[tradeToast.kind]);
    return () => window.clearTimeout(timer);
  }, [tradeToast]);

  useEffect(() => {
    if (!tradeMenu || !executionEnabled) return;

    // Only refetch once the backend is actually reachable. When
    // backendConnection is "disconnected" this would just throw and
    // immediately show "Unavailable" again - waiting for it to flip back
    // to "connected" (which re-runs this effect, since it's a dependency
    // below) avoids a pointless failing request and error toast.
    if (backendConnection === "disconnected") return;

    const controller = new AbortController();
    const requestId = ++tradeStateRequestIdRef.current;

    setIsLoadingBalance(true);
    setIsLoadingPosition(true);

    void Promise.allSettled([
      getAvailableBalance(controller.signal),
      getPositions(controller.signal),
      getSizing(controller.signal),
      getMaxLeverage(symbol),
      getCurrentLeverage(symbol),
      getOpenOrders(symbol, controller.signal),
    ]).then(
      ([
        balanceResult,
        positionsResult,
        sizingResult,
        maxResult,
        currentResult,
        openOrdersResult,
      ]) => {
        if (controller.signal.aborted || requestId !== tradeStateRequestIdRef.current) {
          return;
        }

        // Balance must not become unavailable merely because leverage loading
        // failed. Handle every backend request independently.
        if (balanceResult.status === "fulfilled") {
          setAvailableBalance(balanceResult.value);
          setBalanceError(null);
        } else {
          setAvailableBalance(null);
          setBalanceError(
            balanceResult.reason instanceof Error
              ? balanceResult.reason.message
              : "Unable to load available balance",
          );
        }

        if (positionsResult.status === "fulfilled") {
          const current = positionsResult.value.find(
            (position) => position.symbol.toUpperCase() === symbol.toUpperCase(),
          );
          setPositionSide(current?.side ?? null);
          setPositionQuantity(current?.quantity ?? 0);

          /*
           * this reduce panel used to compute
           * "Close now"/"Remaining" against the RAW position quantity,
           * with zero awareness that some of it might already be claimed
           * by other resting reduce-only orders (an existing TP/SL limit,
           * a previous partial reduce, etc.). So the slider happily let
           * you drag to e.g. 50%, showing a plausible "Close now" figure -
           * but the backend (correctly) only has whatever's left AFTER
           * those other orders' reservations to actually work with, so the
           * real submitted quantity ended up far smaller than what the
           * panel showed, sometimes small enough to fail Binance's
           * min_notional outright. Computing this here means the panel can
           * show the same "available after other orders" figure the
           * backend is actually going to use, instead of a number that
           * looks achievable but isn't.
           */
          if (openOrdersResult.status === "fulfilled" && current) {
            const reduceSide = current.side === "LONG" ? "SELL" : "BUY";
            const reserved = openOrdersResult.value.reduce((total, order) => {
              if (
                !order.reduceOnly ||
                order.side !== reduceSide ||
                order.symbol.toUpperCase() !== symbol.toUpperCase()
              ) {
                return total;
              }

              const orig = Number(order.origQty);
              const executed = Number(order.executedQty);
              const remaining =
                Number.isFinite(orig) && Number.isFinite(executed)
                  ? Math.max(0, orig - executed)
                  : 0;

              return total + remaining;
            }, 0);

            setReservedReduceQuantity(reserved);
          } else {
            setReservedReduceQuantity(0);
          }
        } else {
          setPositionSide(null);
          setPositionQuantity(0);
          setReservedReduceQuantity(0);
        }

        const personalMax =
          sizingResult.status === "fulfilled"
            ? Number(sizingResult.value.max_leverage)
            : Number.NaN;

        // AUTO MARKET sizing is backend-owned; mirror its returned
        // margin_pct strictly for display so the menu cannot claim 1% while an
        // updated setting (for example 2%) is used to place the real order.
        setMarginPct(sizingResult.status === "fulfilled" ? sizingResult.value.margin_pct : null);
        const exchangeMax =
          maxResult.status === "fulfilled" ? Number(maxResult.value.max_leverage) : Number.NaN;

        // Prefer the configured Settings maximum. Apply the exchange cap only
        // when it loaded successfully. Never leave the slider on the temporary
        // 20x fallback just because another request failed.
        const effectiveMax =
          Number.isFinite(personalMax) && personalMax >= 2
            ? Number.isFinite(exchangeMax) && exchangeMax >= 2
              ? Math.min(personalMax, exchangeMax)
              : personalMax
            : Number.isFinite(exchangeMax) && exchangeMax >= 2
              ? exchangeMax
              : FALLBACK_MAX_LEVERAGE;

        setMaxLeverage(effectiveMax);

        if (currentResult.status === "fulfilled") {
          const configuredLeverage = Number(currentResult.value.leverage);
          if (Number.isFinite(configuredLeverage)) {
            setLeverageState(clampLeverage(configuredLeverage, effectiveMax));
          }
        } else {
          console.warn(
            `[leverage] unable to load current leverage for ${symbol}`,
            currentResult.reason,
          );
        }

        setIsLoadingBalance(false);
        setIsLoadingPosition(false);
      },
    );

    return () => controller.abort();
  }, [tradeMenu, backendConnection, symbol, executionEnabled, balanceRevision]);

  const openTradeMenu = (
    clientX: number,
    clientY: number,
    selectedPrice: number,
    marketPrice: number,
  ) => {
    if (!executionEnabled) return;

    const menuWidth = 372;
    const menuHeight = 620;
    const padding = 12;
    const tickSize = getCachedSymbolFilters(symbol)?.tickSize ?? 0.1;

    // Clear every value from the previous opening before rendering this one.
    // This prevents stale LONG/SHORT controls flashing while the new account
    // snapshot is being loaded.
    tradeStateRequestIdRef.current += 1;
    setReducePct(100);
    setPositionSide(null);
    setPositionQuantity(0);
    setReservedReduceQuantity(0);
    setAvailableBalance(null);
    setMarginPct(null);
    setBalanceError(null);
    setIsLoadingBalance(true);
    setIsLoadingPosition(true);

    setTradeMenu({
      x: Math.max(padding, Math.min(clientX + 10, window.innerWidth - menuWidth - padding)),
      y: Math.max(padding, Math.min(clientY + 10, window.innerHeight - menuHeight - padding)),
      selectedPrice: roundToStep(selectedPrice, tickSize),
      marketPrice,
    });
  };

  const closeTradeMenu = () => {
    tradeStateRequestIdRef.current += 1;
    setTradeMenu(null);
  };

  // Live drag value - updates on every slider move, no network call.
  const changeLeverage = (nextLeverage: number) => {
    setLeverageState(clampLeverage(nextLeverage, maxLeverage));
  };

  // Fired once the user releases the slider.
  const commitLeverage = async (nextLeverage: number) => {
    const clamped = clampLeverage(nextLeverage, maxLeverage);
    setLeverageState(clamped);

    const requestId = ++leverageRequestIdRef.current;
    setIsUpdatingLeverage(true);
    setLeverageError(null);

    try {
      await updateLeverage(symbol, clamped);
    } catch (error) {
      if (requestId !== leverageRequestIdRef.current) return;

      setLeverageError(error instanceof Error ? error.message : "Failed to update leverage");
    } finally {
      if (requestId === leverageRequestIdRef.current) {
        setIsUpdatingLeverage(false);
      }
    }
  };

  const emitMarketMarker = (
    side: TradeSide,
    order:
      | {
          symbol?: string | null;
          avgPrice?: string | null;
          price?: string | null;
          updateTime?: number | null;
          transactTime?: number | null;
        }
      | undefined,
    fallbackPrice?: number,
  ) => {
    const averagePrice = Number(order?.avgPrice);
    const responsePrice = Number(order?.price);
    const menuPrice = tradeMenu?.marketPrice;

    const price =
      Number.isFinite(averagePrice) && averagePrice > 0
        ? averagePrice
        : Number.isFinite(responsePrice) && responsePrice > 0
          ? responsePrice
          : Number.isFinite(fallbackPrice) && Number(fallbackPrice) > 0
            ? Number(fallbackPrice)
            : Number.isFinite(menuPrice) && Number(menuPrice) > 0
              ? Number(menuPrice)
              : null;

    if (price === null) {
      console.warn("[trade-marker] market fill did not contain a usable price", order);
      return;
    }

    onMarketOrderFilled({
      // prefer the ACTUAL order response's own symbol (Binance
      // always returns this) over the hook's closure `symbol` - this
      // hook is already scoped to one symbol so the two almost always
      // agree, but preferring the response's own value costs nothing
      // and removes any doubt in the rare case a request is still
      // in-flight across a symbol switch.
      symbol: order?.symbol ?? symbol,
      side,
      time: Math.floor((order?.updateTime ?? order?.transactTime ?? Date.now()) / 1000),
      price,
    });
  };

  const limitOrderFilledImmediately = (order?: BinanceOrderResponse | null): boolean => {
    if (!order) return false;

    if (order.status?.toUpperCase() === "FILLED") {
      return true;
    }

    const originalQuantity = Number(order.origQty);
    const executedQuantity = Number(order.executedQty);

    return (
      Number.isFinite(originalQuantity) &&
      originalQuantity > 0 &&
      Number.isFinite(executedQuantity) &&
      executedQuantity >= originalQuantity - 1e-12
    );
  };

  const submitTrade = async (orderType: TradeOrderType, side: TradeSide) => {
    if (!tradeMenu || isSubmittingTrade) return;
    const action = `${orderType}_${side}` as Exclude<PendingTradeAction, null>;
    setPendingTradeAction(action);
    setTradeToast(null);

    try {
      const isLimit = orderType === "LIMIT";
      let executionPrice = isLimit ? tradeMenu.selectedPrice : tradeMenu.marketPrice;

      // the frontend still needs symbol filters for limit-price rounding
      // and display precision, but quantity sizing belongs to the backend so
      // it can use the authoritative available balance and margin_pct.
      const filters = await getSymbolFilters(symbol);

      if (isLimit) {
        executionPrice = roundToStep(executionPrice, filters.tickSize);
        const result = await placeLimitOrder({
          symbol,
          side,
          price: executionPrice,
          // omitting quantity makes orders.ts request configured-margin
          // sizing instead of silently restoring the old fixed-$50 trade.
          // The leverage the user picked on the slider (see
          // changeLeverage/commitLeverage above), which the backend was
          // already told about (POST /api/leverage) for THIS symbol the
          // moment they released the slider.
          leverage,
        });
        if (typeof result.order.orderId !== "string") {
          throw new Error("Binance did not return an order ID");
        }
        if (limitOrderFilledImmediately(result.order)) {
          emitMarketMarker(side, result.order);
        } else {
          onLimitOrderPlaced({
            orderId: result.order.orderId,
            clientOrderId: result.order.clientOrderId,
            symbol: result.order.symbol ?? symbol,
            side,
            price: result.submitted_price,
            quantity: result.submitted_quantity,
            timeInForce: "GTC",
            intent: "ENTRY",
            // attach the backend's Binance-bracket-aware estimate so
            // the canvas can show EST. LIQ before this LIMIT becomes a position.
            // prefer the backend's Binance-bracket-aware estimate,
            // but keep the visual available when an older backend (or a
            // response without the transient estimate) is still running.
            estimatedLiquidationPrice:
              result.estimated_liquidation_price ??
              estimatePendingLimitLiquidation(
                result.submitted_price,
                result.applied_leverage ?? leverage,
                side,
              ),
          });
        }
      } else {
        const result = await placeMarketOrder({
          symbol,
          side,
          // MARKET now follows the same persisted margin percentage as
          // LIMIT and AUTO MARKET; the backend fetches its reference price.
          leverage,
        });
        emitMarketMarker(side, result.order);
      }

      dispatchTradingStateChanged();
      setTradeMenu(null);
      setTradeToast({
        kind: "success",
        message: isLimit
          ? `${side === "BUY" ? "LONG" : "SHORT"} limit placed at ${executionPrice.toFixed(filters.pricePrecision)}`
          : `${side === "BUY" ? "LONG" : "SHORT"} opened`,
      });
    } catch (error) {
      setTradeToast({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to submit order",
      });
    } finally {
      setPendingTradeAction(null);
    }
  };

  const beginAutoMarket = async (side: TradeSide) => {
    if (!tradeMenu || isSubmittingTrade) return;

    const { tickSize } = await getSymbolFilters(symbol);

    // Prefer the exact chart price the user double-clicked as the initial
    // stop-loss. If it is on the wrong side for the chosen direction, fall
    // back to a compact 0.2% visual starting distance that the user can drag.
    const selectedPriceIsValid =
      side === "BUY"
        ? tradeMenu.selectedPrice < tradeMenu.marketPrice
        : tradeMenu.selectedPrice > tradeMenu.marketPrice;
    const initialDistance = tradeMenu.marketPrice * 0.002;
    const fallbackStop =
      side === "BUY"
        ? tradeMenu.marketPrice - initialDistance
        : tradeMenu.marketPrice + initialDistance;
    const rawStop = selectedPriceIsValid ? tradeMenu.selectedPrice : fallbackStop;

    setAutoMarketDraft({
      side,
      stopLoss: roundToStep(rawStop, tickSize),
    });
    setTradeMenu(null);
  };

  const updateAutoMarketStopLoss = (stopLoss: number) => {
    if (!Number.isFinite(stopLoss) || stopLoss <= 0) return;
    setAutoMarketDraft((current) => (current ? { ...current, stopLoss } : current));
  };

  const cancelAutoMarket = () => {
    if (isSubmittingTrade) return;
    setAutoMarketDraft(null);
  };

  const submitAutoMarket = async () => {
    if (!autoMarketDraft || isSubmittingTrade) return;

    const action = `AUTO_MARKET_${autoMarketDraft.side}` as Exclude<PendingTradeAction, null>;
    setPendingTradeAction(action);
    setTradeToast(null);

    try {
      const filters = await getSymbolFilters(symbol);
      const stopLoss = roundToStep(autoMarketDraft.stopLoss, filters.tickSize);
      const result = await placeAutoMarketOrder({
        symbol,
        side: autoMarketDraft.side,
        stopLoss,
      });

      emitMarketMarker(autoMarketDraft.side, result.order, result.entry_reference_price);

      // The stop selected in the pre-trade overlay is not merely a sizing
      // input: once the market entry fills, immediately create the real
      // closePosition STOP_MARKET order and save it so the live position
      // bracket recognises that protection already exists.
      const stopSide: TradeSide = autoMarketDraft.side === "BUY" ? "SELL" : "BUY";
      let stopResponse: Awaited<ReturnType<typeof placeFullStopLoss>> | null = null;
      let lastStopError: unknown = null;

      for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
          stopResponse = await placeFullStopLoss({
            symbol,
            side: stopSide,
            triggerPrice: stopLoss,
          });
          break;
        } catch (error) {
          lastStopError = error;
          // The market order is already FILLED, but Binance's account update
          // can arrive a fraction later. Give the backend cache a moment to
          // observe the position before retrying the stop placement.
          await new Promise((resolve) => window.setTimeout(resolve, 100));
        }
      }

      // this used to be `Number(stopResponse?.algo?.algoId)` -
      // converting the (now correctly string-typed) algoId through JS's
      // Number() would silently reintroduce the exact precision loss
      // safeJson.ts's parseOrderJsonText exists to prevent. Validate it's
      // a well-formed positive integer string instead of ever actually
      // converting it to a number for storage.
      const algoId = stopResponse?.algo?.algoId;
      if (!stopResponse || typeof algoId !== "string" || !/^\d+$/.test(algoId) || algoId === "0") {
        setAutoMarketDraft(null);
        dispatchTradingStateChanged();
        throw new Error(
          `POSITION OPENED, but automatic stop-loss placement failed: ${
            lastStopError instanceof Error
              ? lastStopError.message
              : "Binance did not return a valid stop order"
          }`,
        );
      }

      // this used to be `saveStop({ symbol: ..., ... })` with no
      // second argument. It happened to still work here (the stop
      // object is truthy, and stopLoss.ts's implementation keys off
      // `stop.symbol` in that branch, not the missing param) - but
      // `symbol` is now a required parameter on saveStop, so every call
      // site passes it explicitly rather than depending on that
      // implementation detail to quietly paper over a missing argument.
      saveStop(
        {
          symbol: symbol.toUpperCase(),
          side: stopSide,
          triggerPrice: stopResponse.trigger_price,
          algoId,
        },
        symbol,
      );

      dispatchTradingStateChanged();
      setAutoMarketDraft(null);
      setTradeToast({
        kind: "success",
        message: `${autoMarketDraft.side === "BUY" ? "LONG" : "SHORT"} opened · ${result.applied_leverage}× · SL ${stopLoss.toFixed(filters.pricePrecision)} protected`,
      });
    } catch (error) {
      setTradeToast({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to submit auto market order",
      });
    } finally {
      setPendingTradeAction(null);
    }
  };

  const submitAdd = async (orderType: TradeOrderType) => {
    if (!tradeMenu || !positionSide || isSubmittingTrade) return;
    setPendingTradeAction(orderType === "LIMIT" ? "LIMIT_ADD" : "MARKET_ADD");
    setTradeToast(null);

    try {
      // ADD sizing is backend-owned now. Omitting quantity makes the
      // backend allocate the configured margin percentage again (about 2% of
      // available balance in the reported setup) at the leverage already on
      // the open position, instead of adding a fixed 50 USDT notional whose
      // actual margin was only 50 / leverage. Leverage remains omitted too so
      // an open ISOLATED position is never changed and cannot hit -4161.
      const result = await executePositionIntent({
        symbol,
        intent: "ADD",
        orderType,
        price: orderType === "LIMIT" ? tradeMenu.selectedPrice : undefined,
      });

      if (orderType === "LIMIT") {
        const orderId = result.order?.orderId;
        if (
          typeof orderId !== "string" ||
          result.submitted_price == null ||
          result.submitted_quantity == null
        ) {
          throw new Error("Backend returned an invalid limit-add order");
        }
        if (limitOrderFilledImmediately(result.order)) {
          emitMarketMarker(result.side, result.order);
        } else {
          onLimitOrderPlaced({
            orderId,
            clientOrderId: result.order?.clientOrderId ?? null,
            symbol: result.order?.symbol ?? symbol,
            side: result.side,
            price: result.submitted_price,
            quantity: result.submitted_quantity,
            timeInForce: "GTC",
            intent: "ADD",
          });
        }
      } else {
        emitMarketMarker(result.side, result.order);
      }

      dispatchTradingStateChanged();
      setTradeMenu(null);
      setTradeToast({ kind: "success", message: `${orderType} add submitted` });
    } catch (error) {
      setTradeToast({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to add",
      });
    } finally {
      setPendingTradeAction(null);
    }
  };

  const submitReduce = async (orderType: TradeOrderType) => {
    if (!tradeMenu || !positionSide || isSubmittingTrade) return;

    setPendingTradeAction(orderType === "LIMIT" ? "LIMIT_REDUCE" : "MARKET_REDUCE");
    setTradeToast(null);

    try {
      const result = await executePositionIntent({
        symbol,
        intent: "REDUCE",
        orderType,
        price: orderType === "LIMIT" ? tradeMenu.selectedPrice : undefined,
        reducePct,
      });

      if (orderType === "LIMIT") {
        const orderId = result.order?.orderId;

        if (
          typeof orderId !== "string" ||
          result.submitted_price == null ||
          result.submitted_quantity == null
        ) {
          throw new Error("Backend returned an invalid limit-reduce order");
        }

        if (limitOrderFilledImmediately(result.order)) {
          emitMarketMarker(result.side, result.order);
        } else {
          onLimitOrderPlaced({
            orderId,
            clientOrderId: result.order?.clientOrderId ?? null,
            symbol: result.order?.symbol ?? symbol,
            side: result.side,
            price: result.submitted_price,
            quantity: result.submitted_quantity,
            timeInForce: "GTC",
            intent: "REDUCE",
            reducePct: result.reduce_pct ?? reducePct,
            remainingPct: result.remaining_position_pct,
          });
        }
      } else {
        emitMarketMarker(result.side, result.close_order);
      }

      dispatchTradingStateChanged();
      setTradeMenu(null);
      setTradeToast({
        kind: "success",
        message:
          orderType === "LIMIT"
            ? `Reduce ${reducePct}% placed at ${tradeMenu.selectedPrice.toFixed(getCachedSymbolFilters(symbol)?.pricePrecision ?? 2)}`
            : `Reduced ${positionSide} by ${reducePct}%`,
      });
    } catch (error) {
      setTradeToast({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to reduce position",
      });
    } finally {
      setPendingTradeAction(null);
    }
  };

  const submitReverse = async () => {
    if (!tradeMenu || !positionSide || isSubmittingTrade) return;

    setPendingTradeAction("MARKET_REVERSE");
    setTradeToast(null);

    try {
      const result = await executePositionIntent({
        symbol,
        intent: "REVERSE",
        orderType: "MARKET",
        leverage: DEFAULT_LEVERAGE,
      });

      emitMarketMarker(result.side, result.open_order);
      dispatchTradingStateChanged();
      setTradeMenu(null);
      setTradeToast({
        kind: "success",
        message: `Reversed to ${positionSide === "LONG" ? "SHORT" : "LONG"}`,
      });
    } catch (error) {
      setTradeToast({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to reverse",
      });
    } finally {
      setPendingTradeAction(null);
    }
  };

  return {
    tradeMenu,
    setTradeMenu,
    openTradeMenu,
    closeTradeMenu,
    isSubmittingTrade,
    pendingTradeAction,
    tradeToast,
    setTradeToast,
    submitTrade,
    beginAutoMarket,
    autoMarketDraft,
    updateAutoMarketStopLoss,
    cancelAutoMarket,
    submitAutoMarket,
    submitAdd,
    submitReduce,
    submitReverse,
    availableBalance,
    marginPct,
    isLoadingBalance,
    balanceError,
    positionSide,
    positionQuantity,
    reservedReduceQuantity,
    isLoadingPosition,
    reducePct,
    setReducePct,
    addMarketFillMarker: emitMarketMarker,
    // Leverage slider (LIMIT/MARKET entry only).
    leverage,
    maxLeverage,
    isUpdatingLeverage,
    leverageError,
    changeLeverage,
    commitLeverage,
  };
}

export type TradeMenuApi = ReturnType<typeof useTradeMenu>;
