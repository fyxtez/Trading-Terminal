import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

type FixedPopoverStyle = Pick<CSSProperties, "left" | "top" | "width" | "maxHeight">;

/** Positions a body-level popover beside its trigger while keeping it on-screen. */
export function useFixedPopoverPosition(
  anchorRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  preferredWidth: number,
  gap = 6,
  margin = 8,
): FixedPopoverStyle | undefined {
  const [style, setStyle] = useState<FixedPopoverStyle>();

  useLayoutEffect(() => {
    if (!isOpen) {
      setStyle(undefined);
      return;
    }

    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;

      const rect = anchor.getBoundingClientRect();
      const width = Math.max(0, Math.min(preferredWidth, window.innerWidth - margin * 2));
      const left = Math.min(
        Math.max(margin, rect.right - width),
        Math.max(margin, window.innerWidth - width - margin),
      );
      const top = Math.min(rect.bottom + gap, Math.max(margin, window.innerHeight - margin));

      setStyle({
        left,
        top,
        width,
        maxHeight: Math.max(96, window.innerHeight - top - margin),
      });
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, gap, isOpen, margin, preferredWidth]);

  return style;
}
