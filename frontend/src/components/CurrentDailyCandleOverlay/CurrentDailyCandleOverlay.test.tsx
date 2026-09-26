import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import CurrentDailyCandleOverlay from "./CurrentDailyCandleOverlay";
import { fetchLatestKline } from "../../trading/api/marketData";

let draw: () => void;
vi.mock("../../utils/pacedLoop", () => ({
  startPacedLoop: (callback: () => void) => {
    draw = callback;
    return () => {};
  },
}));
vi.mock("../../trading/api/marketData", () => ({ fetchLatestKline: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([
  { open: 100, close: 120, color: "#34d399" },
  { open: 120, close: 100, color: "#f04562" },
])(
  "renders filled daily OHLC in $color, tracks offset and clears at rollover",
  async ({ open, close, color }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T23:59:59Z"));
    const day = Date.parse("2026-09-26T00:00:00Z") / 1000;
    vi.mocked(fetchLatestKline).mockResolvedValue({
      time: day as never,
      open,
      high: 130,
      low: 80,
      close,
    });
    const ctx = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: "",
      strokeStyle: "",
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    const props = {
      symbol: "BTCUSDT",
      offset: 50,
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
    expect(fetchLatestKline).toHaveBeenCalledWith("1d", "BTCUSDT", expect.any(AbortSignal));
    expect(ctx.fillRect).toHaveBeenLastCalledWith(341, 180, 18, 20);
    expect(ctx.fillStyle).toBe(color);
    expect(ctx.strokeStyle).toBe(color);
    expect(ctx.moveTo).toHaveBeenCalledWith(350, 170);
    expect(ctx.lineTo).toHaveBeenCalledWith(350, 220);
    view.rerender(<CurrentDailyCandleOverlay {...props} offset={0} />);
    draw();
    expect(ctx.fillRect).toHaveBeenLastCalledWith(291, 180, 18, 20);
    ctx.fillRect.mockClear();
    vi.setSystemTime(new Date("2026-09-27T00:00:00Z"));
    draw();
    expect(ctx.fillRect).not.toHaveBeenCalled();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("does not render a late response from the previous symbol", async () => {
  let resolveOld: (value: never) => void = () => {};
  vi.mocked(fetchLatestKline)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue(null);
  const ctx = { setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
  const props = {
    symbol: "BTCUSDT",
    offset: 0,
    chartRef: { current: { paneSize: () => ({ width: 600, height: 400 }) } },
    candleRef: { current: { priceToCoordinate: (p: number) => p } },
    lastDataTimeRef: { current: 1 },
    coordTimeToX: () => 100,
  } as unknown as ComponentProps<typeof CurrentDailyCandleOverlay>;
  const view = render(<CurrentDailyCandleOverlay {...props} />);
  const calls = vi.mocked(fetchLatestKline).mock.calls;
  const signal = calls[calls.length - 1][2]!;
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
  expect(ctx.fillRect).not.toHaveBeenCalled();
  view.unmount();
});
