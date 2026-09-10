import type { OpenPosition } from "../../trading/api/positions";
export type PositionRiskBasis = {
  side: "LONG" | "SHORT";
  cashRisk: number;
  entry: number;
  stop: number;
  quantity: number;
};
const key = (symbol: string) => `fyxtez:position-initial-risk:${symbol.toUpperCase()}`;
export function readRiskBasis(symbol: string): PositionRiskBasis | null {
  try {
    const value = JSON.parse(localStorage.getItem(key(symbol)) ?? "null");
    return value &&
      (value.side === "LONG" || value.side === "SHORT") &&
      Number.isFinite(value.cashRisk) &&
      value.cashRisk > 0
      ? value
      : null;
  } catch {
    return null;
  }
}
export function writeRiskBasis(symbol: string, basis: PositionRiskBasis | null) {
  if (basis) localStorage.setItem(key(symbol), JSON.stringify(basis));
  else localStorage.removeItem(key(symbol));
}
export function captureRiskBasis(
  position: OpenPosition,
  stop: number | null,
): PositionRiskBasis | null {
  if (stop == null) return null;
  const distance =
    position.side === "LONG" ? position.entry_price - stop : stop - position.entry_price;
  const quantity = Math.abs(position.quantity);
  const cashRisk = distance * quantity;
  if (!Number.isFinite(cashRisk) || cashRisk <= 0) return null;
  return { side: position.side, cashRisk, quantity, entry: position.entry_price, stop };
}
export function priceInR(
  position: OpenPosition,
  price: number | null,
  basis: PositionRiskBasis | null,
): number | null {
  if (!basis || basis.side !== position.side || price == null) return null;
  const direction = position.side === "LONG" ? 1 : -1;
  return (
    (direction * (price - position.entry_price) * Math.abs(position.quantity)) / basis.cashRisk
  );
}
