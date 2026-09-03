import type { Drawing, HorizontalDrawing } from "../../types/drawing";
import { priceToCoordinateWithFutureFallback } from "../../utils/chartPriceCoordinates";
import type { ChartRefs } from "../useChartRefs";

export const PENDING_ORDER_LABEL_HEIGHT = 20;
export const PENDING_ORDER_LABEL_PADDING_X = 8;
export const REDUCE_ORDER_EDITOR_WIDTH = 220;
export const REDUCE_ORDER_EDITOR_HEIGHT = 108;
export const REDUCE_ORDER_EDITOR_GAP = 8;
export const PENDING_ORDER_FONT = "600 11px 'JetBrains Mono', ui-monospace, monospace";

const PENDING_ORDER_CANCEL_SIZE = 20;
const PENDING_ORDER_EDIT_WIDTH = 38;
const PENDING_ORDER_CHASE_WIDTH = 48;
const PENDING_ORDER_EST_LIQ_HIDE_SIZE = 20;
const PENDING_ORDER_GAP = 4;
const PENDING_ORDER_EDGE_MARGIN = 10;

type Rect = { x: number; y: number; width: number; height: number };
type TextRect = Rect & { text: string };

export type PendingOrderRects = {
  label: Rect;
  estimated: TextRect | null;
  estimatedHide: Rect | null;
  edit: Rect | null;
  chase: Rect | null;
  cancel: Rect;
};

function baseAsset(symbol?: string): string {
  return symbol?.replace(/(?:USDT|USDC|BUSD)$/i, "") || "";
}

function formatOrderQuantity(quantity?: number): string {
  if (quantity == null || !Number.isFinite(quantity)) return "";
  return quantity.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 8,
  });
}

export function getPendingOrderLabelText(
  drawing: HorizontalDrawing,
  pricePrecision: number,
): string {
  if (drawing.orderIntent !== "REDUCE") {
    return drawing.price.toFixed(pricePrecision);
  }

  const pct = drawing.orderReducePct;
  const quantity = formatOrderQuantity(drawing.orderQuantity);
  const asset = baseAsset(drawing.orderSymbol);
  const remainingPct = drawing.orderRemainingPct;
  const left = remainingPct == null ? "" : ` · LEFT ${Math.max(0, remainingPct)}%`;
  const pctText = pct == null ? "TP" : `TP ${pct}%`;
  const quantityText = quantity ? ` · ${quantity}${asset ? ` ${asset}` : ""}` : "";

  return `${pctText}${quantityText}${left}`;
}

export function getPendingOrderRects(
  drawing: HorizontalDrawing,
  refs: ChartRefs,
  pricePrecision: number,
): PendingOrderRects | null {
  const chart = refs.chartRef.current;
  const series = refs.candleRef.current;
  const canvas = refs.canvasRef.current;
  if (!chart || !series || !canvas) return null;

  const y = priceToCoordinateWithFutureFallback(series, refs.futureScaleRef.current, drawing.price);
  if (y == null) return null;

  const context = canvas.getContext("2d");
  if (!context) return null;

  const labelText = getPendingOrderLabelText(drawing, pricePrecision);
  context.save();
  context.font = PENDING_ORDER_FONT;
  const textWidth = context.measureText(labelText).width;
  context.restore();

  const paneWidth = chart.paneSize().width;
  const isChaseable = drawing.orderIntent !== "REDUCE";
  const hasEstimatedLiquidation =
    drawing.orderIntent !== "REDUCE" &&
    drawing.estimatedLiquidationPrice != null &&
    Number.isFinite(drawing.estimatedLiquidationPrice) &&
    drawing.estimatedLiquidationPrice > 0;
  const estimatedText = hasEstimatedLiquidation
    ? `EST. LIQ. ${drawing.estimatedLiquidationPrice!.toFixed(pricePrecision)}`
    : "";

  context.save();
  context.font = PENDING_ORDER_FONT;
  const estimatedWidth = hasEstimatedLiquidation
    ? context.measureText(estimatedText).width + PENDING_ORDER_LABEL_PADDING_X * 2
    : 0;
  context.restore();

  const estimatedHideX = hasEstimatedLiquidation
    ? paneWidth - PENDING_ORDER_EDGE_MARGIN - PENDING_ORDER_EST_LIQ_HIDE_SIZE
    : null;
  const estimatedX = hasEstimatedLiquidation
    ? estimatedHideX! - PENDING_ORDER_GAP - estimatedWidth
    : null;
  const cancelX =
    (estimatedX ?? paneWidth - PENDING_ORDER_EDGE_MARGIN) -
    PENDING_ORDER_GAP -
    PENDING_ORDER_CANCEL_SIZE;
  const editX = isChaseable ? null : cancelX - PENDING_ORDER_GAP - PENDING_ORDER_EDIT_WIDTH;
  const chaseX = isChaseable ? cancelX - PENDING_ORDER_GAP - PENDING_ORDER_CHASE_WIDTH : null;
  const labelWidth = textWidth + PENDING_ORDER_LABEL_PADDING_X * 2;
  const controlsLeft = chaseX ?? editX ?? cancelX;
  const labelX = controlsLeft - PENDING_ORDER_GAP - labelWidth;
  const boxY = y - PENDING_ORDER_LABEL_HEIGHT / 2;

  return {
    label: {
      x: labelX,
      y: boxY,
      width: labelWidth,
      height: PENDING_ORDER_LABEL_HEIGHT,
    },
    estimated:
      estimatedX == null
        ? null
        : {
            x: estimatedX,
            y: boxY,
            width: estimatedWidth,
            height: PENDING_ORDER_LABEL_HEIGHT,
            text: estimatedText,
          },
    estimatedHide:
      estimatedHideX == null
        ? null
        : {
            x: estimatedHideX,
            y: boxY,
            width: PENDING_ORDER_EST_LIQ_HIDE_SIZE,
            height: PENDING_ORDER_LABEL_HEIGHT,
          },
    edit:
      editX == null
        ? null
        : {
            x: editX,
            y: boxY,
            width: PENDING_ORDER_EDIT_WIDTH,
            height: PENDING_ORDER_LABEL_HEIGHT,
          },
    chase:
      chaseX == null
        ? null
        : {
            x: chaseX,
            y: boxY,
            width: PENDING_ORDER_CHASE_WIDTH,
            height: PENDING_ORDER_LABEL_HEIGHT,
          },
    cancel: {
      x: cancelX,
      y: boxY,
      width: PENDING_ORDER_CANCEL_SIZE,
      height: PENDING_ORDER_LABEL_HEIGHT,
    },
  };
}

export type PendingOrderControl = "cancel" | "estimated" | "estimatedHide" | "edit" | "chase";

export function findPendingOrderControlHit(
  drawings: Drawing[],
  cancellingOrderIds: Set<string>,
  getRects: (drawing: HorizontalDrawing) => PendingOrderRects | null,
  control: PendingOrderControl,
  x: number,
  y: number,
): { drawing: HorizontalDrawing; rects: PendingOrderRects } | null {
  for (const drawing of drawings) {
    if (drawing.type !== "horizontal" || !drawing.orderSide) continue;
    if (control === "edit" && drawing.orderIntent !== "REDUCE") continue;
    if (cancellingOrderIds.has(drawing.id)) continue;

    const rects = getRects(drawing);
    const rect = rects?.[control];
    if (!rects || !rect) continue;

    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
      return { drawing, rects };
    }
  }

  return null;
}
