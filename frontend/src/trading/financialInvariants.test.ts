import { describe, expect, it } from "vitest";
import { computeDefaultOrderQuantity, roundToStep } from "./api/exchangeInfo";
import { estimatePendingLimitLiquidation } from "./estimatedLiquidation";
import { parseReduceMetadata } from "./reduceMetadata";
import { loadSavedStop, saveStop } from "./stopLoss";

describe("frontend financial invariants", () => {
  it("rounds prices to the selected symbol tick without float noise", () => {
    expect(roundToStep(76_605.74, 0.1)).toBe(76_605.7);
    expect(roundToStep(0.512_345, 0.0001)).toBe(0.5123);
  });

  it("raises a default quantity to satisfy both quantity and notional minimums", () => {
    const quantity = computeDefaultOrderQuantity(
      100,
      {
        tickSize: 0.1,
        pricePrecision: 1,
        stepSize: 0.01,
        quantityPrecision: 2,
        minQty: 0.01,
        minNotional: 20,
      },
      5,
    );

    expect(quantity).toBe(0.2);
    expect(quantity * 100).toBeGreaterThanOrEqual(20);
  });

  it("projects long and short liquidation on opposite sides of entry", () => {
    expect(estimatePendingLimitLiquidation(100, 10, "BUY")).toBe(90);
    expect(estimatePendingLimitLiquidation(100, 10, "SELL")).toBeCloseTo(110, 10);
    expect(estimatePendingLimitLiquidation(100, 1, "BUY")).toBeUndefined();
  });

  it("parses bounded reduce and remaining percentages from an order ID", () => {
    expect(parseReduceMetadata("fe-red-25-l75-123")).toEqual({
      reducePct: 25,
      remainingPct: 75,
    });
    expect(parseReduceMetadata("fe-red-101-l0-123")).toEqual({
      reducePct: undefined,
      remainingPct: 0,
    });
  });

  it("keeps full-position stops isolated by symbol and rejects corrupt storage", () => {
    saveStop(
      {
        symbol: "BTCUSDT",
        side: "SELL",
        triggerPrice: 90,
        algoId: "12345678901234567890",
      },
      "BTCUSDT",
    );

    expect(loadSavedStop("BTCUSDT")).toMatchObject({
      side: "SELL",
      triggerPrice: 90,
      algoId: "12345678901234567890",
    });
    expect(loadSavedStop("ETHUSDT")).toBeNull();

    localStorage.setItem("fyxtez:full-stop:ETHUSDT", "not-json");
    expect(loadSavedStop("ETHUSDT")).toBeNull();
  });
});
