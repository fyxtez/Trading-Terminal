import type { UTCTimestamp } from "lightweight-charts";
import type { Interval } from "../config/constants";
import type { TradeSide } from "../trading/types";

export type DrawingTool =
  | "cursor"
  | "vertical"
  | "horizontal"
  | "trend"
  | "box"
  | "group-select"
  | "ruler"
  | "text"
  | "pen";

export type ChartPoint = {
  time: UTCTimestamp;
  price: number;
};

export type ScreenPoint = {
  x: number;
  y: number;
};

export type VerticalDrawing = {
  id: string;
  type: "vertical";
  time: UTCTimestamp;
  color: string;
  /**
   * The chart interval that was active at the moment this drawing was
   * created (see useDrawings.ts's addDrawing) - "1m", "15m", "4h", etc.
   * Every drawing type below carries the same field for the same reason:
   * it's shown in DrawingInfoTooltip.tsx after hovering a drawing for a
   * moment, and is the first of what may become several recorded facts
   * about a drawing's creation context. Optional only so drawings saved
   * to localStorage before this field existed still load without it -
   * see loadStoredDrawings in utils/drawings.ts.
   */
  timeframe?: Interval;
};

export type HorizontalDrawing = {
  id: string;
  type: "horizontal";
  price: number;
  color: string;
  /** Present only when this line represents a real Binance limit order. */
  orderSide?: TradeSide;
  /** Kept as a string, not number - see safeJson.ts's parseOrderJsonText. */
  orderId?: string;
  clientOrderId?: string;
  orderSymbol?: string;
  orderQuantity?: number;
  timeInForce?: "GTC" | "IOC" | "FOK" | "GTX";
  orderIntent?: "ENTRY" | "ADD" | "REDUCE";
  orderReducePct?: number;
  orderRemainingPct?: number;
  orderPricePending?: boolean;
  orderChasing?: boolean;
  /** projected isolated liquidation while this entry LIMIT is resting. */
  estimatedLiquidationPrice?: number;
  /** hides only the projected liquidation guide, never the order line. */
  estimatedLiquidationHidden?: boolean;
  timeframe?: Interval;
};

export type CoordinateMarkerDrawing = {
  id: string;
  type: "coordinate-marker";
  /** Persistent chart coordinate whose rays extend right to price and down to time. */
  time: UTCTimestamp;
  price: number;
  color: string;
  timeframe?: Interval;
};

export type TrendDrawing = {
  id: string;
  type: "trend";
  start: ChartPoint;
  end: ChartPoint;
  color: string;
  timeframe?: Interval;
};

export type BoxDrawing = {
  id: string;
  type: "box";
  start: ChartPoint;
  end: ChartPoint;
  color: string;
  timeframe?: Interval;
};

export type TextDrawing = {
  id: string;
  type: "text";
  /**
   * Top-left and bottom-right chart anchors - the same shape as Trend/Box.
   * The box scales with the chart under zoom exactly like they do, instead
   * of staying a fixed on-screen pixel size. Font size is derived from the
   * resulting on-screen box each render and clamped between a floor and
   * ceiling (see getTextFontSize in utils/drawings.ts) so it stays
   * readable rather than becoming a giant blob when zoomed in or an
   * unreadable speck when zoomed out.
   */
  start: ChartPoint;
  end: ChartPoint;
  text: string;
  color: string;
  /**
   * Horizontal placement of the text within its box. Optional so drawings
   * saved before this field existed still load fine (see normalizeDrawing
   * in utils/drawings.ts) - undefined is treated the same as "left"
   * everywhere this is read.
   */
  align?: "left" | "center" | "right";
  timeframe?: Interval;
};

export type PenDrawing = {
  id: string;
  type: "pen";
  points: ChartPoint[];
  color: string;
  timeframe?: Interval;
};

export type Drawing =
  | VerticalDrawing
  | HorizontalDrawing
  | CoordinateMarkerDrawing
  | TrendDrawing
  | BoxDrawing
  | TextDrawing
  | PenDrawing;

export type SavedDrawingSet = {
  id: string;
  name: string;
  drawings: Drawing[];
  createdAt: number;
  updatedAt: number;
};

export type HistoryAction = (
  | {
      type: "add";
      drawing: Drawing;
    }
  | {
      type: "delete";
      drawing: Drawing;
    }
  | {
      type: "update";
      before: Drawing;
      after: Drawing;
    }
) & {
  /**
   * Stamped by useDrawings.ts's pushHistory from the shared
   * refs.historySeqRef counter (see useChartRefs.ts) - a single
   * monotonically increasing counter shared with price alerts' own
   * undo/redo stack (see AlertHistoryAction in types/alert.ts). This is
   * what lets Ctrl+Z/Ctrl+Y (see useHotkeys.ts) always undo/redo
   * whichever of the two systems' actions actually happened most
   * recently, instead of always preferring one over the other.
   */
  seq: number;
};

export type DragState = {
  drawingId: string;
  before: Drawing;
  pointerStart: ChartPoint;
  mode:
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
    | "text-left";
};

export type ContextMenuState = {
  x: number;
  y: number;
  drawingId: string | null;
  /** Snapshot of the active marquee selection when its menu was opened. */
  drawingIds?: string[];
  /**
   * The chart price under the cursor at the moment this menu was opened
   * (see screenToChartPoint in useCoordinateMapping.ts), used by the
   * chart-menu branch's "Create alert" button. Null whenever it couldn't
   * be resolved (e.g. right-clicking outside the plotted price range) -
   * that button is disabled in that case rather than creating an alert
   * at a meaningless price.
   */
  price: number | null;
  /** Chart timestamp under the cursor when the menu opened. */
  time: UTCTimestamp | null;
};
