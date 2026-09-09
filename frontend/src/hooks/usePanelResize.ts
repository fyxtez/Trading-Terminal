import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** Hold-drag-release resizing with capture, so releasing outside the panel still finishes. */
export function usePanelResize(
  axis: "x" | "y",
  size: number,
  onChange: (size: number) => void,
  enabled: boolean,
) {
  const [isResizing, setIsResizing] = useState(false);
  const latest = useRef({ size, onChange });
  latest.current = { size, onChange };
  const drag = useRef<{ id: number; start: number; size: number; handle: HTMLDivElement } | null>(
    null,
  );
  const finish = (cancel = false) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (cancel) latest.current.onChange(current.size);
    if (current.handle.hasPointerCapture(current.id))
      current.handle.releasePointerCapture(current.id);
    setIsResizing(false);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    const blur = () => finishRef.current();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") finishRef.current(true);
    };
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", key);
      const current = drag.current;
      drag.current = null;
      if (current?.handle.hasPointerCapture(current.id))
        current.handle.releasePointerCapture(current.id);
    };
  }, []);
  useEffect(() => {
    if (!enabled) finishRef.current();
  }, [enabled]);
  return {
    isResizing,
    resizeHandleProps: {
      onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!enabled || event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.stopPropagation();
        const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
        drag.current = {
          id: event.pointerId,
          start: axis === "x" ? event.clientX : event.clientY,
          size: (axis === "x" ? bounds?.width : bounds?.height) || latest.current.size,
          handle: event.currentTarget,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsResizing(true);
      },
      onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        latest.current.onChange(
          current.size + current.start - (axis === "x" ? event.clientX : event.clientY),
        );
      },
      onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
        if (drag.current?.id !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        finish();
      },
      onPointerCancel: () => finish(true),
      onLostPointerCapture: () => finish(),
    },
  };
}
