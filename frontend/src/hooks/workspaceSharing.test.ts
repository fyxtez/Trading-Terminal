import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useChartRefs } from "./useChartRefs";
import { useTradeMarkers } from "./useTradeMarkers";
import { useDrawings } from "./useDrawings";
import { appendTradeMarkerForSymbol } from "../utils/tradeMarkers";

const markers = (symbol: string) => renderHook(() => useTradeMarkers(useChartRefs(), symbol));
const drawings = () => renderHook(() => useDrawings(useChartRefs(), "BTCUSDT"));
describe("same-symbol workspace sharing", () => {
  it("shows local and external fills in both panes, deduplicates stream IDs and clears together", () => {
    const left = markers("BTCUSDT"),
      right = markers("BTCUSDT"),
      other = markers("SOLUSDT");
    const fill = {
      symbol: "BTCUSDT",
      id: "fill-1",
      time: Math.floor(Date.now() / 1000),
      price: 70000,
      side: "BUY" as const,
    };
    act(() => left.result.current.addMarker(fill));
    expect(right.result.current.markers).toEqual(left.result.current.markers);
    act(() => {
      right.result.current.addMarker(fill);
      appendTradeMarkerForSymbol("BTCUSDT", { ...fill, id: "fill-2" });
    });
    expect(left.result.current.markers).toHaveLength(2);
    expect(right.result.current.markers).toHaveLength(2);
    expect(other.result.current.markers).toHaveLength(0);
    act(() => right.result.current.clearMarkers());
    expect(left.result.current.markers).toHaveLength(0);
  });
  it("shares user annotations without duplicating per-pane runtime order lines", () => {
    const left = drawings(),
      right = drawings();
    act(() =>
      left.result.current.addDrawing({ type: "horizontal", id: "line", price: 10, color: "white" }),
    );
    expect(right.result.current.drawings.map((d) => d.id)).toEqual(["line"]);
    act(() =>
      right.result.current.addDrawing({
        type: "horizontal",
        id: "order-1",
        price: 11,
        color: "green",
        orderSide: "BUY",
      }),
    );
    expect(left.result.current.drawings.map((d) => d.id)).toEqual(["line"]);
    act(() => left.result.current.deleteDrawing("line"));
    expect(right.result.current.drawings.map((d) => d.id)).toEqual(["order-1"]);
  });
});
