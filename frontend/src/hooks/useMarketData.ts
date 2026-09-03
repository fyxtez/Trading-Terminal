import { useEffect, useRef, useState } from "react";
import {
  LineStyle,
  type CandlestickData,
  type Logical,
  type LogicalRange,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  getChartDisplayDecimals,
  getSymbolConfig,
  getFutureBarsForInterval,
  intervalSeconds,
  type Interval,
} from "../config/constants";
import {
  fetchKlines,
  fetchLatestKline,
  fetchOlderKlines,
  mergeLatestCandle,
} from "../trading/api/marketData";
import { getSymbolFilters } from "../trading/api/exchangeInfo";
import type { ChartRefs } from "./useChartRefs";
import type { ConnectionState } from "./useTradingStream";
import { formatSymbolPair } from "../config/symbols";
import {
  loadSavedInterval,
  loadSavedViewport,
  savedViewportShowsCandles,
  saveInterval,
  saveViewportToStorage,
} from "./marketDataPersistence";

/*
 * *
 * This used to maintain a live WebSocket to fstream.binance.com for
 * kline + aggTrade updates, with a REST fallback watchdog for when that
 * socket went quiet. In practice, for at least this user, something at
 * the OS/network level (confirmed: still broken in Incognito, so not a
 * browser extension) lets the WS handshake complete but silently drops
 * every actual data frame afterward - the socket looks "connected" but
 * never receives a single message, forever, on any network/profile
 * tried. That's not something fixable from inside this app.
 *
 * Given the REST fallback was already working reliably, this now
 * polls Binance's plain REST kline endpoint directly - same data, same
 * chart behavior, just no socket to silently fight with. Binance's
 * futures REST rate limits are generous enough (weight budget in the
 * thousands per minute) that polling a single lightweight `limit=1`
 * kline request every couple of seconds is nowhere close to a concern.
 */
const LIVE_POLL_INTERVAL_MS = 1_000;

/**
 * Scroll-triggered history backfill (see backfillOlderCandles below):
 * the initial load only ever fetches 5000 candles (see fetchKlines call
 * in load()), so without this, scrolling far enough left just runs off
 * the end of that array into blank chart space - which is exactly what
 * was happening before this existed. Fetch another chunk once the
 * visible left edge gets within BACKFILL_TRIGGER_BARS of the oldest
 * loaded candle, well before the user could actually scroll into empty
 * space at normal scroll speed.
 */
const BACKFILL_TRIGGER_BARS = 300;
/** Binance's own per-request cap - see fetchOlderKlines' own comment on why this isn't parallelized like the initial load. */
const BACKFILL_CHUNK_SIZE = 1500;

/**
 * Everything related to getting candles onto the chart: one initial
 * REST history load for the active symbol+interval, followed by a
 * lightweight REST poll loop for live updates (see the big comment
 * above for why this isn't a WebSocket).
 *
 * `symbol` (e.g. "BTCUSDT", "SOLUSDT") drives the SAME reload path that
 * switching intervals already used - it's just another entry in the
 * main effect's dependency array, so switching symbols closes the old
 * poll loop, clears all chart data/refs, and reloads everything fresh
 * for the new symbol, exactly like switching from 1m to 1h already did.
 */
export function useMarketData(refs: ChartRefs, symbol: string, registryReady = true) {
  const [interval, setIntervalState] = useState<Interval>(() => loadSavedInterval(symbol));
  const intervalSymbolRef = useRef(symbol);
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const [isChartLoading, setIsChartLoading] = useState(true);
  const [marketDataError, setMarketDataError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // The active symbol's real tick size / decimal precision, from
  // Binance's exchangeInfo. Exposed so anything drawing a price label
  // (the AUTO MARKET overlay, the double-click trade price line) can
  // format it correctly instead of assuming BTC's whole-number
  // precision, which is wrong for lower-priced symbols like XRP.
  const [pricePrecision, setPricePrecision] = useState(0);
  const [tickSize, setTickSize] = useState(1);
  // The poll loop's tick function is created once per symbol/interval
  // effect run and never re-created just because pricePrecision
  // changes - so reading the `pricePrecision` STATE variable directly
  // from inside it would use whatever value was current at effect-setup
  // time forever, even after the real per-symbol precision resolves
  // moments later. This ref is updated wherever setPricePrecision is,
  // and read from inside the poll loop instead, the same pattern
  // liveMarketPriceRef/etc. already use elsewhere in this codebase for
  // exactly this reason.
  const pricePrecisionRef = useRef(0);

  // Health of the live-price REST poll loop, exposed so the Topbar can
  // show a MARKET pill the same way it already shows BACKEND (REST
  // health) and STREAM (trading websocket health). "connected" once the
  // first poll succeeds, "disconnected" if a poll fails (the next tick
  // will retry automatically), "connecting" only during the very first
  // poll after a fresh load.
  const [marketConnection, setMarketConnection] = useState<ConnectionState>("connecting");

  useEffect(() => {
    refs.intervalRef.current = interval;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval]);

  // Timeframe is a per-symbol preference. Restore the target symbol's
  // last-used interval before its candle load is allowed to start.
  useEffect(() => {
    if (intervalSymbolRef.current === symbol) return;

    intervalSymbolRef.current = symbol;
    const savedInterval = loadSavedInterval(symbol);

    // never expose the previous market's quote under the newly-selected
    // symbol. Besides showing stale UI, that old value used to look like a real
    // price jump to frontend-owned price alerts during the switch. The new
    // symbol stays price-less until its own first market-data update arrives.
    setLastPrice(null);
    refs.liveMarketPriceRef.current = null;

    refs.pendingVisibleRangeRef.current = null;
    refs.intervalRef.current = savedInterval;
    setIntervalState(savedInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  useEffect(() => {
    const retryInitialLoad = () => {
      if (!refs.chartReadyRef.current) {
        setReloadKey((current) => current + 1);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        retryInitialLoad();
      }
    };

    window.addEventListener("online", retryInitialLoad);
    window.addEventListener("focus", retryInitialLoad);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("online", retryInitialLoad);
      window.removeEventListener("focus", retryInitialLoad);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    // refs contains stable refs created by useChartRefs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trackLatestCandle = (candle: CandlestickData) => {
    const previousTime = refs.lastDataTimeRef.current;

    if (previousTime !== null && Number(candle.time) > Number(previousTime)) {
      const difference = Number(candle.time) - Number(previousTime);

      const addedBars = Math.max(
        1,
        Math.round(difference / intervalSeconds[refs.intervalRef.current]),
      );

      refs.lastLogicalIndexRef.current += addedBars;
    }

    if (previousTime === null || Number(candle.time) >= Number(previousTime)) {
      refs.lastDataTimeRef.current = candle.time as UTCTimestamp;
    }

    refs.lastCandleRef.current = candle;
  };

  // Tracks the anchor bar time the future series was last built for, so
  // the array isn't rebuilt on every single price tick.
  const futureScaleAnchorRef = useRef<UTCTimestamp | null>(null);

  const updateFutureTimeScale = (
    lastTime: UTCTimestamp,
    lastPriceValue: number,
    selectedInterval: Interval,
  ) => {
    const futureSeries = refs.futureScaleRef.current;

    if (!futureSeries) return;

    if (futureScaleAnchorRef.current === lastTime) return;
    futureScaleAnchorRef.current = lastTime;

    const step = intervalSeconds[selectedInterval];
    const futureBars = getFutureBarsForInterval(selectedInterval);

    const futureData = Array.from({ length: futureBars + 1 }, (_, index) => ({
      time: (Number(lastTime) + index * step) as UTCTimestamp,
      value: lastPriceValue,
    }));

    futureSeries.setData(futureData);
  };

  const updateLivePriceLine = (price: number) => {
    // attach the live price line to the always-present future anchor
    // series. A candle-owned price line disappears when all candles leave the
    // viewport, while this series shares the same right scale and stays visible.
    const series = refs.futureScaleRef.current ?? refs.candleRef.current;

    if (!series) return;

    if (refs.livePriceLineRef.current) {
      refs.livePriceLineRef.current.applyOptions({ price });
      return;
    }

    refs.livePriceLineRef.current = series.createPriceLine({
      price,
      color: "#34d399",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: "",
    });
  };

  const updatePriceUi = (price: number, tickerSymbol: string) => {
    setLastPrice(price);

    refs.liveMarketPriceRef.current = price;

    document.title = `${formatSymbolPair(tickerSymbol)} ${price.toFixed(pricePrecisionRef.current)}`;

    updateLivePriceLine(price);
  };

  useEffect(() => {
    // an optimistically restored dynamic symbol has a temporary Binance
    // placeholder until /api/symbols resolves. Starting its chart beforehand
    // sends an invalid Binance kline request for MEXC symbols after refresh;
    // wait for the authoritative venue, then let registryReady restart this
    // same effect with the correct MEXC source configuration.
    if (!registryReady) {
      setIsChartLoading(true);
      setMarketConnection("connecting");
      return;
    }

    // A symbol switch can render once with the previous symbol's interval
    // before the state update above commits. Do not fetch that stale pair.
    if (interval !== refs.intervalRef.current) return;

    refs.epochRef.current += 1;
    const myEpoch = refs.epochRef.current;

    refs.chartReadyRef.current = false;
    setIsChartLoading(true);
    setMarketConnection("connecting");
    setMarketDataError(null);

    refs.candleRef.current?.setData([]);
    refs.futureScaleRef.current?.setData([]);
    let livePollTimer: number | null = null;
    /*
     * the fixed
     * LIVE_POLL_INTERVAL_MS timer below only happens to notice a new
     * candle whenever it next fires, which - since it isn't aligned to
     * wall-clock candle boundaries at all - can be up to a full poll
     * cycle plus request latency after the actual close. That's exactly
     * what CandleCountdownBadge was surfacing: it faithfully reflects
     * lastDataTimeRef, so any lag in *that* updating shows up as the
     * countdown sitting at 0:00 and only restarting once fresh data
     * finally lands. Scheduling one extra one-off poll timed for
     * shortly after the candle we just applied is expected to close
     * closes that gap down to roughly just network latency, instead of
     * however long was left on the generic timer. The steady interval
     * poll below is untouched and still exists as the general
     * self-heal/staleness safety net if this one-off ever misses.
     */
    let boundaryPokeTimer: number | null = null;

    let cancelled = false;

    refs.lastDataTimeRef.current = null;
    refs.lastLogicalIndexRef.current = 0;
    refs.lastCandleRef.current = null;
    futureScaleAnchorRef.current = null;
    pricePrecisionRef.current = 0;
    refs.historyBackfillRef.current = { isLoading: false, hasMore: true };

    // Applies a freshly-fetched candle to the chart, the series, the
    // future-time-scale overlay, and the live-price UI.
    const applyCandleUpdate = (candle: CandlestickData) => {
      /*
       * applyCandleUpdate
       * is called both by the regular LIVE_POLL_INTERVAL_MS tick and by
       * the boundary-poke timer (see its own comment above) - which fires
       * an EXTRA poll deliberately timed for right around when a candle
       * closes, i.e. right around when the regular interval poll is also
       * likely to be due. Both do their own independent
       * fetchLatestKline() request; if the regular poll's request happens
       * to resolve first (landing the new post-boundary candle) and the
       * boundary poke's slightly-earlier-started request resolves after
       * it with the OLDER pre-boundary candle, this got called with data
       * older than what the series already has - which
       * lightweight-charts throws on synchronously rather than ignoring.
       * Comparing against lastDataTimeRef (kept in sync by every caller)
       * means a genuinely stale response is simply discarded here,
       * regardless of which of the two timers produced it.
       */
      const currentLast = refs.lastDataTimeRef.current;

      if (currentLast !== null && Number(candle.time) < Number(currentLast)) {
        return;
      }

      trackLatestCandle(candle);
      refs.loadedCandlesRef.current = mergeLatestCandle(refs.loadedCandlesRef.current, candle);
      refs.candleRef.current?.update(candle);
      updateFutureTimeScale(candle.time as UTCTimestamp, candle.close, interval);
      updatePriceUi(candle.close, symbol);

      if (boundaryPokeTimer !== null) {
        window.clearTimeout(boundaryPokeTimer);
        boundaryPokeTimer = null;
      }

      const closeTimeMs = (Number(candle.time) + intervalSeconds[interval]) * 1000;
      // A small buffer after the boundary, not right on it - Binance
      // needs a moment to actually start publishing the new candle's
      // row, so firing at t=0 exactly would usually just re-fetch the
      // same candle that's about to close.
      const delayMs = closeTimeMs - Date.now() + 400;

      // Only worth scheduling if the boundary is still ahead of us and
      // not absurdly far off (an unreasonably long delay likely means a
      // clock/interval mismatch - let the regular poll handle it instead
      // of parking a multi-hour timer).
      if (delayMs > 0 && delayMs < 10 * 60_000) {
        boundaryPokeTimer = window.setTimeout(() => {
          boundaryPokeTimer = null;
          void pollLive();
        }, delayMs);
      }
    };

    /*
     * Fetches one more chunk of older candles and prepends it to whatever's
     * already loaded, keeping the chart's current view pinned to the exact
     * same bars instead of jumping - triggered from the
     * subscribeVisibleLogicalRangeChange handler below whenever the
     * visible range's left edge gets close to the start of the currently
     * loaded data.
     */
    const backfillOlderCandles = async () => {
      const backfillState = refs.historyBackfillRef.current;

      if (backfillState.isLoading || !backfillState.hasMore) return;

      const existing = refs.loadedCandlesRef.current;
      const earliest = existing[0];

      if (!earliest) return;

      backfillState.isLoading = true;

      try {
        const older = await fetchOlderKlines(
          interval,
          symbol,
          Number(earliest.time) * 1000,
          BACKFILL_CHUNK_SIZE,
        );

        if (cancelled || myEpoch !== refs.epochRef.current) return;

        if (older.length === 0) {
          backfillState.hasMore = false;
          return;
        }

        // Defensive de-dupe in case Binance's endTime boundary ever
        // returns a candle that's already loaded (see fetchKlines' own
        // dedupe-by-open-time for the same reasoning on the initial load).
        const existingTimes = new Set(
          refs.loadedCandlesRef.current.map((candle) => Number(candle.time)),
        );
        const newOlder = older.filter((candle) => !existingTimes.has(Number(candle.time)));

        if (newOlder.length === 0) {
          backfillState.hasMore = false;
          return;
        }

        const merged = [...newOlder, ...refs.loadedCandlesRef.current];
        refs.loadedCandlesRef.current = merged;

        const chartNow = refs.chartRef.current;
        const timeScale = chartNow?.timeScale();
        const visibleRangeBeforeUpdate = timeScale?.getVisibleLogicalRange();

        refs.candleRef.current?.setData(merged);

        /*
         * Prepending `newOlder.length` bars in front of everything that
         * existed shifts every one of THOSE bars' logical index forward
         * by that same amount - including the anchor bar
         * useCoordinateMapping's timeToLogical/logicalToTime rely on
         * (refs.lastLogicalIndexRef, previously "the last candle's index
         * before this backfill"). Without this adjustment, every drawing
         * placed via the native-lookup-failed fallback path would
         * silently drift by newOlder.length bars' worth of time after
         * every backfill.
         */
        refs.lastLogicalIndexRef.current += newOlder.length;

        // Re-apply the exact same visible window (shifted by the same
        // amount) rather than trusting setData to preserve it - keeps the
        // backfill invisible to the user instead of jumping the view.
        if (timeScale && visibleRangeBeforeUpdate) {
          timeScale.setVisibleLogicalRange({
            from: (visibleRangeBeforeUpdate.from + newOlder.length) as Logical,
            to: (visibleRangeBeforeUpdate.to + newOlder.length) as Logical,
          });
        }

        if (older.length < BACKFILL_CHUNK_SIZE) {
          // Binance handed back fewer candles than asked for - this
          // symbol/interval's history has been exhausted; don't bother
          // asking again.
          backfillState.hasMore = false;
        }
      } catch (error) {
        // Not fatal - the chart keeps whatever it already has, and the
        // next scroll-triggered attempt (still isLoading: false, still
        // hasMore: true) will simply retry.
        console.warn("[history-backfill] failed", error);
      } finally {
        if (!cancelled && myEpoch === refs.epochRef.current) {
          backfillState.isLoading = false;
        }
      }
    };

    // Declared as `let` (not `const`) so applyCandleUpdate above can
    // reference it before its own definition further down - both live in
    // the same closure for the lifetime of this effect run.
    let pollLive: () => Promise<void> = async () => {};

    /**
     * Polls (via rAF, capped at ~30 frames / half a second) until the
     * chart's own container element has a real, non-zero size before
     * running `callback`. See the "mobile first-load price axis stuck
     * at 1" fix below for why this matters - locking the price axis'
     * autoScale off while the container is still mid-layout freezes it
     * onto a degenerate default range that a later resize never
     * revisits.
     */
    function waitForStableContainer(callback: () => void, attempt = 0) {
      const el = refs.containerRef.current;
      const hasSize = !!el && el.clientWidth > 0 && el.clientHeight > 0;

      if (hasSize || attempt >= 30) {
        callback();
        return;
      }

      requestAnimationFrame(() => waitForStableContainer(callback, attempt + 1));
    }

    async function load() {
      try {
        const candles = await fetchKlines(interval, 5000, symbol);

        if (cancelled || myEpoch !== refs.epochRef.current) return;

        const latest = candles[candles.length - 1] ?? null;

        const baseCandles = latest
          ? candles.filter((candle) => Number(candle.time) !== Number(latest.time))
          : candles;

        refs.loadedCandlesRef.current = candles;

        refs.candleRef.current?.setData(baseCandles);

        if (latest) {
          refs.candleRef.current?.update(latest);
        }

        refs.chartReadyRef.current = true;
        setIsChartLoading(false);
        setMarketDataError(null);

        if (latest) {
          refs.lastCandleRef.current = latest;
          refs.lastDataTimeRef.current = latest.time as UTCTimestamp;
          refs.lastLogicalIndexRef.current = candles.length - 1;
          refs.liveMarketPriceRef.current = latest.close;

          updateFutureTimeScale(latest.time as UTCTimestamp, latest.close, interval);
        }

        // Apply this symbol's real tick-size precision (pricePrecision/
        // tickSize below) for anything that needs to match Binance's
        // actual order precision - SL/TP labels, the trade price line,
        // etc. The chart's OWN price axis/crosshair/candle price-line
        // display is deliberately kept separate: it uses the per-symbol
        // cosmetic decimal count from config/constants.ts
        // (CHART_DISPLAY_DECIMALS) instead, so e.g. BTC can show whole
        // numbers on the axis while still trading at its real sub-dollar
        // tick size under the hood.
        const displayDecimals = getChartDisplayDecimals(symbol);

        refs.candleRef.current?.applyOptions({
          priceFormat: {
            type: "price",
            precision: displayDecimals,
            minMove: Math.pow(10, -displayDecimals),
          },
        });

        const symbolConfig = getSymbolConfig(symbol);

        if (symbolConfig.executionEnabled) {
          void getSymbolFilters(symbol)
            .then((filters) => {
              if (cancelled || myEpoch !== refs.epochRef.current) return;

              setPricePrecision(filters.pricePrecision);
              pricePrecisionRef.current = filters.pricePrecision;
              setTickSize(filters.tickSize);
              const chartPrecision = Math.max(displayDecimals, filters.pricePrecision);

              refs.candleRef.current?.applyOptions({
                priceFormat: {
                  type: "price",
                  precision: chartPrecision,
                  minMove: Math.pow(10, -chartPrecision),
                },
              });
            })
            .catch(() => {
              // Keep the cosmetic chart precision if Binance filters are
              // temporarily unavailable; chart loading must remain independent.
            });
        } else {
          const viewOnlyTickSize = Math.pow(10, -displayDecimals);
          setPricePrecision(displayDecimals);
          pricePrecisionRef.current = displayDecimals;
          setTickSize(viewOnlyTickSize);
        }

        const timeScale = refs.chartRef.current?.timeScale();

        if (timeScale) {
          const lastIndex = candles.length - 1;
          const savedViewport = loadSavedViewport(symbol, interval);

          if (savedViewport && savedViewportShowsCandles(savedViewport, candles)) {
            // Store X relative to the newest candle rather than as absolute logical
            // indexes. A symbol may receive new candles while it is hidden; using
            // offsets preserves both the user's horizontal zoom AND where the
            // viewport sat relative to the live edge when they return.
            timeScale.setVisibleLogicalRange({
              from: (lastIndex + savedViewport.xFromOffset) as Logical,
              to: (lastIndex + savedViewport.xToOffset) as Logical,
            });

            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                if (myEpoch !== refs.epochRef.current) return;

                const priceScale = refs.candleRef.current?.priceScale();
                if (!priceScale) return;

                const savedSpan = savedViewport.yTo - savedViewport.yFrom;
                const savedFrom = Math.max(0, savedViewport.yFrom);
                const savedTo = savedViewport.yFrom < 0 ? savedFrom + savedSpan : savedViewport.yTo;

                priceScale.applyOptions({ autoScale: false });
                priceScale.setVisibleRange({
                  from: savedFrom,
                  to: savedTo,
                });
              });
            });
          } else {
            const visibleBars = 220;
            const futureBars = interval === "1m" ? 25 : 20;

            timeScale.setVisibleLogicalRange({
              from: Math.max(0, lastIndex - visibleBars) as Logical,
              to: (lastIndex + futureBars) as Logical,
            });

            refs.candleRef.current?.priceScale().applyOptions({
              autoScale: true,
            });

            /*
             * this used
             * to freeze autoScale off after a flat two-frame delay. On a
             * slower/mobile first paint the chart's container can still
             * be mid-layout (0x0 or not yet its final height) at that
             * point - freezing autoScale then locks the price axis onto
             * whatever degenerate default range lightweight-charts falls
             * back to for a sizeless pane. A later resize fixes the
             * pixel dimensions but never revisits the price range, since
             * autoScale is already off by then - so the axis is left
             * showing that placeholder instead of real prices.
             *
             * waitForStableContainer defers the freeze until the
             * container actually has real dimensions, and the fallback
             * below recenters directly on the latest close if the fitted
             * range still doesn't make sense afterwards - belt and
             * braces against any remaining timing edge case rather than
             * relying purely on the container size becoming valid in
             * time.
             */
            waitForStableContainer(() => {
              requestAnimationFrame(() => {
                if (myEpoch !== refs.epochRef.current) return;

                const priceScale = refs.candleRef.current?.priceScale();
                if (!priceScale) return;

                priceScale.applyOptions({ autoScale: false });

                const fitted = priceScale.getVisibleRange();
                const referencePrice = latest?.close ?? refs.liveMarketPriceRef.current;

                const isDegenerate =
                  !fitted ||
                  !(fitted.to > fitted.from) ||
                  (referencePrice != null &&
                    referencePrice > 0 &&
                    (referencePrice < fitted.from * 0.5 || referencePrice > fitted.to * 1.5));

                if (isDegenerate && referencePrice != null && referencePrice > 0) {
                  const padding = referencePrice * 0.05;
                  priceScale.setVisibleRange({
                    from: Math.max(0, referencePrice - padding),
                    to: referencePrice + padding,
                  });
                }
              });
            });
          }

          refs.pendingVisibleRangeRef.current = null;
        }

        if (latest) {
          window.requestAnimationFrame(() => {
            if (!cancelled && myEpoch === refs.epochRef.current) {
              /*
               * this
               * re-applies the same `latest` bar from earlier in load() on
               * the next animation frame (a lightweight-charts render
               * quirk workaround), but by the time this frame actually
               * fires, the live poll loop below (pollLive/
               * applyCandleUpdate) may have already landed a NEWER candle
               * on this same series via its own update() call - especially
               * likely now that both fetchKlines (parallelized) and the
               * live poll (halved to 1s) run faster than before, shrinking
               * the gap between "load() fetched its data" and "the live
               * poll's own first tick resolves". lightweight-charts throws
               * synchronously if you call update() with an older time than
               * whatever it already has as its last bar. Comparing against
               * lastDataTimeRef - which both this code path and the live
               * poll keep in sync - means this only re-applies `latest` if
               * nothing more recent has already superseded it, instead of
               * blindly trusting a value that may be stale by now.
               */
              const currentLast = refs.lastDataTimeRef.current;

              if (currentLast === null || Number(latest.time) >= Number(currentLast)) {
                refs.candleRef.current?.update(latest);
              }
            }
          });
        }

        // --- Live REST poll loop --------------------------------------
        //
        // Replaces the old WebSocket. Every LIVE_POLL_INTERVAL_MS, fetch
        // just the latest candle (a cheap `limit=1` kline request) and
        // apply it the same way a WS message used to. Simpler, no
        // socket lifecycle to manage, and immune to whatever was
        // silently eating WS data frames for this user.
        //
        // Assigned here (not `const`) because applyCandleUpdate, defined
        // above load() in the outer effect scope, also calls this same
        // function - via the outer `let pollLive` declared alongside it -
        // to fire one extra poll timed right at each candle's expected
        // close instead of waiting on this fixed interval alone.
        pollLive = async () => {
          if (cancelled || myEpoch !== refs.epochRef.current) return;

          try {
            const candle = await fetchLatestKline(interval, symbol);

            if (cancelled || myEpoch !== refs.epochRef.current || !candle) {
              return;
            }

            applyCandleUpdate(candle);
            setMarketConnection("connected");
            setMarketDataError(null);
          } catch (error) {
            if (cancelled || myEpoch !== refs.epochRef.current) return;

            console.warn("[market-poll] failed", error);
            setMarketConnection("disconnected");
            setMarketDataError(
              error instanceof Error
                ? `Live market data unavailable: ${error.message}`
                : "Live market data unavailable",
            );
          }
        };

        void pollLive();
        livePollTimer = window.setInterval(() => void pollLive(), LIVE_POLL_INTERVAL_MS);
      } catch (error) {
        refs.chartReadyRef.current = false;
        setIsChartLoading(false);
        setMarketConnection("disconnected");
        setMarketDataError(
          error instanceof Error
            ? `Could not load market data: ${error.message}`
            : "Could not load market data",
        );
        console.error("Failed to load chart", error);
      }
    }

    /*
     * Fires on every frame of a scroll/pan/zoom gesture (not just once),
     * so backfillOlderCandles' own isLoading/hasMore guards are what
     * actually keep this from firing a flood of duplicate requests -
     * this handler itself just checks how close the visible left edge
     * is to the start of the loaded data.
     */
    const handleVisibleLogicalRangeChange = (range: LogicalRange | null) => {
      if (!range) return;
      if (cancelled || myEpoch !== refs.epochRef.current) return;
      if (range.from > BACKFILL_TRIGGER_BARS) return;

      void backfillOlderCandles();
    };

    const timeScaleForBackfill = refs.chartRef.current?.timeScale();
    timeScaleForBackfill?.subscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);

    // Persist the complete chart viewport per symbol+timeframe. X is saved
    // relative to the latest candle (so newly-arrived bars do not shift the
    // remembered view), while Y is saved as the exact visible price range.
    // A small debounce avoids hammering localStorage on every frame of a drag.
    let viewportSaveTimer: number | null = null;

    const saveCurrentViewport = () => {
      // Symbol/interval changes temporarily clear the series before the
      // next history request finishes. Never persist that transitional empty
      // state because it can overwrite a previously valid chart viewport.
      if (!refs.chartReadyRef.current || refs.loadedCandlesRef.current.length === 0) {
        return;
      }

      const timeScale = refs.chartRef.current?.timeScale();
      const priceScale = refs.candleRef.current?.priceScale();
      const xRange = timeScale?.getVisibleLogicalRange();
      const yRange = priceScale?.getVisibleRange();

      if (!xRange || !yRange) return;
      if (!(xRange.to > xRange.from) || !(yRange.to > yRange.from)) return;

      const lastLogicalIndex = refs.lastLogicalIndexRef.current;
      const ySpan = yRange.to - yRange.from;
      const yFrom = Math.max(0, yRange.from);
      const yTo = yRange.from < 0 ? yFrom + ySpan : yRange.to;

      saveViewportToStorage(symbol, interval, {
        xFromOffset: xRange.from - lastLogicalIndex,
        xToOffset: xRange.to - lastLogicalIndex,
        yFrom,
        yTo,
      });
    };

    const scheduleViewportSave = () => {
      if (viewportSaveTimer !== null) {
        window.clearTimeout(viewportSaveTimer);
      }

      viewportSaveTimer = window.setTimeout(() => {
        viewportSaveTimer = null;
        saveCurrentViewport();
      }, 140);
    };

    const timeScaleForViewport = refs.chartRef.current?.timeScale();
    timeScaleForViewport?.subscribeVisibleLogicalRangeChange(scheduleViewportSave);

    const chartContainer = refs.containerRef.current;
    chartContainer?.addEventListener("pointerup", scheduleViewportSave);
    chartContainer?.addEventListener("wheel", scheduleViewportSave, {
      passive: true,
    });

    load();

    return () => {
      // Capture the final position synchronously before this symbol/interval's
      // refs are cleared and the next market load begins.
      saveCurrentViewport();
      cancelled = true;

      timeScaleForBackfill?.unsubscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);
      timeScaleForViewport?.unsubscribeVisibleLogicalRangeChange(scheduleViewportSave);
      chartContainer?.removeEventListener("pointerup", scheduleViewportSave);
      chartContainer?.removeEventListener("wheel", scheduleViewportSave);

      if (viewportSaveTimer !== null) {
        window.clearTimeout(viewportSaveTimer);
      }

      if (livePollTimer !== null) {
        window.clearInterval(livePollTimer);
      }

      if (boundaryPokeTimer !== null) {
        window.clearTimeout(boundaryPokeTimer);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, symbol, reloadKey, registryReady]);

  const changeInterval = (nextInterval: Interval) => {
    if (nextInterval === refs.intervalRef.current) {
      return;
    }

    refs.pendingVisibleRangeRef.current = null;
    saveInterval(symbol, nextInterval);
    setIntervalState(nextInterval);
  };

  const zoomIn = () => {
    const scale = refs.chartRef.current?.timeScale();
    const range = scale?.getVisibleLogicalRange();

    if (!scale || !range) return;

    const center = (range.from + range.to) / 2;
    const size = (range.to - range.from) * 0.7;

    scale.setVisibleLogicalRange({
      from: (center - size / 2) as Logical,
      to: (center + size / 2) as Logical,
    });
  };

  const zoomOut = () => {
    const scale = refs.chartRef.current?.timeScale();
    const range = scale?.getVisibleLogicalRange();

    if (!scale || !range) return;

    const center = (range.from + range.to) / 2;
    const size = (range.to - range.from) * 1.4;

    scale.setVisibleLogicalRange({
      from: (center - size / 2) as Logical,
      to: (center + size / 2) as Logical,
    });
  };

  return {
    interval,
    lastPrice,
    isChartLoading,
    marketDataError,
    pricePrecision,
    /**
     * Same value as `pricePrecision` above, but as a ref instead of
     * state - for consumers whose own closure gets captured once and
     * never refreshed (see useDrawingCanvas.ts's drawCanvas rAF loop,
     * which reads this specifically for that reason). `pricePrecision`
     * itself is still the right thing to use in a normal React render,
     * where a state update correctly triggers a re-render with the
     * fresh value; this ref is *only* useful for code that can't rely
     * on re-rendering to see the update.
     */
    pricePrecisionRef,
    tickSize,
    marketConnection,
    retryMarketData: () => setReloadKey((current) => current + 1),
    changeInterval,
    zoomIn,
    zoomOut,
  };
}

export type MarketDataApi = ReturnType<typeof useMarketData>;
