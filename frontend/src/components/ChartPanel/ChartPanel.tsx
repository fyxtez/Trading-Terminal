import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import type { Interval } from "../../config/constants";
import type { Drawing, DrawingTool, ScreenPoint } from "../../types/drawing";
import type { TradeMarker, TradeSide, TradeToastState } from "../../trading/types";
import ChartWatermark from "../ChartWatermark/ChartWatermark";
import TradeToast from "../TradeToast/TradeToast";
import ChartTimezoneBadge from "../ChartTimezoneBadge/ChartTimezoneBadge";
import CandleCountdownBadge from "../CandleCountdownBadge/CandleCountdownBadge";
import ChartContextBadges from "../ChartContextBadges/ChartContextBadges";
import { useCandleCountdown } from "../../hooks/useCandleCountdown";
import ChartLoader from "../ChartLoader/ChartLoader";
import ChartPositionPnl from "../ChartPositionPnl/ChartPositionPnl";
import PositionBracketOverlay from "../PositionBracketOverlay/PositionBracketOverlay";
import AutoMarketOverlay from "../AutoMarketOverlay/AutoMarketOverlay";
import SessionZonesOverlay from "../SessionZonesOverlay/SessionZonesOverlay";
import TimeMarkersOverlay from "../TimeMarkersOverlay/TimeMarkersOverlay";
import AlertLinesOverlay from "../AlertLinesOverlay/AlertLinesOverlay";
import DrawingInfoTooltip from "../DrawingInfoTooltip/DrawingInfoTooltip";
import DrawingMoveToast from "../DrawingMoveToast/DrawingMoveToast";
import type { AutoMarketDraft } from "../../hooks/useTradeMenu";
import type { AlertPattern, PriceAlert } from "../../types/alert";
import { startPacedLoop } from "../../utils/pacedLoop";
import {
  ChartTextEditor,
  ReduceOrderEditor,
  TemporaryTradePriceLine,
} from "./ChartTransientEditors";
import "./ChartPanel.css";

type ChartPanelProps = {
  /**
   * The currently selected trading symbol (e.g. "BTCUSDT"). Passed to
   * PositionBracketOverlay both as a normal prop AND as its React `key` -
   * keying by symbol forces a full remount whenever the symbol changes,
   * which is the simplest way to guarantee none of that component's many
   * per-symbol refs/state (saved stop, entry anchor candle, zone width,
   * etc.) leak from one symbol into another.
   */
  symbol: string;
  chartWrapRef: MutableRefObject<HTMLDivElement | null>;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  chartRef: MutableRefObject<IChartApi | null>;
  candleRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>;
  /** Invisible future series used as a price-coordinate fallback beyond candles. */
  futureScaleRef: MutableRefObject<ISeriesApi<"Line"> | null>;
  lastDataTimeRef: MutableRefObject<UTCTimestamp | null>;
  /** Tracks wherever the mouse is currently hovering over the chart (for the crosshair). */
  currentPriceRef: MutableRefObject<number | null>;
  /** The real, live traded market price - used for SL/TP validation, not the mouse position. */
  liveMarketPriceRef: MutableRefObject<number | null>;
  /** Temporary double-click trade price shown while the trade menu is open. */
  temporaryTradePrice: number | null;
  /**
   * Decimal precision for the active symbol's real tick size (from
   * Binance's exchangeInfo - see trading/api/exchangeInfo.ts and
   * useMarketData.ts). Used to format the temporary trade-price line and
   * the AUTO MARKET overlay's price labels correctly for whichever
   * symbol is selected, instead of always assuming BTC's whole-number
   * precision.
   */
  pricePrecision: number;
  /** Price of the confirmed 100%-reduce (full take-profit) limit order, if any. */
  fullTakeProfitPrice: number | null;
  /**
   * Real Binance orderId of the confirmed full-TP order, if any - see the
   * comment on this same prop in PositionBracketOverlay.tsx for why it's
   * needed separately from fullTakeProfitPrice.
   */
  fullTakeProfitOrderId: string | null;
  /**
   * Converts a real bar timestamp into its current on-screen X coordinate,
   * with the same native-lookup + calibrated-fallback logic used for
   * drawings (see useCoordinateMapping.ts). Needed by
   * PositionBracketOverlay so its TP/SL zone stays anchored to the actual
   * candle the trade was opened on, instead of drifting to "now", and by
   * SessionZonesOverlay so the Asia/London/New York lines stay aligned
   * with the chart's time axis.
   */
  coordTimeToX: (time: UTCTimestamp) => number | null;
  /**
   * Set by App.tsx's focusOrderLine whenever an order row is clicked in
   * PositionsPanel (both real orders and the synthetic stop-loss row -
   * see PositionsPanel.tsx). Chart drawings already read this to blink
   * their line; PositionBracketOverlay needs it too so clicking the
   * stop-loss row can blink the actual SL zone/line on the chart, since
   * the stop-loss isn't a regular drawing.
   */
  highlightedOrderIdRef: MutableRefObject<string | null>;
  highlightedOrderUntilRef: MutableRefObject<number>;
  /**
   * Set by App.tsx's focusPosition whenever a row in the Positions tab
   * (as opposed to Open Orders) is clicked. Forwarded to
   * PositionBracketOverlay so it can blink the entry line and whichever
   * TP/SL zones currently exist, independently of the order-id-based
   * highlighting above.
   */
  highlightedPositionUntilRef: MutableRefObject<number>;
  /**
   * WHICH position ("SYMBOL-SIDE") is currently highlighted - see the
   * comment on this same ref in useChartRefs.ts for why
   * highlightedPositionUntilRef alone isn't enough once positions/orders
   * can span multiple symbols at once.
   */
  highlightedPositionKeyRef: MutableRefObject<string | null>;
  /**
   * Forwarded straight through to PositionBracketOverlay so it can anchor
   * the TP/SL zone to the real entry fill - see the comment on this same
   * prop there for why.
   */
  tradeMarkersRef: MutableRefObject<TradeMarker[]>;
  /** Passed through to PositionBracketOverlay's own quick-close X button. */
  onPositionClosed: (side: TradeSide, symbol: string, price?: number) => void;
  /**
   * triggered alerts can belong to a background symbol. The shared
   * canvas toast uses this callback to open that symbol through App's normal
   * chart-tab path instead of navigating the browser directly.
   */
  onOpenAlertSymbol: (symbol: string) => void;
  /**
   * User preference from Settings' "Chart display" section (see
   * App.tsx / SettingsPanel.tsx) - whether the Asia/London/New York
   * session boundary lines are rendered at all. Purely local display
   * state, not backend-gated. Deliberately does NOT also gate
   * ChartIndicators below - the "current session" chip is independent
   * of whether the lines themselves are shown.
   */
  showDrawings: boolean;
  showAsiaSession: boolean;
  showLondonSession: boolean;
  showNewYorkSession: boolean;
  showNewYorkKillZone: boolean;
  /** Whether midnight/start-of-day vertical markers are rendered. */
  showStartOfDay: boolean;
  /** Number of previous chart days to include, capped at 20 in Settings. */
  startOfDayLookbackDays: number;
  /**
   * The drawing currently hovered long enough to show its info popup (see
   * DrawingInfoTooltip.tsx / useDrawingCanvas.ts's HOVER_INFO_DELAY_MS),
   * along with the wrap-relative mouse position it should anchor to.
   * Null whenever nothing's been hovered long enough yet.
   */
  hoveredDrawingInfo: { drawing: Drawing; point: ScreenPoint } | null;
  /** chart-local editor for an existing reduce-only TP order. */
  reduceOrderEditor: {
    drawingId: string;
    left: number;
    top: number;
    reducePct: number;
    isSubmitting: boolean;
  } | null;
  onReduceOrderEditorPctChange: (reducePct: number) => void;
  onSubmitReduceOrderEditor: () => void;
  onCloseReduceOrderEditor: () => void;
  editingText: {
    drawingId: string;
    value: string;
    left: number;
    top: number;
    width: number;
    height: number;
    fontSize: number;
    color: string;
    align: "left" | "center" | "right";
  } | null;
  onEditingTextChange: (value: string) => void;
  onCommitTextEditing: () => void;
  onCancelTextEditing: () => void;
  /** Pending price alerts for the active symbol - see usePriceAlerts.ts. */
  alerts: PriceAlert[];
  /**
   * User preference from Settings' "Chart display" section - whether
   * pending price alert lines are drawn on the chart at all. Purely
   * local display state, same as showSessionZones/showTimeMarkers.
   * Deliberately does NOT pause the underlying monitoring/notification
   * in usePriceAlerts.ts - hiding the lines shouldn't also silence the
   * alert firing when its price is reached.
   */
  showAlerts: boolean;
  onRemoveAlert: (id: string) => void;
  onUpdateAlertPrice: (id: string, price: number) => void;
  onToggleAlertSide: (id: string) => void;
  onSetAlertPattern: (id: string, pattern: AlertPattern) => void;
  onSetAlertAdditionalInfo: (id: string, additionalInfo: string) => void;
  onToggleAlertLocked: (id: string) => void;
  onToggleAlertHidden: (id: string) => void;
  autoMarketDraft: AutoMarketDraft | null;
  isSubmittingAutoMarket: boolean;
  onAutoMarketStopLossChange: (price: number) => void;
  onSubmitAutoMarket: () => void;
  onCancelAutoMarket: () => void;
  /**
   * Trade confirmation/error/pending toast (see useTradeMenu.ts). Rendered
   * inside .chart-wrap so it's anchored to the canvas rather than the whole
   * app - unified with the other bottom-center canvas notifications (e.g.
   * AutoMarketOverlay's error/instruction messages, and PositionBracketOverlay's
   * SL/TP submit lifecycle) instead of each living as its own separate toast.
   */
  tradeToast: TradeToastState | null;
  onSetTradeToast: (toast: TradeToastState | null) => void;
  tool: DrawingTool;
  isHoveringDrawing: boolean;
  /**
   * Whether the currently-hovered drawing is specifically a horizontal
   * (price) line - order lines (limit/reduce/TP) or a plain horizontal
   * drawing. Used to apply the same ns-resize cursor these already get
   * from the stop-loss line (a real DOM element with its own hardcoded
   * cursor), since dragging any of them is the same purely-vertical price
   * move. Other drawing types keep the generic pointer cursor via
   * isHoveringDrawing above.
   */
  isHoveringHorizontalDrawing: boolean;
  isChartLoading: boolean;
  marketDataError: string | null;
  onRetryMarketData: () => void;
  interval: Interval;
  chartTimeZoneLabel: string;
  cancelTooltip: ScreenPoint | null;
  chaseTooltip: ScreenPoint | null;
  /** hover explanation for a pending order's projected liquidation preview. */
  estimatedLiquidationTooltip: ScreenPoint | null;
  positionPnl: number | null;
  positionRealizedPnl: number | null;
  totalPnl: number | null;
  showCandleCountdown: boolean;
  /** local Settings preference controls whether chart branding is rendered. */
  showWatermark: boolean;
  showDrawingSetBadge: boolean;
  activeDrawingSetName: string;
  isDrawingSetUnsaved: boolean;
  canSaveDrawingSet: boolean;
  onSaveDrawingSet: (name: string) => boolean;
  isToolbarCollapsed: boolean;
  onShowToolbar: () => void;
  onPointerDownCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMoveCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUpCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerLeave: () => void;
  onContextMenuCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onDoubleClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onMobileDoubleTap: (clientX: number, clientY: number) => void;
};

const DRAWING_TOOL_CURSOR_ICONS: Record<DrawingTool, string> = {
  cursor: "↖",
  text: "T",
  pen: "✎",
  trend: "╱",
  box: "▭",
  "group-select": "□",
  horizontal: "─",
  vertical: "│",
  ruler: "↕%",
};

export default function ChartPanel({
  symbol,
  chartWrapRef,
  containerRef,
  canvasRef,
  chartRef,
  candleRef,
  futureScaleRef,
  lastDataTimeRef,
  liveMarketPriceRef,
  temporaryTradePrice,
  pricePrecision,
  fullTakeProfitPrice,
  fullTakeProfitOrderId,
  coordTimeToX,
  highlightedOrderIdRef,
  highlightedOrderUntilRef,
  highlightedPositionUntilRef,
  highlightedPositionKeyRef,
  tradeMarkersRef,
  onPositionClosed,
  onOpenAlertSymbol,
  showDrawings,
  showAsiaSession,
  showLondonSession,
  showNewYorkSession,
  showNewYorkKillZone,
  showStartOfDay,
  startOfDayLookbackDays,
  hoveredDrawingInfo,
  reduceOrderEditor,
  onReduceOrderEditorPctChange,
  onSubmitReduceOrderEditor,
  onCloseReduceOrderEditor,
  editingText,
  onEditingTextChange,
  onCommitTextEditing,
  onCancelTextEditing,
  alerts,
  showAlerts,
  onRemoveAlert,
  onUpdateAlertPrice,
  onToggleAlertSide,
  onSetAlertPattern,
  onSetAlertAdditionalInfo,
  onToggleAlertLocked,
  onToggleAlertHidden,
  autoMarketDraft,
  isSubmittingAutoMarket,
  onAutoMarketStopLossChange,
  onSubmitAutoMarket,
  onCancelAutoMarket,
  tool,
  isHoveringDrawing,
  isHoveringHorizontalDrawing,
  isChartLoading,
  marketDataError,
  onRetryMarketData,
  interval,
  chartTimeZoneLabel,
  cancelTooltip,
  chaseTooltip,
  estimatedLiquidationTooltip,
  positionPnl,
  positionRealizedPnl,
  totalPnl,
  showCandleCountdown,
  showWatermark,
  showDrawingSetBadge,
  activeDrawingSetName,
  isDrawingSetUnsaved,
  canSaveDrawingSet,
  onSaveDrawingSet,
  isToolbarCollapsed,
  onShowToolbar,
  onPointerDownCapture,
  onPointerMoveCapture,
  onPointerUpCapture,
  onPointerLeave,
  onContextMenuCapture,
  onDoubleClick,
  onMobileDoubleTap,
  tradeToast,
  onSetTradeToast,
}: ChartPanelProps) {
  const candleCountdown = useCandleCountdown(lastDataTimeRef, interval);
  const [candleCountdownAnchor, setCandleCountdownAnchor] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [candleCountdownOffset, setCandleCountdownOffset] = useState({ x: 0, y: 0 });
  const [isCandleCountdownMoveArmed, setIsCandleCountdownMoveArmed] = useState(false);
  const [isCandleCountdownMoving, setIsCandleCountdownMoving] = useState(false);
  const candleCountdownBaseAnchorRef = useRef<{ left: number; top: number } | null>(null);
  const candleCountdownGrabOffsetRef = useRef({ x: 0, y: 0 });
  const toolCursorIndicatorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let previousLeft: number | null = null;
    let previousTop: number | null = null;

    const updateCandleCountdownAnchor = () => {
      if (!showCandleCountdown || isChartLoading) {
        if (previousLeft !== null || previousTop !== null) {
          previousLeft = null;
          previousTop = null;
          setCandleCountdownAnchor(null);
        }
        return;
      }

      const latestTime = lastDataTimeRef.current;
      const livePrice = liveMarketPriceRef.current;
      const chart = chartRef.current;
      const wrap = chartWrapRef.current;
      const series = candleRef.current;

      if (
        latestTime === null ||
        livePrice === null ||
        !Number.isFinite(livePrice) ||
        chart === null ||
        wrap === null ||
        series === null
      ) {
        return;
      }

      const candleX = coordTimeToX(latestTime);
      const candleY = series.priceToCoordinate(livePrice);
      const paneWidth = chart.timeScale().width();

      if (
        candleX === null ||
        candleY === null ||
        !Number.isFinite(candleX) ||
        !Number.isFinite(candleY) ||
        candleX < 0 ||
        candleX > paneWidth ||
        candleY < 0 ||
        candleY > wrap.clientHeight
      ) {
        if (previousLeft !== null || previousTop !== null) {
          previousLeft = null;
          previousTop = null;
          setCandleCountdownAnchor(null);
        }
        return;
      }

      /*
       * anchor the candle-close timer to the live/latest candle
       * instead of the chart's top-left corner. The small right/up offset
       * keeps the badge visually attached to the candle without covering its
       * body, while the pane clamps stop it from leaking into the price scale.
       */
      const baseLeft = candleX + 14;
      const baseTop = candleY - 42;
      candleCountdownBaseAnchorRef.current = { left: baseLeft, top: baseTop };

      /*
       * keep the user's timer adjustment relative to the current
       * candle rather than converting it into a fixed screen position. This
       * means the timer still follows the live candle while preserving the
       * chosen small X/Y offset. The hard limits intentionally prevent the
       * badge from being moved so far away that it loses its candle context.
       */
      const nextLeft = Math.round(
        Math.min(Math.max(8, baseLeft + candleCountdownOffset.x), Math.max(8, paneWidth - 102)),
      );
      const nextTop = Math.round(
        Math.min(
          Math.max(8, baseTop + candleCountdownOffset.y),
          Math.max(8, wrap.clientHeight - 38),
        ),
      );

      if (nextLeft !== previousLeft || nextTop !== previousTop) {
        previousLeft = nextLeft;
        previousTop = nextTop;
        setCandleCountdownAnchor({ left: nextLeft, top: nextTop });
      }
    };

    return startPacedLoop(updateCandleCountdownAnchor, 30);
  }, [
    candleRef,
    candleCountdownOffset.x,
    candleCountdownOffset.y,
    chartRef,
    chartWrapRef,
    coordTimeToX,
    isChartLoading,
    lastDataTimeRef,
    liveMarketPriceRef,
    showCandleCountdown,
  ]);

  const handleCandleCountdownMovePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();

      if (isCandleCountdownMoving) {
        // pressing the move button again drops the timer immediately.
        setIsCandleCountdownMoving(false);
        setIsCandleCountdownMoveArmed(false);
        return;
      }

      if (candleCountdownAnchor === null) return;
      const wrap = chartWrapRef.current;
      if (wrap === null) return;

      const rect = wrap.getBoundingClientRect();
      candleCountdownGrabOffsetRef.current = {
        x: event.clientX - rect.left - candleCountdownAnchor.left,
        y: event.clientY - rect.top - candleCountdownAnchor.top,
      };

      /*
       * the move-arrow click is now both the unlock and pick-up action.
       * Capturing the pointer-to-badge offset here prevents the timer from
       * jumping when it immediately starts following the cursor.
       */
      setIsCandleCountdownMoveArmed(true);
      setIsCandleCountdownMoving(true);
    },
    [candleCountdownAnchor, chartWrapRef, isCandleCountdownMoving],
  );

  const handleCandleCountdownPlacementClick = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!isCandleCountdownMoveArmed || candleCountdownAnchor === null) return;

      event.preventDefault();
      event.stopPropagation();

      if (isCandleCountdownMoving) {
        // the second click drops the timer and locks the chosen offset.
        setIsCandleCountdownMoving(false);
        setIsCandleCountdownMoveArmed(false);
        return;
      }

      const wrap = chartWrapRef.current;
      if (wrap === null) return;
      const rect = wrap.getBoundingClientRect();
      candleCountdownGrabOffsetRef.current = {
        x: event.clientX - rect.left - candleCountdownAnchor.left,
        y: event.clientY - rect.top - candleCountdownAnchor.top,
      };
      setIsCandleCountdownMoving(true);
    },
    [candleCountdownAnchor, chartWrapRef, isCandleCountdownMoveArmed, isCandleCountdownMoving],
  );

  useEffect(() => {
    if (!isCandleCountdownMoving) return;

    const handlePointerMove = (event: PointerEvent) => {
      const wrap = chartWrapRef.current;
      const base = candleCountdownBaseAnchorRef.current;
      if (wrap === null || base === null) return;

      const rect = wrap.getBoundingClientRect();
      const desiredLeft = event.clientX - rect.left - candleCountdownGrabOffsetRef.current.x;
      const desiredTop = event.clientY - rect.top - candleCountdownGrabOffsetRef.current.y;

      /*
       * movement is deliberately constrained to a compact area
       * around the candle origin (±80 px X / ±60 px Y). This keeps the timer
       * customizable without allowing it to become visually detached from
       * the candle it describes.
       */
      setCandleCountdownOffset({
        x: Math.max(-80, Math.min(80, Math.round(desiredLeft - base.left))),
        y: Math.max(-60, Math.min(60, Math.round(desiredTop - base.top))),
      });
    };

    const handlePlacementPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".candle-countdown-move-button")) {
        return;
      }

      /*
       * after the arrow has picked the timer up, the very next click
       * anywhere drops it. Consume that placement pointer-down so the same
       * click cannot accidentally interact with the chart underneath.
       */
      event.preventDefault();
      event.stopPropagation();
      setIsCandleCountdownMoving(false);
      setIsCandleCountdownMoveArmed(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerdown", handlePlacementPointerDown, true);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", handlePlacementPointerDown, true);
    };
  }, [chartWrapRef, isCandleCountdownMoving]);

  const touchStartRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    startedAt: number;
    moved: boolean;
  } | null>(null);
  const lastTapRef = useRef<{ x: number; y: number; at: number } | null>(null);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    onPointerDownCapture(event);

    if (event.pointerType !== "touch" || event.defaultPrevented) return;

    touchStartRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startedAt: performance.now(),
      moved: false,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    onPointerMoveCapture(event);

    const indicator = toolCursorIndicatorRef.current;
    if (indicator) {
      if (event.pointerType === "touch") {
        indicator.style.opacity = "0";
      } else {
        const bounds = event.currentTarget.getBoundingClientRect();
        const localX = event.clientX - bounds.left;
        const localY = event.clientY - bounds.top;
        const indicatorSize = 28;
        const offset = 14;

        /*
         * keep the active drawing-tool icon beside the pointer so the
         * user does not need to look back at the toolbar before drawing. It
         * normally sits above-right, flips left/below near chart edges, and is
         * moved through this ref instead of React state so pointer movement
         * never rerenders the otherwise-heavy chart panel.
         */
        const left =
          localX + offset + indicatorSize <= bounds.width
            ? localX + offset
            : localX - offset - indicatorSize;
        const top =
          localY - offset - indicatorSize >= 0 ? localY - offset - indicatorSize : localY + offset;

        indicator.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
        indicator.style.opacity = "1";
      }
    }

    const touch = touchStartRef.current;
    if (!touch || touch.pointerId !== event.pointerId) return;

    if (Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 10) {
      touch.moved = true;
    }
  };

  const handlePointerLeave = () => {
    if (toolCursorIndicatorRef.current) {
      toolCursorIndicatorRef.current.style.opacity = "0";
    }
    onPointerLeave();
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    onPointerUpCapture(event);

    const touch = touchStartRef.current;
    touchStartRef.current = null;

    if (
      event.pointerType !== "touch" ||
      !touch ||
      touch.pointerId !== event.pointerId ||
      touch.moved ||
      performance.now() - touch.startedAt > 350
    ) {
      return;
    }

    const now = performance.now();
    const lastTap = lastTapRef.current;
    const isDoubleTap =
      lastTap !== null &&
      now - lastTap.at <= 320 &&
      Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= 28;

    if (isDoubleTap) {
      lastTapRef.current = null;
      onMobileDoubleTap(event.clientX, event.clientY);
    } else {
      lastTapRef.current = { x: event.clientX, y: event.clientY, at: now };
    }
  };

  return (
    <div
      ref={chartWrapRef}
      className={`chart-wrap tool-${tool} ${
        isHoveringDrawing ? "hovering-drawing" : ""
      } ${isHoveringHorizontalDrawing ? "hovering-horizontal-drawing" : ""}`}
      onPointerDownCapture={handlePointerDown}
      onPointerMoveCapture={handlePointerMove}
      onPointerUpCapture={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onContextMenuCapture={onContextMenuCapture}
      onDoubleClick={onDoubleClick}
    >
      <div
        ref={containerRef}
        className={`chart ${isChartLoading ? "chart-loading" : "chart-ready"}`}
      />

      {tool !== "cursor" && !isChartLoading && (
        <div
          ref={toolCursorIndicatorRef}
          className={`tool-cursor-indicator tool-cursor-indicator--${tool}`}
          aria-hidden="true"
        >
          {DRAWING_TOOL_CURSOR_ICONS[tool]}
        </div>
      )}

      {(showAsiaSession || showLondonSession || showNewYorkSession) && (
        <SessionZonesOverlay
          chartWrapRef={chartWrapRef}
          chartRef={chartRef}
          candleRef={candleRef}
          coordTimeToX={coordTimeToX}
          showAsia={showAsiaSession}
          showLondon={showLondonSession}
          showNewYork={showNewYorkSession}
          showNewYorkKillZone={showNewYorkKillZone}
        />
      )}

      {showStartOfDay && (
        <TimeMarkersOverlay
          chartWrapRef={chartWrapRef}
          chartRef={chartRef}
          candleRef={candleRef}
          hour={0}
          minute={0}
          daysBack={startOfDayLookbackDays}
          coordTimeToX={coordTimeToX}
        />
      )}

      {showAlerts && alerts.length > 0 && (
        <AlertLinesOverlay
          chartWrapRef={chartWrapRef}
          chartRef={chartRef}
          candleRef={candleRef}
          futureScaleRef={futureScaleRef}
          alerts={alerts}
          pricePrecision={pricePrecision}
          onRemoveAlert={onRemoveAlert}
          onUpdateAlertPrice={onUpdateAlertPrice}
          onToggleAlertSide={onToggleAlertSide}
          onSetAlertPattern={onSetAlertPattern}
          onSetAlertAdditionalInfo={onSetAlertAdditionalInfo}
          onToggleAlertLocked={onToggleAlertLocked}
          onToggleAlertHidden={onToggleAlertHidden}
        />
      )}

      {/* do not hide the entire shared canvas here. useDrawingCanvas now
          suppresses only user drawings, leaving TP/reduce order lines visible. */}
      <canvas ref={canvasRef} className="drawing-canvas" />

      {reduceOrderEditor && (
        <ReduceOrderEditor
          editor={reduceOrderEditor}
          onPercentageChange={onReduceOrderEditorPctChange}
          onSubmit={onSubmitReduceOrderEditor}
          onClose={onCloseReduceOrderEditor}
        />
      )}

      {editingText && showDrawings && (
        <ChartTextEditor
          editor={editingText}
          onChange={onEditingTextChange}
          onCommit={onCommitTextEditing}
          onCancel={onCancelTextEditing}
        />
      )}

      {temporaryTradePrice !== null && (
        <TemporaryTradePriceLine
          candleRef={candleRef}
          chartWrapRef={chartWrapRef}
          price={temporaryTradePrice}
          pricePrecision={pricePrecision}
        />
      )}

      {autoMarketDraft && (
        <AutoMarketOverlay
          draft={autoMarketDraft}
          isSubmitting={isSubmittingAutoMarket}
          chartWrapRef={chartWrapRef}
          candleRef={candleRef}
          marketPriceRef={liveMarketPriceRef}
          lastDataTimeRef={lastDataTimeRef}
          coordTimeToX={coordTimeToX}
          pricePrecision={pricePrecision}
          onStopLossChange={onAutoMarketStopLossChange}
          onSubmit={onSubmitAutoMarket}
          onCancel={onCancelAutoMarket}
        />
      )}

      <PositionBracketOverlay
        key={symbol}
        symbol={symbol}
        // pass the live timeframe so TP/SL zone width can be kept as an
        // absolute time duration instead of reinterpreting the same bar count.
        interval={interval}
        chartWrapRef={chartWrapRef}
        chartRef={chartRef}
        candleRef={candleRef}
        lastDataTimeRef={lastDataTimeRef}
        marketPriceRef={liveMarketPriceRef}
        fullTakeProfitPrice={fullTakeProfitPrice}
        fullTakeProfitOrderId={fullTakeProfitOrderId}
        coordTimeToX={coordTimeToX}
        highlightedOrderIdRef={highlightedOrderIdRef}
        highlightedOrderUntilRef={highlightedOrderUntilRef}
        highlightedPositionUntilRef={highlightedPositionUntilRef}
        highlightedPositionKeyRef={highlightedPositionKeyRef}
        tradeMarkersRef={tradeMarkersRef}
        onPositionClosed={onPositionClosed}
        pricePrecision={pricePrecision}
        onToast={onSetTradeToast}
      />

      {tradeToast && <TradeToast tradeToast={tradeToast} onDismiss={() => onSetTradeToast(null)} />}

      {/* render the watermark conditionally so Settings can hide it without changing chart behavior. */}
      {showWatermark && <ChartWatermark />}

      {isToolbarCollapsed && (
        <button
          className="toolbar-reveal-button"
          onClick={(event) => {
            event.stopPropagation();
            onShowToolbar();
          }}
          title="Show toolbar"
        >
          ☰
        </button>
      )}

      {!isChartLoading &&
        showCandleCountdown &&
        candleCountdown.label !== null &&
        candleCountdownAnchor !== null && (
          <div
            className="candle-countdown-anchor"
            style={{
              left: candleCountdownAnchor.left,
              top: candleCountdownAnchor.top,
            }}
          >
            <CandleCountdownBadge
              label={candleCountdown.label}
              interval={interval}
              allLabels={candleCountdown.allLabels}
              moveArmed={isCandleCountdownMoveArmed}
              moving={isCandleCountdownMoving}
              onMovePointerDown={handleCandleCountdownMovePointerDown}
              onPlacementPointerDown={handleCandleCountdownPlacementClick}
            />
          </div>
        )}

      {!isChartLoading && (
        <div className="chart-top-context-row">
          <ChartContextBadges
            symbol={symbol}
            activeDrawingSetName={activeDrawingSetName}
            showDrawingSetBadge={showDrawingSetBadge}
            isDrawingSetUnsaved={isDrawingSetUnsaved}
            canSaveDrawingSet={canSaveDrawingSet}
            onSaveDrawingSet={onSaveDrawingSet}
          />
        </div>
      )}

      {/* <ChartIndicators /> */}

      {!isChartLoading &&
        (positionPnl !== null || positionRealizedPnl !== null || totalPnl !== null) && (
          // flex collapses unavailable cards automatically; fixed offsets
          // left an empty RPNL-sized gap whenever its backend lookup failed.
          <div className="chart-position-pnl-stack">
            {positionPnl !== null && <ChartPositionPnl pnl={positionPnl} />}
            {positionRealizedPnl !== null && (
              <ChartPositionPnl pnl={positionRealizedPnl} variant="realized" />
            )}
            {totalPnl !== null && <ChartPositionPnl pnl={totalPnl} variant="total" />}
          </div>
        )}

      {!isChartLoading && <ChartTimezoneBadge label={chartTimeZoneLabel} />}

      {cancelTooltip && (
        <div
          className="pending-order-tooltip"
          style={{ left: cancelTooltip.x, top: cancelTooltip.y }}
        >
          Cancel order
        </div>
      )}

      {chaseTooltip && (
        <div
          className="pending-order-tooltip"
          style={{ left: chaseTooltip.x, top: chaseTooltip.y }}
        >
          Chase to market
        </div>
      )}

      {estimatedLiquidationTooltip && (
        <div
          className="pending-order-tooltip"
          style={{
            left: estimatedLiquidationTooltip.x,
            top: estimatedLiquidationTooltip.y,
          }}
        >
          {/* make it explicit that EST. LIQ. is a pre-fill estimate,
              not Binance's final liquidation price for an open position. */}
          Estimated liquidation price if this limit order fills. Actual liquidation can differ after
          execution.
        </div>
      )}

      {hoveredDrawingInfo && (
        <DrawingInfoTooltip
          drawing={hoveredDrawingInfo.drawing}
          x={hoveredDrawingInfo.point.x}
          y={hoveredDrawingInfo.point.y}
        />
      )}

      {/* drawing-move feedback belongs to the chart workspace, not the
          application viewport. Rendering it inside .chart-wrap keeps the toast
          anchored to the candle canvas bottom-right even when panels resize. */}
      <DrawingMoveToast onOpenAlertSymbol={onOpenAlertSymbol} />

      {isChartLoading && <ChartLoader interval={interval} />}
      {!isChartLoading && marketDataError && (
        <div className="chart-market-degraded" role="alert">
          <div>
            <strong>MARKET DATA DEGRADED</strong>
            <span>{marketDataError}</span>
          </div>
          <button type="button" onClick={onRetryMarketData}>
            RETRY
          </button>
        </div>
      )}
    </div>
  );
}
