import { Children, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

const STORAGE_KEY = "fyxtez:chart-split-ratio";
const DIVIDER_WIDTH = 8;
export function clampSplitRatio(ratio: number, width: number) {
  const available = Math.max(1, width - DIVIDER_WIDTH);
  const minimum = Math.min(240 / available, 0.5);
  return Math.min(1 - minimum, Math.max(minimum, ratio));
}
function readRatio() {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY) ?? "0.5");
    return Number.isFinite(value) && value > 0 && value < 1 ? value : 0.5;
  } catch {
    return 0.5;
  }
}
function saveRatio(value: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    /* Best effort. */
  }
}

export default function ChartWorkspaceLayout({
  children,
  split,
}: {
  children: ReactNode;
  split: boolean;
}) {
  const panes = Children.toArray(children);
  const container = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; original: number } | null>(null);
  const [ratio, setRatio] = useState(readRatio);
  const ratioRef = useRef(ratio);
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const effectiveRatio = width ? clampSplitRatio(ratio, width) : ratio;
  const change = (next: number) => {
    ratioRef.current = next;
    setRatio(next);
  };
  const finish = (cancel = false) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (cancel) change(current.original);
    else saveRatio(ratioRef.current);
    if (handle.current?.hasPointerCapture(current.id))
      handle.current.releasePointerCapture(current.id);
    setDragging(false);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const blur = () => finishRef.current();
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  }, []);
  useEffect(() => {
    if (!split) finishRef.current();
  }, [split]);

  return (
    <div
      ref={container}
      className={`chart-workspaces ${split ? "split" : ""} ${dragging ? "resizing-charts" : ""}`}
      style={
        split
          ? ({
              gridTemplateColumns: `minmax(0, ${effectiveRatio}fr) ${DIVIDER_WIDTH}px minmax(0, ${1 - effectiveRatio}fr)`,
            } as CSSProperties)
          : undefined
      }
    >
      {panes[0]}
      {split && (
        <div
          ref={handle}
          className="chart-divider"
          role="separator"
          tabIndex={0}
          aria-label="Resize charts"
          aria-orientation="vertical"
          aria-valuenow={Math.round(effectiveRatio * 100)}
          aria-valuemin={Math.round(clampSplitRatio(0, width) * 100)}
          aria-valuemax={Math.round(clampSplitRatio(1, width) * 100)}
          title="Drag to resize charts · Double-click to reset"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.focus();
            drag.current = { id: event.pointerId, original: ratioRef.current };
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
          }}
          onPointerMove={(event) => {
            if (drag.current?.id !== event.pointerId || !container.current) return;
            const rect = container.current.getBoundingClientRect();
            change(
              clampSplitRatio(
                (event.clientX - rect.left - DIVIDER_WIDTH / 2) /
                  Math.max(1, rect.width - DIVIDER_WIDTH),
                rect.width,
              ),
            );
          }}
          onPointerUp={(event) => {
            if (drag.current?.id === event.pointerId) {
              event.stopPropagation();
              finish();
            }
          }}
          onPointerCancel={() => finish(true)}
          onLostPointerCapture={() => finish()}
          onDoubleClick={() => {
            change(0.5);
            saveRatio(0.5);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              finish(true);
              return;
            }
            if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            const next =
              event.key === "Home"
                ? 0.5
                : clampSplitRatio(
                    effectiveRatio + (event.key === "ArrowLeft" ? -0.02 : 0.02),
                    width,
                  );
            change(next);
            saveRatio(next);
          }}
        />
      )}
      {split && panes[1]}
    </div>
  );
}
