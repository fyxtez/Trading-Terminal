import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  DEFAULT_BOX_COLOR,
  DEFAULT_LINE_COLOR,
  PENDING_LIMIT_LONG_COLOR,
  PENDING_LIMIT_SHORT_COLOR,
  alignTimeToInterval,
} from "../../config/constants";
import type { HorizontalDrawing, ScreenPoint } from "../../types/drawing";
import type { TradeMarker } from "../../trading/types";
import { priceToCoordinateWithFutureFallback } from "../../utils/chartPriceCoordinates";
import { getTextFontSize } from "../../utils/drawings";
import { brightenColor, hexToRgba } from "../../utils/geometry";
import { localDateTimeFormatter } from "../../utils/time";
import type { ChartRefs } from "../useChartRefs";
import type { CoordinateMapping } from "../useCoordinateMapping";
import {
  drawBoxHandles,
  drawEndpointHandles,
  drawEstimatedLiquidationButton,
  drawEstimatedLiquidationHideButton,
  drawLine,
  drawPendingOrderCancelButton,
  drawPendingOrderChaseButton,
  drawPendingOrderEditButton,
  drawPendingOrderLabel,
} from "./canvasPrimitives";
import { clampToEditablePane, getTextRect, isOrderDrawing } from "./drawingGeometry";
import {
  REDUCE_ORDER_EDITOR_GAP,
  REDUCE_ORDER_EDITOR_HEIGHT,
  REDUCE_ORDER_EDITOR_WIDTH,
  getPendingOrderLabelText,
  getPendingOrderRects,
} from "./pendingOrderLayout";
import type { EditingTextState, ReduceOrderEditorState } from "./types";

type CanvasRendererOptions = {
  refs: ChartRefs;
  coord: CoordinateMapping;
  pricePrecision: number;
  showDrawings: boolean;
  cancellingOrderIds: Set<string>;
  reduceOrderEditorRef: MutableRefObject<ReduceOrderEditorState | null>;
  setReduceOrderEditor: Dispatch<SetStateAction<ReduceOrderEditorState | null>>;
  editingTextRef: MutableRefObject<EditingTextState | null>;
  setEditingText: Dispatch<SetStateAction<EditingTextState | null>>;
};

export function drawCanvasFrame({
  refs,
  coord,
  pricePrecision,
  showDrawings,
  cancellingOrderIds,
  reduceOrderEditorRef,
  setReduceOrderEditor,
  editingTextRef,
  setEditingText,
}: CanvasRendererOptions): void {
  const canvas = refs.canvasRef.current;
  const wrap = refs.chartWrapRef.current;
  const chart = refs.chartRef.current;
  const series = refs.candleRef.current;
  const futureSeries = refs.futureScaleRef.current;

  if (!canvas || !wrap || !chart || !series) {
    return;
  }

  // candle-specific conversion becomes null in an all-future viewport.
  // The invisible future series shares the same right scale and therefore
  // provides an equivalent coordinate fallback for every canvas drawing.
  const priceToY = (price: number) =>
    priceToCoordinateWithFutureFallback(series, futureSeries, price);

  const width = wrap.clientWidth;
  const height = wrap.clientHeight;

  const pixelRatio = window.devicePixelRatio || 1;

  const expectedWidth = Math.round(width * pixelRatio);
  const expectedHeight = Math.round(height * pixelRatio);

  if (canvas.width !== expectedWidth || canvas.height !== expectedHeight) {
    canvas.width = expectedWidth;
    canvas.height = expectedHeight;

    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }

  const context = canvas.getContext("2d");

  if (!context) {
    return;
  }

  /*
   * everything from here down used to run unguarded. A single bad
   * frame - a stale/NaN coordinate right after the tab or the whole
   * laptop wakes from sleep, the chart briefly not fully laid out yet
   * mid-symbol-switch, etc. - threw an uncaught exception straight out
   * of this rAF callback. Nothing ever caught it, so the
   * next scheduled draw never ran, permanently
   * killing this whole loop. Every drawing (trendlines, pen strokes,
   * boxes) and every order-line label they share this canvas with went
   * blank and stayed blank - only a full page reload restarted the
   * effect and brought them back. Catching here means one bad frame
   * just gets skipped and retried ~16ms later with fresh data instead
   * of taking the whole canvas down for the rest of the session.
   */
  try {
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);

    const paneSize = chart.paneSize();

    wrap.style.setProperty("--pane-inset-right", `${Math.max(0, width - paneSize.width)}px`);
    wrap.style.setProperty("--pane-inset-bottom", `${Math.max(0, height - paneSize.height)}px`);

    context.save();
    context.beginPath();
    context.rect(0, 0, paneSize.width, paneSize.height);
    context.clip();

    const drawEstimatedLiquidationGuide = (
      drawing: HorizontalDrawing,
      rects: ReturnType<typeof getPendingOrderRects>,
      color: string,
    ) => {
      if (
        drawing.estimatedLiquidationHidden ||
        drawing.estimatedLiquidationPrice == null ||
        !rects?.estimated
      ) {
        return;
      }

      const liquidationY = priceToY(drawing.estimatedLiquidationPrice);
      const orderY = priceToY(drawing.price);
      if (liquidationY == null || orderY == null) return;

      const connectorX = rects.estimated.x + rects.estimated.width / 2;
      const direction = liquidationY < orderY ? -1 : 1;
      const arrowSize = 6;

      context.save();
      context.strokeStyle = color;
      context.lineWidth = 1;
      // multiply by the inherited order opacity so cancelling an order dims
      // its EST. LIQ connector/level together with the label and eye control.
      const inheritedAlpha = context.globalAlpha;
      context.globalAlpha = inheritedAlpha * 0.4;
      context.setLineDash([6, 5]);

      // the EST. LIQ boundary is intentionally softer than the real
      // resting order line because it is a projection, not a Binance position.
      context.beginPath();
      context.moveTo(0, liquidationY);
      context.lineTo(width, liquidationY);
      context.stroke();

      // connector starts at the EST. LIQ rectangle and points directly
      // toward the projected level, matching the visual relationship requested.
      context.beginPath();
      context.moveTo(connectorX, orderY + direction * 11);
      context.lineTo(connectorX, liquidationY - direction * arrowSize);
      context.stroke();

      context.setLineDash([]);
      context.globalAlpha = inheritedAlpha * 0.72;
      context.beginPath();
      context.moveTo(connectorX - arrowSize, liquidationY - direction * arrowSize);
      context.lineTo(connectorX, liquidationY);
      context.lineTo(connectorX + arrowSize, liquidationY - direction * arrowSize);
      context.stroke();
      context.restore();
    };

    const drawTradeMarker = (anchor: ScreenPoint, side: TradeMarker["side"], color: string) => {
      const isBuy = side === "BUY";

      // this was a plain object literal, which only has the 6 keys
      // actually written out here - indexing it with the full Interval
      // union (which also includes "12h" and "1w") was a type error, even
      // though the runtime behavior was always correct: a missing key
      // just reads as undefined and falls through to the `?? 1` default
      // below. Marking it Partial<Record<Interval, number>> tells
      // TypeScript what was already true at runtime - not every interval
      // needs its own entry here, unlisted ones use the default 1 scale.
      const markerScaleByInterval: Partial<Record<typeof refs.intervalRef.current, number>> = {
        "1m": 0.9,
        "5m": 0.7,
        "15m": 0.6,
        "1h": 0.5,
        "4h": 0.5,
        "1d": 0.45,
      };

      const intervalScale = markerScaleByInterval[refs.intervalRef.current] ?? 1;

      const visibleRange = refs.chartRef.current?.timeScale().getVisibleLogicalRange();
      const visibleBars = visibleRange ? Math.max(1, visibleRange.to - visibleRange.from) : 245;
      const zoomScale = Math.min(1.8, Math.max(0.55, Math.sqrt(245 / visibleBars)));
      const markerScale = intervalScale * zoomScale;

      const badgeWidth = 20 * markerScale;
      const badgeHeight = 16 * markerScale;
      const tailSize = 6 * markerScale;
      const gap = 4 * markerScale;
      const radius = 4 * markerScale;
      const fontSize = Math.max(6, 10 * markerScale);

      const badgeCenterY = isBuy
        ? anchor.y + gap + tailSize + badgeHeight / 2
        : anchor.y - gap - tailSize - badgeHeight / 2;

      const left = anchor.x - badgeWidth / 2;
      const top = badgeCenterY - badgeHeight / 2;

      context.save();
      context.fillStyle = color;

      context.beginPath();
      context.moveTo(left + radius, top);
      context.arcTo(left + badgeWidth, top, left + badgeWidth, top + badgeHeight, radius);
      context.arcTo(left + badgeWidth, top + badgeHeight, left, top + badgeHeight, radius);
      context.arcTo(left, top + badgeHeight, left, top, radius);
      context.arcTo(left, top, left + badgeWidth, top, radius);
      context.closePath();
      context.fill();

      context.beginPath();
      if (isBuy) {
        context.moveTo(anchor.x - tailSize, top);
        context.lineTo(anchor.x + tailSize, top);
        context.lineTo(anchor.x, anchor.y);
      } else {
        context.moveTo(anchor.x - tailSize, top + badgeHeight);
        context.lineTo(anchor.x + tailSize, top + badgeHeight);
        context.lineTo(anchor.x, anchor.y);
      }
      context.closePath();
      context.fill();

      context.fillStyle = "#0b0e14";
      context.font = `700 ${fontSize}px 'JetBrains Mono', ui-monospace, monospace`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(isBuy ? "B" : "S", anchor.x, badgeCenterY + 0.5);

      context.restore();
    };

    for (const drawing of refs.drawingsRef.current) {
      // "Show drawings" controls only user-created chart annotations.
      // Pending Binance order lines (including TP/reduce lines) share this canvas,
      // so hiding the whole canvas also hid trading controls. Keep order drawings
      // rendered while filtering only regular drawings from the paint pass.
      if (!showDrawings && !isOrderDrawing(drawing)) continue;

      const selected =
        refs.selectedIdRef.current === drawing.id ||
        refs.groupSelectedIdsRef.current.has(drawing.id);

      if (drawing.type === "vertical") {
        const x = coord.timeToX(drawing.time);

        if (x === null) continue;

        drawLine(context, { x, y: 0 }, { x, y: height }, drawing.color, selected, true);
        continue;
      }

      if (drawing.type === "horizontal") {
        const y = priceToY(drawing.price);

        if (y == null) continue;

        const isPendingOrder = drawing.orderSide !== undefined;
        const isReduceOrder = drawing.orderIntent === "REDUCE";
        const isHighlighted =
          drawing.orderId !== undefined &&
          refs.highlightedOrderIdRef.current === drawing.orderId &&
          Date.now() < refs.highlightedOrderUntilRef.current;
        const blinkOn = isHighlighted && Math.floor(Date.now() / 180) % 2 === 0;
        const renderColor = blinkOn ? "#fff3b0" : drawing.color;
        const isCancelling = cancellingOrderIds.has(drawing.id);

        /*
         * Binance may need a few seconds
         * to confirm a limit-order cancellation. Keep the order visible as the
         * source-of-truth pending state, but dim the ENTIRE line/label/buttons as
         * soon as X is clicked so the user gets immediate visual confirmation.
         */
        context.save();
        context.globalAlpha = isCancelling ? 0.28 : 1;

        drawLine(
          context,
          { x: 0, y },
          { x: width, y },
          renderColor,
          selected || isHighlighted,
          isPendingOrder ? isReduceOrder : true,
          blinkOn,
          selected,
        );

        if (drawing.orderSide) {
          const rects = getPendingOrderRects(drawing, refs, pricePrecision);

          if (rects) {
            drawPendingOrderLabel(
              context,
              rects.label,
              getPendingOrderLabelText(drawing, pricePrecision),
              renderColor,
            );
            drawEstimatedLiquidationGuide(drawing, rects, renderColor);
            if (rects.estimated) {
              drawEstimatedLiquidationButton(context, rects.estimated, renderColor);
            }
            if (rects.estimatedHide) {
              drawEstimatedLiquidationHideButton(
                context,
                rects.estimatedHide,
                renderColor,
                drawing.estimatedLiquidationHidden === true,
              );
            }
            if (rects.chase) {
              drawPendingOrderChaseButton(context, rects.chase, renderColor, drawing.orderChasing);
            }
            if (rects.edit) {
              drawPendingOrderEditButton(context, rects.edit, renderColor);
            }

            const activeReduceEditor = reduceOrderEditorRef.current;
            if (activeReduceEditor?.drawingId === drawing.id && rects.edit) {
              /*
               * the old TP editor stored one click-time x/y coordinate, so
               * panning/zooming/resizing the chart left the popover floating in
               * its old screen position. Recalculate a clamped anchor from the
               * live TP line geometry during the canvas paint loop. Prefer below
               * the line, but flip above it near the bottom edge.
               */
              const preferredLeft = rects.edit.x + rects.edit.width - REDUCE_ORDER_EDITOR_WIDTH;
              const nextLeft = Math.max(
                8,
                Math.min(preferredLeft, Math.max(8, width - REDUCE_ORDER_EDITOR_WIDTH - 8)),
              );
              const belowTop = rects.edit.y + rects.edit.height + REDUCE_ORDER_EDITOR_GAP;
              const aboveTop = rects.edit.y - REDUCE_ORDER_EDITOR_HEIGHT - REDUCE_ORDER_EDITOR_GAP;
              const nextTop = Math.max(
                8,
                belowTop + REDUCE_ORDER_EDITOR_HEIGHT <= height - 8
                  ? belowTop
                  : Math.min(
                      Math.max(8, aboveTop),
                      Math.max(8, height - REDUCE_ORDER_EDITOR_HEIGHT - 8),
                    ),
              );

              if (
                Math.abs(activeReduceEditor.left - nextLeft) > 0.5 ||
                Math.abs(activeReduceEditor.top - nextTop) > 0.5
              ) {
                setReduceOrderEditor((current) => {
                  if (!current || current.drawingId !== drawing.id) return current;
                  const next = { ...current, left: nextLeft, top: nextTop };
                  reduceOrderEditorRef.current = next;
                  return next;
                });
              }
            }

            drawPendingOrderCancelButton(context, rects.cancel, renderColor);
          }
        }

        context.restore();
        continue;
      }

      if (drawing.type === "coordinate-marker") {
        const x = coord.timeToX(drawing.time);
        const y = priceToY(drawing.price);

        if (x === null || y === null) continue;

        // A persistent, one-quadrant crosshair: horizontal ray runs from
        // the anchor to the price scale, vertical ray from the anchor down
        // to the time axis. Clipping above keeps both rays inside the plot.
        drawLine(context, { x, y }, { x: paneSize.width, y }, drawing.color, selected, true);
        drawLine(context, { x, y }, { x, y: paneSize.height }, drawing.color, selected, true);

        context.save();
        context.beginPath();
        context.arc(x, y, selected ? 4.5 : 3.5, 0, Math.PI * 2);
        context.fillStyle = selected ? brightenColor(drawing.color) : drawing.color;
        context.fill();
        context.restore();
        continue;
      }

      if (drawing.type === "text") {
        const rect = getTextRect(drawing, coord);
        if (!rect) continue;

        const align = drawing.align ?? "left";

        const activeEditor = editingTextRef.current;
        if (activeEditor?.drawingId === drawing.id) {
          const editableRect = clampToEditablePane(rect, refs);
          const fontSize = getTextFontSize(
            editableRect.width,
            editableRect.height,
            activeEditor.value,
          );
          if (
            Math.abs(activeEditor.left - editableRect.left) > 0.5 ||
            Math.abs(activeEditor.top - editableRect.top) > 0.5 ||
            Math.abs(activeEditor.width - editableRect.width) > 0.5 ||
            Math.abs(activeEditor.height - editableRect.height) > 0.5 ||
            activeEditor.fontSize !== fontSize ||
            activeEditor.color !== drawing.color ||
            activeEditor.align !== align
          ) {
            setEditingText((previous) => {
              if (!previous || previous.drawingId !== drawing.id) return previous;
              const next = { ...previous, ...editableRect, fontSize, color: drawing.color, align };
              editingTextRef.current = next;
              return next;
            });
          }
          // The DOM editor replaces the canvas text while editing. Drawing both
          // caused the dark/duplicate text visible behind the selected input.
          continue;
        }

        const fontSize = getTextFontSize(rect.width, rect.height, drawing.text);

        // Canvas's own textAlign controls both which edge the text hugs
        // AND which x-coordinate fillText expects, so both have to change
        // together: "left" measures from the box's left edge, "center"
        // from its horizontal midpoint, "right" from its right edge.
        const textX =
          align === "center"
            ? rect.left + rect.width / 2
            : align === "right"
              ? rect.left + rect.width
              : rect.left;

        context.save();
        context.font = `500 ${fontSize}px Inter, "Helvetica Neue", Arial, sans-serif`;
        context.fillStyle = drawing.color;
        context.textAlign = align;
        context.textBaseline = "middle";
        context.fillText(drawing.text, textX, rect.top + rect.height / 2, rect.width);

        if (selected) {
          context.strokeStyle = brightenColor(drawing.color);
          context.lineWidth = 1.5;
          context.setLineDash([5, 4]);
          context.strokeRect(rect.left, rect.top, rect.width, rect.height);
          context.setLineDash([]);

          const handles = [
            [rect.left, rect.top],
            [rect.left + rect.width / 2, rect.top],
            [rect.left + rect.width, rect.top],
            [rect.left + rect.width, rect.top + rect.height / 2],
            [rect.left + rect.width, rect.top + rect.height],
            [rect.left + rect.width / 2, rect.top + rect.height],
            [rect.left, rect.top + rect.height],
            [rect.left, rect.top + rect.height / 2],
          ];
          context.fillStyle = brightenColor(drawing.color);
          for (const [hx, hy] of handles) context.fillRect(hx - 4, hy - 4, 8, 8);
        }
        context.restore();
        continue;
      }

      if (drawing.type === "pen") {
        const screenPoints = drawing.points
          .map((point) => coord.chartPointToScreen(point, false))
          .filter((point): point is ScreenPoint => point !== null);

        if (screenPoints.length < 2) continue;

        context.save();
        context.beginPath();
        context.strokeStyle = selected ? brightenColor(drawing.color) : drawing.color;
        context.lineWidth = selected ? 3 : 2;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.moveTo(screenPoints[0].x, screenPoints[0].y);

        for (let pointIndex = 1; pointIndex < screenPoints.length; pointIndex += 1) {
          context.lineTo(screenPoints[pointIndex].x, screenPoints[pointIndex].y);
        }

        context.stroke();
        context.restore();
        continue;
      }

      const start = coord.chartPointToScreen(drawing.start);
      const end = coord.chartPointToScreen(drawing.end);

      if (!start || !end) continue;

      if (drawing.type === "trend") {
        drawLine(context, start, end, drawing.color, selected);

        if (selected) {
          drawEndpointHandles(context, start, end, brightenColor(drawing.color));
        }

        continue;
      }

      const left = Math.min(start.x, end.x);
      const top = Math.min(start.y, end.y);
      const boxWidth = Math.abs(end.x - start.x);
      const boxHeight = Math.abs(end.y - start.y);

      context.save();
      context.fillStyle = hexToRgba(drawing.color, 0.18);
      context.strokeStyle = selected ? brightenColor(drawing.color) : drawing.color;
      context.lineWidth = selected ? 2.5 : 2;

      context.fillRect(left, top, boxWidth, boxHeight);
      context.strokeRect(left, top, boxWidth, boxHeight);

      context.restore();

      if (selected) {
        drawBoxHandles(context, start, end, brightenColor(drawing.color));
      }
    }

    for (const marker of refs.tradeMarkersRef.current) {
      const alignedTime = alignTimeToInterval(marker.time, refs.intervalRef.current);

      const loadedCandle = refs.loadedCandlesRef.current.find(
        (candle) => Number(candle.time) === Number(alignedTime),
      );

      const latestCandle = refs.lastCandleRef.current;
      const candle =
        loadedCandle ??
        (latestCandle && Number(latestCandle.time) === Number(alignedTime) ? latestCandle : null);

      if (!candle) continue;

      const x = coord.timeToX(alignedTime);
      const lowY = priceToY(candle.low);
      const highY = priceToY(candle.high);

      if (x === null || lowY === null || highY === null) continue;

      const anchor: ScreenPoint = {
        x,
        y: marker.side === "BUY" ? lowY : highY,
      };

      drawTradeMarker(
        anchor,
        marker.side,
        marker.side === "BUY" ? PENDING_LIMIT_LONG_COLOR : PENDING_LIMIT_SHORT_COLOR,
      );
    }

    const pendingStart = refs.pendingStartRef.current;
    const previewPoint = refs.previewPointRef.current;

    if (pendingStart && previewPoint) {
      const start = coord.chartPointToScreen(pendingStart);
      const end = coord.chartPointToScreen(previewPoint);

      if (start && end) {
        if (refs.toolRef.current === "trend") {
          context.save();
          context.globalAlpha = 0.75;
          drawLine(context, start, end, DEFAULT_LINE_COLOR, false);
          context.restore();
        }

        if (refs.toolRef.current === "box") {
          const left = Math.min(start.x, end.x);
          const top = Math.min(start.y, end.y);
          const boxWidth = Math.abs(end.x - start.x);
          const boxHeight = Math.abs(end.y - start.y);

          context.save();
          context.fillStyle = hexToRgba(DEFAULT_BOX_COLOR, 0.18);
          context.strokeStyle = DEFAULT_BOX_COLOR;
          context.lineWidth = 2;

          context.fillRect(left, top, boxWidth, boxHeight);
          context.strokeRect(left, top, boxWidth, boxHeight);

          context.restore();
        }
      }
    }

    const groupBox = refs.groupSelectionBoxRef.current;
    if (groupBox) {
      // transient marquee UI only - it is rendered by the canvas but
      // never enters drawingsRef/localStorage/history as a real drawing.
      const left = Math.min(groupBox.start.x, groupBox.end.x);
      const top = Math.min(groupBox.start.y, groupBox.end.y);
      const boxWidth = Math.abs(groupBox.end.x - groupBox.start.x);
      const boxHeight = Math.abs(groupBox.end.y - groupBox.start.y);
      context.save();
      context.setLineDash([6, 4]);
      context.lineWidth = 1.5;
      context.strokeStyle = "rgba(245, 166, 35, 0.95)";
      context.fillStyle = "rgba(245, 166, 35, 0.10)";
      context.fillRect(left, top, boxWidth, boxHeight);
      context.strokeRect(left, top, boxWidth, boxHeight);
      context.restore();
    }

    const rulerStart = refs.rulerStartRef.current;
    const rulerEnd = refs.rulerEndRef.current;

    if (rulerStart && rulerEnd) {
      const start = coord.chartPointToScreen(rulerStart);
      const end = coord.chartPointToScreen(rulerEnd);

      if (start && end && Number.isFinite(rulerStart.price) && rulerStart.price !== 0) {
        const left = Math.min(start.x, end.x);
        const top = Math.min(start.y, end.y);
        const rulerWidth = Math.abs(end.x - start.x);
        const rulerHeight = Math.abs(end.y - start.y);
        const percentage = ((rulerEnd.price - rulerStart.price) / rulerStart.price) * 100;
        const positive = percentage >= 0;
        const color = positive ? "#34d399" : "#f04562";
        const label = `${positive ? "+" : ""}${percentage.toFixed(2)}%`;

        context.save();
        context.fillStyle = positive ? "rgba(52, 211, 153, 0.14)" : "rgba(240, 69, 98, 0.14)";
        context.strokeStyle = color;
        context.lineWidth = 1.5;
        context.setLineDash([5, 4]);
        context.fillRect(left, top, rulerWidth, rulerHeight);
        context.strokeRect(
          left + 0.5,
          top + 0.5,
          Math.max(0, rulerWidth - 1),
          Math.max(0, rulerHeight - 1),
        );
        context.setLineDash([]);

        context.font = "700 12px 'JetBrains Mono', ui-monospace, monospace";
        const textWidth = context.measureText(label).width;
        const labelWidth = textWidth + 14;
        const labelHeight = 24;
        const labelX = Math.max(
          4,
          Math.min(left + rulerWidth / 2 - labelWidth / 2, paneSize.width - labelWidth - 4),
        );
        const preferredY = top + rulerHeight / 2 - labelHeight / 2;
        const labelY = Math.max(4, Math.min(preferredY, paneSize.height - labelHeight - 4));

        context.fillStyle = "rgba(11, 14, 20, 0.94)";
        context.fillRect(labelX, labelY, labelWidth, labelHeight);
        context.strokeStyle = color;
        context.lineWidth = 1;
        context.strokeRect(labelX + 0.5, labelY + 0.5, labelWidth - 1, labelHeight - 1);
        context.fillStyle = color;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(label, labelX + labelWidth / 2, labelY + labelHeight / 2 + 0.5);
        context.restore();
      }
    }

    context.restore();

    // Coordinate-marker axis badges are intentionally rendered AFTER the
    // plot-pane clip is restored. The rays themselves stay inside the pane,
    // while these two labels occupy the same right-price / bottom-time gutters
    // that the live crosshair uses, making the stored coordinate readable even
    // when the mouse has moved somewhere else.
    for (const drawing of refs.drawingsRef.current) {
      if (drawing.type !== "coordinate-marker") continue;

      const x = coord.timeToX(drawing.time);
      const y = priceToY(drawing.price);
      if (x === null || y === null) continue;

      const selected =
        refs.selectedIdRef.current === drawing.id ||
        refs.groupSelectedIdsRef.current.has(drawing.id);
      const color = selected ? brightenColor(drawing.color) : drawing.color;

      context.save();
      context.font = "600 11px 'JetBrains Mono', ui-monospace, monospace";
      context.textBaseline = "middle";

      if (y >= 0 && y <= paneSize.height && width > paneSize.width) {
        const priceText = drawing.price.toFixed(pricePrecision);
        const labelX = paneSize.width;
        const labelHeight = 20;
        const labelY = Math.max(0, Math.min(y - labelHeight / 2, height - labelHeight));

        context.fillStyle = "rgba(11, 14, 20, 0.96)";
        context.fillRect(labelX, labelY, width - labelX, labelHeight);
        context.strokeStyle = color;
        context.lineWidth = 1;
        context.strokeRect(
          labelX + 0.5,
          labelY + 0.5,
          Math.max(0, width - labelX - 1),
          labelHeight - 1,
        );
        context.fillStyle = color;
        /*
         * the coordinate-marker price used to be right-aligned five
         * pixels from the outer canvas edge, which made it look detached from
         * its badge and cramped against the viewport border. Center it inside
         * the actual price-scale gutter, matching a normal axis price label.
         */
        context.textAlign = "center";
        context.fillText(priceText, labelX + (width - labelX) / 2, labelY + labelHeight / 2 + 0.5);
      }

      if (x >= 0 && x <= paneSize.width && height > paneSize.height) {
        const timeText = localDateTimeFormatter.format(new Date(Number(drawing.time) * 1000));
        const labelHeight = height - paneSize.height;
        const textWidth = context.measureText(timeText).width;
        const labelWidth = Math.min(paneSize.width, Math.max(116, textWidth + 16));
        const labelX = Math.max(0, Math.min(x - labelWidth / 2, paneSize.width - labelWidth));

        context.fillStyle = "rgba(11, 14, 20, 0.96)";
        context.fillRect(labelX, paneSize.height, labelWidth, labelHeight);
        context.strokeStyle = color;
        context.lineWidth = 1;
        context.strokeRect(
          labelX + 0.5,
          paneSize.height + 0.5,
          labelWidth - 1,
          Math.max(0, labelHeight - 1),
        );
        context.fillStyle = color;
        context.textAlign = "center";
        context.fillText(
          timeText,
          labelX + labelWidth / 2,
          paneSize.height + labelHeight / 2 + 0.5,
        );
      }

      context.restore();
    }
  } catch (error) {
    console.error("[useDrawingCanvas] drawCanvas frame failed, retrying next frame:", error);
  }
}
