import { useRef } from "react";
import type {
  IChartApi,
  ISeriesApi,
  CandlestickData,
  UTCTimestamp,
  IPriceLine,
} from "lightweight-charts";
import type { Interval } from "../config/constants";
import type {
  ChartPoint,
  DragState,
  Drawing,
  DrawingTool,
  HistoryAction,
  PenDrawing,
} from "../types/drawing";
import type { TradeMarker } from "../trading/types";
import type { AlertHistoryAction } from "../types/alert";

/**
 * Every ref used across the chart + drawing engine lives here, created
 * once per <App /> mount. Keeping them in a single bag (rather than
 * scattered per-hook) is what lets useCoordinateMapping, useDrawings,
 * useDrawingCanvas, useChartInstance and useMarketData all read/write
 * the same underlying values without prop-drilling every single ref
 * individually.
 */
export function useChartRefs() {
  const chartWrapRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartReadyRef = useRef(false);

  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const futureScaleRef = useRef<ISeriesApi<"Line"> | null>(null);

  const mousePriceLineRef = useRef<IPriceLine | null>(null);
  const livePriceLineRef = useRef<IPriceLine | null>(null);

  const currentTimeRef = useRef<UTCTimestamp | null>(null);

  const currentPriceRef = useRef<number | null>(null);

  const liveMarketPriceRef = useRef<number | null>(null);

  const lastCandleRef = useRef<CandlestickData | null>(null);

  const loadedCandlesRef = useRef<CandlestickData[]>([]);

  const lastDataTimeRef = useRef<UTCTimestamp | null>(null);
  const lastLogicalIndexRef = useRef<number>(0);

  /**
   * Bookkeeping for scroll-triggered history backfill (see
   * useMarketData.ts's backfillOlderCandles) - bundled into one ref
   * since both flags are always read/written together right next to
   * each other. `isLoading` guards against firing a second backfill
   * request while one's already in flight (subscribeVisibleLogicalRangeChange
   * fires on every frame of a scroll/zoom gesture, not once); `hasMore`
   * latches false once a request comes back with fewer candles than
   * asked for (or empty) - i.e. this symbol/interval's history has been
   * exhausted - so no further requests are attempted after that.
   */
  const historyBackfillRef = useRef<{ isLoading: boolean; hasMore: boolean }>({
    isLoading: false,
    hasMore: true,
  });

  const intervalRef = useRef<Interval>("1m");

  const pendingVisibleRangeRef = useRef<{
    from: UTCTimestamp;
    to: UTCTimestamp;
  } | null>(null);

  const selectedIdRef = useRef<string | null>(null);
  // FEATURE: Alt+G group selection is intentionally ref-backed because the
  // canvas render/hit-test loops are long-lived and must see membership
  // changes immediately without relying on a React render closure.
  const groupSelectionModeRef = useRef(false);
  const groupSelectedIdsRef = useRef<Set<string>>(new Set());
  const groupSelectionBoxRef = useRef<{
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | null>(null);
  const highlightedOrderIdRef = useRef<string | null>(null);
  const highlightedOrderUntilRef = useRef(0);

  /*
   * Set by App.tsx's focusPosition whenever a row in the Positions tab
   * (as opposed to Open Orders) is clicked. Blinks the entry line and
   * whichever TP/SL zones currently exist together, since a position
   * (unlike an order) has no single Binance orderId to match against.
   *
   * FIX: highlightedPositionUntilRef alone used to be the ONLY signal
   * PositionBracketOverlay checked - a bare timestamp with no idea WHICH
   * position it referred to. Since the Open Orders/Positions panel is
   * now account-wide (can show positions across several symbols at
   * once), clicking ANY position row - for ANY symbol - lit up whichever
   * chart happened to be on screen, regardless of whether that chart's
   * symbol had anything to do with the row that was clicked.
   * highlightedPositionKeyRef carries WHICH position ("SYMBOL-SIDE") was
   * actually clicked, so PositionBracketOverlay can compare it against
   * its OWN position instead of reacting to every click unconditionally.
   */
  const highlightedPositionUntilRef = useRef(0);
  const highlightedPositionKeyRef = useRef<string | null>(null);

  const toolRef = useRef<DrawingTool>("cursor");

  const undoRef = useRef<HistoryAction[]>([]);
  const redoRef = useRef<HistoryAction[]>([]);

  /**
   * Shared, monotonically increasing counter stamped onto every
   * drawing history action (useDrawings.ts's pushHistory) AND every
   * price-alert history action (usePriceAlerts.ts's pushAlertHistory).
   * Comparing these `seq` numbers across the two otherwise-independent
   * undo/redo stacks below is what lets Ctrl+Z/Ctrl+Y (useHotkeys.ts)
   * always act on whichever action - a drawing edit or an alert edit -
   * actually happened most recently.
   */
  const historySeqRef = useRef(0);

  const alertUndoRef = useRef<AlertHistoryAction[]>([]);
  const alertRedoRef = useRef<AlertHistoryAction[]>([]);

  const dragRef = useRef<DragState | null>(null);
  const penDraftRef = useRef<PenDrawing | null>(null);
  const pendingStartRef = useRef<ChartPoint | null>(null);
  const previewPointRef = useRef<ChartPoint | null>(null);
  const rulerStartRef = useRef<ChartPoint | null>(null);
  const rulerEndRef = useRef<ChartPoint | null>(null);

  const animationFrameRef = useRef<number | null>(null);

  const epochRef = useRef(0);

  const drawingsRef = useRef<Drawing[]>([]);

  const tradeMarkersRef = useRef<TradeMarker[]>([]);

  return {
    chartWrapRef,
    containerRef,
    canvasRef,
    chartReadyRef,
    chartRef,
    candleRef,
    futureScaleRef,
    mousePriceLineRef,
    livePriceLineRef,
    currentTimeRef,
    currentPriceRef,
    liveMarketPriceRef,
    lastCandleRef,
    loadedCandlesRef,
    lastDataTimeRef,
    lastLogicalIndexRef,
    historyBackfillRef,
    intervalRef,
    pendingVisibleRangeRef,
    selectedIdRef,
    groupSelectionModeRef,
    groupSelectedIdsRef,
    groupSelectionBoxRef,
    highlightedOrderIdRef,
    highlightedOrderUntilRef,
    highlightedPositionUntilRef,
    highlightedPositionKeyRef,
    toolRef,
    undoRef,
    redoRef,
    historySeqRef,
    alertUndoRef,
    alertRedoRef,
    dragRef,
    penDraftRef,
    pendingStartRef,
    previewPointRef,
    rulerStartRef,
    rulerEndRef,
    animationFrameRef,
    epochRef,
    drawingsRef,
    tradeMarkersRef,
  };
}

export type ChartRefs = ReturnType<typeof useChartRefs>;
