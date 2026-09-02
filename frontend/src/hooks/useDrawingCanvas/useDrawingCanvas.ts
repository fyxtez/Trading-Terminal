import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { UTCTimestamp } from "lightweight-charts";
import {
  DEFAULT_BOX_COLOR,
  DEFAULT_LINE_COLOR,
} from "../../config/constants";
import { cloneDrawing, getTextFontSize } from "../../utils/drawings";
import { startPacedLoop } from "../../utils/pacedLoop";
import type {
  ContextMenuState,
  DragState,
  Drawing,
  HorizontalDrawing,
  PenDrawing,
  ScreenPoint,
  TextDrawing,
} from "../../types/drawing";
import {
  cancelOrder,
  chaseLimitOrder,
  updateReduceOrder,
} from "../../trading/api/orders";
import { isStaleOrderError } from "../../trading/errors";
import type { ChartRefs } from "../useChartRefs";
import type { CoordinateMapping } from "../useCoordinateMapping";
import type { DrawingsApi } from "../useDrawings";
import type { MarketDataApi } from "../useMarketData";
import type { TradeMenuApi } from "../useTradeMenu";
import {
  clampToEditablePane,
  getTextRect,
  isOrderDrawing,
  type BoxHandleMode,
} from "./drawingGeometry";
import {
  REDUCE_ORDER_EDITOR_GAP,
  REDUCE_ORDER_EDITOR_HEIGHT,
  REDUCE_ORDER_EDITOR_WIDTH,
  findPendingOrderControlHit,
  getPendingOrderRects as buildPendingOrderRects,
} from "./pendingOrderLayout";
import type { EditingTextState, ReduceOrderEditorState } from "./types";
import { drawCanvasFrame } from "./canvasRenderer";
import { useArmedDrawingInteractions } from "./useArmedDrawingInteractions";

/**
 * Binance order lines (pending limit entries/adds/reduces) already get
 * their own hover UX - the cancel/chase tooltips handled elsewhere in
 * this file. The hover-info popup (see hoveredDrawingInfo below) is only
 * for drawings the user actually drew themselves, so it doesn't pile up
 * on top of that existing UI.
 */
/** How long the mouse has to sit still over a drawing before the info popup appears. */
const HOVER_INFO_DELAY_MS = 500;

/**
 * Everything that happens directly on the canvas overlay: the
 * paced render loop, all pointer-down/move/up capture
 * handling for creating/dragging/selecting drawings, the right-click
 * context menu trigger, and the double-click trade-ticket trigger.
 */
export function useDrawingCanvas(
  refs: ChartRefs,
  coord: CoordinateMapping,
  drawingsApi: DrawingsApi,
  marketData: MarketDataApi,
  tradeMenuApi: TradeMenuApi,
  isHotkeysOpen: boolean,
  setIsHotkeysOpen: (open: boolean) => void,
  showDrawings: boolean,
) {
  const [isHoveringDrawing, setIsHoveringDrawing] = useState(false);
  const [editingText, setEditingText] = useState<EditingTextState | null>(null);
  const editingTextRef = useRef<typeof editingText>(null);
  // FIX: the canvas paint loop is intentionally mounted once, so mirror this
  // setting in a ref to let that long-lived loop see visibility changes.
  const showDrawingsRef = useRef(showDrawings);

  useEffect(() => {
    editingTextRef.current = editingText;
  }, [editingText]);

  useEffect(() => {
    showDrawingsRef.current = showDrawings;
  }, [showDrawings]);

  /*
   * FEATURE (limit-cancel feedback): keep order ids here while their Binance
   * cancel request is in flight. The paced canvas loop is mounted once, so a
   * ref (rather than React state captured by that old closure) lets the line
   * dim immediately on the very next paint frame without waiting for a render.
   */
  const cancellingOrderIdsRef = useRef<Set<string>>(new Set());

  // FIX: hidden user drawings must be completely inert, not merely invisible.
  // Keep exchange order drawings interactive because "Show drawings" is only a
  // preference for user annotations; TP/reduce/order controls intentionally stay on.
  // FEATURE: a dimmed order is temporarily non-interactive while cancel is pending,
  // preventing duplicate cancel/chase/reprice actions against the same Binance order.
  const isDrawingInteractive = (drawing: Drawing) =>
    !cancellingOrderIdsRef.current.has(drawing.id) &&
    (showDrawings || isOrderDrawing(drawing));

  // Whether the currently-hovered drawing is specifically a horizontal
  // (price) line - order lines, or a plain horizontal drawing. Tracked
  // separately from isHoveringDrawing so the chart can show the same
  // ns-resize cursor over these that the stop-loss line already uses
  // (dragging either one is a purely vertical price move), while other
  // drawing types (trend, box, pen, vertical) keep the generic pointer
  // cursor.
  const [isHoveringHorizontalDrawing, setIsHoveringHorizontalDrawing] =
    useState(false);

  // Position (wrap-relative) of the "Cancel order" tooltip shown while
  // hovering a pending order's cancel button; null when not hovering one.
  const [cancelTooltip, setCancelTooltip] = useState<ScreenPoint | null>(null);
  const [chaseTooltip, setChaseTooltip] = useState<ScreenPoint | null>(null);
  // FEATURE: the projected liquidation value is not an actual Binance position
  // liquidation yet, so hovering its label explains exactly what the preview means.
  const [estimatedLiquidationTooltip, setEstimatedLiquidationTooltip] =
    useState<ScreenPoint | null>(null);

  /*
   * FEATURE: clicking the visible TP percentage on a reduce-order label opens
   * a compact chart-local editor. This intentionally reuses the SAME backend
   * reduce-order endpoint as Open Orders, so changing size from the chart and
   * changing it from the table can never drift into two separate behaviors.
   */
  const [reduceOrderEditor, setReduceOrderEditor] =
    useState<ReduceOrderEditorState | null>(null);
  // FIX: the canvas paint loop is mounted once, so it cannot safely read the
  // latest React editor state from its original closure. Mirror the editor in a
  // ref so its DOM popover can continuously follow the TP line while the chart
  // pans, zooms or resizes.
  const reduceOrderEditorRef = useRef<typeof reduceOrderEditor>(null);

  useEffect(() => {
    reduceOrderEditorRef.current = reduceOrderEditor;
  }, [reduceOrderEditor]);

  /*
   * The "hover a drawing for a moment to see its info" popup (currently
   * just the timeframe it was drawn on - see DrawingInfoTooltip.tsx).
   * `point` tracks the current mouse position so the popup keeps
   * following the cursor while it stays over the same drawing, but only
   * gets set (making the popup visible) after HOVER_INFO_DELAY_MS of
   * continuous hover over that one drawing - see the timer logic in
   * handlePointerMoveCapture below.
   */
  const [hoveredDrawingInfo, setHoveredDrawingInfo] = useState<{
    drawing: Drawing;
    point: ScreenPoint;
  } | null>(null);
  const hoverInfoTimerRef = useRef<number | null>(null);
  const hoverInfoDrawingIdRef = useRef<string | null>(null);

  const clearHoverInfoTimer = () => {
    if (hoverInfoTimerRef.current !== null) {
      window.clearTimeout(hoverInfoTimerRef.current);
      hoverInfoTimerRef.current = null;
    }
  };

  const clearHoveredDrawingInfo = () => {
    hoverInfoDrawingIdRef.current = null;
    clearHoverInfoTimer();
    setHoveredDrawingInfo(null);
  };

  useEffect(() => {
    if (showDrawings) return;

    // FIX: turning drawings off while one is hovered used to leave the hover
    // cursor/timeframe tooltip alive until the mouse moved again. Clear that
    // transient interaction state immediately so hidden annotations behave locked.
    setIsHoveringDrawing(false);
    setIsHoveringHorizontalDrawing(false);
    clearHoveredDrawingInfo();
  }, [showDrawings]);

  useEffect(() => clearHoverInfoTimer, []);

  const {
    armedGroupMove,
    setArmedGroupMove,
    setIsGroupMarqueeActive,
    armedOrderLineId,
    armedTrendEndpoint,
    armedTrendMove,
    armedBoxHandle,
    armOrderLineMove,
    armTrendEndpointMove,
    armTrendMove,
    armBoxHandleMove,
    submitOrderLineMove,
  } = useArmedDrawingInteractions(
    refs,
    coord,
    drawingsApi,
    marketData,
    tradeMenuApi,
  );

  const getLocalPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const wrap = refs.chartWrapRef.current;

    if (!wrap) return null;

    const rect = wrap.getBoundingClientRect();

    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const getPendingOrderRects = (drawing: HorizontalDrawing) =>
    buildPendingOrderRects(
      drawing,
      refs,
      marketData.pricePrecisionRef.current,
    );

  const findPendingOrderControl = (
    control: Parameters<typeof findPendingOrderControlHit>[3],
    x: number,
    y: number,
  ) =>
    findPendingOrderControlHit(
      refs.drawingsRef.current,
      cancellingOrderIdsRef.current,
      getPendingOrderRects,
      control,
      x,
      y,
    );

  const findPendingOrderCancelHit = (x: number, y: number) =>
    findPendingOrderControl("cancel", x, y);
  const findPendingOrderEstimatedLiquidationHit = (x: number, y: number) =>
    findPendingOrderControl("estimated", x, y);
  const findPendingOrderEstimatedLiquidationHideHit = (
    x: number,
    y: number,
  ) => findPendingOrderControl("estimatedHide", x, y);
  const findPendingReduceOrderEditHit = (x: number, y: number) =>
    findPendingOrderControl("edit", x, y);
  const findPendingOrderChaseHit = (x: number, y: number) =>
    findPendingOrderControl("chase", x, y);

  const beginTextEditing = (drawing: TextDrawing) => {
    const rawRect = getTextRect(drawing, coord);
    if (!rawRect) return;
    const rect = clampToEditablePane(rawRect, refs);
    const nextEditor = {
      drawingId: drawing.id,
      value: drawing.text,
      ...rect,
      fontSize: getTextFontSize(rect.width, rect.height, drawing.text),
      color: drawing.color,
      align: drawing.align ?? "left",
    };
    editingTextRef.current = nextEditor;
    setEditingText(nextEditor);
    drawingsApi.setSelectedId(drawing.id);
    drawingsApi.setContextMenu(null);
  };

  const commitTextEditing = () => {
    const editor = editingTextRef.current;
    if (!editor) return;
    const current = refs.drawingsRef.current.find((drawing) => drawing.id === editor.drawingId);
    editingTextRef.current = null;
    setEditingText(null);
    if (!current || current.type !== "text" || current.text === editor.value) return;
    drawingsApi.updateDrawing(current.id, (drawing) =>
      drawing.type === "text" ? { ...drawing, text: editor.value || "text here..." } : drawing,
    );
  };

  const cancelTextEditing = () => {
    editingTextRef.current = null;
    setEditingText(null);
  };

  const drawCanvas = () =>
    drawCanvasFrame({
      refs,
      coord,
      pricePrecision: marketData.pricePrecisionRef.current,
      showDrawings: showDrawingsRef.current,
      cancellingOrderIds: cancellingOrderIdsRef.current,
      reduceOrderEditorRef,
      setReduceOrderEditor,
      editingTextRef,
      setEditingText,
    });

  useEffect(() => {
    // The drawing layer used to repaint at the monitor refresh rate even when
    // absolutely nothing changed. A bounded 20 FPS cadence stays smooth for
    // pointer interactions while avoiding a permanent 60/100/240 FPS canvas
    // workload on high-refresh multi-monitor setups.
    return startPacedLoop(drawCanvas);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const closeReduceOrderEditor = () => {
    // FIX: clear the live ref at the same time as React state; otherwise the
    // long-lived canvas loop could see one stale frame and re-anchor an editor
    // that the user had just closed.
    reduceOrderEditorRef.current = null;
    setReduceOrderEditor(null);
  };

  const setReduceOrderEditorPct = (reducePct: number) => {
    const clamped = Math.max(1, Math.min(100, Math.round(reducePct)));
    setReduceOrderEditor((current) => {
      if (!current) return current;
      const next = { ...current, reducePct: clamped };
      reduceOrderEditorRef.current = next;
      return next;
    });
  };

  const submitReduceOrderEditor = () => {
    const editor = reduceOrderEditor;
    if (!editor || editor.isSubmitting) return;

    const drawing = refs.drawingsRef.current.find(
      (candidate) => candidate.id === editor.drawingId,
    );

    if (
      !drawing ||
      drawing.type !== "horizontal" ||
      drawing.orderIntent !== "REDUCE" ||
      !drawing.orderId ||
      !drawing.orderSymbol
    ) {
      closeReduceOrderEditor();
      tradeMenuApi.setTradeToast({
        kind: "error",
        message: "This take-profit order is no longer available to edit.",
      });
      window.dispatchEvent(new Event("orders-state-changed"));
      return;
    }

    setReduceOrderEditor((current) => {
      if (!current) return current;
      const next = { ...current, isSubmitting: true };
      reduceOrderEditorRef.current = next;
      return next;
    });
    tradeMenuApi.setTradeToast({
      kind: "success",
      message: `Updating take profit to ${editor.reducePct}%…`,
    });

    void updateReduceOrder(
      drawing.orderSymbol,
      drawing.orderId,
      editor.reducePct,
    )
      .then((result) => {
        /*
         * FEATURE: the reduce update endpoint replaces the live Binance limit
         * order and can therefore return a new order id/client id. Mirror every
         * returned field onto the existing chart drawing immediately; the normal
         * Open Orders refresh remains authoritative and will reconcile afterward.
         */
        drawingsApi.replaceDrawingWithoutHistory(drawing.id, {
          ...drawing,
          orderId:
            typeof result.order?.orderId === "string"
              ? result.order.orderId
              : drawing.orderId,
          clientOrderId: result.order?.clientOrderId ?? drawing.clientOrderId,
          orderQuantity: result.submitted_quantity,
          orderReducePct: result.reduce_pct,
          orderRemainingPct: result.remaining_position_pct,
        });

        reduceOrderEditorRef.current = null;
        setReduceOrderEditor(null);
        window.dispatchEvent(new Event("orders-state-changed"));

        const requested = result.requested_reduce_pct;
        const actual = result.reduce_pct;
        const wasBumped =
          requested !== undefined && Math.round(requested) !== Math.round(actual);

        tradeMenuApi.setTradeToast({
          kind: "success",
          message: wasBumped
            ? `Exchange minimum adjusted TP from ${Math.round(requested!)}% to ${Math.round(actual)}%`
            : `Take profit updated to ${Math.round(actual)}%`,
        });
      })
      .catch((error: unknown) => {
        setReduceOrderEditor((current) => {
          if (!current) return current;
          const next = { ...current, isSubmitting: false };
          reduceOrderEditorRef.current = next;
          return next;
        });
        window.dispatchEvent(new Event("orders-state-changed"));
        tradeMenuApi.setTradeToast({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Failed to update take-profit size",
        });
      });
  };

  const handlePointerDownCapture = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;

    /*
     * FIX: this handler runs in the CAPTURE phase on the whole chart-wrap
     * div, which means it fires before a real DOM button layered on top
     * of the chart (the toolbar-reveal button, the candle-countdown
     * badge) ever gets its own click event. Every branch below does pure
     * screen-coordinate hit-testing against drawings with no regard for
     * what's actually under the cursor, so a box/trend drawing sitting
     * at the same coordinates as one of those buttons would get
     * selected here AND (since most branches call stopPropagation) the
     * button's own click would never fire at all - it looked like the
     * button "wasn't clickable" whenever a drawing happened to be behind
     * it. Bailing out immediately for any real button element sidesteps
     * that: the click just proceeds normally to whatever button it
     * actually landed on, and none of the chart's own hit-testing runs.
     */
    if (event.target instanceof HTMLElement && event.target.closest("button, input, textarea, .chart-text-editor")) {
      return;
    }

    if (armedOrderLineId) return;
    if (armedTrendEndpoint) return;
    if (armedTrendMove) return;
    if (armedGroupMove) return;
    if (armedBoxHandle) return;

    const local = getLocalPointer(event);

    if (!local) return;

    /*
     * FIX: a box/trend drawing's own rectangle can visually extend past
     * the plot area into the price-scale gutter on the right (or the
     * time-scale gutter at the bottom) - lightweight-charts reserves
     * that space for its own axis labels, but nothing here was ever
     * checking whether a click actually landed inside the real plot
     * area before hit-testing it against drawings. So clicking directly
     * on a price label that happened to have a drawing rendered behind
     * it moved/selected that drawing instead of doing nothing - same
     * bug shape as the button-click guard above, just for the chart's
     * own axis gutters instead of a DOM button. handleChartDoubleClick
     * below already has this exact same bounds check; this just applies
     * it here too.
     */
    const chart = refs.chartRef.current;

    if (chart) {
      const paneSize = chart.paneSize();

      if (
        local.x < 0 ||
        local.y < 0 ||
        local.x > paneSize.width ||
        local.y > paneSize.height
      ) {
        return;
      }
    }

    drawingsApi.setContextMenu(null);

    if (isHotkeysOpen) {
      setIsHotkeysOpen(false);
      return;
    }

    const chartPoint = coord.screenToChartPoint(local.x, local.y);

    if (!chartPoint) return;

    if (refs.toolRef.current === "ruler") {
      event.preventDefault();
      event.stopPropagation();

      // The ruler uses a click -> move -> click interaction. The first
      // click fixes the starting price/time and pointer movement previews the
      // measurement. The second click finishes the one-shot measurement and
      // immediately returns the chart to the default cursor/select tool.
      if (refs.rulerStartRef.current) {
        drawingsApi.setTool("cursor");
      } else {
        refs.rulerStartRef.current = { ...chartPoint };
        refs.rulerEndRef.current = { ...chartPoint };
      }

      return;
    }

    if (refs.toolRef.current === "pen") {
      event.preventDefault();
      event.stopPropagation();

      // See xToTime's comment on `continuous` - a pen stroke needs the
      // mouse's real sub-bar position, not "whichever candle is under the
      // cursor", or it starts choppy from its very first point.
      const startPoint =
        coord.screenToChartPoint(local.x, local.y, true) ?? chartPoint;

      const pen: PenDrawing = {
        id: crypto.randomUUID(),
        type: "pen",
        points: [{ ...startPoint }],
        color: DEFAULT_LINE_COLOR,
        // Pen drawings are added directly (not through drawingsApi.addDrawing,
        // which stamps this for every other drawing type) since the draft
        // needs to exist in refs.drawingsRef immediately, while still being
        // built up point-by-point, before it's ever pushed to history - so
        // it's stamped here instead.
        timeframe: refs.intervalRef.current,
      };

      refs.penDraftRef.current = pen;
      drawingsApi.syncDrawings([...refs.drawingsRef.current, pen]);
      drawingsApi.setSelectedId(pen.id);

      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    if (refs.toolRef.current === "text") {
      event.preventDefault();
      event.stopPropagation();

      // A single click only gives us one point (`chartPoint`, the
      // top-left corner). The opposite corner needs a REAL chart anchor
      // too now (see TextDrawing in types/drawing.ts), so pick a sane
      // default on-screen size, clamp it to stay inside the pane, and
      // convert THAT pixel position into a chart point via
      // screenToChartPoint - same idea as how the trend/box tools resolve
      // their second point, just derived instead of clicked.
      const paneSize = refs.chartRef.current?.paneSize();
      const defaultBoxWidth = 140;
      const defaultBoxHeight = 42;
      const endLocalX = paneSize
        ? Math.min(local.x + defaultBoxWidth, paneSize.width - 4)
        : local.x + defaultBoxWidth;
      const endLocalY = paneSize
        ? Math.min(local.y + defaultBoxHeight, paneSize.height - 4)
        : local.y + defaultBoxHeight;

      // Falls back to `chartPoint` (a zero-size box, later floored by
      // getTextRect's MIN_BOX_SIZE) only in the unlikely case the pane
      // can't resolve that pixel to a chart point at all.
      const endPoint = coord.screenToChartPoint(endLocalX, endLocalY) ?? chartPoint;

      const textDrawing: TextDrawing = {
        id: crypto.randomUUID(),
        type: "text",
        start: { ...chartPoint },
        end: { ...endPoint },
        text: "text here...",
        color: DEFAULT_LINE_COLOR,
      };
      drawingsApi.addDrawing(textDrawing);
      drawingsApi.setTool("cursor");
      beginTextEditing({ ...textDrawing, timeframe: refs.intervalRef.current });
      return;
    }

    if (refs.toolRef.current === "vertical") {
      event.preventDefault();
      event.stopPropagation();

      drawingsApi.addDrawing({
        id: crypto.randomUUID(),
        type: "vertical",
        time: chartPoint.time,
        color: DEFAULT_LINE_COLOR,
      });

      drawingsApi.setTool("cursor");
      return;
    }

    if (refs.toolRef.current === "horizontal") {
      event.preventDefault();
      event.stopPropagation();

      drawingsApi.addDrawing({
        id: crypto.randomUUID(),
        type: "horizontal",
        price: chartPoint.price,
        color: DEFAULT_LINE_COLOR,
      });

      drawingsApi.setTool("cursor");
      return;
    }

    if (refs.toolRef.current === "trend" || refs.toolRef.current === "box") {
      event.preventDefault();
      event.stopPropagation();

      if (!refs.pendingStartRef.current) {
        refs.pendingStartRef.current = chartPoint;
        refs.previewPointRef.current = chartPoint;
        return;
      }

      if (refs.toolRef.current === "trend") {
        drawingsApi.addDrawing({
          id: crypto.randomUUID(),
          type: "trend",
          start: {
            ...refs.pendingStartRef.current,
          },
          end: chartPoint,
          color: DEFAULT_LINE_COLOR,
        });
      } else {
        drawingsApi.addDrawing({
          id: crypto.randomUUID(),
          type: "box",
          start: {
            ...refs.pendingStartRef.current,
          },
          end: chartPoint,
          color: DEFAULT_BOX_COLOR,
        });
      }

      refs.pendingStartRef.current = null;
      refs.previewPointRef.current = null;

      drawingsApi.setTool("cursor");
      return;
    }

    const estimatedLiquidationHideHit =
      findPendingOrderEstimatedLiquidationHideHit(local.x, local.y);

    if (estimatedLiquidationHideHit) {
      event.preventDefault();
      event.stopPropagation();
      const drawing = estimatedLiquidationHideHit.drawing;

      // FEATURE: the eye toggle affects only the projected EST. LIQ geometry.
      // The original LIMIT line and its CHASE/X controls stay untouched.
      drawingsApi.replaceDrawingWithoutHistory(drawing.id, {
        ...drawing,
        estimatedLiquidationHidden: !drawing.estimatedLiquidationHidden,
      });
      return;
    }

    const reduceEditHit = findPendingReduceOrderEditHit(local.x, local.y);

    if (reduceEditHit) {
      event.preventDefault();
      event.stopPropagation();
      setCancelTooltip(null);
      setChaseTooltip(null);

      const { drawing, rects } = reduceEditHit;
      const editRect = rects.edit!;
      /*
       * FEATURE: TP-size editing now opens only from the dedicated EDIT button.
       * Seed the same smart/clamped anchor used by the live paint-loop sync so
       * the popover is correctly placed immediately on the first frame.
       */
      const pane = refs.chartRef.current?.paneSize();
      const paneWidth = pane?.width ?? refs.canvasRef.current?.width ?? 0;
      const paneHeight = pane?.height ?? refs.canvasRef.current?.height ?? 0;
      const preferredLeft =
        editRect.x + editRect.width - REDUCE_ORDER_EDITOR_WIDTH;
      const left = Math.max(
        8,
        Math.min(
          preferredLeft,
          Math.max(8, paneWidth - REDUCE_ORDER_EDITOR_WIDTH - 8),
        ),
      );
      const belowTop = editRect.y + editRect.height + REDUCE_ORDER_EDITOR_GAP;
      const aboveTop = editRect.y - REDUCE_ORDER_EDITOR_HEIGHT - REDUCE_ORDER_EDITOR_GAP;
      const top = Math.max(
        8,
        belowTop + REDUCE_ORDER_EDITOR_HEIGHT <= paneHeight - 8
          ? belowTop
          : Math.min(
              Math.max(8, aboveTop),
              Math.max(8, paneHeight - REDUCE_ORDER_EDITOR_HEIGHT - 8),
            ),
      );
      const nextEditor = {
        drawingId: drawing.id,
        left,
        top,
        reducePct: Math.max(
          1,
          Math.min(100, Math.round(drawing.orderReducePct ?? 100)),
        ),
        isSubmitting: false,
      };
      reduceOrderEditorRef.current = nextEditor;
      setReduceOrderEditor(nextEditor);
      return;
    }

    const chaseHit = findPendingOrderChaseHit(local.x, local.y);

    if (chaseHit) {
      event.preventDefault();
      event.stopPropagation();
      setCancelTooltip(null);
      setChaseTooltip(null);

      const drawing = chaseHit.drawing;

      if (
        drawing.orderId === undefined ||
        !drawing.orderSymbol ||
        !drawing.orderSide
      ) {
        tradeMenuApi.setTradeToast({
          kind: "error",
          message: "This order line has incomplete Binance metadata.",
        });
        return;
      }

      drawingsApi.replaceDrawingWithoutHistory(drawing.id, {
        ...drawing,
        orderChasing: true,
      });

      tradeMenuApi.setTradeToast({
        kind: "success",
        message: `Chasing ${drawing.orderSide === "BUY" ? "long" : "short"} limit to market…`,
      });

      void chaseLimitOrder(drawing.orderSymbol, drawing.orderId)
        .then((result) => {
          drawingsApi.deleteDrawing(drawing.id);
          tradeMenuApi.addMarketFillMarker(
            result.side,
            result.market_order,
            drawing.price,
          );
          window.dispatchEvent(new Event("trading-state-changed"));

          tradeMenuApi.setTradeToast({
            kind: "success",
            message: `${result.side === "BUY" ? "Long" : "Short"} limit chased to market`,
          });
        })
        .catch((error: unknown) => {
          drawingsApi.replaceDrawingWithoutHistory(drawing.id, {
            ...drawing,
            orderChasing: false,
          });

          tradeMenuApi.setTradeToast({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "Failed to chase limit order",
          });
        });

      return;
    }

    const cancelHit = findPendingOrderCancelHit(local.x, local.y);

    if (cancelHit) {
      event.preventDefault();
      event.stopPropagation();
      setCancelTooltip(null);

      const drawing = cancelHit.drawing;

      if (drawing.orderId === undefined || !drawing.orderSymbol) {
        tradeMenuApi.setTradeToast({
          kind: "error",
          message:
            "This order line has no Binance order ID. Recreate the order.",
        });
        return;
      }

      const label = drawing.orderSide === "BUY" ? "Long" : "Short";

      tradeMenuApi.setTradeToast({
        kind: "success",
        message: `Cancelling ${label.toLowerCase()} limit order…`,
      });

      /*
       * FEATURE (cancel-in-progress dimming): do not pretend the order is gone
       * before Binance confirms it. Mark it as cancelling immediately; the paced
       * canvas loop reads this ref and dims the full order UI on the next frame.
       * On success we remove it, and on a real failure we simply undim it.
       */
      cancellingOrderIdsRef.current.add(drawing.id);

      void cancelOrder(drawing.orderSymbol, drawing.orderId)
        .then(() => {
          /*
           * FIX (cancel dim flicker): the REST cancel can succeed before the
           * separate Open Orders snapshot has caught up. Removing the cancelling
           * marker here made a stale snapshot re-create the same line at full
           * opacity for a moment, producing the visible dim -> normal -> gone
           * flash. Keep a short-lived tombstone for the same drawing/order id so
           * any stale re-added copy stays dimmed and non-interactive until the
           * authoritative Open Orders refresh removes it.
           */
          drawingsApi.removeDrawingWithoutHistory(drawing.id);
          window.dispatchEvent(new Event("orders-state-changed"));

          window.setTimeout(() => {
            cancellingOrderIdsRef.current.delete(drawing.id);
          }, 15_000);

          tradeMenuApi.setTradeToast({
            kind: "success",
            message: `${label} limit order cancelled`,
          });
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error
              ? error.message
              : "Failed to cancel limit order";
          /*
           * FIX: this order can genuinely no longer exist on Binance by
           * the time Cancel is clicked (already filled, or already
           * replaced by a reprice/reduce-edit elsewhere) - same "-2013"/
           * "not found" family of stale-order responses already handled
           * in the reprice-reduce catch above, plus "-2011 Unknown order
           * sent" (Binance's other way of saying it doesn't recognize
           * this order id at all). Previously this always showed the raw
           * Binance text and left the now-stale drawing sitting on the
           * chart looking clickable - deleting it here and refreshing
           * Open Orders means the chart stops showing a "ghost" cancel
           * button for an order that's already gone, instead of only
           * fixing itself whenever the next unrelated refresh happens to
           * catch up.
           */
          const staleOrder = isStaleOrderError(message);

          // FEATURE: every completed request must clear the dimmed/pending marker.
          // A real failure leaves the order in place at normal opacity so it can
          // be retried; a stale-order response removes the ghost line entirely.
          cancellingOrderIdsRef.current.delete(drawing.id);

          if (staleOrder) {
            drawingsApi.removeDrawingWithoutHistory(drawing.id);
            window.dispatchEvent(new Event("orders-state-changed"));
          }

          tradeMenuApi.setTradeToast({
            kind: "error",
            message: staleOrder
              ? "This order no longer exists. Open Orders was refreshed."
              : message,
          });
        });

      return;
    }

    const hit = coord.findDrawingAt(local.x, local.y, isDrawingInteractive);

    if (refs.groupSelectionModeRef.current) {
      event.preventDefault();
      event.stopPropagation();

      const selectedIds = refs.groupSelectedIdsRef.current;
      // FEATURE: Shift+click is the explicit remove gesture. A plain click on
      // an already-selected member is reserved for picking up/moving the group,
      // so selection editing and group translation never fight over one click.
      if (hit && event.shiftKey && selectedIds.has(hit.id)) {
        selectedIds.delete(hit.id);
        return;
      }

      // Clicking any already-selected member picks up the entire group. The
      // next click drops it; no mouse button needs to remain pressed.
      if (hit && selectedIds.has(hit.id)) {
        const before = refs.drawingsRef.current
          .filter(
            (drawing) => selectedIds.has(drawing.id) && !isOrderDrawing(drawing),
          )
          .map((drawing) => cloneDrawing(drawing));
        if (before.length > 0) {
          setArmedGroupMove({ pointerStart: chartPoint, before });
        }
        return;
      }

      // FEATURE: a click anywhere else starts the dashed marquee. It uses
      // screen coordinates because selection is visual and must match exactly
      // what falls inside the rectangle at the current pan/zoom level.
      refs.groupSelectionBoxRef.current = {
        start: { ...local },
        end: { ...local },
      };
      setIsGroupMarqueeActive(true);
      return;
    }

    if (!hit) {
      drawingsApi.setSelectedId(null);
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (hit.type === "horizontal" && hit.orderSide !== undefined) {
      armOrderLineMove(hit);
      return;
    }

    drawingsApi.setSelectedId(hit.id);

    let dragMode:
      | "move"
      | "trend-start"
      | "trend-end"
      | "box-top-left"
      | "box-top-right"
      | "box-bottom-left"
      | "box-bottom-right"
      | "box-top"
      | "box-right"
      | "box-bottom"
      | "box-left"
      | "text-top-left"
      | "text-top"
      | "text-top-right"
      | "text-right"
      | "text-bottom-right"
      | "text-bottom"
      | "text-bottom-left"
      | "text-left" = "move";

    if (hit.type === "trend") {
      const startScreen = coord.chartPointToScreen(hit.start);
      const endScreen = coord.chartPointToScreen(hit.end);
      const handleThreshold = 12;

      if (
        startScreen &&
        Math.hypot(local.x - startScreen.x, local.y - startScreen.y) <=
          handleThreshold
      ) {
        dragMode = "trend-start";
      } else if (
        endScreen &&
        Math.hypot(local.x - endScreen.x, local.y - endScreen.y) <=
          handleThreshold
      ) {
        dragMode = "trend-end";
      }

      // FEATURE: endpoint edits and whole-line translation both use the same
      // click-move-click interaction; neither requires holding the button.
      if (dragMode === "trend-start" || dragMode === "trend-end") {
        armTrendEndpointMove(hit, dragMode === "trend-start" ? "start" : "end");
        return;
      }

      armTrendMove(hit, chartPoint);
      return;
    }

    if (hit.type === "box") {
      const startScreen = coord.chartPointToScreen(hit.start);
      const endScreen = coord.chartPointToScreen(hit.end);
      const handleThreshold = 12;

      if (startScreen && endScreen) {
        const left = Math.min(startScreen.x, endScreen.x);
        const right = Math.max(startScreen.x, endScreen.x);
        const top = Math.min(startScreen.y, endScreen.y);
        const bottom = Math.max(startScreen.y, endScreen.y);

        // Corners resize both dimensions (pivoting on the opposite
        // corner); edge midpoints resize only ONE dimension, keeping
        // the other two sides fixed - same split as Text's 8 handles
        // below. Corners are listed first so a click near an actual
        // corner always wins over the edge midpoint sitting right next
        // to it, rather than whichever happens to be first in the array.
        const handles: Array<{
          mode: BoxHandleMode;
          x: number;
          y: number;
        }> = [
          { mode: "box-top-left", x: left, y: top },
          { mode: "box-top-right", x: right, y: top },
          { mode: "box-bottom-left", x: left, y: bottom },
          { mode: "box-bottom-right", x: right, y: bottom },
          { mode: "box-top", x: (left + right) / 2, y: top },
          { mode: "box-right", x: right, y: (top + bottom) / 2 },
          { mode: "box-bottom", x: (left + right) / 2, y: bottom },
          { mode: "box-left", x: left, y: (top + bottom) / 2 },
        ];

        const handle = handles.find(
          (item) =>
            Math.hypot(local.x - item.x, local.y - item.y) <= handleThreshold,
        );

        // Same click-move-click flow as the trend-endpoint block above,
        // now covering all 8 box handles (this used to fall through to
        // dragMode + the ordinary press-and-hold drag path below, which
        // is also where the edge handles' "grabbing an edge doesn't
        // resize" bug lived before that was fixed separately - this is
        // the follow-up: stop holding the mouse down at all). A plain
        // whole-box move (grabbing the box body, not a handle) is
        // untouched and still uses the ordinary drag path below.
        if (handle) {
          armBoxHandleMove(hit, handle.mode);
          return;
        }
      }
    }

    if (hit.type === "text") {
      const rect = getTextRect(hit, coord);
      const handleThreshold = 12;
      if (rect) {
        const handles: Array<{ mode: DragState["mode"]; x: number; y: number }> = [
          { mode: "text-top-left", x: rect.left, y: rect.top },
          { mode: "text-top", x: rect.left + rect.width / 2, y: rect.top },
          { mode: "text-top-right", x: rect.left + rect.width, y: rect.top },
          { mode: "text-right", x: rect.left + rect.width, y: rect.top + rect.height / 2 },
          { mode: "text-bottom-right", x: rect.left + rect.width, y: rect.top + rect.height },
          { mode: "text-bottom", x: rect.left + rect.width / 2, y: rect.top + rect.height },
          { mode: "text-bottom-left", x: rect.left, y: rect.top + rect.height },
          { mode: "text-left", x: rect.left, y: rect.top + rect.height / 2 },
        ];
        const handle = handles.find((item) => Math.hypot(local.x - item.x, local.y - item.y) <= handleThreshold);
        if (handle) dragMode = handle.mode;
      }
    }

    refs.dragRef.current = {
      drawingId: hit.id,
      before: cloneDrawing(hit),
      pointerStart: chartPoint,
      mode: dragMode,
    };

    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMoveCapture = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const local = getLocalPointer(event);

    if (!local) return;

    if (
      refs.toolRef.current === "cursor" &&
      !refs.dragRef.current &&
      !refs.penDraftRef.current &&
      !armedOrderLineId
    ) {
      const estimateHit =
        findPendingOrderEstimatedLiquidationHit(local.x, local.y);
      const estimateHideHit =
        findPendingOrderEstimatedLiquidationHideHit(local.x, local.y);
      const chaseHit = findPendingOrderChaseHit(local.x, local.y);
      const cancelHit = findPendingOrderCancelHit(local.x, local.y);

      if (estimateHit?.rects.estimated) {
        setIsHoveringDrawing(true);
        setIsHoveringHorizontalDrawing(false);
        setCancelTooltip(null);
        setChaseTooltip(null);
        setEstimatedLiquidationTooltip({
          x:
            estimateHit.rects.estimated.x +
            estimateHit.rects.estimated.width / 2,
          y: estimateHit.rects.estimated.y,
        });
        clearHoveredDrawingInfo();
      } else if (estimateHideHit) {
        setIsHoveringDrawing(true);
        setIsHoveringHorizontalDrawing(false);
        setCancelTooltip(null);
        setChaseTooltip(null);
        setEstimatedLiquidationTooltip(null);
        clearHoveredDrawingInfo();
      } else if (chaseHit?.rects.chase) {
        setIsHoveringDrawing(true);
        setIsHoveringHorizontalDrawing(false);
        setCancelTooltip(null);
        setEstimatedLiquidationTooltip(null);
        setChaseTooltip({
          x: chaseHit.rects.chase.x + chaseHit.rects.chase.width / 2,
          y: chaseHit.rects.chase.y,
        });
        clearHoveredDrawingInfo();
      } else if (cancelHit) {
        setIsHoveringDrawing(true);
        setIsHoveringHorizontalDrawing(false);
        setChaseTooltip(null);
        setEstimatedLiquidationTooltip(null);
        setCancelTooltip({
          x: cancelHit.rects.cancel.x + cancelHit.rects.cancel.width / 2,
          y: cancelHit.rects.cancel.y,
        });
        clearHoveredDrawingInfo();
      } else {
        setCancelTooltip(null);
        setChaseTooltip(null);
        setEstimatedLiquidationTooltip(null);

        const hit = coord.findDrawingAt(local.x, local.y, isDrawingInteractive);
        setIsHoveringDrawing(hit !== null);
        setIsHoveringHorizontalDrawing(hit !== null && hit.type === "horizontal");

        if (hit && !isOrderDrawing(hit)) {
          if (hoverInfoDrawingIdRef.current !== hit.id) {
            // Just landed on a different drawing (or the first one) -
            // restart the delay from zero rather than showing instantly.
            hoverInfoDrawingIdRef.current = hit.id;
            clearHoverInfoTimer();
            setHoveredDrawingInfo(null);

            const pointAtScheduleTime = { x: local.x, y: local.y };

            hoverInfoTimerRef.current = window.setTimeout(() => {
              hoverInfoTimerRef.current = null;

              // Still hovering the very same drawing once the delay
              // elapses? Only then does the popup actually appear.
              if (hoverInfoDrawingIdRef.current === hit.id) {
                setHoveredDrawingInfo({
                  drawing: hit,
                  point: pointAtScheduleTime,
                });
              }
            }, HOVER_INFO_DELAY_MS);
          } else {
            // Same drawing as last frame - if the popup's already showing,
            // keep it tracking the mouse instead of staying pinned to
            // wherever the hover first started.
            setHoveredDrawingInfo((previous) =>
              previous ? { drawing: hit, point: { x: local.x, y: local.y } } : previous,
            );
          }
        } else {
          clearHoveredDrawingInfo();
        }
      }
    } else {
      setIsHoveringDrawing(false);
      setIsHoveringHorizontalDrawing(false);
      setCancelTooltip(null);
      setChaseTooltip(null);
      setEstimatedLiquidationTooltip(null);
      clearHoveredDrawingInfo();
    }

    const chartPoint = coord.screenToChartPoint(local.x, local.y);

    if (!chartPoint) return;

    if (refs.rulerStartRef.current) {
      event.preventDefault();
      event.stopPropagation();
      refs.rulerEndRef.current = { ...chartPoint };
      return;
    }

    const penDraft = refs.penDraftRef.current;

    if (penDraft) {
      event.preventDefault();
      event.stopPropagation();

      // Same reasoning as the pen's first point above - without
      // `continuous: true` here, every mouse-move sample inside the same
      // candle's pixel width would keep landing on that candle's one
      // shared time, so the stroke reduces to a vertical jog per candle
      // instead of tracking the mouse's actual path.
      const continuousChartPoint =
        coord.screenToChartPoint(local.x, local.y, true) ?? chartPoint;

      const previousPoint = penDraft.points[penDraft.points.length - 1];
      const previousScreen = coord.chartPointToScreen(previousPoint, false);
      const currentScreen = coord.chartPointToScreen(
        continuousChartPoint,
        false,
      );

      if (
        !previousScreen ||
        !currentScreen ||
        Math.hypot(
          currentScreen.x - previousScreen.x,
          currentScreen.y - previousScreen.y,
        ) >= 2
      ) {
        const updatedPen: PenDrawing = {
          ...penDraft,
          points: [...penDraft.points, { ...continuousChartPoint }],
        };

        refs.penDraftRef.current = updatedPen;
        drawingsApi.replaceDrawingWithoutHistory(updatedPen.id, updatedPen);
      }

      return;
    }

    if (
      (refs.toolRef.current === "trend" || refs.toolRef.current === "box") &&
      refs.pendingStartRef.current
    ) {
      refs.previewPointRef.current = chartPoint;
    }

    const drag = refs.dragRef.current;

    if (!drag) return;

    event.preventDefault();
    event.stopPropagation();

    const original = drag.before;

    if (original.type === "trend" && drag.mode === "trend-start") {
      drawingsApi.replaceDrawingWithoutHistory(original.id, {
        ...original,
        start: { ...chartPoint },
      });

      return;
    }

    if (original.type === "trend" && drag.mode === "trend-end") {
      drawingsApi.replaceDrawingWithoutHistory(original.id, {
        ...original,
        end: { ...chartPoint },
      });

      return;
    }

    if (original.type === "text" && drag.mode.startsWith("text-")) {
      const originalRect = getTextRect(original, coord);
      if (!originalRect) return;

      const minSize = 18;
      let left = originalRect.left;
      let right = originalRect.left + originalRect.width;
      let top = originalRect.top;
      let bottom = originalRect.top + originalRect.height;

      if (drag.mode.includes("left")) left = Math.min(local.x, right - minSize);
      if (drag.mode.includes("right")) right = Math.max(local.x, left + minSize);
      if (drag.mode.includes("top")) top = Math.min(local.y, bottom - minSize);
      if (drag.mode.includes("bottom")) bottom = Math.max(local.y, top + minSize);

      // Both corners are now real chart anchors (see TextDrawing in
      // types/drawing.ts), so - unlike the old single-anchor + pixel-box
      // model - resizing has to resolve BOTH the new top-left and the new
      // bottom-right through screenToChartPoint, not just one.
      const nextStart = coord.screenToChartPoint(left, top);
      const nextEnd = coord.screenToChartPoint(right, bottom);
      if (!nextStart || !nextEnd) return;

      drawingsApi.replaceDrawingWithoutHistory(original.id, {
        ...original,
        start: nextStart,
        end: nextEnd,
      });
      return;
    }

    // Box's 8 resize handles (corners + edges) no longer reach here at
    // all - grabbing one now arms the click-move-click flow instead (see
    // armBoxHandleMove and the armedBoxHandle effect above, plus
    // computeBoxResize for the actual corner/edge math). Only a plain
    // whole-box move (grabbing the box body, not a handle) still falls
    // through to the generic start/end delta case further below.

    const timeDelta = Number(chartPoint.time) - Number(drag.pointerStart.time);
    const priceDelta = chartPoint.price - drag.pointerStart.price;

    if (original.type === "vertical") {
      drawingsApi.replaceDrawingWithoutHistory(original.id, {
        ...original,
        time: Math.round(Number(original.time) + timeDelta) as UTCTimestamp,
      });

      return;
    }

    if (original.type === "horizontal") {
      drawingsApi.replaceDrawingWithoutHistory(original.id, {
        ...original,
        price: original.price + priceDelta,
        ...(original.orderId !== undefined
          ? { orderPricePending: true }
          : {}),
      });

      return;
    }

    if (original.type === "coordinate-marker") {
      drawingsApi.replaceDrawingWithoutHistory(original.id, {
        ...original,
        time: Math.round(Number(original.time) + timeDelta) as UTCTimestamp,
        price: original.price + priceDelta,
      });

      return;
    }

    if (original.type === "pen") {
      drawingsApi.replaceDrawingWithoutHistory(original.id, {
        ...original,
        points: original.points.map((point) => ({
          time: Math.round(Number(point.time) + timeDelta) as UTCTimestamp,
          price: point.price + priceDelta,
        })),
      });

      return;
    }

    // Text falls through to here now too (no dedicated branch needed):
    // it has real start/end chart anchors exactly like Trend/Box, so
    // moving it means shifting both anchors by the same time/price delta,
    // same as this block already does for those two.
    drawingsApi.replaceDrawingWithoutHistory(original.id, {
      ...original,
      start: {
        time: Math.round(
          Number(original.start.time) + timeDelta,
        ) as UTCTimestamp,
        price: original.start.price + priceDelta,
      },
      end: {
        time: Math.round(Number(original.end.time) + timeDelta) as UTCTimestamp,
        price: original.end.price + priceDelta,
      },
    });
  };

  const handlePointerUpCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (refs.toolRef.current === "ruler") {
      // Do not finish the measurement on mouse-up. It remains visible while
      // the pointer moves and is removed only by the ruler's second click.
      event.preventDefault();
      event.stopPropagation();

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      return;
    }

    const penDraft = refs.penDraftRef.current;

    if (penDraft) {
      event.preventDefault();
      event.stopPropagation();

      refs.penDraftRef.current = null;

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const completed = refs.drawingsRef.current.find(
        (drawing) => drawing.id === penDraft.id,
      );

      if (!completed || completed.type !== "pen") return;

      if (completed.points.length < 2) {
        drawingsApi.syncDrawings(
          refs.drawingsRef.current.filter(
            (drawing) => drawing.id !== completed.id,
          ),
        );
        drawingsApi.setSelectedId(null);
        return;
      }

      drawingsApi.pushHistory({
        type: "add",
        drawing: cloneDrawing(completed),
      });

      return;
    }

    const drag = refs.dragRef.current;

    if (!drag) return;

    event.preventDefault();
    event.stopPropagation();

    const after = refs.drawingsRef.current.find(
      (drawing) => drawing.id === drag.drawingId,
    );

    refs.dragRef.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (!after) return;

    const isPendingLimitMove =
      drag.before.type === "horizontal" &&
      after.type === "horizontal" &&
      drag.before.orderSide !== undefined &&
      drag.before.orderId !== undefined &&
      drag.before.orderSymbol !== undefined &&
      drag.before.orderQuantity !== undefined &&
      after.price !== drag.before.price;

    if (!isPendingLimitMove) {
      const settledAfter =
        after.type === "horizontal" && after.orderPricePending
          ? { ...after, orderPricePending: false }
          : after;

      if (settledAfter !== after) {
        drawingsApi.replaceDrawingWithoutHistory(settledAfter.id, settledAfter);
      }

      const changed = JSON.stringify(drag.before) !== JSON.stringify(settledAfter);
      if (changed) {
        drawingsApi.pushHistory({
          type: "update",
          before: cloneDrawing(drag.before),
          after: cloneDrawing(settledAfter),
        });
      } else if (settledAfter.type === "text") {
        beginTextEditing(settledAfter);
      }
      return;
    }

    submitOrderLineMove(
      cloneDrawing(drag.before) as HorizontalDrawing,
      (after as HorizontalDrawing).price,
    );
  };

  const handleContextMenuCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    const wrap = refs.chartWrapRef.current;

    if (!wrap) return;

    const rect = wrap.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const hit = coord.findDrawingAt(x, y, isDrawingInteractive);
    const groupDrawingIds =
      hit && refs.groupSelectedIdsRef.current.has(hit.id)
        ? [...refs.groupSelectedIdsRef.current]
        : undefined;

    event.preventDefault();
    event.stopPropagation();

    drawingsApi.setSelectedId(hit?.id ?? null);

    // Used by "Create alert" in the chart menu and in the context menus
    // for trend/vertical lines. Horizontal lines use their exact stored
    // price instead (see ContextMenu.tsx).
    const point = coord.screenToChartPoint(x, y);

    drawingsApi.setContextMenu({
      x: event.clientX,
      y: event.clientY,
      drawingId: hit?.id ?? null,
      drawingIds: groupDrawingIds,
      price: point?.price ?? null,
      time: point?.time ?? null,
    } as ContextMenuState);
  };

  const openTradeMenuAt = (clientX: number, clientY: number): boolean => {
    if (refs.toolRef.current !== "cursor") return false;
    if (
      refs.dragRef.current ||
      refs.penDraftRef.current ||
      refs.pendingStartRef.current
    )
      return false;

    const wrap = refs.chartWrapRef.current;
    const chart = refs.chartRef.current;

    if (!wrap || !chart || marketData.isChartLoading) return false;

    const rect = wrap.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const paneSize = chart.paneSize();

    if (
      localX < 0 ||
      localY < 0 ||
      localX > paneSize.width ||
      localY > paneSize.height
    ) {
      return false;
    }

    if (coord.findDrawingAt(localX, localY, isDrawingInteractive)) return false;

    const point = coord.screenToChartPoint(localX, localY);
    const marketPrice =
      marketData.lastPrice ?? refs.lastCandleRef.current?.close ?? null;

    if (!point || marketPrice === null) return false;

    drawingsApi.setContextMenu(null);
    setIsHotkeysOpen(false);
    drawingsApi.setSelectedId(null);

    tradeMenuApi.openTradeMenu(clientX, clientY, point.price, marketPrice);
    return true;
  };

  const handleChartDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const wrap = refs.chartWrapRef.current;
    if (wrap) {
      const rect = wrap.getBoundingClientRect();
      const hit = coord.findDrawingAt(
        event.clientX - rect.left,
        event.clientY - rect.top,
        isDrawingInteractive,
      );
      if (hit?.type === "text") {
        event.preventDefault();
        event.stopPropagation();
        beginTextEditing(hit);
        return;
      }
    }
    if (!openTradeMenuAt(event.clientX, event.clientY)) return;

    event.preventDefault();
    event.stopPropagation();
  };

  const handleChartDoubleTap = (clientX: number, clientY: number) => {
    openTradeMenuAt(clientX, clientY);
  };

  const handlePointerLeave = () => {
    if (!refs.rulerStartRef.current) {
      refs.rulerEndRef.current = null;
    }
    setIsHoveringDrawing(false);
    setIsHoveringHorizontalDrawing(false);
    setCancelTooltip(null);
    setChaseTooltip(null);
    clearHoveredDrawingInfo();
  };

  return {
    isHoveringDrawing,
    setIsHoveringDrawing,
    isHoveringHorizontalDrawing,
    cancelTooltip,
    chaseTooltip,
    estimatedLiquidationTooltip,
    hoveredDrawingInfo,
    reduceOrderEditor,
    setReduceOrderEditorPct,
    submitReduceOrderEditor,
    closeReduceOrderEditor,
    editingText,
    setEditingTextValue: (value: string) =>
      setEditingText((current) => {
        if (!current) return current;
        const next = { ...current, value };
        editingTextRef.current = next;
        return next;
      }),
    commitTextEditing,
    cancelTextEditing,
    isPlacingOrderLine: armedOrderLineId !== null,
    handlePointerDownCapture,
    handlePointerMoveCapture,
    handlePointerUpCapture,
    handlePointerLeave,
    handleContextMenuCapture,
    handleChartDoubleClick,
    handleChartDoubleTap,
  };
}

export type DrawingCanvasApi = ReturnType<typeof useDrawingCanvas>;
