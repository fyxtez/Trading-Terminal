import { useLayoutEffect, type RefObject } from "react";

/** Measure the rendered menu, including expanded submenus, before positioning it. */
export function useViewportMenuPosition(
  ref: RefObject<HTMLElement>,
  anchor: { x: number; y: number } | null,
) {
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu || !anchor) return;
    const place = () => {
      const { width, height } = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(anchor.x, window.innerWidth - width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(anchor.y, window.innerHeight - height - 8))}px`;
    };
    place();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    observer?.observe(menu);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [ref, anchor?.x, anchor?.y]);
}
