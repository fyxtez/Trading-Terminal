import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createChart } from "lightweight-charts";
import { useChartRefs } from "./useChartRefs";
import { useChartInstance } from "./useChartInstance";

vi.mock("lightweight-charts", async (original) => ({
  ...(await original<typeof import("lightweight-charts")>()),
  createChart: vi.fn(),
}));
afterEach(() => vi.unstubAllGlobals());

it("reuses the mouse price line across 10000 moves and clears it on teardown", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  let move: (param: { point: { x: number; y: number } }) => void = () => {};
  let price = 0;
  const line = {
    options: () => ({ price }),
    applyOptions: vi.fn((next: { price: number }) => {
      price = next.price;
    }),
  };
  const series = {
    coordinateToPrice: (y: number) => y,
    createPriceLine: vi.fn((next: { price: number }) => {
      price = next.price;
      return line;
    }),
    removePriceLine: vi.fn(),
    priceScale: () => ({ getVisibleRange: () => null }),
  };
  const chart = {
    addSeries: () => series,
    subscribeCrosshairMove: (callback: typeof move) => {
      move = callback;
    },
    timeScale: () => ({ coordinateToLogical: (x: number) => x }),
    remove: vi.fn(),
  };
  vi.mocked(createChart).mockReturnValue(chart as never);
  const hook = renderHook(() => {
    const refs = useChartRefs();
    refs.containerRef.current ??= document.createElement("div");
    useChartInstance(refs, () => null);
    return refs;
  });
  act(() => {
    for (let i = 0; i < 10000; i++) move({ point: { x: 10, y: i } });
  });
  expect(series.createPriceLine).toHaveBeenCalledTimes(1);
  expect(series.removePriceLine).not.toHaveBeenCalled();
  expect(hook.result.current.currentPriceRef.current).toBe(9999);
  line.applyOptions.mockClear();
  move({ point: { x: 20, y: 9999 } });
  expect(line.applyOptions).not.toHaveBeenCalled();
  hook.unmount();
  expect(chart.remove).toHaveBeenCalledTimes(1);
  expect(hook.result.current.mousePriceLineRef.current).toBeNull();
});
