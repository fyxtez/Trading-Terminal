import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChartWorkspaceLayout, { clampSplitRatio } from "./ChartWorkspaceLayout";
afterEach(() => vi.unstubAllGlobals());
describe("resizable chart layout", () => {
  it("keeps both panes usable, including windows narrower than two minimum widths", () => {
    expect(clampSplitRatio(0, 1008)).toBe(0.24);
    expect(clampSplitRatio(1, 1008)).toBe(0.76);
    expect(clampSplitRatio(0.9, 400)).toBe(0.5);
  });
  it("remembers the size and preserves mounted charts while resizing and splitting", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1208,
    } as DOMRect);
    const mount = vi.fn();
    function Chart() {
      useEffect(() => {
        mount();
      }, []);
      return <div>Chart</div>;
    }
    const view = render(
      <ChartWorkspaceLayout split={false}>
        <Chart key="left" />
      </ChartWorkspaceLayout>,
    );
    view.rerender(
      <ChartWorkspaceLayout split>
        <Chart key="left" />
        <Chart key="right" />
      </ChartWorkspaceLayout>,
    );
    expect(mount).toHaveBeenCalledTimes(2);
    const divider = screen.getByRole("separator");
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(divider).toHaveAttribute("aria-valuenow", "52");
    expect(localStorage.getItem("fyxtez:chart-split-ratio")).toBe("0.52");
    expect(mount).toHaveBeenCalledTimes(2);
    fireEvent.doubleClick(divider);
    expect(divider).toHaveAttribute("aria-valuenow", "50");
  });
});
