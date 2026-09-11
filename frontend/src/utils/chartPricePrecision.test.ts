import { expect, it } from "vitest";
import { chartPricePrecision } from "./chartPricePrecision";
const candle = (price: number) => ({ open: price, high: price, low: price, close: price });
it("keeps meaningful PEPE prices instead of rounding them to zero", () => {
  const precision = chartPricePrecision(5, [candle(0.000003245), candle(0.00002)]);
  expect(precision).toBe(9);
  expect((0.000003245).toFixed(precision)).toBe("0.000003245");
  expect(10 ** -precision).toBeLessThan(0.000001);
});
it("keeps small historical candles readable alongside a higher current price", () => {
  expect(chartPricePrecision(5, [candle(0.00000003123), candle(0.000003245)])).toBe(11);
});
it("preserves configured precision for ordinary symbols and invalid/empty data", () => {
  expect(chartPricePrecision(0, [candle(78000)])).toBe(0);
  expect(chartPricePrecision(8, [candle(0.25)])).toBe(8);
  expect(chartPricePrecision(5, [])).toBe(5);
  expect(chartPricePrecision(5, [candle(0), candle(NaN), candle(Infinity)])).toBe(5);
});
