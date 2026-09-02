import { useEffect, useRef, useState } from "react";
import type { MutableRefObject, PointerEvent as ReactPointerEvent } from "react";
import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { AlertPattern, PriceAlert } from "../../types/alert";
import { startPacedLoop } from "../../utils/pacedLoop";
import {
  coordinateToPriceWithFutureFallback,
  priceToCoordinateWithFutureFallback,
} from "../../utils/chartPriceCoordinates";
import "./AlertLinesOverlay.css";

type AlertLinesOverlayProps = {
  chartWrapRef: MutableRefObject<HTMLDivElement | null>;
  chartRef: MutableRefObject<IChartApi | null>;
  candleRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>;
  futureScaleRef: MutableRefObject<ISeriesApi<"Line"> | null>;
  alerts: PriceAlert[];
  pricePrecision: number;
  onRemoveAlert: (id: string) => void;
  /**
   * Called once, on the confirming click, after the user repositions an
   * alert line - see the click-move-click flow below.
   */
  onUpdateAlertPrice: (id: string, price: number) => void;
  onToggleAlertSide: (id: string) => void;
  onSetAlertPattern: (id: string, pattern: AlertPattern) => void;
  onSetAlertAdditionalInfo: (id: string, additionalInfo: string) => void;
  onToggleAlertLocked: (id: string) => void;
  onToggleAlertHidden: (id: string) => void;
};

type PositionedAlert = {
  id: string;
  y: number;
  price: number;
  side: PriceAlert["side"];
  pattern: AlertPattern;
  additionalInfo: string;
  locked: boolean;
  hidden: boolean;
};

const PATTERN_OPTIONS: { value: AlertPattern; label: string }[] = [
  { value: "none", label: "None" },
  { value: "breakout", label: "Breakout" },
  { value: "breakdown", label: "Breakdown" },
  { value: "support", label: "Support" },
  { value: "resistance", label: "Resistance" },
  { value: "retest", label: "Retest" },
  { value: "sweep", label: "Sweep" },
];

function formatAlertPrice(price: number, pricePrecision: number): string {
  return price.toLocaleString(undefined, {
    minimumFractionDigits: pricePrecision,
    maximumFractionDigits: pricePrecision,
  });
}

/**
 * A grey, semi-transparent line at each pending price alert's level -
 * created from the chart's right-click menu (see ContextMenu.tsx's
 * "Create alert" button). Deliberately NOT a regular drawing
 * (types/drawing.ts's Drawing union): it can't be colored or picked up
 * by findDrawingAt, it just sits there showing where the alert will
 * fire, repositionable to retarget its price and with an "x" to cancel
 * it early.
 *
 * Repositioning uses click-move-click, not press-and-hold-drag - the
 * exact same interaction PositionBracketOverlay's TP/SL placement uses
 * (see its beginDrag/finishDrag): click the line once to "pick it up",
 * move the mouse freely (no button held), then click again anywhere to
 * drop it at the new price. Escape or a right-click cancels instead.
 *
 * Positioning follows the same per-frame recompute pattern as
 * SessionZonesOverlay/TemporaryTradePriceLine - price -> y drifts
 * whenever the chart pans, zooms, or the price scale autoscales, so it
 * has to be read fresh every frame rather than computed once. While a
 * line is actively being repositioned, its position instead comes from
 * the live pointer position (see armedRef below) so it doesn't fight
 * the rAF loop's own recompute.
 */
export default function AlertLinesOverlay({
  chartWrapRef,
  chartRef,
  candleRef,
  futureScaleRef,
  alerts,
  pricePrecision,
  onRemoveAlert,
  onUpdateAlertPrice,
  onToggleAlertSide,
  onSetAlertPattern,
  onSetAlertAdditionalInfo,
  onToggleAlertLocked,
  onToggleAlertHidden,
}: AlertLinesOverlayProps) {
  const [positioned, setPositioned] = useState<PositionedAlert[]>([]);
  const [paneWidth, setPaneWidth] = useState(0);

  // Which alert (if any) is currently mid-reposition, and its live
  // preview y. Kept in both a ref (for the rAF loop, which shouldn't
  // re-subscribe every time this changes) and state (to actually
  // re-render the preview as the mouse moves).
  const armedRef = useRef<{ id: string; y: number } | null>(null);
  const [armed, setArmed] = useState<{ id: string; y: number } | null>(null);

  // Which alert's pattern popover (if any) is currently open.
  const [openPatternMenuId, setOpenPatternMenuId] = useState<string | null>(
    null,
  );
  // FEATURE: one inline note editor can be open at a time. A separate draft
  // avoids issuing a persistent-alert PUT request for every keystroke.
  const [infoEditor, setInfoEditor] = useState<{ id: string; value: string } | null>(null);

  const commitAdditionalInfo = () => {
    if (!infoEditor) return;
    onSetAlertAdditionalInfo(infoEditor.id, infoEditor.value);
    setInfoEditor(null);
  };

  useEffect(() => {
    if (alerts.length === 0) {
      setPositioned([]);
      return;
    }

    const update = () => {
      const chart = chartRef.current;
      const series = candleRef.current;

      if (!chart || !series) {
        return;
      }

      const paneSize = chart.paneSize();
      const nextPositioned: PositionedAlert[] = [];
      const armedNow = armedRef.current;

      for (const alert of alerts) {
        // While this specific alert is being repositioned, its on-screen
        // y comes straight from the live pointer (see below), not from
        // re-deriving it from the (not-yet-committed) price.
        if (armedNow && armedNow.id === alert.id) {
          nextPositioned.push({
            id: alert.id,
            y: armedNow.y,
            price: alert.price,
            side: alert.side,
            pattern: alert.pattern,
            additionalInfo: alert.additionalInfo,
            locked: alert.locked,
            hidden: alert.hidden,
          });
          continue;
        }

        // FIX: preserve alert positions after every candle leaves the viewport;
        // the future series shares the same right scale and remains visible.
        const y = priceToCoordinateWithFutureFallback(
          series,
          futureScaleRef.current,
          alert.price,
        );

        if (y === null || y < 0 || y > paneSize.height) continue;

        nextPositioned.push({
          id: alert.id,
          y,
          price: alert.price,
          side: alert.side,
          pattern: alert.pattern,
          additionalInfo: alert.additionalInfo,
          locked: alert.locked,
          hidden: alert.hidden,
        });
      }

      setPositioned((current) => {
        if (
          current.length === nextPositioned.length &&
          current.every((item, index) => {
            const next = nextPositioned[index];
            return (
              item.id === next.id &&
              Math.abs(item.y - next.y) <= 0.25 &&
              item.price === next.price &&
              item.side === next.side &&
              item.pattern === next.pattern
              && item.additionalInfo === next.additionalInfo
              && item.locked === next.locked
              && item.hidden === next.hidden
            );
          })
        ) {
          return current;
        }

        return nextPositioned;
      });
      setPaneWidth((current) =>
        Math.abs(current - paneSize.width) <= 0.25 ? current : paneSize.width,
      );

    };

    return startPacedLoop(update);
  }, [alerts, chartWrapRef, chartRef, candleRef, futureScaleRef]);

  // Explicit cancel path for the click-move-click flow - Escape and
  // right-click both back out of an in-progress reposition without
  // committing anything.
  const cancelArm = () => {
    armedRef.current = null;
    setArmed(null);
  };

  const beginReposition = (
    event: ReactPointerEvent<HTMLDivElement>,
    id: string,
  ) => {
    // Already mid-reposition for some (possibly other) alert - ignore a
    // second grab rather than restarting it.
    if (armedRef.current) return;
    if (alerts.find((alert) => alert.id === id)?.locked) return;

    event.preventDefault();
    event.stopPropagation();

    const wrap = chartWrapRef.current;
    if (!wrap) return;

    const rect = wrap.getBoundingClientRect();
    const y = event.clientY - rect.top;

    armedRef.current = { id, y };
    setArmed({ id, y });
  };

  useEffect(() => {
    if (!armed) return;

    const handlePointerMove = (event: PointerEvent) => {
      const wrap = chartWrapRef.current;
      const current = armedRef.current;
      if (!wrap || !current) return;

      const rect = wrap.getBoundingClientRect();
      const y = event.clientY - rect.top;

      armedRef.current = { id: current.id, y };
      setArmed({ id: current.id, y });
    };

    /*
     * Click-move-click, not press-and-hold-drag - see beginReposition
     * above (whose pointerdown set `armed` and ran BEFORE this effect
     * exists, so it's never seen by the listener below). The *next*
     * left click anywhere - a fresh pointerdown, registered with
     * `once: true` - confirms the current preview price.
     */
    const handleConfirmClick = (event: PointerEvent) => {
      if (event.button !== 0) return;

      const current = armedRef.current;
      const series = candleRef.current;
      const futureSeries = futureScaleRef.current;
      armedRef.current = null;
      setArmed(null);

      if (!current || !series) return;

      const price = coordinateToPriceWithFutureFallback(
        series,
        futureSeries,
        current.y,
      );
      if (price === null) return;

      onUpdateAlertPrice(current.id, price);
    };

    const handleCancelKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelArm();
    };

    const handleCancelContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      cancelArm();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerdown", handleConfirmClick, {
      once: true,
    });
    window.addEventListener("keydown", handleCancelKey);
    window.addEventListener("contextmenu", handleCancelContextMenu);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", handleConfirmClick);
      window.removeEventListener("keydown", handleCancelKey);
      window.removeEventListener("contextmenu", handleCancelContextMenu);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, chartWrapRef, candleRef, onUpdateAlertPrice]);

  /*
   * Closes the pattern popover on any click that isn't stopped by the
   * popover itself or its own toggle button (both of which call
   * event.stopPropagation() - see below). Attached only while a
   * popover is actually open, and only added to the DOM after the
   * click that opened it has already fully finished dispatching, so it
   * never immediately closes the popover it just opened.
   */
  useEffect(() => {
    if (!openPatternMenuId) return;

    const handleOutsideClick = () => setOpenPatternMenuId(null);
    window.addEventListener("click", handleOutsideClick);
    return () => window.removeEventListener("click", handleOutsideClick);
  }, [openPatternMenuId]);

  if (positioned.length === 0 || paneWidth <= 0) return null;

  return (
    <div className="alert-lines-overlay">
      {positioned.map((alert) => (
        <div
          key={alert.id}
          className={`alert-line ${armed?.id === alert.id ? "repositioning" : ""} ${alert.hidden ? "alert-line-hidden" : ""} ${alert.locked ? "alert-line-locked" : ""}`}
          style={{ top: alert.y, width: paneWidth }}
        >
          <div
            className="alert-line-hit-area"
            onPointerDown={(event) => beginReposition(event, alert.id)}
          />

          <div className="alert-line-label">
            <button
              type="button"
              className={`alert-line-control ${alert.locked ? "active" : ""}`}
              aria-label={alert.locked ? "Unlock alert" : "Lock alert"}
              title={alert.locked ? "Unlock alert" : "Lock alert"}
              onClick={(event) => {
                event.stopPropagation();
                onToggleAlertLocked(alert.id);
              }}
            >
              {alert.locked ? "UNLOCK" : "LOCK"}
            </button>

            <button
              type="button"
              className={`alert-line-control alert-line-opacity-control ${alert.hidden ? "active" : ""}`}
              aria-label={alert.hidden ? "Restore alert opacity" : "Dim alert"}
              title={alert.hidden ? "Restore alert opacity" : "Dim alert"}
              disabled={alert.locked}
              onClick={(event) => {
                event.stopPropagation();
                onToggleAlertHidden(alert.id);
              }}
            >
              {alert.hidden ? "RESTORE" : "DIM"}
            </button>

            <div className="alert-line-pattern-wrap">
              <button
                type="button"
                className={`alert-line-pattern ${
                  alert.pattern !== "none" ? "alert-line-pattern-set" : ""
                }`}
                aria-label="Set pattern"
                title="Set pattern"
                disabled={alert.locked}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenPatternMenuId((current) =>
                    current === alert.id ? null : alert.id,
                  );
                }}
              >
                {alert.pattern === "none" ? "PATTERN" : alert.pattern.toUpperCase()}
              </button>

              {openPatternMenuId === alert.id && (
                <div
                  className="alert-line-pattern-menu"
                  onClick={(event) => event.stopPropagation()}
                >
                  {PATTERN_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`alert-line-pattern-option ${
                        alert.pattern === option.value ? "active" : ""
                      }`}
                      onClick={() => {
                        onSetAlertPattern(alert.id, option.value);
                        setOpenPatternMenuId(null);
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="alert-line-info-wrap">
              <button
                type="button"
                className={`alert-line-info ${alert.additionalInfo ? "alert-line-info-set" : ""}`}
                aria-label={alert.additionalInfo ? "Edit additional alert info" : "Add alert info"}
                title={alert.additionalInfo || "Add optional notification info"}
                aria-disabled={alert.locked}
                onClick={(event) => {
                  event.stopPropagation();
                  // FIX: locked alerts keep INFO hover/title readable, but clicking cannot edit their text until unlocked.
                  if (alert.locked) return;
                  setOpenPatternMenuId(null);
                  setInfoEditor((current) => current?.id === alert.id
                    ? null
                    : { id: alert.id, value: alert.additionalInfo });
                }}
              >
                INFO
              </button>

              {infoEditor?.id === alert.id && (
                <input
                  autoFocus
                  className="alert-line-info-input"
                  value={infoEditor.value}
                  maxLength={500}
                  placeholder="Optional alert info"
                  aria-label="Additional alert info"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setInfoEditor({ id: alert.id, value: event.target.value })}
                  onBlur={commitAdditionalInfo}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      // FEATURE: blurring uses the single commit path, avoiding
                      // duplicate history/API updates from Enter plus onBlur.
                      event.currentTarget.blur();
                    }
                  }}
                />
              )}
            </div>

            <button
              type="button"
              className={`alert-line-side alert-line-side-${(alert.side ?? "LONG").toLowerCase()}`}
              aria-label={`Setup: ${alert.side}. Click to flip.`}
              title="Click to flip LONG/SHORT"
              disabled={alert.locked}
              onClick={(event) => {
                event.stopPropagation();
                onToggleAlertSide(alert.id);
              }}
            >
              {alert.side}
            </button>

            <span>ALERT: {formatAlertPrice(alert.price, pricePrecision)}</span>

            <button
              type="button"
              className="alert-line-remove"
              aria-label="Remove alert"
              title="Remove alert"
              disabled={alert.locked}
              onClick={(event) => {
                event.stopPropagation();
                onRemoveAlert(alert.id);
              }}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
