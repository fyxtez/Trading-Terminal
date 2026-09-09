import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { useViewportMenuPosition } from "./useViewportMenuPosition";
function Menu({ x, y }: { x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useViewportMenuPosition(ref, { x, y });
  return <div data-testid="menu" ref={ref} />;
}
describe("viewport menu placement", () => {
  it("keeps the measured menu inside the right and bottom edges and repositions on resize", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 228,
      height: 360,
    } as DOMRect);
    render(<Menu x={window.innerWidth - 2} y={window.innerHeight - 2} />);
    const menu = screen.getByTestId("menu");
    expect(menu.style.left).toBe(`${window.innerWidth - 228 - 8}px`);
    expect(menu.style.top).toBe(`${window.innerHeight - 360 - 8}px`);
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      width: 280,
      height: 600,
    } as DOMRect);
    fireEvent(window, new Event("resize"));
    expect(menu.style.left).toBe(`${window.innerWidth - 280 - 8}px`);
    expect(menu.style.top).toBe(`${Math.max(8, window.innerHeight - 600 - 8)}px`);
  });
});
