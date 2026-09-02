import { useCallback, useEffect, useRef, useState } from "react";
import {
  closePositionMarket,
  getPositions,
  type OpenPosition,
} from "../trading/api/positions";
import type { TradeSide } from "../trading/types";

const POST_CLOSE_REFRESH_DELAY_MS = 250;

/*
 * FIX (positions going stale - "Binance shows 0 positions but the app
 * still shows one open" - and the reverse): this used to refresh ONLY in
 * reaction to the "account-state-changed" DOM event, which is dispatched
 * from useTradingStream.ts's handling of the LOCAL trading websocket
 * (browser <-> this app's own backend). That event is itself downstream
 * of the backend's OWN connection to Binance's user-data stream - if
 * that connection ever misses/drops a message (this session has already
 * demonstrated real, confirmed network unreliability for persistent
 * connections - the kline WebSocket silently dropped data, and the
 * backend logged an outright failed Binance REST call), nothing here
 * would ever notice and re-check on its own; the UI would just sit on
 * stale data until the user did something else or reloaded the page.
 *
 * A quiet periodic REST poll, independent of any push notification,
 * means the position list self-heals within a few seconds regardless of
 * where in the chain a push event went missing - the same fix already
 * applied to the chart's own live price feed (see useMarketData.ts).
 */
const POSITIONS_SELF_HEAL_POLL_MS = 4_000;

export function usePositions(
  isOpen: boolean,
  onPositionClosed?: (side: TradeSide, symbol: string, price?: number) => void,
) {
  const [positions, setPositions] = useState<OpenPosition[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [closingSymbol, setClosingSymbol] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * Incremented for every positions request.
   * Only the newest request is allowed to update React state.
   */
  const refreshRequestIdRef = useRef(0);

  /*
   * Prevents state updates after the hook has actually unmounted.
   * This is reset to true during every effect setup, so it also works
   * correctly with React StrictMode in development.
   */
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      refreshRequestIdRef.current += 1;
    };
  }, []);

  const refresh = useCallback(async (force = false) => {
    const requestId = ++refreshRequestIdRef.current;

    setIsLoading(true);
    setError(null);

    try {
      const result = await getPositions(undefined, force);

      if (
        !mountedRef.current ||
        requestId !== refreshRequestIdRef.current
      ) {
        return;
      }

      setPositions(result);
    } catch (caughtError) {
      if (
        !mountedRef.current ||
        requestId !== refreshRequestIdRef.current
      ) {
        return;
      }

      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to load positions",
      );
    } finally {
      if (
        mountedRef.current &&
        requestId === refreshRequestIdRef.current
      ) {
        setIsLoading(false);
      }
    }
  }, []);


  useEffect(() => {
    let refreshTimer: number | null = null;
    const handleTradingStateChanged = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        // force=true: something just happened (a position was
        // opened/closed/modified elsewhere) and this needs to reflect
        // the real current state right now, not a moment-ago cached
        // snapshot from whichever of the other pollers happened to hit
        // this endpoint most recently.
        void refresh(true);
      }, 100);
    };

    window.addEventListener("account-state-changed", handleTradingStateChanged);
    return () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      window.removeEventListener("account-state-changed", handleTradingStateChanged);
    };
  }, [refresh]);

  // Self-heal poll - see the big comment above. Runs continuously
  // regardless of whether the panel is open, same as the event listener
  // above already did; a background poll every few seconds is cheap and
  // guarantees positions can never drift out of sync for more than one
  // poll interval, independent of any push notification.
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refresh();
    }, POSITIONS_SELF_HEAL_POLL_MS);

    return () => window.clearInterval(intervalId);
  }, [refresh]);

  // Load when the panel opens. Live changes arrive through the trading
  // websocket and trigger the debounced handler above; the interval above
  // is the resilience backstop for when that path misses something.
  useEffect(() => {
    if (!isOpen) {
      setIsLoading(false);
      return;
    }

    void refresh(true);
  }, [isOpen, refresh]);

  const closeMarket = useCallback(
    async (position: OpenPosition) => {
      if (closingSymbol !== null) {
        return;
      }

      const symbol = position.symbol.toUpperCase();

      setClosingSymbol(symbol);
      setError(null);

      try {
        const result = await closePositionMarket(symbol);

        if (!mountedRef.current) {
          return;
        }

        /*
         * The backend confirmed that the reduce-only market order was filled,
         * so remove the position immediately from the UI.
         */
        setPositions((current) =>
          current.filter(
            (item) => item.symbol.toUpperCase() !== symbol,
          ),
        );

        // FIX: this hook updates its own `positions` state directly above,
        // but never told anything ELSE that the account changed -
        // specifically, PositionBracketOverlay's chart-side TP FULL/STOP
        // LOSS/close controls only refresh reactively off this exact
        // event (or their own multi-second self-heal poll). Without it,
        // closing a position from this panel's "Market" button left the
        // chart's own controls stale for however long that poll took to
        // notice on its own - same bug shape, opposite direction, as the
        // one this event fixes for PositionBracketOverlay's own close-X.
        window.dispatchEvent(new Event("account-state-changed"));

        /*
         * Closing a LONG fills as a SELL and closing a SHORT fills as a
         * BUY - use the side the backend actually executed rather than
         * inferring it from the position, so the fill marker always
         * matches reality even if the backend ever changes that logic.
         */
        const avgPrice = Number(result?.order?.avgPrice);
        onPositionClosed?.(
          result.side,
          symbol,
          Number.isFinite(avgPrice) && avgPrice > 0 ? avgPrice : undefined,
        );

        /*
         * Confirm the real account state shortly afterwards.
         */
        window.setTimeout(() => {
          if (mountedRef.current) {
            void refresh(true);
          }
        }, POST_CLOSE_REFRESH_DELAY_MS);
      } catch (caughtError) {
        if (!mountedRef.current) {
          return;
        }

        setError(
          caughtError instanceof Error
            ? caughtError.message
            : `Unable to close ${symbol}`,
        );

        /*
         * Re-read the account because the exchange may have filled the order
         * even if the response was interrupted.
         */
        void refresh(true);
      } finally {
        if (mountedRef.current) {
          setClosingSymbol(null);
        }
      }
    },
    [closingSymbol, refresh, onPositionClosed],
  );

  return {
    positions,
    isLoading,
    closingSymbol,
    error,
    refresh,
    closeMarket,
  };
}
