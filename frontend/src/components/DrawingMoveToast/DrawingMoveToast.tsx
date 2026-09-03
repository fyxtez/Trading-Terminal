import { useEffect, useRef, useState } from "react";

import { getSymbolInfo } from "../../config/symbols";
import type { AlertTriggeredEvent } from "../../trading/types";
import "./DrawingMoveToast.css";

type DrawingMovedDetail = {
  label?: string;
};

type DrawingToastItem = {
  id: number;
  kind: "drawing";
  label: string;
  message: string;
};

type AlertToastItem = {
  id: number;
  kind: "alert";
  symbol: string;
  displaySymbol: string;
  triggerPrice: number;
};

type ToastItem = DrawingToastItem | AlertToastItem;
type ToastInput = Omit<DrawingToastItem, "id"> | Omit<AlertToastItem, "id">;

type DrawingMoveToastProps = {
  onOpenAlertSymbol: (symbol: string) => void;
};

const DRAWING_AUTO_HIDE_MS = 3000;
const ALERT_AUTO_HIDE_MS = 10000;

/**
 * use a tiny tool-shaped glyph so stacked move notifications are
 * easier to scan without making the toast wider. The glyph is decorative;
 * the text remains the source of truth for accessibility.
 */
function drawingGlyph(label: string) {
  const normalized = label.toLowerCase();

  if (normalized.includes("box")) return "□";
  if (normalized.includes("horizontal")) return "─";
  if (normalized.includes("vertical")) return "│";
  if (normalized.includes("text")) return "T";
  if (normalized.includes("coordinate")) return "+";
  if (normalized.includes("pen")) return "⌁";
  return "╱";
}

/**
 * the existing drawing-move stack also surfaces backend price-alert
 * triggers. Keeping both event types in one stack prevents overlapping toast
 * systems while letting an alert from another symbol provide a direct chart
 * navigation action. Drawing toasts keep the fast 3s lifetime, while alert
 * toasts stay visible for at least 10s so there is enough time to notice and open them.
 */
export default function DrawingMoveToast({ onOpenAlertSymbol }: DrawingMoveToastProps) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextToastIdRef = useRef(1);
  const hideTimersRef = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    const appendToast = (toast: ToastInput) => {
      const id = nextToastIdRef.current++;

      // append instead of replacing so rapid drawing edits and alert
      // triggers remain independently actionable until their own timers expire.
      setToasts((current) => [...current, { ...toast, id } as ToastItem]);

      // price-alert notifications now remain visible for 10 seconds because
      // 5 seconds was too easy to miss while watching another chart. Drawing
      // confirmations remain intentionally brief at 3 seconds.
      const autoHideMs = toast.kind === "alert" ? ALERT_AUTO_HIDE_MS : DRAWING_AUTO_HIDE_MS;

      const timer = window.setTimeout(() => {
        setToasts((current) => current.filter((item) => item.id !== id));
        hideTimersRef.current.delete(id);
      }, autoHideMs);
      hideTimersRef.current.set(id, timer);
    };

    const handleDrawingMoved = (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<DrawingMovedDetail>;
      const label = event.detail?.label?.trim() || "Drawing";
      appendToast({ kind: "drawing", label, message: `${label} moved` });
    };

    const handleAlertTriggered = (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<AlertTriggeredEvent>;
      const symbol = event.detail?.symbol?.trim().toUpperCase();
      if (!symbol) return;

      // backend events use exchange pair symbols (for example LITUSDT)
      // while chart routes/tabs use the base ticker label. Resolve the same
      // display label used everywhere else so the clickable toast identifies LIT.
      const displaySymbol = getSymbolInfo(symbol).label;
      appendToast({
        kind: "alert",
        symbol,
        displaySymbol,
        triggerPrice: event.detail.trigger_price,
      });
    };

    window.addEventListener("drawing-geometry-moved", handleDrawingMoved);
    window.addEventListener("persistent-price-alert-triggered", handleAlertTriggered);
    return () => {
      window.removeEventListener("drawing-geometry-moved", handleDrawingMoved);
      window.removeEventListener("persistent-price-alert-triggered", handleAlertTriggered);
      hideTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      hideTimersRef.current.clear();
    };
  }, []);

  if (toasts.length === 0) return null;

  const dismissToast = (id: number) => {
    const timer = hideTimersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      hideTimersRef.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  };

  const undo = (id: number) => {
    /*
     * simulate the exact Ctrl+Z hotkey rather than duplicating undo
     * logic here. This keeps every drawing toast aligned with the existing
     * combined drawing + alert history stack.
     */
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        code: "KeyZ",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    dismissToast(id);
  };

  const openAlertSymbol = (toast: AlertToastItem) => {
    // navigating through the app's tab API opens the alerted symbol
    // exactly like the symbol switcher, preserving tab/category behavior and
    // avoiding a full page reload or hand-written route mutation here.
    onOpenAlertSymbol(toast.symbol);
    dismissToast(toast.id);
  };

  /*
   * alerts use the entire toast as the navigation target rather than a
   * small Open button. The matching keyboard handlers keep the larger target
   * accessible without changing drawing-toast behavior.
   */
  return (
    <div className="drawing-move-toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`drawing-move-toast ${toast.kind === "alert" ? "alert-triggered" : ""}`}
          role={toast.kind === "alert" ? "button" : "status"}
          tabIndex={toast.kind === "alert" ? 0 : undefined}
          onClick={toast.kind === "alert" ? () => openAlertSymbol(toast) : undefined}
          onKeyDown={
            toast.kind === "alert"
              ? (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openAlertSymbol(toast);
                  }
                }
              : undefined
          }
          aria-label={
            toast.kind === "alert"
              ? `${toast.displaySymbol} alert triggered at ${toast.triggerPrice}. Open chart.`
              : undefined
          }
        >
          <span className="drawing-move-toast-icon" aria-hidden="true">
            {toast.kind === "drawing" ? drawingGlyph(toast.label) : "!"}
          </span>

          <div className="drawing-move-toast-copy">
            {toast.kind === "drawing" ? (
              <>
                <strong>{toast.message}</strong>
                <span>Use Ctrl+Z to undo.</span>
              </>
            ) : (
              <>
                <strong>{toast.displaySymbol} alert triggered</strong>
                <span>Price reached {toast.triggerPrice}</span>
              </>
            )}
          </div>

          {toast.kind === "drawing" && (
            <button type="button" onClick={() => undo(toast.id)}>
              Undo action
            </button>
          )}

          {/* countdown duration mirrors each toast's actual lifetime: drawing
              confirmations remain 3s, while alert notifications now stay visible 10s. */}
          <div className="drawing-move-toast-progress-track" aria-hidden="true">
            <div
              className={`drawing-move-toast-progress ${
                toast.kind === "alert" ? "alert-progress" : ""
              }`}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
