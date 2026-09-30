import { expect, it } from "vitest";
import { captureRiskBasis, priceInR } from "./positionRiskBasis";
import { deriveBracketPresentation } from "./positionBracketPresentation";
import type { OpenPosition } from "../../trading/api/positions";
const position = { side: "SHORT", entry_price: 100, quantity: 2 } as OpenPosition;
it("keeps the original cash risk when the stop crosses entry into profit", () => {
  const basis = captureRiskBasis(position, 110)!;
  expect(basis.cashRisk).toBe(20);
  expect(priceInR(position, 70, basis)).toBe(3);
  expect(priceInR(position, 99, basis)).toBe(0.1);
  expect(priceInR(position, 70, basis)).toBe(3);
  const model = deriveBracketPresentation({
    position,
    coordinates: { ready: false } as any,
    dragKind: null,
    previewPrice: null,
    displayedStopPrice: 99,
    displayedTakeProfitPrice: 70,
    isTakeProfitDraft: false,
    isStopDraft: false,
    pricePrecision: 2,
    riskBasis: basis,
  });
  expect(model.takeProfitRLabel).toBe("3R");
  expect(model.stopRLabel).toBe("+0.1R");
});
it("normalizes the whole position through repeated adds and reductions", () => {
  const basis = captureRiskBasis(position, 110)!;
  for (const quantity of [4, 6, 12, 3, 1, 2]) {
    expect(priceInR({ ...position, quantity }, 70, basis)).toBe(3);
    expect(priceInR({ ...position, quantity }, 110, basis)).toBe(-1);
  }
  expect(priceInR({ ...position, quantity: 4, entry_price: 115 }, 70, basis)).toBe(4.5);
});
it("does not invent initial risk from break-even or a profit-protecting stop", () => {
  expect(captureRiskBasis(position, 100)).toBeNull();
  expect(captureRiskBasis(position, 99)).toBeNull();
  expect(priceInR(position, 70, null)).toBeNull();
});

it("normalizes long positions and preserves a profit-protecting stop", () => {
  const long = { ...position, side: "LONG" as const };
  const basis = captureRiskBasis(long, 90)!;
  for (const quantity of [2, 12, 1]) {
    expect(priceInR({ ...long, quantity }, 130, basis)).toBe(3);
    expect(priceInR({ ...long, quantity }, 105, basis)).toBe(0.5);
  }
});
it("rejects invalid stored quantity and non-finite prices", () => {
  const basis = captureRiskBasis(position, 110)!;
  for (const quantity of [0, -1, NaN, Infinity]) {
    expect(priceInR(position, 70, { ...basis, quantity })).toBeNull();
  }
  expect(priceInR(position, Infinity, basis)).toBeNull();
});
