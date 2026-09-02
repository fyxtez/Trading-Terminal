import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Keeps an absolutely-positioned popover fully inside the browser viewport
 * by measuring its rendered position once it's open and returning a
 * horizontal pixel offset to apply via `transform: translateX(...)`.
 *
 * Why this is needed: popovers like the chart-tab "+" menu anchor to their
 * trigger button (e.g. `right: 0` on the menu's own wrapper), but that
 * wrapper isn't guaranteed to sit at the true edge of the window. With only
 * one chart tab open, the "+" button sits right after it - nowhere near the
 * right edge of the screen - so a fixed-width popover anchored off it can
 * run past the left edge of the window entirely. The app root has
 * `overflow: hidden`, so that overflowing portion (typically the icon +
 * ticker columns, since they're the leftmost content) is silently clipped
 * rather than causing a scrollbar, which makes it look like the icons
 * "disappeared".
 */
export function useViewportClampOffset(
  popoverRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  margin = 8,
): number {
  const [offset, setOffset] = useState(0);

  useLayoutEffect(() => {
    if (!isOpen) {
      setOffset(0);
      return;
    }

    const clamp = () => {
      const el = popoverRef.current;
      if (!el) return;

      // Measure from the popover's natural (un-shifted) position every
      // time, so repeated resizes never compound a previously-applied
      // offset.
      el.style.transform = "";
      const rect = el.getBoundingClientRect();

      let next = 0;
      if (rect.right > window.innerWidth - margin) {
        next -= rect.right - (window.innerWidth - margin);
      }
      if (rect.left + next < margin) {
        next += margin - (rect.left + next);
      }
      setOffset(next);
    };

    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [isOpen, popoverRef, margin]);

  return offset;
}
