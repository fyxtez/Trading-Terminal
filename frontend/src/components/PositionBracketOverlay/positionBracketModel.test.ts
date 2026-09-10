import { describe, expect, it } from "vitest";
import { positionZoneWidthPx } from "./positionBracketModel";

describe("position zone width", () => {
  it("keeps automatic brackets readable across minute, weekly and monthly charts and zoom levels", () => {
    for (const seconds of [60, 3600, 604800, 2592000]) {
      for (const spacing of [0.5, 6, 40, 100]) {
        expect(positionZoneWidthPx(null, spacing, seconds)).toBe(220);
      }
    }
  });
  it("scales both edges with candles after the initial timeframe layout", () => {
    expect(positionZoneWidthPx(null, 6, 60, 6)).toBe(220);
    expect(positionZoneWidthPx(null, 3, 60, 6)).toBe(110);
    expect(positionZoneWidthPx(null, 12, 60, 6)).toBe(440);
    expect(positionZoneWidthPx(null, 3, 604800, 3)).toBe(220);
  });
  it("preserves an explicitly resized zone's market duration", () => {
    expect(positionZoneWidthPx(3600, 6, 60)).toBe(360);
    expect(positionZoneWidthPx(3600, 12, 60)).toBe(720);
    expect(positionZoneWidthPx(3600, 6, 3600)).toBe(6);
    expect(positionZoneWidthPx(0, 6, 60)).toBe(0);
  });
});
