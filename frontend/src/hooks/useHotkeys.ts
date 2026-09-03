import { useEffect, useRef } from "react";
import type { UTCTimestamp } from "lightweight-charts";
import { DEFAULT_LINE_COLOR, intervalSeconds } from "../config/constants";
import type { Drawing } from "../types/drawing";
import { cloneDrawing } from "../utils/drawings";
import type { ChartRefs } from "./useChartRefs";
import type { ChartTabsApi } from "./useChartTabs";
import type { DrawingsApi } from "./useDrawings";
import type { PriceAlertsApi } from "./usePriceAlerts";
import type { TradeMenuApi } from "./useTradeMenu";

const PASTE_OFFSET_PX = 12;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

function isOrderDrawing(drawing: Drawing): boolean {
  return (
    drawing.type === "horizontal" &&
    (drawing.orderId !== undefined || drawing.orderSide !== undefined)
  );
}

/**
 * Creates a visually offset copy of a drawing.
 *
 * Horizontal movement is one candle to the right. Vertical movement is a
 * fixed number of screen pixels downward, converted back to a chart price so
 * the offset remains visually small regardless of zoom level or BTC price.
 */
function offsetDrawing(drawing: Drawing, refs: ChartRefs): Drawing {
  const timeOffset = intervalSeconds[refs.intervalRef.current];
  const series = refs.candleRef.current;

  const offsetTime = (time: UTCTimestamp) => (Number(time) + timeOffset) as UTCTimestamp;

  const offsetPrice = (price: number) => {
    if (!series) return price;

    const y = series.priceToCoordinate(price);
    if (y === null) return price;

    const nextPrice = series.coordinateToPrice(y + PASTE_OFFSET_PX);
    return nextPrice !== null && Number.isFinite(nextPrice) && nextPrice > 0 ? nextPrice : price;
  };

  const id = crypto.randomUUID();

  if (drawing.type === "vertical") {
    return {
      ...drawing,
      id,
      time: offsetTime(drawing.time),
    };
  }

  if (drawing.type === "horizontal") {
    return {
      ...drawing,
      id,
      price: offsetPrice(drawing.price),
    };
  }

  if (drawing.type === "coordinate-marker") {
    return {
      ...drawing,
      id,
      time: offsetTime(drawing.time),
      price: offsetPrice(drawing.price),
    };
  }

  if (drawing.type === "pen") {
    return {
      ...drawing,
      id,
      points: drawing.points.map((point) => ({
        time: offsetTime(point.time),
        price: offsetPrice(point.price),
      })),
    };
  }

  // Text falls through to the generic start/end case below now too - see
  // the comment there.

  return {
    ...drawing,
    id,
    start: {
      time: offsetTime(drawing.start.time),
      price: offsetPrice(drawing.start.price),
    },
    end: {
      time: offsetTime(drawing.end.time),
      price: offsetPrice(drawing.end.price),
    },
  };
}

/**
 * Alt+C creates a Text drawing directly at the crosshair - unlike the
 * click-to-create path in useDrawingCanvas.ts, there's no pixel position
 * from a click to offset for the second corner, just a chart point. Mirrors
 * offsetDrawing's approach above: resolve a sane default on-screen box size
 * in PIXELS from that anchor, then convert back to a chart point, so the
 * box is a normal, glanceable size regardless of current price or zoom
 * level - the same reasoning offsetDrawing uses to keep its paste offset a
 * constant visual distance instead of a constant price/time delta.
 */
function defaultTextEnd(
  start: { time: UTCTimestamp; price: number },
  refs: ChartRefs,
): { time: UTCTimestamp; price: number } {
  const defaultBoxWidthPx = 140;
  const defaultBoxHeightPx = 42;

  const fallback = {
    time: (Number(start.time) + intervalSeconds[refs.intervalRef.current] * 10) as UTCTimestamp,
    price: start.price * 0.98,
  };

  const chart = refs.chartRef.current;
  const series = refs.candleRef.current;
  if (!chart || !series) return fallback;

  const startX = chart.timeScale().timeToCoordinate(start.time);
  const startY = series.priceToCoordinate(start.price);

  const endTime =
    startX !== null
      ? (chart
          .timeScale()
          .coordinateToTime((startX + defaultBoxWidthPx) as never) as UTCTimestamp | null)
      : null;
  const endPrice = startY !== null ? series.coordinateToPrice(startY + defaultBoxHeightPx) : null;

  return {
    time: endTime ?? fallback.time,
    price: endPrice ?? fallback.price,
  };
}

/**
 * Global keydown handler for all chart shortcuts. Registered on
 * `document` with capture=true, exactly as in the original component,
 * so it keeps working regardless of which element currently has focus.
 */
export function useHotkeys(
  refs: ChartRefs,
  drawingsApi: DrawingsApi,
  priceAlertsApi: PriceAlertsApi,
  tradeMenuApi: TradeMenuApi,
  chartTabsApi: ChartTabsApi,
) {
  const copiedDrawingRef = useRef<Drawing | null>(null);

  /*
   * the keydown listener below is registered by a
   * mount-once (`useEffect(..., [])`) effect - the exact same pattern
   * already found and fixed twice elsewhere this session (the drawing
   * canvas's price-precision label, both times the culprit was a
   * closure over a plain value that changes after mount, inside
   * something that only ever runs its very first version). This hook
   * gets called fresh on every App render with whatever the current
   * drawingsApi/tradeMenuApi objects are - but since the effect creating
   * the actual listener never re-runs, it was permanently using
   * whichever drawingsApi/tradeMenuApi existed on the app's very FIRST
   * render, forever. Calling drawingsApi.deleteDrawing/undo/redo/
   * addDrawing through that frozen, ancient reference meant every one
   * of those operations was working against however the underlying
   * drawings/history state looked at that very first render (most
   * likely still empty, before anything had even loaded) - not
   * whatever's actually on screen now. That's exactly why "delete this
   * one drawing" wiped everything, "undo" did too, and ALT+H/ALT+V's
   * addDrawing calls never visibly landed anywhere. The right-click
   * context menu's own delete button was never affected, because it's
   * a completely ordinary React onClick - a fresh closure every render,
   * never frozen the way this listener was.
   *
   * Refs updated on every render (not inside an effect - a plain
   * assignment during render is the established, correct way to do
   * this, see useTradingStream.ts's handlerRef for the same pattern
   * already in use elsewhere) mean the listener always reads whatever
   * is actually current at the moment a key is pressed, regardless of
   * how long ago the listener itself was originally created.
   */
  const drawingsApiRef = useRef(drawingsApi);
  drawingsApiRef.current = drawingsApi;

  const priceAlertsApiRef = useRef(priceAlertsApi);
  priceAlertsApiRef.current = priceAlertsApi;

  const tradeMenuApiRef = useRef(tradeMenuApi);
  tradeMenuApiRef.current = tradeMenuApi;

  const chartTabsApiRef = useRef(chartTabsApi);
  chartTabsApiRef.current = chartTabsApi;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const drawingsApi = drawingsApiRef.current;
      const priceAlertsApi = priceAlertsApiRef.current;
      const tradeMenuApi = tradeMenuApiRef.current;
      const chartTabsApi = chartTabsApiRef.current;

      // Never hijack normal clipboard/editing shortcuts while typing.
      if (isEditableTarget(event.target)) return;

      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        event.code === "KeyW"
      ) {
        // Chromium reserves Ctrl+W for the browser itself, so Alt+W is
        // the reliable in-app equivalent. Consume it only when another symbol
        // tab exists; the final chart tab keeps the existing invariant that the
        // workspace always has at least one active symbol.
        if (chartTabsApi.tabs.length > 1) {
          event.preventDefault();
          event.stopPropagation();
          chartTabsApi.closeActiveTab();
        }
        return;
      }

      if (event.ctrlKey && !event.shiftKey && event.code === "KeyC") {
        const selectedId = refs.selectedIdRef.current;
        if (!selectedId) return;

        const selected = refs.drawingsRef.current.find((drawing) => drawing.id === selectedId);

        // Binance order lines are operational UI, not copyable drawings.
        if (!selected || isOrderDrawing(selected)) return;

        event.preventDefault();
        copiedDrawingRef.current = cloneDrawing(selected);
        return;
      }

      if (event.ctrlKey && !event.shiftKey && event.code === "KeyV") {
        const copied = copiedDrawingRef.current;
        if (!copied) return;

        event.preventDefault();

        const duplicate = offsetDrawing(copied, refs);
        drawingsApi.addDrawing(duplicate);

        // Repeated Ctrl+V keeps stepping copies diagonally instead of stacking
        // every pasted drawing on the exact same offset.
        copiedDrawingRef.current = cloneDrawing(duplicate);
        return;
      }

      if (event.ctrlKey && !event.shiftKey && event.code === "KeyZ") {
        event.preventDefault();

        /*
         * Drawings and price alerts each keep their own independent
         * undo/redo stack, but every entry in both is stamped with the
         * SAME shared, monotonically increasing refs.historySeqRef
         * counter (see the comment on HistoryAction in
         * types/drawing.ts) - so comparing the `seq` of whichever
         * action currently sits on top of each stack tells us which of
         * the two systems' actions actually happened most recently.
         * That's the one Ctrl+Z should undo, regardless of which
         * system it belongs to - a chart-wide "undo my last action",
         * not "undo my last drawing edit specifically".
         */
        const drawingTop = refs.undoRef.current[refs.undoRef.current.length - 1];
        const alertTop = refs.alertUndoRef.current[refs.alertUndoRef.current.length - 1];

        if (!drawingTop && !alertTop) return;

        if (alertTop && (!drawingTop || alertTop.seq > drawingTop.seq)) {
          priceAlertsApi.undo();
        } else {
          drawingsApi.undo();
        }

        return;
      }

      if (
        (event.ctrlKey && event.code === "KeyY") ||
        (event.ctrlKey && event.shiftKey && event.code === "KeyZ")
      ) {
        event.preventDefault();

        /*
         * Same shared-seq comparison as undo above, but the SMALLER
         * seq among the two redo-stack tops is the one to redo first.
         * Reasoning: undo always pops the larger-seq (more recent)
         * action first across the two stacks, so as a sequence of
         * undos progresses, each newly-undone action's seq is
         * necessarily <= the previous one's. That means whichever redo
         * stack currently has the SMALLEST-seq top holds the action
         * that was undone MOST RECENTLY - exactly the one Ctrl+Y
         * should bring back first.
         */
        const drawingTop = refs.redoRef.current[refs.redoRef.current.length - 1];
        const alertTop = refs.alertRedoRef.current[refs.alertRedoRef.current.length - 1];

        if (!drawingTop && !alertTop) return;

        if (alertTop && (!drawingTop || alertTop.seq < drawingTop.seq)) {
          priceAlertsApi.redo();
        } else {
          drawingsApi.redo();
        }

        return;
      }

      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        (event.code === "ArrowLeft" || event.code === "ArrowRight")
      ) {
        // Alt+Left/Right normally triggers browser history navigation.
        // In the terminal it instead cycles through the currently open
        // chart tabs, wrapping at either end.
        event.preventDefault();
        event.stopPropagation();
        chartTabsApi.activateAdjacentTab(event.code === "ArrowLeft" ? "previous" : "next");
        return;
      }

      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        event.code === "KeyG"
      ) {
        // Alt+G toggles a persistent canvas-level multi-selection
        // mode. Membership lives in refs so the paced renderer and pointer
        // handlers observe it immediately; normal single selection is cleared
        // to avoid two competing selection models being active at once.
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        drawingsApi.setTool(refs.toolRef.current === "group-select" ? "cursor" : "group-select");
        drawingsApi.setSelectedId(null);
        drawingsApi.setContextMenu(null);
        return;
      }

      if (event.altKey && event.code === "KeyV") {
        event.preventDefault();

        const time = refs.currentTimeRef.current;

        if (time === null) return;

        drawingsApi.addDrawing({
          id: crypto.randomUUID(),
          type: "vertical",
          time,
          color: DEFAULT_LINE_COLOR,
        });

        return;
      }

      if (event.altKey && event.code === "KeyH") {
        event.preventDefault();

        const price = refs.currentPriceRef.current;

        if (price === null) return;

        drawingsApi.addDrawing({
          id: crypto.randomUUID(),
          type: "horizontal",
          price,
          color: DEFAULT_LINE_COLOR,
        });

        return;
      }

      if (event.altKey && event.code === "KeyC") {
        event.preventDefault();

        const time = refs.currentTimeRef.current;
        const price = refs.currentPriceRef.current;

        if (time === null || price === null) return;

        const start = { time, price };

        drawingsApi.addDrawing({
          id: crypto.randomUUID(),
          type: "text",
          start,
          end: defaultTextEnd(start, refs),
          text: "text here...",
          color: DEFAULT_LINE_COLOR,
        });

        drawingsApi.setTool("cursor");
        return;
      }

      if (event.altKey && event.code === "KeyT") {
        event.preventDefault();
        drawingsApi.setTool("trend");
        return;
      }

      if (event.altKey && event.code === "KeyN") {
        event.preventDefault();
        drawingsApi.setTool("pen");
        return;
      }

      if (event.altKey && event.code === "KeyB") {
        event.preventDefault();
        drawingsApi.setTool("box");
        return;
      }

      if (event.altKey && event.code === "KeyR") {
        event.preventDefault();
        drawingsApi.setTool(refs.toolRef.current === "ruler" ? "cursor" : "ruler");
        return;
      }

      if (event.code === "Escape") {
        if (refs.penDraftRef.current) {
          const penId = refs.penDraftRef.current.id;
          refs.penDraftRef.current = null;
          drawingsApi.syncDrawings(
            refs.drawingsRef.current.filter((drawing) => drawing.id !== penId),
          );
        }

        drawingsApi.setTool("cursor");
        drawingsApi.setSelectedId(null);
        drawingsApi.setContextMenu(null);
        tradeMenuApi.setTradeMenu(null);

        // Escape outside an active group move exits Alt+G mode and
        // clears its visual selection, restoring ordinary drawing behavior.
        refs.groupSelectionModeRef.current = false;
        refs.groupSelectedIdsRef.current.clear();
      }

      if (
        (event.code === "Delete" || event.code === "Backspace") &&
        refs.groupSelectionModeRef.current &&
        refs.groupSelectedIdsRef.current.size > 0
      ) {
        // group deletion removes only user drawings (never Binance
        // order lines) and records each removal in the existing history stack.
        event.preventDefault();
        event.stopPropagation();
        const selectedIds = new Set(refs.groupSelectedIdsRef.current);
        const deleted = refs.drawingsRef.current.filter(
          (drawing) => selectedIds.has(drawing.id) && !isOrderDrawing(drawing),
        );

        if (deleted.length > 0) {
          drawingsApi.syncDrawings(
            refs.drawingsRef.current.filter(
              (drawing) => !deleted.some((item) => item.id === drawing.id),
            ),
          );
          deleted.forEach((drawing) =>
            drawingsApi.pushHistory({
              type: "delete",
              drawing: cloneDrawing(drawing),
            }),
          );
        }

        refs.groupSelectedIdsRef.current.clear();
        return;
      }

      if (event.code === "Delete" && refs.selectedIdRef.current) {
        event.preventDefault();
        drawingsApi.deleteDrawing(refs.selectedIdRef.current);
      }
    };

    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
