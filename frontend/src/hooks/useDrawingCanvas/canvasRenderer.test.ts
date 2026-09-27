import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChartRefs } from "../useChartRefs";
import type { CoordinateMapping } from "../useCoordinateMapping";
import { drawCanvasFrame, invalidateCanvasFrame } from "./canvasRenderer";

function setup() {
  const { result } = renderHook(useChartRefs);
  const refs = result.current;
  const canvas = document.createElement("canvas");
  const wrap = document.createElement("div");
  Object.defineProperties(wrap, {
    clientWidth: { value: 800, configurable: true },
    clientHeight: { value: 600, configurable: true },
  });
  const methods: Record<string, ReturnType<typeof vi.fn>> = {};
  const context = new Proxy(
    {},
    {
      get: (_, key: string) => (methods[key] ??= vi.fn()),
      set: () => true,
    },
  ) as CanvasRenderingContext2D;
  vi.spyOn(canvas, "getContext").mockReturnValue(context as never);
  const logical = { from: 0, to: 100 };
  const price = { from: 0, to: 200 };
  const pane = { width: 740, height: 570 };
  refs.canvasRef.current = canvas;
  refs.chartWrapRef.current = wrap;
  refs.chartRef.current = {
    paneSize: () => pane,
    timeScale: () => ({ getVisibleLogicalRange: () => logical }),
  } as never;
  refs.candleRef.current = {
    priceScale: () => ({ getVisibleRange: () => price }),
    priceToCoordinate: (value: number) => value,
  } as never;
  const timeToX = vi.fn(() => 50);
  const options: Parameters<typeof drawCanvasFrame>[0] = {
    refs,
    coord: {
      timeToX,
      chartPointToScreen: (point: { time: number; price: number }) => ({
        x: point.time,
        y: point.price,
      }),
    } as unknown as CoordinateMapping,
    pricePrecision: 2,
    showDrawings: true,
    cancellingOrderIds: new Set(),
    reduceOrderEditorRef: { current: null },
    setReduceOrderEditor: vi.fn(),
    editingTextRef: { current: null },
    setEditingText: vi.fn(),
  };
  const draw = () => drawCanvasFrame(options);
  return { refs, canvas, wrap, context, logical, price, pane, options, draw, timeToX };
}

describe("retained drawing canvas", () => {
  it("paints an idle canvas once across 10000 frames", () => {
    const { refs, context, draw, timeToX } = setup();
    refs.drawingsRef.current = [{ id: "v", type: "vertical", time: 1, color: "red" }] as never;
    for (let frame = 0; frame < 10000; frame++) draw();
    expect(context.clearRect).toHaveBeenCalledTimes(1);
    expect(timeToX).toHaveBeenCalledTimes(1);
  });

  it("repaints for horizontal pan, vertical scale, pane resize and drawing edits", () => {
    const { refs, context, logical, price, pane, draw } = setup();
    draw();
    logical.from++;
    draw();
    price.to++;
    draw();
    pane.width--;
    draw();
    refs.drawingsRef.current = [{ id: "v", type: "vertical", time: 1, color: "red" }] as never;
    draw();
    draw();
    expect(context.clearRect).toHaveBeenCalledTimes(5);
  });

  it("tracks mutable selection sets, gestures, visibility and live candles", () => {
    const { refs, context, options, draw } = setup();
    draw();
    refs.groupSelectedIdsRef.current.add("v");
    draw();
    refs.groupSelectedIdsRef.current.clear();
    draw();
    refs.groupSelectionBoxRef.current = { start: { x: 1, y: 2 }, end: { x: 3, y: 4 } };
    draw();
    refs.groupSelectionBoxRef.current.end.x = 8;
    draw();
    options.showDrawings = false;
    draw();
    refs.loadedCandlesRef.current = [];
    draw();
    options.cancellingOrderIds.add("order");
    draw();
    expect(context.clearRect).toHaveBeenCalledTimes(8);
  });

  it("continues blinking and paints the final unhighlighted state", () => {
    const { refs, context, draw } = setup();
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    refs.highlightedOrderUntilRef.current = 1000;
    refs.highlightedOrderIdRef.current = "order";
    draw();
    now.mockReturnValue(180);
    draw();
    now.mockReturnValue(1001);
    draw();
    draw();
    expect(context.clearRect).toHaveBeenCalledTimes(3);
  });

  it("repaints after font invalidation or a pixel-ratio change", () => {
    const { canvas, context, draw } = setup();
    const ratio = vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(1);
    draw();
    invalidateCanvasFrame(canvas);
    draw();
    ratio.mockReturnValue(2);
    draw();
    expect(context.clearRect).toHaveBeenCalledTimes(3);
    expect(canvas.width).toBe(1600);
  });

  it("resets failed frames and recovers instead of caching partial output", () => {
    const { refs, canvas, context, draw, timeToX } = setup();
    refs.drawingsRef.current = [{ id: "v", type: "vertical", time: 1, color: "red" }] as never;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const reset = vi.spyOn(canvas, "width", "set");
    timeToX.mockImplementation(() => {
      throw new Error("coordinate unavailable");
    });
    draw();
    reset.mockClear();
    draw();
    expect(reset).toHaveBeenCalledWith(800);
    timeToX.mockReturnValue(50);
    draw();
    draw();
    expect(errors).toHaveBeenCalledTimes(2);
    expect(context.clearRect).toHaveBeenCalledTimes(3);
  });
});
