import { describe, expect, it, vi } from "vitest";
import { traceSmoothPenPath } from "./canvasPrimitives";

function createPathContext() {
  return {
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    bezierCurveTo: vi.fn(),
  };
}

describe("traceSmoothPenPath", () => {
  it("keeps a two-point stroke as one exact segment", () => {
    const context = createPathContext();

    traceSmoothPenPath(context, [
      { x: 2, y: 3 },
      { x: 8, y: 9 },
    ]);

    expect(context.moveTo).toHaveBeenCalledWith(2, 3);
    expect(context.lineTo).toHaveBeenCalledWith(8, 9);
    expect(context.bezierCurveTo).not.toHaveBeenCalled();
  });

  it("rounds a sampled curve with continuous cubic segments", () => {
    const context = createPathContext();

    traceSmoothPenPath(context, [
      { x: 0, y: 4 },
      { x: 4, y: 0 },
      { x: 8, y: 4 },
      { x: 4, y: 8 },
      { x: 0, y: 4 },
    ]);

    expect(context.moveTo).toHaveBeenCalledWith(0, 4);
    // Five raw samples become 20 tightly-spaced samples after two corner-
    // cutting passes. The cubic path ends exactly where the user's stroke did.
    expect(context.bezierCurveTo).toHaveBeenCalledTimes(19);
    const finalCurve = context.bezierCurveTo.mock.calls[18];
    expect(finalCurve.slice(-2)).toEqual([0, 4]);
    expect(
      context.bezierCurveTo.mock.calls.every((call) =>
        call.every((coordinate) => Number.isFinite(coordinate)),
      ),
    ).toBe(true);
    expect(context.lineTo).not.toHaveBeenCalled();
  });
});
