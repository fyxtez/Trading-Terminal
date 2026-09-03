import { useState } from "react";
import { intervals, type Interval } from "../../config/constants";
import type { ContextMenuState, Drawing } from "../../types/drawing";
import "../../styles/floatingPanel.css";
import "./ContextMenu.css";

const DRAWING_COLORS = [
  "#60a5fa",
  "#38bdf8",
  "#22d3ee",
  "#a78bfa",
  "#c084fc",
  "#f0f0f0",
  "#94a3b8",
  "#f5a623",
  "#fb923c",
  "#f04562",
  "#f472b6",
  "#34d399",
  "#2dd4bf",
];

const TEXT_ALIGN_OPTIONS = ["left", "center", "right"] as const;

/**
 * Small inline "lines" glyph per alignment, rather than pulling in an icon
 * library for three icons - the line lengths/positions are just enough to
 * read as left/center/right-aligned paragraph text at this size.
 */
function TextAlignIcon({ align }: { align: (typeof TEXT_ALIGN_OPTIONS)[number] }) {
  const lines =
    align === "left"
      ? [
          [3, 15],
          [3, 11],
          [3, 15],
        ]
      : align === "center"
        ? [
            [3, 15],
            [5, 13],
            [3, 15],
          ]
        : [
            [3, 15],
            [7, 15],
            [3, 15],
          ];

  return (
    <svg width="18" height="14" viewBox="0 0 18 14" fill="none" aria-hidden="true">
      {lines.map(([x1, x2], index) => (
        <line
          key={index}
          x1={x1}
          y1={3 + index * 4}
          x2={x2}
          y2={3 + index * 4}
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

type ContextMenuProps = {
  contextMenu: ContextMenuState;
  hasPenDrawings: boolean;
  hasDrawings: boolean;
  hasTradeMarkers: boolean;
  /**
   * How many regular (non-order-line) drawings exist per chart interval -
   * see drawingCountsByTimeframe in useDrawings.ts. Only intervals with
   * at least one drawing show up as keys. Drives which timeframe buttons
   * in the "Delete TF lines" submenu are enabled and their line counts.
   */
  drawingCountsByTimeframe: Partial<Record<Interval, number>>;
  /**
   * The full drawing the menu was opened on (looked up by contextMenu.drawingId
   * in App.tsx), null for the chart-background menu. Only used to decide
   * whether to show the Text align section and which option is currently
   * active - every other action below still takes contextMenu.drawingId
   * directly, unchanged.
   */
  targetDrawing: Drawing | null;
  onDeleteDrawing: (id: string) => void;
  onChangeColor: (id: string, color: string) => void;
  onChangeAlign: (id: string, align: "left" | "center" | "right") => void;
  /** Makes a trend line horizontal while retaining both X coordinates. */
  onStraightenOnXAxis: (id: string) => void;
  onStraightenSelectionOnXAxis: (ids: string[]) => void;
  onResetView: () => void;
  onDeleteAllPen: () => void;
  onDeleteAllDrawings: () => void;
  onDeleteDrawingsByTimeframe: (timeframe: Interval) => void;
  onDeleteAllTradeMarkers: () => void;
  /**
   * Creates a price alert at the price under the cursor when the menu
   * was opened (contextMenu.price - see types/drawing.ts). Only ever
   * called while that price is non-null; the button itself is disabled
   * otherwise (see the chart-menu branch below).
   */
  onCreateAlert: (price: number) => void;
  /** Creates a persistent L-shaped crosshair at the right-click coordinate. */
  onCreateCoordinateMarker: (time: number, price: number) => void;
  /**
   * Called after every action below fires, regardless of whether that
   * individual handler already happens to close the menu itself. This is
   * the single place that guarantees "any button click closes the menu" -
   * new buttons added later automatically get the same behavior without
   * needing to remember to call setContextMenu(null) themselves.
   */
  onClose: () => void;
};

export default function ContextMenu({
  contextMenu,
  hasPenDrawings,
  hasDrawings,
  hasTradeMarkers,
  drawingCountsByTimeframe,
  targetDrawing,
  onDeleteDrawing,
  onChangeColor,
  onChangeAlign,
  onStraightenOnXAxis,
  onStraightenSelectionOnXAxis,
  onResetView,
  onDeleteAllPen,
  onDeleteAllDrawings,
  onDeleteDrawingsByTimeframe,
  onDeleteAllTradeMarkers,
  onCreateAlert,
  onCreateCoordinateMarker,
  onClose,
}: ContextMenuProps) {
  const isDrawingMenu = Boolean(contextMenu.drawingId);
  const isGroupDrawingMenu = Boolean(contextMenu.drawingIds?.length);
  const canCreateAlertFromDrawing =
    targetDrawing?.type === "trend" ||
    targetDrawing?.type === "horizontal" ||
    targetDrawing?.type === "vertical";
  const drawingAlertPrice =
    targetDrawing?.type === "horizontal" ? targetDrawing.price : contextMenu.price;
  /*
   * Both reset to their defaults for free every time this menu opens,
   * since the chart-menu branch is only ever mounted while
   * drawingsApi.contextMenu is set (see App.tsx) - a fresh right-click
   * always starts back at the collapsed "Delete TF lines" button rather
   * than reopening mid-submenu or mid-confirmation from last time.
   */
  const [isTimeframeMenuOpen, setIsTimeframeMenuOpen] = useState(false);
  const [confirmingTimeframe, setConfirmingTimeframe] = useState<Interval | null>(null);

  return (
    <div
      className={`context-menu ${isDrawingMenu ? "context-menu-drawing" : "context-menu-chart"}`}
      style={{ left: contextMenu.x, top: contextMenu.y }}
      onClick={(event) => event.stopPropagation()}
    >
      {isDrawingMenu ? (
        <>
          {isGroupDrawingMenu ? (
            <button
              className="context-action"
              onClick={() => {
                onStraightenSelectionOnXAxis(contextMenu.drawingIds!);
                onClose();
              }}
            >
              Straighten selected on X axis
            </button>
          ) : (
            canCreateAlertFromDrawing && (
              <>
                <button
                  className="context-action"
                  disabled={drawingAlertPrice === null}
                  onClick={() => {
                    onCreateAlert(drawingAlertPrice!);
                    onClose();
                  }}
                >
                  Create alert
                </button>

                <div className="context-separator" />
              </>
            )
          )}

          {!isGroupDrawingMenu && targetDrawing?.type === "trend" && (
            <>
              <button
                className="context-action"
                disabled={targetDrawing.start.price === targetDrawing.end.price}
                onClick={() => {
                  onStraightenOnXAxis(contextMenu.drawingId!);
                  onClose();
                }}
              >
                Straighten on X axis
              </button>

              <div className="context-separator" />
            </>
          )}

          {!isGroupDrawingMenu && (
            <button
              className="context-delete"
              onClick={() => {
                onDeleteDrawing(contextMenu.drawingId!);
                onClose();
              }}
            >
              Delete drawing
            </button>
          )}

          {!isGroupDrawingMenu && <div className="context-separator" />}

          {!isGroupDrawingMenu && (
            <>
              <div className="context-label">Line color</div>
              <div className="color-row">
                {DRAWING_COLORS.map((color) => (
                  <button
                    key={color}
                    className="color-button"
                    style={{ backgroundColor: color }}
                    aria-label={`Set drawing color to ${color}`}
                    title={color}
                    onClick={() => {
                      onChangeColor(contextMenu.drawingId!, color);
                      onClose();
                    }}
                  />
                ))}
              </div>
            </>
          )}

          {!isGroupDrawingMenu && targetDrawing?.type === "text" && (
            <>
              <div className="context-separator" />

              <div className="context-label">Text align</div>
              <div className="context-align-row">
                {TEXT_ALIGN_OPTIONS.map((align) => (
                  <button
                    key={align}
                    className={`context-align-button ${
                      (targetDrawing.align ?? "left") === align ? "context-align-active" : ""
                    }`}
                    aria-label={`Align text ${align}`}
                    title={`Align ${align}`}
                    onClick={() => {
                      onChangeAlign(contextMenu.drawingId!, align);
                      onClose();
                    }}
                  >
                    <TextAlignIcon align={align} />
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <button
            className="context-action"
            onClick={() => {
              onResetView();
              onClose();
            }}
          >
            Reset chart view
          </button>

          <button
            className="context-action"
            disabled={contextMenu.price === null}
            onClick={() => {
              onCreateAlert(contextMenu.price!);
              onClose();
            }}
          >
            Create alert
          </button>

          <button
            className="context-action"
            disabled={contextMenu.price === null || contextMenu.time === null}
            onClick={() => {
              onCreateCoordinateMarker(contextMenu.time!, contextMenu.price!);
              onClose();
            }}
          >
            Create crosshair marker
          </button>

          <div className="context-separator" />

          <button
            className="context-action context-danger"
            disabled={!hasPenDrawings}
            onClick={() => {
              onDeleteAllPen();
              onClose();
            }}
          >
            Delete all pen drawings
          </button>

          <button
            className="context-action context-danger"
            disabled={!hasDrawings}
            onClick={() => {
              onDeleteAllDrawings();
              onClose();
            }}
          >
            Delete all drawings
          </button>

          <div className="context-separator" />

          {confirmingTimeframe ? (
            <div className="context-confirm">
              <div className="context-confirm-label">
                Delete {drawingCountsByTimeframe[confirmingTimeframe] ?? 0} {confirmingTimeframe}{" "}
                line
                {(drawingCountsByTimeframe[confirmingTimeframe] ?? 0) === 1 ? "" : "s"}?
              </div>
              <div className="context-confirm-actions">
                <button
                  className="context-confirm-yes"
                  onClick={() => {
                    onDeleteDrawingsByTimeframe(confirmingTimeframe);
                    onClose();
                  }}
                >
                  Yes
                </button>
                <button className="context-confirm-no" onClick={() => setConfirmingTimeframe(null)}>
                  No
                </button>
              </div>
            </div>
          ) : isTimeframeMenuOpen ? (
            <>
              <div className="context-label">Delete TF lines</div>
              <div className="context-tf-grid">
                {intervals.map((interval) => {
                  const count = drawingCountsByTimeframe[interval] ?? 0;
                  return (
                    <button
                      key={interval}
                      className="context-tf-button"
                      disabled={count === 0}
                      onClick={() => setConfirmingTimeframe(interval)}
                    >
                      <span className="context-tf-label">{interval}</span>
                      <span className="context-tf-count">{count > 0 ? count : "\u2013"}</span>
                    </button>
                  );
                })}
              </div>
              <button className="context-action" onClick={() => setIsTimeframeMenuOpen(false)}>
                Back
              </button>
            </>
          ) : (
            <button
              className="context-action context-danger"
              disabled={!hasDrawings}
              onClick={() => setIsTimeframeMenuOpen(true)}
            >
              Delete TF lines
            </button>
          )}

          <div className="context-separator" />

          <button
            className="context-action context-danger"
            disabled={!hasTradeMarkers}
            onClick={() => {
              onDeleteAllTradeMarkers();
              onClose();
            }}
          >
            Remove all markers
          </button>
        </>
      )}
    </div>
  );
}
