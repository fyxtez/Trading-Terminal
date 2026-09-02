import type { Logical, UTCTimestamp } from "lightweight-charts";
import { alignTimeToInterval } from "../config/constants";
import { distanceToSegment } from "../utils/geometry";
import {
  coordinateToPriceWithFutureFallback,
  priceToCoordinateWithFutureFallback,
} from "../utils/chartPriceCoordinates";
import type { ChartPoint, Drawing, ScreenPoint } from "../types/drawing";
import type { ChartRefs } from "./useChartRefs";

/**
 * All time <-> pixel <-> price conversion logic for the chart. This is
 * the trickiest part of the whole app (see the long comment on
 * getCoordinateCalibration below) so it is kept as one cohesive unit,
 * exactly as it worked before the refactor - only the imports changed.
 */
export function useCoordinateMapping(refs: ChartRefs) {
  /**
   * Convert a timestamp to the chart's actual logical bar space.
   *
   * IMPORTANT: logical indices are derived from loadedCandlesRef, not from a
   * "last bar + seconds/interval" estimate. Real exchange data can contain
   * gaps and history can be prepended while the app is running. Interpolating
   * between the two neighbouring REAL candles makes the mapping stable under
   * zoom/pan and correct even when timestamps are not perfectly uniform.
   */
  const timeToLogical = (time: UTCTimestamp): Logical | null => {
    const candles = refs.loadedCandlesRef.current;
    if (candles.length === 0) return null;

    const target = Number(time);

    // Binary-search the first candle whose time is >= target.
    let lo = 0;
    let hi = candles.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (Number(candles[mid].time) < target) lo = mid + 1;
      else hi = mid;
    }

    if (lo < candles.length && Number(candles[lo].time) === target) {
      return lo as Logical;
    }

    // Inside the loaded data: interpolate only between the neighbouring
    // candles. This is the key difference from the old global approximation.
    if (lo > 0 && lo < candles.length) {
      const leftIndex = lo - 1;
      const rightIndex = lo;
      const leftTime = Number(candles[leftIndex].time);
      const rightTime = Number(candles[rightIndex].time);
      const span = rightTime - leftTime;
      if (span <= 0) return leftIndex as Logical;

      const fraction = (target - leftTime) / span;
      return (leftIndex + fraction) as Logical;
    }

    // Rare extrapolation outside loaded history. Use only the nearest pair,
    // never the whole dataset, so gaps elsewhere cannot affect the result.
    if (candles.length < 2) return null;

    if (lo === 0) {
      const t0 = Number(candles[0].time);
      const t1 = Number(candles[1].time);
      const span = t1 - t0;
      if (span <= 0) return null;
      return ((target - t0) / span) as Logical;
    }

    const last = candles.length - 1;
    const previous = last - 1;
    const t0 = Number(candles[previous].time);
    const t1 = Number(candles[last].time);
    const span = t1 - t0;
    if (span <= 0) return null;
    return (last + (target - t1) / span) as Logical;
  };

  /**
   * Exact inverse of timeToLogical for continuous drawing placement.
   * A fractional logical coordinate is converted back through the actual
   * neighbouring candle timestamps rather than intervalSeconds.
   */
  const logicalToTime = (logical: Logical | number): UTCTimestamp | null => {
    const candles = refs.loadedCandlesRef.current;
    if (candles.length === 0 || !Number.isFinite(Number(logical))) return null;

    const value = Number(logical);
    const leftIndex = Math.floor(value);
    const fraction = value - leftIndex;

    if (leftIndex >= 0 && leftIndex < candles.length - 1) {
      const leftTime = Number(candles[leftIndex].time);
      const rightTime = Number(candles[leftIndex + 1].time);
      return Math.round(
        leftTime + fraction * (rightTime - leftTime),
      ) as UTCTimestamp;
    }

    if (candles.length < 2) {
      return candles[0].time as UTCTimestamp;
    }

    if (value < 0) {
      const t0 = Number(candles[0].time);
      const t1 = Number(candles[1].time);
      return Math.round(t0 + value * (t1 - t0)) as UTCTimestamp;
    }

    const last = candles.length - 1;
    const t0 = Number(candles[last - 1].time);
    const t1 = Number(candles[last].time);
    return Math.round(t1 + (value - last) * (t1 - t0)) as UTCTimestamp;
  };

  /*
   * IMPORTANT: chart.timeScale().timeToCoordinate(time) / coordinateToTime(x)
   * ONLY work for times that fall EXACTLY on the current interval's grid
   * (confirmed against TradingView's own lightweight-charts issue tracker -
   * e.g. a 1-minute-aligned timestamp reliably returns null on a 5m/15m/1h
   * chart). Since our drawings are almost always created on a DIFFERENT
   * timeframe than the one they're later viewed on, they will essentially
   * never land exactly on the new grid - so native lookup fails for nearly
   * every drawing whenever the timeframe differs from the one it was drawn
   * on. That's fine; it's a real, documented library constraint, not a bug
   * to fight - we just need a fallback that's actually correct.
   *
   * getCoordinateCalibration() builds that fallback by reading the pixel
   * position of TWO REAL candles straight from the currently loaded data
   * (their times are guaranteed to be exact grid points, so native lookup
   * for them always succeeds) and computing pixels-per-second from those
   * two known-good points. Any other time is then placed with simple linear
   * interpolation/extrapolation - no hand-maintained "last bar index"
   * bookkeeping involved, so it can't silently drift or go stale the way
   * our previous logical-index anchor did.
   */
  const getCoordinateCalibration = (): {
    anchorTime: number;
    anchorX: number;
    pixelsPerSecond: number;
  } | null => {
    const chart = refs.chartRef.current;
    const candles = refs.loadedCandlesRef.current;

    if (!chart || candles.length < 2) {
      return null;
    }

    const timeScale = chart.timeScale();

    const first = candles[0];
    const last = candles[candles.length - 1];

    const firstX = timeScale.timeToCoordinate(first.time);
    const lastX = timeScale.timeToCoordinate(last.time);

    if (firstX === null || lastX === null) {
      return null;
    }

    const totalSeconds = Number(last.time) - Number(first.time);

    if (totalSeconds <= 0) {
      return null;
    }

    const pixelsPerSecond = (lastX - firstX) / totalSeconds;

    if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond === 0) {
      return null;
    }

    return {
      anchorTime: Number(last.time),
      anchorX: lastX,
      pixelsPerSecond,
    };
  };

  const timeToX = (time: UTCTimestamp, alignToInterval = true): number | null => {
    const chart = refs.chartRef.current;

    if (!chart) return null;

    /*
     * Keep the original timestamp in storage, but display it on the
     * candle bucket of the active timeframe. This prevents drawings
     * made on a lower timeframe from floating inside the current
     * higher-timeframe candle.
     *
     * `alignToInterval` lets a caller opt OUT of that snapping -
     * needed for pen strokes (see the `false` passed for every pen
     * point above): a pen drawing can have dozens of points sampled a
     * few seconds apart, and floor-ing every one of them onto the SAME
     * higher-timeframe bucket collapses what should be a smooth curve
     * into a jagged handful of distinct x-positions - the "pen
     * drawings go too straight/blocky on higher timeframes" bug. A
     * single vertical/trend/box endpoint benefits from "snap to this
     * candle"; a hundred pen points sharing one candle's worth of
     * granularity does not.
     */
    const displayTime = alignToInterval
      ? alignTimeToInterval(time, refs.intervalRef.current)
      : time;

    /*
     * FIX (pen strokes became stair-stepped on 15m+): alignToInterval=false
     * means the timestamp is an intentional fractional/sub-candle pen sample.
     * Even though timeToCoordinate sometimes returns a non-null value for such
     * a timestamp, Lightweight Charts quantizes that result to a bar column.
     * The larger the timeframe, the wider those repeated columns become.
     * Bypass the native lookup for continuous points and use the fractional
     * logical interpolation below; snapped drawing anchors retain the native
     * fast path exactly as before.
     */
    if (alignToInterval) {
      const nativeX = chart.timeScale().timeToCoordinate(displayTime);

      if (nativeX !== null) {
        return nativeX;
      }
    }

    /*
     * A drawing timestamp does not always land on a real candle grid point.
     * That is especially true for continuously positioned drawings such as
     * Text after moving/resizing. `timeToCoordinate()` correctly returns null
     * for those timestamps.
     *
     * Do NOT approximate their X from pixels-per-second. Lightweight Charts
     * zooms/pans in LOGICAL bar space, not wall-clock seconds; a seconds-based
     * interpolation therefore changes its error as bar spacing changes and a
     * drawing visibly drifts left/right while wheel-zooming.
     *
     * Our last-data logical anchor is kept in sync by useMarketData (including
     * history prepends), so convert the timestamp to the chart's continuous
     * logical index and let Lightweight Charts perform the final logical->X
     * transform. This uses the exact same transform as the candles themselves
     * and is therefore invariant under zoom/pan.
     */
    const logical = timeToLogical(displayTime);

    if (logical === null) return null;

    /*
     * BUG: chart.timeScale().logicalToCoordinate() only accepts WHOLE bar
     * indices - lightweight-charts' internal `jt()` checks `t % 1 === 0`
     * and returns 0 (not null!) for any fractional logical value. Since
     * `logical` here is almost always fractional (that's the whole point -
     * it's a continuous sub-bar position), calling logicalToCoordinate on
     * it directly silently collapsed the result to 0 - the pane's left
     * edge - for every drawing whose anchor didn't land exactly on a
     * loaded candle (most commonly: anything placed in the whitespace
     * past the last candle, or after a drag/resize). That's the "text
     * teleports to the left edge on zoom" bug: at the zoom level where a
     * drawing was first placed, x=0 can coincidentally be off-screen, so
     * nothing looks wrong until zooming brings x=0 into view.
     *
     * Fix: logicalToCoordinate DOES work correctly for the two whole bars
     * surrounding `logical`, so get both of those (real, library-verified
     * coordinates) and linearly interpolate between them using the
     * fractional part - this is the exact geometric inverse of what
     * timeToLogical did to produce the fractional value in the first
     * place, and it stays correct at every zoom level since bar spacing
     * is uniform in pixel space between any two adjacent bars.
     */
    const floorLogical = Math.floor(logical);
    const ceilLogical = Math.ceil(logical);

    if (floorLogical === ceilLogical) {
      const logicalX = chart.timeScale().logicalToCoordinate(floorLogical as Logical);
      return logicalX === null ? null : logicalX;
    }

    const floorX = chart.timeScale().logicalToCoordinate(floorLogical as Logical);
    const ceilX = chart.timeScale().logicalToCoordinate(ceilLogical as Logical);

    if (floorX === null || ceilX === null) return null;

    const fraction = logical - floorLogical;
    return floorX + (ceilX - floorX) * fraction;
  };

  const xToTime = (x: number, continuous = false): UTCTimestamp | null => {
    const chart = refs.chartRef.current;

    if (!chart) return null;

    /*
     * `chart.timeScale().coordinateToTime(x)` (the native lookup below)
     * returns "the time of whichever BAR occupies this pixel column" -
     * it's fundamentally discrete, snapped to the current interval's
     * grid, not a continuous sub-bar timestamp. That's fine for a single
     * click (vertical line, trend/box endpoint) but is exactly why pen
     * strokes still looked choppy even after chartPointToScreen stopped
     * re-aligning on RENDER: every point was already stamped with its
     * enclosing candle's time at CREATION time, so many consecutive
     * mouse-move samples inside the same candle's pixel width produced
     * the exact same stored time (differing only in price) - a vertical
     * jog - before jumping to the next candle's time as a big diagonal
     * step. `continuous: true` skips native lookup entirely and goes
     * straight to the calibration-based linear interpolation (real
     * sub-bar precision, proportional to pixel offset) so pen points
     * capture the mouse's actual continuous path instead of only ever
     * landing on candle boundaries.
     */
    if (!continuous) {
      const nativeTime = chart.timeScale().coordinateToTime(x);

      if (nativeTime !== null) {
        return nativeTime as UTCTimestamp;
      }
    }

    /*
     * Continuous drawing placement must be the inverse of timeToX's fallback.
     * Using coordinateToLogical() here means a point captured between candles
     * stays on that exact fractional logical position when the chart is later
     * zoomed or panned. A seconds-per-pixel calibration is only an
     * approximation and was the source of Text's horizontal anchor drift.
     */
    const logical = chart.timeScale().coordinateToLogical(x);

    if (logical === null) return null;

    return logicalToTime(logical);
  };

  const chartPointToScreen = (
    point: ChartPoint | null | undefined,
    alignToInterval = true,
  ): ScreenPoint | null => {
    const chart = refs.chartRef.current;
    const series = refs.candleRef.current;

    // Drawings are persisted in localStorage and can survive code-shape
    // changes/HMR. Never let one stale or malformed anchor take down the
    // entire pointer-move/render loop. Invalid points simply are not
    // drawable/hit-testable.
    if (
      !chart ||
      !series ||
      !point ||
      !Number.isFinite(Number(point.time)) ||
      !Number.isFinite(point.price)
    ) {
      return null;
    }

    const x = timeToX(point.time, alignToInterval);
    // FIX: when no candle is visible, the candlestick series returns null even
    // though the shared right scale is kept alive by the invisible future
    // series. Fall back to that series so drawings still receive Y coordinates.
    const y = priceToCoordinateWithFutureFallback(
      series,
      refs.futureScaleRef.current,
      point.price,
    );

    if (x === null || y === null) {
      return null;
    }

    return { x, y };
  };

  const screenToChartPoint = (
    x: number,
    y: number,
    continuous = false,
  ): ChartPoint | null => {
    const chart = refs.chartRef.current;
    const series = refs.candleRef.current;

    if (!chart || !series) return null;

    const price = coordinateToPriceWithFutureFallback(
      series,
      refs.futureScaleRef.current,
      y,
    );

    if (price === null) return null;

    const time = xToTime(x, continuous);

    if (time === null) return null;

    return {
      time,
      price,
    };
  };

  const findDrawingAt = (
    x: number,
    y: number,
    isInteractive: (drawing: Drawing) => boolean = () => true,
  ): Drawing | null => {
    const chart = refs.chartRef.current;
    const series = refs.candleRef.current;

    if (!chart || !series) return null;

    const threshold = 8;

    for (
      let index = refs.drawingsRef.current.length - 1;
      index >= 0;
      index -= 1
    ) {
      const drawing = refs.drawingsRef.current[index];

      // FIX: callers can exclude drawings that are currently non-interactive
      // (for example hidden user annotations) before hit-testing geometry.
      // Filtering inside the reverse scan is important because it still lets a
      // visible order line underneath a hidden drawing receive pointer events.
      if (!isInteractive(drawing)) continue;

      if (drawing.type === "vertical") {
        const lineX = timeToX(drawing.time);

        if (lineX !== null && Math.abs(x - lineX) <= threshold) {
          return drawing;
        }

        continue;
      }

      if (drawing.type === "horizontal") {
        const lineY = priceToCoordinateWithFutureFallback(
          series,
          refs.futureScaleRef.current,
          drawing.price,
        );
        const paneWidth = chart.paneSize().width;

        // The chart wrapper also includes lightweight-charts' right price
        // scale. A horizontal line visually reaches that scale, but the scale
        // must remain reserved for chart/price interaction: never allow an
        // order/reduce line to be armed or dragged from the Bitcoin price
        // labels themselves. The line remains draggable everywhere inside
        // the actual candle pane.
        const isInsidePlotPane = x >= 0 && x < paneWidth;

        if (
          isInsidePlotPane &&
          lineY != null &&
          Math.abs(y - lineY) <= threshold
        ) {
          return drawing;
        }

        continue;
      }

      if (drawing.type === "coordinate-marker") {
        const markerX = timeToX(drawing.time);
        const markerY = priceToCoordinateWithFutureFallback(
          series,
          refs.futureScaleRef.current,
          drawing.price,
        );
        const pane = chart.paneSize();

        if (markerX === null || markerY === null) continue;

        const onHorizontalRay =
          x >= markerX - threshold &&
          x <= pane.width + threshold &&
          Math.abs(y - markerY) <= threshold;
        const onVerticalRay =
          y >= markerY - threshold &&
          y <= pane.height + threshold &&
          Math.abs(x - markerX) <= threshold;

        if (onHorizontalRay || onVerticalRay) {
          return drawing;
        }

        continue;
      }

      if (drawing.type === "pen") {
        for (
          let pointIndex = 1;
          pointIndex < drawing.points.length;
          pointIndex += 1
        ) {
          const previous = chartPointToScreen(
            drawing.points[pointIndex - 1],
            false,
          );
          const current = chartPointToScreen(drawing.points[pointIndex], false);

          if (!previous || !current) continue;

          if (distanceToSegment({ x, y }, previous, current) <= threshold) {
            return drawing;
          }
        }

        continue;
      }

      // Text is intentionally NOT special-cased here anymore: it now
      // anchors two real chart points (start/end) exactly like Trend/Box,
      // so it falls straight through to their shared bounding-box hit
      // test below instead of needing its own branch.
      const start = chartPointToScreen(drawing.start);
      const end = chartPointToScreen(drawing.end);

      if (!start || !end) continue;

      if (drawing.type === "trend") {
        const distance = distanceToSegment({ x, y }, start, end);

        if (distance <= threshold) {
          return drawing;
        }

        continue;
      }

      const left = Math.min(start.x, end.x);
      const right = Math.max(start.x, end.x);
      const top = Math.min(start.y, end.y);
      const bottom = Math.max(start.y, end.y);

      const inside =
        x >= left - threshold &&
        x <= right + threshold &&
        y >= top - threshold &&
        y <= bottom + threshold;

      if (inside) {
        return drawing;
      }
    }

    return null;
  };

  return {
    timeToLogical,
    logicalToTime,
    getCoordinateCalibration,
    timeToX,
    xToTime,
    chartPointToScreen,
    screenToChartPoint,
    findDrawingAt,
  };
}

export type CoordinateMapping = ReturnType<typeof useCoordinateMapping>;
