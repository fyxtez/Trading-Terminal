import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import CurrentDailyCandleOverlay from "./CurrentDailyCandleOverlay";
import { getDailyCandle } from "../../trading/api/dailyCandle";

let draw: () => void;
vi.mock("../../utils/pacedLoop", () => ({
  startPacedLoop: (callback: () => void) => {
    draw = callback;
    return () => {};
  },
}));
vi.mock("../../trading/api/dailyCandle", () => ({ getDailyCandle: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([
  { open: 100, close: 120, color: "#34d399" },
  { open: 120, close: 100, color: "#f04562" },
])(
  "renders filled daily OHLC in $color, stays 100 px from the latest candle and clears at rollover",
  async ({ open, close, color }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T23:59:59Z"));
    const day = Date.parse("2026-09-26T00:00:00Z") / 1000;
    vi.mocked(getDailyCandle).mockResolvedValue({
      time: day as never,
      open,
      high: 130,
      low: 80,
      close,
    });
    const props = {
      symbol: "BTCUSDT",
      chartRef: { current: { paneSize: () => ({ width: 600, height: 400 }) } },
      candleRef: {
        current: {
          priceToCoordinate: (price: number) => 300 - price,
          options: () => ({
            upColor: "#34d399",
            downColor: "#f04562",
            wickUpColor: "#34d399",
            wickDownColor: "#f04562",
          }),
        },
      },
      lastDataTimeRef: { current: day + 86000 },
      coordTimeToX: () => 200,
    } as unknown as ComponentProps<typeof CurrentDailyCandleOverlay>;
    const view = render(<CurrentDailyCandleOverlay {...props} />);
    await act(async () => {});
    draw();
    expect(getDailyCandle).toHaveBeenCalledWith("BTCUSDT", expect.any(AbortSignal));
    const body = view.container.querySelector("rect")!;
    const wick = view.container.querySelector("path")!;
    const group = view.container.querySelector("g")!;
    expect(body).toHaveAttribute("x", "291");
    expect(body).toHaveAttribute("y", "180");
    expect(body).toHaveAttribute("height", "20");
    expect(body).toHaveAttribute("fill", color);
    expect(wick).toHaveAttribute("stroke", color);
    expect(wick).toHaveAttribute("d", "M 300 170 L 300 180 M 300 200 L 300 220");
    for (const anchor of [200, 210, 230, 260, 324, 398, 300, 200]) {
      view.rerender(<CurrentDailyCandleOverlay {...props} coordTimeToX={() => anchor} />);
      draw();
      expect(view.container.querySelectorAll("rect")).toHaveLength(1);
      expect(view.container.querySelectorAll("path")).toHaveLength(1);
      expect(view.container.querySelector("rect")).toBe(body);
      expect(body).toHaveAttribute("x", String(anchor + 100 - 9));
      expect(group.style.display).toBe("");
    }
    view.rerender(<CurrentDailyCandleOverlay {...props} coordTimeToX={() => 700} />);
    draw();
    expect(group.style.display).toBe("none");
    view.rerender(<CurrentDailyCandleOverlay {...props} />);
    draw();
    expect(group.style.display).toBe("");
    vi.setSystemTime(new Date("2026-09-27T00:00:00Z"));
    draw();
    expect(group.style.display).toBe("none");
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("does not render a late response from the previous symbol", async () => {
  let resolveOld: (value: never) => void = () => {};
  vi.mocked(getDailyCandle)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue(null);
  const props = {
    symbol: "BTCUSDT",
    chartRef: { current: { paneSize: () => ({ width: 600, height: 400 }) } },
    candleRef: { current: { priceToCoordinate: (p: number) => p } },
    lastDataTimeRef: { current: 1 },
    coordTimeToX: () => 100,
  } as unknown as ComponentProps<typeof CurrentDailyCandleOverlay>;
  const view = render(<CurrentDailyCandleOverlay {...props} />);
  const calls = vi.mocked(getDailyCandle).mock.calls;
  const signal = calls[calls.length - 1][1]!;
  view.rerender(<CurrentDailyCandleOverlay {...props} symbol="ETHUSDT" />);
  expect(signal.aborted).toBe(true);
  await act(async () => {
    resolveOld({
      time: Math.floor(Date.now() / 86400000) * 86400,
      open: 100,
      high: 120,
      low: 90,
      close: 110,
    } as never);
  });
  draw();
  expect(view.container.querySelector("g")!.style.display).toBe("none");
  view.unmount();
});
