import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePanelResize } from "./usePanelResize";
function Panel({ axis }: { axis: "x" | "y" }) {
  const [size, change] = useState(400);
  const { isResizing, resizeHandleProps } = usePanelResize(axis, size, change, true);
  return (
    <section data-size={size} data-resizing={isResizing} data-testid="panel">
      <div data-testid="handle" {...resizeHandleProps} />
    </section>
  );
}
beforeEach(() => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    },
  );
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: vi.fn(() => false),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
  Reflect.deleteProperty(HTMLElement.prototype, "hasPointerCapture");
});
describe("panel hold-drag-release", () => {
  it.each(["x", "y"] as const)("resizes on %s and stops on the first release", (axis) => {
    render(<Panel axis={axis} />);
    const handle = screen.getByTestId("handle"),
      panel = screen.getByTestId("panel");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500, clientY: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 450, clientY: 450 });
    expect(panel).toHaveAttribute("data-size", "450");
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(panel).toHaveAttribute("data-resizing", "false");
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, clientY: 300 });
    expect(panel).toHaveAttribute("data-size", "450");
  });
  it("restores the starting size on Escape and stops on lost window focus", () => {
    render(<Panel axis="x" />);
    const handle = screen.getByTestId("handle"),
      panel = screen.getByTestId("panel");
    fireEvent.pointerDown(handle, { button: 0, clientX: 500 });
    fireEvent.pointerMove(handle, { clientX: 450 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panel).toHaveAttribute("data-size", "400");
    expect(panel).toHaveAttribute("data-resizing", "false");
    fireEvent.pointerDown(handle, { button: 0, clientX: 500 });
    fireEvent.blur(window);
    expect(panel).toHaveAttribute("data-resizing", "false");
  });
});
