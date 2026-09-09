import { renderHook } from "@testing-library/react";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { describe, expect, it, vi } from "vitest";
import type { PenDrawing } from "../types/drawing";
import { useChartRefs } from "./useChartRefs";
import { useCoordinateMapping } from "./useCoordinateMapping";

const timestamp = (value: number) => value as UTCTimestamp;
const candle = (time: number) => ({ time: timestamp(time), open: 1, high: 1, low: 1, close: 1 });

function setup() {
  const hook = renderHook(() => {
    const refs = useChartRefs();
    return { refs, coord: useCoordinateMapping(refs) };
  });
  const { refs } = hook.result.current;
  const priceToCoordinate = vi.fn((price: number) => price);
  refs.chartRef.current = {
    timeScale: () => ({ logicalToCoordinate: (logical: number) => logical * 100 }),
  } as unknown as IChartApi;
  refs.candleRef.current = { priceToCoordinate } as unknown as ISeriesApi<"Candlestick">;
  refs.loadedCandlesRef.current = [candle(100), candle(200), candle(300)];
  return { ...hook, priceToCoordinate };
}

describe("coordinate mapping", () => {
  it.each([43200, 86400, 604800, 2592000])(
    "preserves sub-bar Pen samples with %s-second candles despite rounded native lookup",
    (step) => {
      const { result } = setup();
      const { refs, coord } = result.current;
      const start = 1700000000;
      refs.loadedCandlesRef.current = [
        candle(start),
        candle(start + step),
        candle(start + step * 3),
      ];
      let spacing = 40;
      let offset = 100;
      const nativeTime = vi.fn(() => timestamp(start));
      refs.chartRef.current = {
        timeScale: () => ({
          coordinateToLogical: (x: number) => Math.ceil((x - offset) / spacing),
          logicalToCoordinate: (index: number) => offset + index * spacing,
          coordinateToTime: nativeTime,
        }),
      } as unknown as IChartApi;
      refs.candleRef.current = {
        coordinateToPrice: (y: number) => y,
        priceToCoordinate: (price: number) => price,
      } as unknown as ISeriesApi<"Candlestick">;
      // Include multiple points inside each bar, a history gap and future whitespace.
      const xs = [103, 107, 113, 121, 139, 147, 173, 193];
      const points = xs.map((x) => coord.screenToChartPoint(x, 20, true)!);
      expect(new Set(points.map((point) => point.time)).size).toBe(xs.length);
      points.forEach((point, index) => {
        expect(coord.chartPointToScreen(point, false)?.x).toBeCloseTo(xs[index], 2);
      });
      expect(nativeTime).not.toHaveBeenCalled();
      spacing = 80;
      offset = 50;
      points.forEach((point, index) => {
        expect(coord.chartPointToScreen(point, false)?.x).toBeCloseTo(
          50 + (xs[index] - 100) * 2,
          2,
        );
      });
      // Single-click tools retain their intentional candle snapping.
      expect(coord.xToTime(53)).toBe(start);
      expect(nativeTime).toHaveBeenCalledOnce();
    },
  );

  it("keeps callbacks stable across renders while using replaced history and chart refs", () => {
    const { result, rerender } = setup();
    const { refs, coord } = result.current;
    expect(coord.timeToLogical(timestamp(150))).toBe(0.5);
    refs.loadedCandlesRef.current = [candle(0), candle(100), candle(200), candle(300)];
    rerender();
    expect(result.current.coord).toBe(coord);
    expect(coord.timeToLogical(timestamp(150))).toBe(1.5);
    expect(coord.timeToX(timestamp(150), false)).toBe(150);
    refs.chartRef.current = {
      timeScale: () => ({ logicalToCoordinate: (logical: number) => logical * 200 }),
    } as unknown as IChartApi;
    expect(coord.timeToX(timestamp(150), false)).toBe(300);
  });

  it("converts each pen point once when scanning an entire stroke", () => {
    const { result, priceToCoordinate } = setup();
    const { refs, coord } = result.current;
    const drawing: PenDrawing = {
      id: "stroke",
      type: "pen",
      color: "#ffffff",
      points: [100, 150, 200, 250, 300].map((time) => ({ time: timestamp(time), price: 10 })),
    };
    refs.drawingsRef.current = [drawing];
    expect(coord.findDrawingAt(50, 100)).toBeNull();
    expect(priceToCoordinate).toHaveBeenCalledTimes(drawing.points.length);
    expect(coord.findDrawingAt(50, 10)).toBe(drawing);
  });

  it("does not bridge an invalid pen point during hit testing", () => {
    const { result } = setup();
    const { refs, coord } = result.current;
    refs.drawingsRef.current = [
      {
        id: "broken-stroke",
        type: "pen",
        color: "#ffffff",
        points: [
          { time: timestamp(100), price: 10 },
          { time: timestamp(200), price: NaN },
          { time: timestamp(300), price: 10 },
        ],
      },
    ];
    expect(coord.findDrawingAt(100, 10)).toBeNull();
  });
});
