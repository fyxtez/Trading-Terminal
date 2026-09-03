import { useCallback, useEffect, useRef, useState } from "react";
import { getPositions, type OpenPosition } from "../trading/api/positions";

/*
 * same resilience gap already closed in usePositions.ts/
 * useOpenOrders.ts (see their own comments for the full story) - this
 * hook used to refresh ONLY in reaction to the "account-state-changed"
 * event. When that event is missed (the backend's own connection to
 * Binance's user-data stream has already been observed to drop data on
 * this setup), positionPnl/totalPnl just sat frozen at whatever they
 * were before the miss - e.g. showing a stale non-zero PNL/TOTAL after
 * every position had actually closed, since clearPositionPnl() below
 * only clears positionPnl immediately and otherwise relies entirely on
 * that same event firing to recompute totalPnl. A symbol change forced
 * a fresh fetch (refresh depends on `symbol`, so switching symbols
 * re-runs the mount effect below) which is why switching charts always
 * "fixed" it. A quiet periodic poll closes that gap independent of any
 * push notification, the same way it already does for Positions/Open
 * Orders.
 */
const CHART_PNL_SELF_HEAL_POLL_MS = 4_000;

export type ChartPositionPnl = {
  symbol: string;
  side: "LONG" | "SHORT";
  unrealizedPnl: number;
  realizedPnl: number | null;
};

export function useChartPositionPnl(symbol: string): {
  positionPnl: ChartPositionPnl | null;
  /**
   * Sum of unrealized_pnl across every open position (not just the active
   * chart's symbol) - i.e. "how much am I up/down right now" across the
   * whole account. This is unrealized-only for now (see the type's own
   * name): closed/realized PNL isn't tracked anywhere yet, so a position
   * closed at a loss and one still open at a gain won't net out here.
   * null when fewer than two distinct symbols are open, because with one
   * symbol the TOTAL card would only duplicate that symbol's PNL card.
   */
  totalPnl: number | null;
  /**
   * Immediately hides the PNL card and invalidates any in-flight refresh,
   * so a stale response can't repaint it right after. Call this the
   * instant a close is confirmed (e.g. from Close Everything) instead of
   * waiting for the next account-state event to notice the position is gone.
   */
  clearPositionPnl: () => void;
} {
  const [positionPnl, setPositionPnl] = useState<ChartPositionPnl | null>(null);
  const [totalPnl, setTotalPnl] = useState<number | null>(null);
  const mountedRef = useRef(false);
  const requestIdRef = useRef(0);

  const refresh = useCallback(
    async (force = false) => {
      const requestId = ++requestIdRef.current;

      try {
        const positions = await getPositions(undefined, force);

        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return;
        }

        /*
         * UX UPDATE: when the account has only one open symbol, TOTAL is
         * identical to that symbol's PNL and merely duplicates the card directly
         * above it. Count distinct symbols (rather than raw position rows, so
         * hedge-mode legs on one market still count as one symbol) and expose the
         * aggregate only when it actually combines two or more markets.
         */
        const openSymbolCount = new Set(positions.map((item) => item.symbol.toUpperCase())).size;

        setTotalPnl(
          openSymbolCount > 1
            ? positions.reduce((sum, item) => sum + item.unrealized_pnl, 0)
            : null,
        );

        const normalizedSymbol = symbol.toUpperCase();
        const position: OpenPosition | undefined = positions.find(
          (item) => item.symbol.toUpperCase() === normalizedSymbol,
        );

        if (!position) {
          setPositionPnl(null);
          return;
        }

        setPositionPnl({
          symbol: position.symbol,
          side: position.side,
          unrealizedPnl: position.unrealized_pnl,
          // keep lifecycle realized PNL separate from the live mark-price
          // value so chart badges never present their sum as one ambiguous PNL.
          realizedPnl: position.realized_pnl,
        });
      } catch {
        // Keep the last confirmed value during a temporary request failure.
      }
    },
    [symbol],
  );

  const clearPositionPnl = useCallback(() => {
    // Bump the request id first so any refresh() already in flight (e.g.
    // one that started just before the close was confirmed) gets dropped
    // instead of repainting the card with stale data once it resolves.
    requestIdRef.current += 1;
    setPositionPnl(null);
    // Not touched here: totalPnl still reflects whatever other positions
    // are open. The account-state-changed handler below fires a fresh
    // refresh() moments later (same one that re-fetches positionPnl),
    // which recomputes it from the real, current position list.
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh(true);

    let refreshTimer: number | null = null;
    const handleTradingStateChanged = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refresh(true);
      }, 100);
    };

    window.addEventListener("account-state-changed", handleTradingStateChanged);

    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      window.removeEventListener("account-state-changed", handleTradingStateChanged);
    };
  }, [refresh]);

  // Self-heal poll - see the big comment above. Independent of the
  // event-driven refresh; guarantees the PNL/TOTAL cards can never drift
  // out of sync (e.g. showing a stale amount after positions have
  // actually closed) for more than one poll interval, regardless of
  // whether the account-state-changed event was missed.
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refresh();
    }, CHART_PNL_SELF_HEAL_POLL_MS);

    return () => window.clearInterval(intervalId);
  }, [refresh]);

  return { positionPnl, totalPnl, clearPositionPnl };
}
