import { describe, expect, it } from "vitest";
import type { CandlestickData, UTCTimestamp } from "lightweight-charts";
import { mergeLatestCandle } from "./marketData";

const candle = (time: number, close = 10): CandlestickData => ({
  time: time as UTCTimestamp,
  open: 10,
  high: 12,
  low: 8,
  close,
});

describe("live candle history", () => {
  it("repeated ticks replace the current bar without growing history or mutating snapshots", () => {
    const original = [candle(60), candle(120)];
    let history = original;
    for (let tick = 0; tick < 3600; tick++) {
      history = mergeLatestCandle(history, candle(120, 11));
    }
    expect(history).toEqual([candle(60), candle(120, 11)]);
    expect(original).toEqual([candle(60), candle(120)]);
    expect(mergeLatestCandle(history, candle(180))).toHaveLength(3);
  });

  it("keeps older corrections sorted and deduplicated", () => {
    const history = [candle(60), candle(180)];
    expect(mergeLatestCandle(history, candle(120))).toEqual([candle(60), candle(120), candle(180)]);
    expect(mergeLatestCandle(history, candle(60, 11))).toEqual([candle(60, 11), candle(180)]);
  });
});
