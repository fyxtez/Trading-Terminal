import { describe, expect, it } from "vitest";
import type { OpenPosition } from "../../trading/api/positions";
import { deriveBracketPresentation, type BracketCoordinates } from "./positionBracketPresentation";

const position: OpenPosition = {
  symbol: "BTCUSDT",
  side: "LONG",
  leverage: 10,
  quantity: 1,
  size: 100,
  entry_price: 100,
  mark_price: 101,
  liquidation_price: 50,
  margin: 10,
  unrealized_pnl: 1,
  realized_pnl: 0,
  roi_pct: 10,
};

const coordinates: BracketCoordinates = {
  entryY: 100,
  previewY: 60,
  stopY: 120,
  takeProfitY: 60,
  liquidationY: 180,
  liquidationLineWidth: 800,
  paneLeft: 20,
  paneWidth: 300,
  paneHeight: 500,
  entryLineWidth: 400,
  ready: true,
  isStopHighlighted: false,
  isTakeProfitHighlighted: false,
  isPositionHighlighted: false,
};

describe("deriveBracketPresentation", () => {
  it("derives a two-R long bracket and its zone bounds", () => {
    const model = deriveBracketPresentation({
      position,
      coordinates,
      dragKind: null,
      previewPrice: null,
      displayedStopPrice: 90,
      displayedTakeProfitPrice: 120,
      isTakeProfitDraft: false,
      isStopDraft: false,
      pricePrecision: 1,
    });

    expect(model.takeProfitRLabel).toBe("2R");
    expect(model.showTakeProfitZone).toBe(true);
    expect(model.showStopZone).toBe(true);
    expect(model.edgeHandleBounds).toEqual({ top: 60, height: 60 });
  });

  it("uses the live preview and hides the matching persisted zone", () => {
    const model = deriveBracketPresentation({
      position,
      coordinates,
      dragKind: "TAKE_PROFIT",
      previewPrice: 130,
      displayedStopPrice: 90,
      displayedTakeProfitPrice: 120,
      isTakeProfitDraft: true,
      isStopDraft: false,
      pricePrecision: 1,
    });

    expect(model.preview?.distancePct).toBe(30);
    expect(model.takeProfitRLabel).toBe("3R");
    expect(model.showTakeProfitZone).toBe(false);
    expect(model.showTakeProfitDraftLine).toBe(false);
  });
});
