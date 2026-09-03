import type { UTCTimestamp } from "lightweight-charts";
import type { BoxDrawing, DragState, Drawing, ScreenPoint, TextDrawing } from "../../types/drawing";
import { priceToCoordinateWithFutureFallback } from "../../utils/chartPriceCoordinates";
import type { ChartRefs } from "../useChartRefs";
import type { CoordinateMapping } from "../useCoordinateMapping";

export type BoxHandleMode = Extract<DragState["mode"], `box-${string}`>;

export type ScreenRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ScreenBounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export function isOrderDrawing(drawing: Drawing): boolean {
  return (
    drawing.type === "horizontal" &&
    (drawing.orderId !== undefined || drawing.orderSide !== undefined)
  );
}

export function reduceOrderBoundaryStep(
  marketPrice: number,
  tickSize: number,
  pricePrecision: number,
): number {
  if (Number.isFinite(tickSize) && tickSize > 0 && tickSize < marketPrice) {
    return tickSize;
  }

  const precisionStep = 10 ** -Math.max(0, pricePrecision);
  if (precisionStep > 0 && precisionStep < marketPrice) {
    return precisionStep;
  }

  return Math.max(Number.EPSILON, marketPrice * 0.001);
}

export function computeBoxResize(
  original: BoxDrawing,
  mode: BoxHandleMode,
  cursor: { time: UTCTimestamp; price: number },
): {
  start: { time: UTCTimestamp; price: number };
  end: { time: UTCTimestamp; price: number };
} {
  const leftTime = Math.min(Number(original.start.time), Number(original.end.time)) as UTCTimestamp;
  const rightTime = Math.max(
    Number(original.start.time),
    Number(original.end.time),
  ) as UTCTimestamp;
  const topPrice = Math.max(original.start.price, original.end.price);
  const bottomPrice = Math.min(original.start.price, original.end.price);

  if (
    mode === "box-top-left" ||
    mode === "box-top-right" ||
    mode === "box-bottom-left" ||
    mode === "box-bottom-right"
  ) {
    let opposite: { time: UTCTimestamp; price: number };

    if (mode === "box-top-left") {
      opposite = { time: rightTime, price: bottomPrice };
    } else if (mode === "box-top-right") {
      opposite = { time: leftTime, price: bottomPrice };
    } else if (mode === "box-bottom-left") {
      opposite = { time: rightTime, price: topPrice };
    } else {
      opposite = { time: leftTime, price: topPrice };
    }

    return { start: { ...cursor }, end: opposite };
  }

  let nextLeftTime = leftTime;
  let nextRightTime = rightTime;
  let nextTopPrice = topPrice;
  let nextBottomPrice = bottomPrice;

  if (mode === "box-left") nextLeftTime = cursor.time;
  if (mode === "box-right") nextRightTime = cursor.time;
  if (mode === "box-top") nextTopPrice = cursor.price;
  if (mode === "box-bottom") nextBottomPrice = cursor.price;

  return {
    start: { time: nextLeftTime, price: nextTopPrice },
    end: { time: nextRightTime, price: nextBottomPrice },
  };
}

export function translateDrawing(drawing: Drawing, timeDelta: number, priceDelta: number): Drawing {
  const moveTime = (time: UTCTimestamp) => Math.round(Number(time) + timeDelta) as UTCTimestamp;

  if (drawing.type === "vertical") {
    return { ...drawing, time: moveTime(drawing.time) };
  }
  if (drawing.type === "horizontal") {
    return { ...drawing, price: drawing.price + priceDelta };
  }
  if (drawing.type === "coordinate-marker") {
    return {
      ...drawing,
      time: moveTime(drawing.time),
      price: drawing.price + priceDelta,
    };
  }
  if (drawing.type === "pen") {
    return {
      ...drawing,
      points: drawing.points.map((point) => ({
        time: moveTime(point.time),
        price: point.price + priceDelta,
      })),
    };
  }

  return {
    ...drawing,
    start: {
      time: moveTime(drawing.start.time),
      price: drawing.start.price + priceDelta,
    },
    end: {
      time: moveTime(drawing.end.time),
      price: drawing.end.price + priceDelta,
    },
  };
}

export function getTextRect(drawing: TextDrawing, coord: CoordinateMapping): ScreenRect | null {
  const minBoxSize = 18;
  const start = coord.chartPointToScreen(drawing.start);
  const end = coord.chartPointToScreen(drawing.end);
  if (!start || !end) return null;

  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    width: Math.max(minBoxSize, Math.abs(end.x - start.x)),
    height: Math.max(minBoxSize, Math.abs(end.y - start.y)),
  };
}

function drawingScreenBounds(
  drawing: Drawing,
  refs: ChartRefs,
  coord: CoordinateMapping,
): ScreenBounds | null {
  const pane = refs.chartRef.current?.paneSize();
  if (!pane) return null;

  if (drawing.type === "vertical") {
    const x = coord.timeToX(drawing.time);
    return x == null ? null : { left: x, right: x, top: 0, bottom: pane.height };
  }
  if (drawing.type === "horizontal") {
    const series = refs.candleRef.current;
    const y = series
      ? priceToCoordinateWithFutureFallback(series, refs.futureScaleRef.current, drawing.price)
      : null;
    return y == null ? null : { left: 0, right: pane.width, top: y, bottom: y };
  }
  if (drawing.type === "coordinate-marker") {
    const point = coord.chartPointToScreen(drawing);
    return point ? { left: point.x, right: point.x, top: point.y, bottom: point.y } : null;
  }
  if (drawing.type === "pen") {
    const points = drawing.points
      .map((point) => coord.chartPointToScreen(point))
      .filter((point): point is ScreenPoint => point !== null);
    if (points.length === 0) return null;
    return {
      left: Math.min(...points.map((point) => point.x)),
      right: Math.max(...points.map((point) => point.x)),
      top: Math.min(...points.map((point) => point.y)),
      bottom: Math.max(...points.map((point) => point.y)),
    };
  }
  if (drawing.type === "text") {
    const rect = getTextRect(drawing, coord);
    return rect
      ? {
          left: rect.left,
          right: rect.left + rect.width,
          top: rect.top,
          bottom: rect.top + rect.height,
        }
      : null;
  }

  const start = coord.chartPointToScreen(drawing.start);
  const end = coord.chartPointToScreen(drawing.end);
  if (!start || !end) return null;
  return {
    left: Math.min(start.x, end.x),
    right: Math.max(start.x, end.x),
    top: Math.min(start.y, end.y),
    bottom: Math.max(start.y, end.y),
  };
}

export function drawingIntersectsMarquee(
  drawing: Drawing,
  marquee: ScreenBounds,
  refs: ChartRefs,
  coord: CoordinateMapping,
): boolean {
  const pointInside = (point: ScreenPoint) =>
    point.x >= marquee.left &&
    point.x <= marquee.right &&
    point.y >= marquee.top &&
    point.y <= marquee.bottom;

  const orientation = (a: ScreenPoint, b: ScreenPoint, c: ScreenPoint) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const segmentCrosses = (a: ScreenPoint, b: ScreenPoint, c: ScreenPoint, d: ScreenPoint) => {
    const abC = orientation(a, b, c);
    const abD = orientation(a, b, d);
    const cdA = orientation(c, d, a);
    const cdB = orientation(c, d, b);
    const boundsOverlap =
      Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <=
        Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) &&
      Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <=
        Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
    return boundsOverlap && abC * abD <= 0 && cdA * cdB <= 0;
  };
  const segmentIntersects = (start: ScreenPoint, end: ScreenPoint) => {
    if (pointInside(start) || pointInside(end)) return true;
    const topLeft = { x: marquee.left, y: marquee.top };
    const topRight = { x: marquee.right, y: marquee.top };
    const bottomRight = { x: marquee.right, y: marquee.bottom };
    const bottomLeft = { x: marquee.left, y: marquee.bottom };
    return (
      segmentCrosses(start, end, topLeft, topRight) ||
      segmentCrosses(start, end, topRight, bottomRight) ||
      segmentCrosses(start, end, bottomRight, bottomLeft) ||
      segmentCrosses(start, end, bottomLeft, topLeft)
    );
  };

  if (drawing.type === "trend") {
    const start = coord.chartPointToScreen(drawing.start);
    const end = coord.chartPointToScreen(drawing.end);
    return start !== null && end !== null && segmentIntersects(start, end);
  }

  if (drawing.type === "pen") {
    const points = drawing.points
      .map((point) => coord.chartPointToScreen(point))
      .filter((point): point is ScreenPoint => point !== null);
    if (points.length === 1) return pointInside(points[0]);
    for (let index = 1; index < points.length; index += 1) {
      if (segmentIntersects(points[index - 1], points[index])) return true;
    }
    return false;
  }

  const bounds = drawingScreenBounds(drawing, refs, coord);
  return (
    bounds !== null &&
    bounds.right >= marquee.left &&
    bounds.left <= marquee.right &&
    bounds.bottom >= marquee.top &&
    bounds.top <= marquee.bottom
  );
}

export function clampToEditablePane(rect: ScreenRect, refs: ChartRefs): ScreenRect {
  const paneSize = refs.chartRef.current?.paneSize();
  if (!paneSize) return rect;

  const maxWidth = Math.max(18, paneSize.width - Math.max(0, rect.left));
  const maxHeight = Math.max(18, paneSize.height - Math.max(0, rect.top));

  return {
    left: rect.left,
    top: rect.top,
    width: Math.min(rect.width, maxWidth),
    height: Math.min(rect.height, maxHeight),
  };
}
