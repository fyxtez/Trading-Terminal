import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useChartRefs } from "../useChartRefs";
import { useDrawings } from "../useDrawings";
import { useArmedDrawingInteractions } from "./useArmedDrawingInteractions";
import type { CoordinateMapping } from "../useCoordinateMapping";
import type { MarketDataApi } from "../useMarketData";
import type { TradeMenuApi } from "../useTradeMenu";
import type { TrendDrawing } from "../../types/drawing";
import { drawingsStorageKey } from "../../config/constants";
vi.mock("../../utils/sharedDrawings", () => ({
  connectSharedDrawings: () => () => {},
  publishSharedDrawings: vi.fn(),
}));
const trend = {
  id: "t",
  type: "trend",
  color: "white",
  start: { time: 100, price: 10 },
  end: { time: 200, price: 20 },
} as TrendDrawing;
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(drawingsStorageKey("BTCUSDT"), JSON.stringify([trend]));
});
function setup() {
  return renderHook(() => {
    const refs = useChartRefs();
    const drawings = useDrawings(refs, "BTCUSDT");
    const armed = useArmedDrawingInteractions(
      refs,
      {} as CoordinateMapping,
      drawings,
      {} as MarketDataApi,
      {} as TradeMenuApi,
    );
    return { refs, drawings, armed };
  });
}
it.each(["move", "endpoint"])("releases an armed trend %s when that drawing is deleted", (kind) => {
  const { result } = setup();
  act(() => {
    if (kind === "move") result.current.armed.armTrendMove(trend, trend.start);
    else result.current.armed.armTrendEndpointMove(trend, "end");
  });
  act(() => result.current.drawings.deleteDrawing(trend.id));
  expect(result.current.armed.armedTrendMove).toBeNull();
  expect(result.current.armed.armedTrendEndpoint).toBeNull();
  expect(result.current.drawings.selectedId).toBeNull();
  expect(result.current.refs.drawingsRef.current).toEqual([]);
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    window.dispatchEvent(new MouseEvent("pointerdown", { button: 0 }));
  });
  expect(result.current.refs.drawingsRef.current).toEqual([]);
});
it("releases an armed move on a remote deletion without resurrecting the trend", () => {
  const { result } = setup();
  act(() => result.current.armed.armTrendMove(trend, trend.start));
  act(() =>
    window.dispatchEvent(
      new CustomEvent("terminal:workspace-drawings-changed", {
        detail: { symbol: "BTCUSDT", sender: null, drawings: [] },
      }),
    ),
  );
  expect(result.current.armed.armedTrendMove).toBeNull();
  expect(result.current.refs.drawingsRef.current).toEqual([]);
});
