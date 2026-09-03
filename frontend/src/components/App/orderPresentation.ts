import { stopStorageKey } from "../../trading/stopLoss";

export const LIMIT_REDUCE_COLOR = "#f5a623";

export function loadFullStopPrice(symbol: string): number | null {
  try {
    const raw = localStorage.getItem(stopStorageKey(symbol));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { triggerPrice?: unknown };
    const price = Number(parsed.triggerPrice);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

export function classifyLimitOrder(
  clientOrderId?: string | null,
  reduceOnly?: boolean,
): "ENTRY" | "ADD" | "REDUCE" | undefined {
  if (reduceOnly || clientOrderId?.startsWith("fe-red-")) return "REDUCE";
  if (clientOrderId?.startsWith("fe-entry-")) return "ENTRY";
  if (clientOrderId?.startsWith("fe-add-")) return "ADD";
  return undefined;
}
