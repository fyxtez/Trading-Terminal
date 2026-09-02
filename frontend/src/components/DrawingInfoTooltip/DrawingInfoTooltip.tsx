import type { Drawing } from "../../types/drawing";
import "./DrawingInfoTooltip.css";

type DrawingInfoTooltipProps = {
  drawing: Drawing;
  /** Wrap-relative mouse position the popup anchors itself to (top-left offset from here). */
  x: number;
  y: number;
};

/**
 * Small "info card" shown after hovering a drawing for HOVER_INFO_DELAY_MS
 * (see useDrawingCanvas.ts). Currently only shows the chart interval the
 * drawing was created on (drawing.timeframe - see the comment on that
 * field in types/drawing.ts for how/when it gets set), but built as a
 * list of label/value rows so more facts can be added later without
 * restructuring this component.
 */
export default function DrawingInfoTooltip({
  drawing,
  x,
  y,
}: DrawingInfoTooltipProps) {
  return (
    <div
      className="drawing-info-tooltip"
      style={{ left: x, top: y }}
      aria-hidden="true"
    >
      <div className="drawing-info-row">
        <span className="drawing-info-label">Timeframe</span>
        <span className="drawing-info-value">
          {drawing.timeframe ?? "—"}
        </span>
      </div>
    </div>
  );
}
