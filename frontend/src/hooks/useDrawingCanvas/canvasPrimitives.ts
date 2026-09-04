import type { ScreenPoint } from "../../types/drawing";
import { brightenColor } from "../../utils/geometry";
import {
  PENDING_ORDER_FONT,
  PENDING_ORDER_LABEL_PADDING_X,
  type PendingOrderRects,
} from "./pendingOrderLayout";

type Rect = { x: number; y: number; width: number; height: number };

type PenPathContext = Pick<CanvasRenderingContext2D, "bezierCurveTo" | "lineTo" | "moveTo">;

const PEN_CORNER_CUTTING_PASSES = 2;

/**
 * Chaikin corner cutting is deliberately done in screen space. The stored pen
 * points must stay in chart coordinates so they continue to follow zoom/pan,
 * but those coordinates can map back to a small pixel staircase. Two light
 * passes remove that quantisation without changing either end of an open
 * stroke or permanently rewriting the user's drawing.
 */
function softenPenCorners(points: readonly ScreenPoint[]): ScreenPoint[] {
  let softened = points.map((point) => ({ ...point }));

  for (let pass = 0; pass < PEN_CORNER_CUTTING_PASSES; pass += 1) {
    if (softened.length < 3) break;

    const next: ScreenPoint[] = [{ ...softened[0] }];

    for (let index = 0; index < softened.length - 1; index += 1) {
      const current = softened[index];
      const following = softened[index + 1];

      next.push(
        {
          x: current.x * 0.75 + following.x * 0.25,
          y: current.y * 0.75 + following.y * 0.25,
        },
        {
          x: current.x * 0.25 + following.x * 0.75,
          y: current.y * 0.25 + following.y * 0.75,
        },
      );
    }

    next.push({ ...softened[softened.length - 1] });
    softened = next;
  }

  return softened;
}

/**
 * Trace a freehand stroke guided by every captured point while rounding the
 * joins between them. Pointer events are not guaranteed to arrive for every
 * hardware sample, so connecting sparse samples with lineTo leaves visible
 * polygon edges on small circles. Screen-space corner cutting first removes
 * small horizontal/vertical quantisation steps; Catmull-Rom-to-Bezier then
 * gives all remaining adjacent segments a continuous tangent.
 */
export function traceSmoothPenPath(context: PenPathContext, points: ScreenPoint[]): void {
  if (points.length === 0) return;

  context.moveTo(points[0].x, points[0].y);

  if (points.length === 1) return;
  if (points.length === 2) {
    context.lineTo(points[1].x, points[1].y);
    return;
  }

  const softened = softenPenCorners(points);

  for (let index = 0; index < softened.length - 1; index += 1) {
    const previous = softened[Math.max(0, index - 1)];
    const current = softened[index];
    const next = softened[index + 1];
    const following = softened[Math.min(softened.length - 1, index + 2)];

    context.bezierCurveTo(
      current.x + (next.x - previous.x) / 6,
      current.y + (next.y - previous.y) / 6,
      next.x - (following.x - current.x) / 6,
      next.y - (following.y - current.y) / 6,
      next.x,
      next.y,
    );
  }
}

export function drawLine(
  context: CanvasRenderingContext2D,
  start: ScreenPoint,
  end: ScreenPoint,
  color: string,
  selected: boolean,
  dashed = false,
  emphasized = false,
  brighten = selected,
): void {
  context.save();
  context.beginPath();
  context.strokeStyle = brighten ? brightenColor(color) : color;
  context.lineWidth = emphasized ? 4 : selected ? 2.5 : 2;
  if (emphasized) {
    context.shadowColor = color;
    context.shadowBlur = 10;
  }
  context.lineCap = "round";
  context.setLineDash(dashed ? [7, 5] : []);
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.stroke();
  context.restore();
}

export function drawEndpointHandles(
  context: CanvasRenderingContext2D,
  start: ScreenPoint,
  end: ScreenPoint,
  color: string,
): void {
  context.save();
  context.fillStyle = color;
  context.fillRect(start.x - 4, start.y - 4, 8, 8);
  context.fillRect(end.x - 4, end.y - 4, 8, 8);
  context.restore();
}

export function drawBoxHandles(
  context: CanvasRenderingContext2D,
  start: ScreenPoint,
  end: ScreenPoint,
  color: string,
): void {
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);

  context.save();
  context.fillStyle = color;
  for (const point of [
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom },
    { x: (left + right) / 2, y: top },
    { x: right, y: (top + bottom) / 2 },
    { x: (left + right) / 2, y: bottom },
    { x: left, y: (top + bottom) / 2 },
  ]) {
    context.fillRect(point.x - 4, point.y - 4, 8, 8);
  }
  context.restore();
}

export function drawPendingOrderLabel(
  context: CanvasRenderingContext2D,
  rect: Rect,
  text: string,
  color: string,
): void {
  context.save();
  context.fillStyle = color;
  context.fillRect(rect.x, rect.y, rect.width, rect.height);
  context.fillStyle = "#0b0e14";
  context.font = PENDING_ORDER_FONT;
  context.textBaseline = "middle";
  context.textAlign = "left";
  context.fillText(text, rect.x + PENDING_ORDER_LABEL_PADDING_X, rect.y + rect.height / 2 + 1);
  context.restore();
}

export function drawPendingOrderCancelButton(
  context: CanvasRenderingContext2D,
  rect: Rect,
  color: string,
): void {
  context.save();
  context.fillStyle = "#10141b";
  context.fillRect(rect.x, rect.y, rect.width, rect.height);
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
  context.fillStyle = color;
  context.font = "700 12px 'JetBrains Mono', ui-monospace, monospace";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("×", rect.x + rect.width / 2, rect.y + rect.height / 2 + 1);
  context.restore();
}

function drawOutlinedButton(
  context: CanvasRenderingContext2D,
  rect: Rect,
  color: string,
  text: string,
): void {
  context.save();
  context.fillStyle = "rgba(13, 16, 23, 0.96)";
  context.fillRect(rect.x, rect.y, rect.width, rect.height);
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
  context.fillStyle = color;
  context.font = "700 8px 'JetBrains Mono', ui-monospace, monospace";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, rect.x + rect.width / 2, rect.y + rect.height / 2 + 0.5);
  context.restore();
}

export function drawPendingOrderEditButton(
  context: CanvasRenderingContext2D,
  rect: Rect,
  color: string,
): void {
  drawOutlinedButton(context, rect, color, "EDIT");
}

export function drawPendingOrderChaseButton(
  context: CanvasRenderingContext2D,
  rect: Rect,
  color: string,
  isChasing = false,
): void {
  drawOutlinedButton(context, rect, color, isChasing ? "..." : "CHASE");
}

export function drawEstimatedLiquidationButton(
  context: CanvasRenderingContext2D,
  rect: NonNullable<PendingOrderRects["estimated"]>,
  color: string,
): void {
  context.save();
  context.fillStyle = "rgba(13, 16, 23, 0.96)";
  context.fillRect(rect.x, rect.y, rect.width, rect.height);
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
  context.fillStyle = color;
  context.font = PENDING_ORDER_FONT;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(rect.text, rect.x + rect.width / 2, rect.y + rect.height / 2 + 0.5);
  context.restore();
}

export function drawEstimatedLiquidationHideButton(
  context: CanvasRenderingContext2D,
  rect: Rect,
  color: string,
  hidden: boolean,
): void {
  context.save();
  context.fillStyle = "rgba(13, 16, 23, 0.96)";
  context.fillRect(rect.x, rect.y, rect.width, rect.height);
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.globalAlpha *= 0.72;
  context.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);

  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  context.beginPath();
  context.ellipse(cx, cy, 5.2, 3.4, 0, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.arc(cx, cy, 1.4, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
  if (!hidden) {
    context.beginPath();
    context.moveTo(cx - 5.5, cy - 5.5);
    context.lineTo(cx + 5.5, cy + 5.5);
    context.stroke();
  }
  context.restore();
}
