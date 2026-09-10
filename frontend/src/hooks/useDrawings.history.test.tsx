import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useDrawings } from "./useDrawings";
import { useChartRefs } from "./useChartRefs";
import { drawingsStorageKey } from "../config/constants";
import type { Drawing } from "../types/drawing";

const sync = vi.hoisted(() => ({ receive: null as null | ((drawings: Drawing[]) => void) }));
vi.mock("../utils/sharedDrawings", () => ({
  publishSharedDrawings: vi.fn(),
  connectSharedDrawings: (
    _symbol: string,
    _initial: Drawing[],
    receive: (drawings: Drawing[]) => void,
  ) => {
    sync.receive = receive;
    return () => {
      sync.receive = null;
    };
  },
}));
const initial = {
  id: "trend",
  type: "trend",
  color: "white",
  start: { time: 100, price: 10 },
  end: { time: 200, price: 20 },
};
// serde_json emits alphabetically sorted object fields, including nested points.
const serverCopy = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    ),
  );
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(drawingsStorageKey("BTCUSDT"), JSON.stringify([initial]));
});
it("preserves undo and redo when a moved trend's acknowledgement reorders JSON fields", () => {
  const { result } = renderHook(() => {
    const refs = useChartRefs();
    return { refs, drawings: useDrawings(refs, "BTCUSDT") };
  });
  act(() =>
    result.current.drawings.updateDrawing(
      "trend",
      (d) => ({ ...d, start: { time: 110, price: 11 }, end: { time: 210, price: 21 } }) as Drawing,
    ),
  );
  const moved = serverCopy(result.current.refs.drawingsRef.current);
  act(() => sync.receive!(moved));
  expect(result.current.refs.undoRef.current).toHaveLength(1);
  act(() => result.current.drawings.undo());
  expect(result.current.refs.drawingsRef.current[0]).toEqual(initial);
  act(() => sync.receive!(serverCopy([initial])));
  expect(result.current.refs.redoRef.current).toHaveLength(1);
  act(() => result.current.drawings.redo());
  expect(result.current.refs.drawingsRef.current).toEqual(moved);
});
it("still discards history that would resurrect a genuinely remote deletion", () => {
  const { result } = renderHook(() => {
    const refs = useChartRefs();
    return { refs, drawings: useDrawings(refs, "BTCUSDT") };
  });
  act(() => result.current.drawings.updateDrawing("trend", (d) => ({ ...d, color: "red" })));
  act(() => sync.receive!([]));
  expect(result.current.refs.undoRef.current).toHaveLength(0);
  expect(result.current.refs.drawingsRef.current).toEqual([]);
});
