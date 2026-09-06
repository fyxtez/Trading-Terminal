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
