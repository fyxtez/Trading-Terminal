import { useEffect, useState } from "react";
import type { Logical } from "lightweight-charts";
import {
  activeDrawingSetStorageKey,
  drawingSetsStorageKey,
  drawingsStorageKey,
  intervals,
  type Interval,
} from "../config/constants";
import {
  cloneDrawing,
  cloneDrawings,
  loadStoredDrawings,
  loadStoredDrawingSets,
  saveDrawings,
  saveDrawingSets,
} from "../utils/drawings";
import type {
  ContextMenuState,
  Drawing,
  DrawingTool,
  HistoryAction,
  SavedDrawingSet,
} from "../types/drawing";
import type { ChartRefs } from "./useChartRefs";

/**
 * Owns every piece of state related to drawings themselves: the list
 * of drawings, which tool is active, which drawing is selected, the
 * right-click context menu, and the full undo/redo history stack.
 *
 * `symbol` scopes ALL of this to one trading pair - drawings are
 * persisted under a per-symbol storage key (see drawingsStorageKey), and
 * switching symbols reloads that OTHER symbol's saved drawings instead
 * of continuing to show/persist the previous one's.
 */
type SymbolDrawingsState = {
  symbol: string;
  drawings: Drawing[];
};

const normalizeSymbol = (symbol: string) => symbol.toUpperCase();

/**
 * drawing-move feedback should fire only for real geometry changes,
 * not unrelated updates such as color/text alignment edits. Keeping the
 * geometry signature here lets every movement path that records an undo entry
 * (drag, click-move-click, resize, group move) share one reliable detector.
 */
function drawingGeometrySignature(drawing: Drawing): string {
  switch (drawing.type) {
    case "vertical":
      return `${Number(drawing.time)}`;
    case "horizontal":
      return `${drawing.price}`;
    case "coordinate-marker":
      return `${Number(drawing.time)}:${drawing.price}`;
    case "pen":
      return JSON.stringify(drawing.points);
    case "trend":
    case "box":
    case "text":
      return JSON.stringify([drawing.start, drawing.end]);
  }
}

function drawingMoveLabel(drawing: Drawing): string {
  switch (drawing.type) {
    case "trend":
      return "Trendline";
    case "box":
      return "Box";
    case "horizontal":
      return "Horizontal line";
    case "vertical":
      return "Vertical line";
    case "coordinate-marker":
      return "Coordinate marker";
    case "text":
      return "Text";
    case "pen":
      return "Pen drawing";
  }
}

export function useDrawings(refs: ChartRefs, symbol: string) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const [tool, setToolState] = useState<DrawingTool>("cursor");
  const [drawingState, setDrawingState] = useState<SymbolDrawingsState>(() => ({
    symbol: normalizedSymbol,
    drawings: loadStoredDrawings(drawingsStorageKey(normalizedSymbol)),
  }));
  const isHydrated = drawingState.symbol === normalizedSymbol;
  const drawings = isHydrated ? drawingState.drawings : [];
  const [drawingSets, setDrawingSets] = useState<SavedDrawingSet[]>(() =>
    loadStoredDrawingSets(drawingSetsStorageKey(normalizedSymbol)),
  );
  const [activeDrawingSetId, setActiveDrawingSetId] = useState<string | null>(() =>
    localStorage.getItem(activeDrawingSetStorageKey(normalizedSymbol)),
  );
  const [selectedId, setSelectedIdState] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  /*
   * The canvas render loop and hit-testing (useDrawingCanvas /
   * useCoordinateMapping) read exclusively from refs.drawingsRef, never
   * from this `drawings` state directly - that's what lets the RAF loop
   * run without re-subscribing on every state change. refs.drawingsRef
   * is created empty in useChartRefs, so it must be seeded with the
   * persisted drawings loaded above before anything is ever painted.
   */
  if (isHydrated) {
    if (refs.drawingsRef.current !== drawingState.drawings) {
      refs.drawingsRef.current = drawingState.drawings;
    }
  } else if (refs.drawingsRef.current.length > 0) {
    // Never expose the previous symbol's drawings during the transition render.
    refs.drawingsRef.current = [];
  }

  const setTool = (nextTool: DrawingTool) => {
    // the dashed marquee is a real toolbar tool, while the selected
    // group itself remains ref-backed for the canvas. Entering starts a fresh
    // group; leaving clears both the marquee and its selection.
    const wasGroupSelecting = refs.toolRef.current === "group-select";
    const willGroupSelect = nextTool === "group-select";
    if (willGroupSelect && !wasGroupSelecting) {
      refs.groupSelectedIdsRef.current.clear();
    } else if (!willGroupSelect && wasGroupSelecting) {
      refs.groupSelectionModeRef.current = false;
      refs.groupSelectedIdsRef.current.clear();
      refs.groupSelectionBoxRef.current = null;
    }
    refs.groupSelectionModeRef.current = willGroupSelect;
    refs.toolRef.current = nextTool;
    setToolState(nextTool);

    refs.pendingStartRef.current = null;
    refs.previewPointRef.current = null;
    refs.rulerStartRef.current = null;
    refs.rulerEndRef.current = null;
  };

  const setSelectedId = (id: string | null) => {
    refs.selectedIdRef.current = id;
    setSelectedIdState(id);
  };

  const syncDrawings = (next: Drawing[], options: { syncActiveDrawingSet?: boolean } = {}) => {
    refs.drawingsRef.current = next;
    setDrawingState({
      symbol: normalizedSymbol,
      drawings: next,
    });

    // Once a named set is active it behaves like the current document:
    // every drawing add, edit, delete, undo, or redo is persisted back to
    // that set immediately. Pending order lines are runtime-only drawings
    // and must never become part of a saved set.
    if (options.syncActiveDrawingSet === false || !activeDrawingSetId) return;

    const current = next.filter((drawing) => !(drawing.type === "horizontal" && drawing.orderSide));

    setDrawingSets((previousSets) => {
      const activeSet = previousSets.find((set) => set.id === activeDrawingSetId);

      if (!activeSet) return previousSets;

      const clonedCurrent = cloneDrawings(current);
      if (JSON.stringify(activeSet.drawings) === JSON.stringify(clonedCurrent)) {
        return previousSets;
      }

      const updatedSets = previousSets.map((set) =>
        set.id === activeDrawingSetId
          ? {
              ...set,
              drawings: clonedCurrent,
              updatedAt: Date.now(),
            }
          : set,
      );

      saveDrawingSets(drawingSetsStorageKey(normalizedSymbol), updatedSets);
      return updatedSets;
    });
  };

  const pushHistory = (
    action:
      | { type: "add"; drawing: Drawing }
      | { type: "delete"; drawing: Drawing }
      | { type: "update"; before: Drawing; after: Drawing },
  ) => {
    refs.historySeqRef.current += 1;
    refs.undoRef.current.push({
      ...action,
      seq: refs.historySeqRef.current,
    } as HistoryAction);
    refs.redoRef.current = [];

    /*
     * after a persistent chart tool is actually moved/resized, emit
     * one app-level event so the UI can offer an immediate Undo action plus
     * the Ctrl+Z hint. Exchange order lines are excluded because moving those
     * already has its own success/error toast and should not look like a plain
     * drawing edit.
     */
    if (
      action.type === "update" &&
      !(action.after.type === "horizontal" && action.after.orderSide) &&
      drawingGeometrySignature(action.before) !== drawingGeometrySignature(action.after)
    ) {
      window.dispatchEvent(
        new CustomEvent("drawing-geometry-moved", {
          detail: { label: drawingMoveLabel(action.after) },
        }),
      );
    }
  };

  const addDrawing = (drawing: Drawing) => {
    /*
     * Record which chart interval was active at creation time, unless the
     * caller already set one (e.g. the hotkey "duplicate drawing" flow
     * passes through a clone of an existing drawing, whose original
     * timeframe should be kept rather than overwritten with whatever
     * interval happens to be showing right now). Read straight from the
     * ref (not React state) since this needs the CURRENT interval at the
     * exact moment of creation, not whatever value this closure captured
     * on its last render.
     */
    const stamped: Drawing =
      drawing.timeframe !== undefined
        ? drawing
        : { ...drawing, timeframe: refs.intervalRef.current };

    syncDrawings([...refs.drawingsRef.current, stamped]);

    pushHistory({
      type: "add",
      drawing: cloneDrawing(stamped),
    });

    setSelectedId(stamped.id);
  };

  const replaceDrawingWithoutHistory = (id: string, replacement: Drawing) => {
    syncDrawings(
      refs.drawingsRef.current.map((drawing) => (drawing.id === id ? replacement : drawing)),
    );
  };

  /*
   * cancelling an exchange order is not a
   * user drawing edit, so removing its chart line after Binance confirms the
   * cancellation must not create an undo/redo entry that could resurrect a
   * dead order. This helper removes only the visual order drawing/history-free.
   */
  const removeDrawingWithoutHistory = (id: string) => {
    syncDrawings(refs.drawingsRef.current.filter((drawing) => drawing.id !== id));

    // setSelectedId is a wrapper, not a React state setter, so read the
    // current selection from the ref and clear it only if the removed drawing
    // was selected.
    if (refs.selectedIdRef.current === id) {
      setSelectedId(null);
    }

    setContextMenu(null);
  };

  const updateDrawing = (id: string, updater: (drawing: Drawing) => Drawing) => {
    const current = refs.drawingsRef.current.find((drawing) => drawing.id === id);

    if (!current) return;

    const before = cloneDrawing(current);
    const after = updater(cloneDrawing(current));

    syncDrawings(refs.drawingsRef.current.map((drawing) => (drawing.id === id ? after : drawing)));

    pushHistory({
      type: "update",
      before,
      after: cloneDrawing(after),
    });
  };

  const deleteDrawing = (id: string) => {
    const drawing = refs.drawingsRef.current.find((item) => item.id === id);

    if (!drawing) return;

    syncDrawings(refs.drawingsRef.current.filter((item) => item.id !== id));

    pushHistory({
      type: "delete",
      drawing: cloneDrawing(drawing),
    });

    setSelectedId(null);
    setContextMenu(null);
  };

  const deleteAllDrawings = () => {
    // Pending limit-order lines are a special drawing, not a regular
    // one the user drew - "delete all" shouldn't touch open orders.
    // Use the dedicated cancel ("x") button on the line itself for those.
    const keep = refs.drawingsRef.current.filter(
      (drawing) => drawing.type === "horizontal" && drawing.orderSide,
    );

    if (keep.length === refs.drawingsRef.current.length) {
      setContextMenu(null);
      return;
    }

    // Starting a new set must clear only the working canvas; the previously
    // saved active set remains intact and can still be loaded later.
    syncDrawings(keep, { syncActiveDrawingSet: false });
    refs.undoRef.current = [];
    refs.redoRef.current = [];
    setSelectedId(null);
    setContextMenu(null);
    setActiveDrawingSetId(null);
    localStorage.removeItem(activeDrawingSetStorageKey(normalizedSymbol));
  };

  const deleteAllPenDrawings = () => {
    const penDrawings = refs.drawingsRef.current.filter((drawing) => drawing.type === "pen");

    if (penDrawings.length === 0) {
      setContextMenu(null);
      return;
    }

    syncDrawings(refs.drawingsRef.current.filter((drawing) => drawing.type !== "pen"));

    refs.undoRef.current = [];
    refs.redoRef.current = [];
    setSelectedId(null);
    setContextMenu(null);
  };

  /*
   * Bulk-deletes every regular drawing stamped with a given timeframe
   * (see the `timeframe` field on Drawing in types/drawing.ts). Same
   * shape as deleteAllPenDrawings just above: pending limit-order lines
   * are never touched, and this counts as a single non-undoable action
   * (clearing history) rather than pushing one "delete" entry per line,
   * since a per-line undo trail for a bulk clear isn't useful and would
   * make undo silently resurrect lines one at a time.
   */
  const deleteDrawingsByTimeframe = (timeframe: Interval) => {
    const matching = refs.drawingsRef.current.filter(
      (drawing) =>
        drawing.timeframe === timeframe && !(drawing.type === "horizontal" && drawing.orderSide),
    );

    if (matching.length === 0) {
      setContextMenu(null);
      return;
    }

    syncDrawings(
      refs.drawingsRef.current.filter(
        (drawing) =>
          !(
            drawing.timeframe === timeframe && !(drawing.type === "horizontal" && drawing.orderSide)
          ),
      ),
    );

    refs.undoRef.current = [];
    refs.redoRef.current = [];
    setSelectedId(null);
    setContextMenu(null);
  };

  const regularDrawings = drawings.filter(
    (drawing) => !(drawing.type === "horizontal" && drawing.orderSide),
  );

  /*
   * How many regular (non-order-line) drawings exist per chart interval,
   * keyed the same way as the `intervals` array in config/constants.ts.
   * Drives the "Delete TF lines" submenu in ContextMenu.tsx - each
   * timeframe button shows/disables based on this. A drawing saved
   * before the `timeframe` field existed (see the comment on it in
   * types/drawing.ts) simply isn't counted under any timeframe here.
   */
  const drawingCountsByTimeframe = intervals.reduce<Partial<Record<Interval, number>>>(
    (counts, interval) => {
      const count = regularDrawings.filter((drawing) => drawing.timeframe === interval).length;
      if (count > 0) counts[interval] = count;
      return counts;
    },
    {},
  );

  const saveCurrentDrawingSet = (name: string) => {
    const trimmedName = name.trim();
    const current = refs.drawingsRef.current.filter(
      (drawing) => !(drawing.type === "horizontal" && drawing.orderSide),
    );

    if (!trimmedName) return false;

    const now = Date.now();
    const existing = drawingSets.find(
      (set) => set.name.toLocaleLowerCase() === trimmedName.toLocaleLowerCase(),
    );
    const nextSet: SavedDrawingSet = {
      id: existing?.id ?? crypto.randomUUID(),
      name: trimmedName,
      drawings: cloneDrawings(current),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const nextSets = existing
      ? drawingSets.map((set) => (set.id === existing.id ? nextSet : set))
      : [nextSet, ...drawingSets];

    setDrawingSets(nextSets);
    saveDrawingSets(drawingSetsStorageKey(normalizedSymbol), nextSets);
    setActiveDrawingSetId(nextSet.id);
    localStorage.setItem(activeDrawingSetStorageKey(normalizedSymbol), nextSet.id);

    return true;
  };

  const loadDrawingSet = (setId: string) => {
    const set = drawingSets.find((item) => item.id === setId);
    if (!set) return false;

    const orderLines = refs.drawingsRef.current.filter(
      (drawing) => drawing.type === "horizontal" && drawing.orderSide,
    );
    // Do not write the loaded drawings into the set that happened to be
    // active before this click. The newly loaded set becomes active below.
    syncDrawings([...orderLines, ...cloneDrawings(set.drawings)], {
      syncActiveDrawingSet: false,
    });
    refs.undoRef.current = [];
    refs.redoRef.current = [];
    setSelectedId(null);
    setContextMenu(null);
    setActiveDrawingSetId(set.id);
    localStorage.setItem(activeDrawingSetStorageKey(normalizedSymbol), set.id);
    return true;
  };

  const renameDrawingSet = (setId: string, name: string) => {
    const trimmedName = name.trim();
    if (!trimmedName) return false;

    const duplicate = drawingSets.some(
      (set) => set.id !== setId && set.name.toLocaleLowerCase() === trimmedName.toLocaleLowerCase(),
    );
    if (duplicate) return false;

    const now = Date.now();
    const nextSets = drawingSets.map((set) =>
      set.id === setId ? { ...set, name: trimmedName, updatedAt: now } : set,
    );
    if (nextSets.every((set, index) => set === drawingSets[index])) return false;

    setDrawingSets(nextSets);
    saveDrawingSets(drawingSetsStorageKey(normalizedSymbol), nextSets);
    return true;
  };

  const deleteDrawingSet = (setId: string) => {
    const nextSets = drawingSets.filter((set) => set.id !== setId);
    setDrawingSets(nextSets);
    saveDrawingSets(drawingSetsStorageKey(normalizedSymbol), nextSets);

    if (activeDrawingSetId === setId) {
      setActiveDrawingSetId(null);
      localStorage.removeItem(activeDrawingSetStorageKey(normalizedSymbol));
    }
  };

  const resetChartView = () => {
    const chart = refs.chartRef.current;
    const series = refs.candleRef.current;
    const candles = refs.loadedCandlesRef.current;

    if (!chart || !series || candles.length === 0) {
      setContextMenu(null);
      return;
    }

    const lastIndex = candles.length - 1;
    const visibleBars = 220;
    const futureBars = refs.intervalRef.current === "1m" ? 25 : 20;

    chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, lastIndex - visibleBars) as Logical,
      to: (lastIndex + futureBars) as Logical,
    });

    series.priceScale().applyOptions({ autoScale: true });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        refs.candleRef.current?.priceScale().applyOptions({ autoScale: false });
      });
    });

    setSelectedId(null);
    setContextMenu(null);
  };

  const reverseAction = (action: HistoryAction) => {
    if (action.type === "add") {
      syncDrawings(refs.drawingsRef.current.filter((drawing) => drawing.id !== action.drawing.id));

      return;
    }

    if (action.type === "delete") {
      syncDrawings([...refs.drawingsRef.current, cloneDrawing(action.drawing)]);

      return;
    }

    syncDrawings(
      refs.drawingsRef.current.map((drawing) =>
        drawing.id === action.before.id ? cloneDrawing(action.before) : drawing,
      ),
    );
  };

  const applyAction = (action: HistoryAction) => {
    if (action.type === "add") {
      syncDrawings([...refs.drawingsRef.current, cloneDrawing(action.drawing)]);

      return;
    }

    if (action.type === "delete") {
      syncDrawings(refs.drawingsRef.current.filter((drawing) => drawing.id !== action.drawing.id));

      return;
    }

    syncDrawings(
      refs.drawingsRef.current.map((drawing) =>
        drawing.id === action.after.id ? cloneDrawing(action.after) : drawing,
      ),
    );
  };

  const undo = () => {
    const action = refs.undoRef.current.pop();

    if (!action) return;

    reverseAction(action);
    refs.redoRef.current.push(action);

    setSelectedId(null);
    setContextMenu(null);

    refs.pendingStartRef.current = null;
    refs.previewPointRef.current = null;
    refs.rulerStartRef.current = null;
    refs.rulerEndRef.current = null;
  };

  const redo = () => {
    const action = refs.redoRef.current.pop();

    if (!action) return;

    applyAction(action);
    refs.undoRef.current.push(action);

    setSelectedId(null);
    setContextMenu(null);

    refs.pendingStartRef.current = null;
    refs.previewPointRef.current = null;
    refs.rulerStartRef.current = null;
    refs.rulerEndRef.current = null;
  };

  const changeDrawingColor = (drawingId: string, color: string) => {
    updateDrawing(drawingId, (drawing) => ({
      ...drawing,
      color,
    }));

    setContextMenu(null);
  };

  const changeTextAlign = (drawingId: string, align: "left" | "center" | "right") => {
    updateDrawing(drawingId, (drawing) =>
      drawing.type === "text" ? { ...drawing, align } : drawing,
    );

    setContextMenu(null);
  };

  const straightenTrendOnXAxis = (drawingId: string) => {
    updateDrawing(drawingId, (drawing) =>
      drawing.type === "trend"
        ? {
            ...drawing,
            end: {
              ...drawing.end,
              price: drawing.start.price,
            },
          }
        : drawing,
    );

    setContextMenu(null);
  };

  const straightenTrendsOnXAxis = (drawingIds: string[]) => {
    const selectedIds = new Set(drawingIds);
    const changes = refs.drawingsRef.current.flatMap((drawing) => {
      if (
        !selectedIds.has(drawing.id) ||
        drawing.type !== "trend" ||
        drawing.start.price === drawing.end.price
      ) {
        return [];
      }

      const before = cloneDrawing(drawing);
      const after: Drawing = {
        ...drawing,
        end: { ...drawing.end, price: drawing.start.price },
      };
      return [{ before, after }];
    });

    if (changes.length > 0) {
      const replacements = new Map(changes.map(({ after }) => [after.id, after]));
      syncDrawings(
        refs.drawingsRef.current.map((drawing) => replacements.get(drawing.id) ?? drawing),
      );
      changes.forEach(({ before, after }) =>
        pushHistory({ type: "update", before, after: cloneDrawing(after) }),
      );
    }

    setContextMenu(null);
  };

  /*
   * Reload from storage whenever the active symbol changes. Drawings are
   * namespaced per symbol (drawingsStorageKey), so a BTC trend line must
   * never stay "loaded" (selectable, undo-able, or overwritable) while
   * looking at SOL - this swaps the in-memory list for the newly
   * selected symbol's own saved drawings, and clears any selection/undo
   * history that referred to the previous symbol's drawings.
   */
  useEffect(() => {
    const next = loadStoredDrawings(drawingsStorageKey(normalizedSymbol));
    const nextDrawingSets = loadStoredDrawingSets(drawingSetsStorageKey(normalizedSymbol));
    setDrawingSets(nextDrawingSets);
    const storedActiveId = localStorage.getItem(activeDrawingSetStorageKey(normalizedSymbol));
    setActiveDrawingSetId(
      storedActiveId && nextDrawingSets.some((set) => set.id === storedActiveId)
        ? storedActiveId
        : null,
    );

    refs.drawingsRef.current = next;
    setDrawingState({
      symbol: normalizedSymbol,
      drawings: next,
    });
    setSelectedId(null);
    setContextMenu(null);
    refs.undoRef.current = [];
    refs.redoRef.current = [];
    refs.pendingStartRef.current = null;
    refs.previewPointRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalizedSymbol]);

  useEffect(() => {
    // A symbol change first renders with the previous symbol's React state.
    // Never write that transitional state under the newly selected symbol key.
    if (!isHydrated) return;

    saveDrawings(drawingsStorageKey(drawingState.symbol), drawingState.drawings);
  }, [drawingState, isHydrated]);

  return {
    tool,
    setTool,
    drawings,
    regularDrawingsCount: regularDrawings.length,
    drawingSets,
    activeDrawingSetId,
    saveCurrentDrawingSet,
    loadDrawingSet,
    renameDrawingSet,
    deleteDrawingSet,
    isHydrated,
    selectedId,
    setSelectedId,
    contextMenu,
    setContextMenu,
    syncDrawings,
    pushHistory,
    replaceDrawingWithoutHistory,
    removeDrawingWithoutHistory,
    addDrawing,
    updateDrawing,
    deleteDrawing,
    deleteAllDrawings,
    deleteAllPenDrawings,
    deleteDrawingsByTimeframe,
    drawingCountsByTimeframe,
    resetChartView,
    changeDrawingColor,
    changeTextAlign,
    straightenTrendOnXAxis,
    straightenTrendsOnXAxis,
    undo,
    redo,
  };
}

export type DrawingsApi = ReturnType<typeof useDrawings>;
