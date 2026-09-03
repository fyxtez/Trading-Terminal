import { beforeEach, describe, expect, it } from "vitest";
import { classifyLimitOrder, loadFullStopPrice } from "./orderPresentation";
describe("order presentation", () => {
  beforeEach(() => localStorage.clear());

  it("classifies application client-order prefixes", () => {
    expect(classifyLimitOrder("fe-entry-long-1")).toBe("ENTRY");
    expect(classifyLimitOrder("fe-add-1")).toBe("ADD");
    expect(classifyLimitOrder("fe-red-50-1")).toBe("REDUCE");
  });

  it("treats any reduce-only order as a reduction", () => {
    expect(classifyLimitOrder("external-order", true)).toBe("REDUCE");
    expect(classifyLimitOrder("external-order", false)).toBeUndefined();
  });

  it("restores a persisted stop price without requiring the full stop shape", () => {
    localStorage.setItem("fyxtez:full-stop:BTCUSDT", JSON.stringify({ triggerPrice: 96.5 }));
    expect(loadFullStopPrice("btcusdt")).toBe(96.5);
  });
});
