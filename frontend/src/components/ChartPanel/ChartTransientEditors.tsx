import { useCallback, useEffect, useState } from "react";
import type { MutableRefObject } from "react";
import type { ISeriesApi } from "lightweight-charts";
import { startPacedLoop } from "../../utils/pacedLoop";

type TemporaryTradePriceLineProps = {
  candleRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>;
  chartWrapRef: MutableRefObject<HTMLDivElement | null>;
  price: number;
  pricePrecision: number;
};

export function TemporaryTradePriceLine({
  candleRef,
  chartWrapRef,
  price,
  pricePrecision,
}: TemporaryTradePriceLineProps) {
  const [top, setTop] = useState<number | null>(null);

  useEffect(() => {
    let previousTop: number | null = null;

    const updatePosition = () => {
      const series = candleRef.current;
      const wrap = chartWrapRef.current;
      const nextTop = series?.priceToCoordinate(price) ?? null;
      const isVisible =
        nextTop !== null &&
        Number.isFinite(nextTop) &&
        wrap !== null &&
        nextTop >= 0 &&
        nextTop <= wrap.clientHeight;
      const normalizedTop = isVisible ? nextTop : null;

      if (normalizedTop !== previousTop) {
        previousTop = normalizedTop;
        setTop(normalizedTop);
      }
    };

    return startPacedLoop(updatePosition);
  }, [candleRef, chartWrapRef, price]);

  if (top === null) return null;

  return (
    <div className="temporary-trade-price-line" style={{ top }} aria-hidden="true">
      <span className="temporary-trade-price-label">
        {price.toLocaleString(undefined, {
          minimumFractionDigits: pricePrecision,
          maximumFractionDigits: pricePrecision,
        })}
      </span>
    </div>
  );
}

type ReduceOrderEditor = {
  drawingId: string;
  left: number;
  top: number;
  reducePct: number;
  isSubmitting: boolean;
};

type ReduceOrderEditorProps = {
  editor: ReduceOrderEditor;
  onPercentageChange: (reducePct: number) => void;
  onSubmit: () => void;
  onClose: () => void;
};

export function ReduceOrderEditor({
  editor,
  onPercentageChange,
  onSubmit,
  onClose,
}: ReduceOrderEditorProps) {
  return (
    <div
      className="chart-reduce-order-editor"
      style={{ left: editor.left, top: editor.top }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="chart-reduce-order-editor-header">
        <div className="chart-reduce-order-editor-title">Take profit size</div>
        <button
          type="button"
          className="chart-reduce-order-editor-close"
          disabled={editor.isSubmitting}
          onClick={onClose}
          aria-label="Close take-profit editor"
        >
          ×
        </button>
      </div>
      <div className="chart-reduce-order-editor-slider-row">
        <input
          className="chart-reduce-order-editor-slider"
          type="range"
          min="1"
          max="100"
          step="1"
          value={editor.reducePct}
          disabled={editor.isSubmitting}
          onChange={(event) => onPercentageChange(Number(event.target.value))}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              onSubmit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
          aria-label="Take-profit percentage"
        />
        <output className="chart-reduce-order-editor-value">{editor.reducePct}%</output>
      </div>
      <div className="chart-reduce-order-editor-actions">
        <button
          type="button"
          className="secondary"
          disabled={editor.isSubmitting}
          onClick={onClose}
        >
          Cancel
        </button>
        <button type="button" className="primary" disabled={editor.isSubmitting} onClick={onSubmit}>
          {editor.isSubmitting ? "Updating…" : "Update TP"}
        </button>
      </div>
    </div>
  );
}

type TextEditor = {
  drawingId: string;
  value: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  color: string;
  align: "left" | "center" | "right";
};

type ChartTextEditorProps = {
  editor: TextEditor;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
};

export function ChartTextEditor({ editor, onChange, onCommit, onCancel }: ChartTextEditorProps) {
  // Keep the ref callback stable so typing does not refocus and reselect the
  // input on every render. preventScroll also avoids shifting a zoomed chart.
  const focusEditor = useCallback((element: HTMLInputElement | null) => {
    element?.focus({ preventScroll: true });
  }, []);

  return (
    <input
      key={editor.drawingId}
      className="chart-text-editor"
      ref={focusEditor}
      value={editor.value}
      style={{
        left: editor.left,
        top: editor.top,
        width: editor.width,
        height: editor.height,
        fontSize: editor.fontSize,
        color: editor.color,
        textAlign: editor.align,
      }}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => onChange(event.target.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onBlur={onCommit}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      aria-label="Edit chart text"
    />
  );
}
