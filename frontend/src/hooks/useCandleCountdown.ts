import { useEffect, useState, type MutableRefObject } from "react";
import type { UTCTimestamp } from "lightweight-charts";
import {
  alignTimeToInterval,
  intervals,
  intervalSeconds,
  type Interval,
} from "../config/constants";

/**
 * Formats a remaining-seconds count as a compact clock string:
 * - under an hour:      "4:37"
 * - an hour or more:    "1:04:37"
 * - a day or more (1d/1w intervals): "3d 06:04:37"
 *
 * Always clamped to >= 0 - once fresh data arrives (kline stream update or
 * the REST poll fallback in useMarketData.ts, whichever gets there first),
 * lastDataTimeRef jumps to the new candle's own open time and this simply
 * starts counting down again from the new interval length. So a countdown
 * that briefly reads "0:00" right at the boundary self-corrects the
 * moment fresh data lands, the same self-healing shape as everything else
 * reading off that ref.
 */
function formatRemaining(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));

  const days = Math.floor(clamped / 86_400);
  const hours = Math.floor((clamped % 86_400) / 3_600);
  const minutes = Math.floor((clamped % 3_600) / 60);
  const seconds = clamped % 60;

  const pad = (value: number) => String(value).padStart(2, "0");

  if (days > 0) {
    return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }

  return `${minutes}:${pad(seconds)}`;
}

/**
 * The timestamp (seconds) a candle that opened at `openTimeSeconds`
 * closes at, for a given interval.
 *
 * For every interval except "1M" this is just `openTimeSeconds +
 * intervalSeconds[interval]` - a fixed duration. A calendar month isn't
 * fixed (28-31 days depending on which month, plus leap years), so using
 * the 30-day approximation from intervalSeconds here would make the
 * countdown you're actually looking at on a 1M chart drift up to a full
 * day off in either direction depending on the month. `Date.UTC` handles
 * the month-12-into-next-year overflow (and leap years) correctly on its
 * own, so this needs no special-casing for December.
 */
function getCloseTimeSeconds(
  openTimeSeconds: number,
  interval: Interval,
): number {
  if (interval === "1M") {
    const date = new Date(openTimeSeconds * 1000);
    return (
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0) /
      1000
    );
  }

  return openTimeSeconds + intervalSeconds[interval];
}

export type CandleCountdown = {
  /**
   * "Time until the current candle closes" for the active chart
   * timeframe, e.g. "4:37" for a 5m chart - null whenever there's no
   * candle loaded yet, so the caller can hide the badge entirely instead
   * of showing a meaningless "0:00".
   */
  label: string | null;
  /**
   * Same countdown for every available timeframe, active one included -
   * powers the dropdown that lists all of them at once. Every entry
   * except the active interval is derived purely from wall-clock math
   * via alignTimeToInterval (today's/this hour's/etc. candle boundary),
   * since this app only loads real candle data for whichever one
   * timeframe is on the chart right now - there's no live data to read
   * for the other seven. Using the same alignTimeToInterval this
   * codebase's chart gridlines/snapping already use (rather than
   * reimplementing the math here) keeps every "1w" boundary - Binance's
   * real Monday 00:00 UTC weekly open, not a naive epoch-floor - and
   * every "1M" boundary - the real 1st-of-the-month open, not a 30-day
   * approximation (see getCloseTimeSeconds above) - in sync with the
   * rest of the app instead of just with itself. The active interval's
   * own entry always reuses `label` verbatim instead of recomputing it,
   * so the badge and its own row in the dropdown can never visually
   * disagree.
   */
  allLabels: Record<Interval, string>;
};

/**
 * Ticking countdown-to-close data for CandleCountdownBadge: the active
 * timeframe's own label (reading lastDataTimeRef, already tracked by
 * useMarketData.ts as the open time of whichever candle it most recently
 * received - live update or initial load, doesn't matter) plus a
 * countdown for every other timeframe, for the badge's dropdown.
 */
export function useCandleCountdown(
  lastDataTimeRef: MutableRefObject<UTCTimestamp | null>,
  interval: Interval,
): CandleCountdown {
  const [state, setState] = useState<CandleCountdown>({
    label: null,
    allLabels: {} as Record<Interval, string>,
  });

  useEffect(() => {
    const tick = () => {
      const nowSeconds = Date.now() / 1000;
      const openTime = lastDataTimeRef.current;

      const label =
        openTime === null
          ? null
          : formatRemaining(
              getCloseTimeSeconds(Number(openTime), interval) - nowSeconds,
            );

      const allLabels = {} as Record<Interval, string>;

      for (const candidate of intervals) {
        if (candidate === interval && label !== null) {
          allLabels[candidate] = label;
          continue;
        }

        const alignedOpen = Number(
          alignTimeToInterval(nowSeconds as UTCTimestamp, candidate),
        );
        allLabels[candidate] = formatRemaining(
          getCloseTimeSeconds(alignedOpen, candidate) - nowSeconds,
        );
      }

      setState({ label, allLabels });
    };

    tick();
    const intervalId = window.setInterval(tick, 1_000);

    return () => window.clearInterval(intervalId);
  }, [lastDataTimeRef, interval]);

  return state;
}
