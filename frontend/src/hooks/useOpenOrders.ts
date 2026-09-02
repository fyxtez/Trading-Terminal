import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelOrder as cancelBinanceOrder,
  getOpenOrders,
  chaseLimitOrder as chaseBinanceLimitOrder,
  updateReduceOrder as updateBinanceReduceOrder,
  type OpenOrder,
} from "../trading/api/orders";
import type { MarketOrderFill } from "../trading/types";
import { isStaleOrderError } from "../trading/errors";

/*
 * FIX: same resilience gap as usePositions.ts (see the comment there for
 * the full story) - this used to refresh open orders ONLY in reaction to
 * "trading-state-changed"/"orders-state-changed" DOM events. If one of
 * those is ever missed anywhere upstream (the backend's own connection
 * to Binance's user-data stream has already been observed to drop data
 * on this setup), the Open Orders list would sit stale until something
 * else happened to trigger a refresh. A quiet periodic poll closes that
 * gap independent of any push notification.
 */
const OPEN_ORDERS_SELF_HEAL_POLL_MS = 4_000;

/**
 * `symbol` is either a specific trading symbol (chart order-line
 * rendering wants just that one) or `null` (PositionsPanel's Open
 * Orders tab wants every symbol's open orders, the same way the
 * Positions tab already shows every symbol's positions - not just
 * whichever one happens to be selected on the chart).
 */
export function useOpenOrders(
  symbol: string | null,
  onMarketOrderFilled?: (fill: MarketOrderFill) => void,
) {
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);
  const [updatingOrderId, setUpdatingOrderId] = useState<string | null>(null);
  const [chasingOrderId, setChasingOrderId] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (force = false) => {
    const requestId = ++requestIdRef.current;

    setIsLoading(true);
    setError(null);

    try {
      const nextOrders = await getOpenOrders(symbol ?? undefined, undefined, force);

      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return;
      }

      setOrders(nextOrders);
    } catch (caughtError) {
      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return;
      }

      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to load open orders",
      );
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [symbol]);

  useEffect(() => {
    void refresh(true);

    // Binance user-data events are forwarded through /api/ws/trading and
    // become this browser event. Debounce bursts so one fill/cancel sequence
    // produces one snapshot fetch instead of several overlapping requests.
    let refreshTimer: number | null = null;
    const handleTradingStateChanged = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refresh(true);
      }, 100);
    };

    window.addEventListener("trading-state-changed", handleTradingStateChanged);
    window.addEventListener("orders-state-changed", handleTradingStateChanged);

    return () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      window.removeEventListener("trading-state-changed", handleTradingStateChanged);
      window.removeEventListener("orders-state-changed", handleTradingStateChanged);
    };
  }, [refresh]);

  // Self-heal poll - see the big comment above. Independent of the
  // event-driven refresh; guarantees open orders can never drift out of
  // sync for more than one poll interval regardless of whether any push
  // notification along the chain was missed.
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refresh();
    }, OPEN_ORDERS_SELF_HEAL_POLL_MS);

    return () => window.clearInterval(intervalId);
  }, [refresh]);

  const cancelOrder = useCallback(
    async (order: OpenOrder) => {
      if (cancellingOrderId !== null) return;

      setCancellingOrderId(order.orderId);
      setError(null);

      try {
        await cancelBinanceOrder(order.symbol, order.orderId);

        if (!mountedRef.current) return;

        setOrders((current) =>
          current.filter((item) => item.orderId !== order.orderId),
        );
      } catch (caughtError) {
        if (!mountedRef.current) return;

        const message =
          caughtError instanceof Error
            ? caughtError.message
            : `Unable to cancel order ${order.orderId}`;

        setError(message);

        /*
         * FIX (ghost order never disappearing): this used to only call
         * refresh() here and hope it eventually cleaned things up. But
         * if this order genuinely doesn't exist anymore (confirmed by
         * Binance's own rejection, not a guess), waiting on refresh()
         * means the still-showing row keeps failing the same action
         * indefinitely if refresh() itself keeps failing too - e.g. the
         * backend having a rough patch reaching Binance (the exact
         * "502 Bad Gateway"/timeout situation already seen on this
         * setup), which stops the self-heal poll from ever succeeding
         * long enough to notice this order is gone. Removing it from
         * local state immediately, the moment the stale-order response
         * confirms it's gone, means the row disappears right away
         * regardless of whether any subsequent refresh happens to
         * succeed.
         */
        if (isStaleOrderError(message)) {
          setOrders((current) =>
            current.filter((item) => item.orderId !== order.orderId),
          );
        }

        void refresh(true);
      } finally {
        if (mountedRef.current) {
          setCancellingOrderId(null);
        }
      }
    },
    [cancellingOrderId, refresh],
  );


  const updateReduceOrder = useCallback(
    async (order: OpenOrder, reducePct: number) => {
      if (updatingOrderId !== null) return;

      setUpdatingOrderId(order.orderId);
      setError(null);

      try {
        const result = await updateBinanceReduceOrder(
          order.symbol,
          order.orderId,
          reducePct,
        );

        if (!mountedRef.current) return result;

        await refresh(true);
        window.dispatchEvent(new Event("trading-state-changed"));

        return result;
      } catch (caughtError) {
        if (!mountedRef.current) return;

        const message =
          caughtError instanceof Error
            ? caughtError.message
            : `Unable to update reduce order ${order.orderId}`;

        setError(message);

        // Same reasoning as cancelOrder's own catch above - don't wait
        // on refresh() (which can itself keep failing) to notice a
        // confirmed-gone order and remove it from the list.
        if (isStaleOrderError(message)) {
          setOrders((current) =>
            current.filter((item) => item.orderId !== order.orderId),
          );
        }

        void refresh(true);
        throw caughtError;
      } finally {
        if (mountedRef.current) {
          setUpdatingOrderId(null);
        }
      }
    },
    [refresh, updatingOrderId],
  );


  const chaseOrder = useCallback(
    async (order: OpenOrder) => {
      if (chasingOrderId !== null) return null;

      setChasingOrderId(order.orderId);
      setError(null);

      try {
        const result = await chaseBinanceLimitOrder(
          order.symbol,
          order.orderId,
        );

        if (!mountedRef.current) return result;

        setOrders((current) =>
          current.filter((item) => item.orderId !== order.orderId),
        );

        const averagePrice = Number(result.market_order.avgPrice);
        const responsePrice = Number(result.market_order.price);

        const markerPrice =
          Number.isFinite(averagePrice) && averagePrice > 0
            ? averagePrice
            : Number.isFinite(responsePrice) && responsePrice > 0
              ? responsePrice
              : Number(order.price);

        if (
          onMarketOrderFilled &&
          Number.isFinite(markerPrice) &&
          markerPrice > 0
        ) {
          onMarketOrderFilled({
            symbol: result.market_order.symbol ?? order.symbol,
            side: result.side,
            time: Math.floor(
              (
                result.market_order.updateTime ??
                result.market_order.transactTime ??
                Date.now()
              ) / 1000,
            ),
            price: markerPrice,
          });
        }

        window.dispatchEvent(new Event("trading-state-changed"));
        void refresh(true);

        return result;
      } catch (caughtError) {
        if (!mountedRef.current) return null;

        const message =
          caughtError instanceof Error
            ? caughtError.message
            : `Unable to chase order ${order.orderId}`;

        setError(message);

        // Same reasoning as cancelOrder/updateReduceOrder's own catches.
        if (isStaleOrderError(message)) {
          setOrders((current) =>
            current.filter((item) => item.orderId !== order.orderId),
          );
        }

        void refresh(true);
        throw caughtError;
      } finally {
        if (mountedRef.current) {
          setChasingOrderId(null);
        }
      }
    },
    [chasingOrderId, onMarketOrderFilled, refresh],
  );

  return {
    orders,
    isLoading,
    error,
    cancellingOrderId,
    updatingOrderId,
    chasingOrderId,
    refresh,
    cancelOrder,
    updateReduceOrder,
    chaseOrder,
  };
}

export type OpenOrdersApi = ReturnType<typeof useOpenOrders>;
