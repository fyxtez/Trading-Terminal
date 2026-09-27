import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, type ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ChartPanel from "./ChartPanel";
import { useChartRefs } from "../../hooks/useChartRefs";
import { useAppPreferences } from "../App/useAppPreferences";
import { getDailyCandle } from "../../trading/api/dailyCandle";

const positionLife = vi.hoisted(() => ({ mounts: 0, cleanups: 0 }));
vi.mock("../PositionBracketOverlay/PositionBracketOverlay", () => ({
  default: () => {
    useEffect(() => {
      positionLife.mounts++;
      return () => {
        positionLife.cleanups++;
      };
    }, []);
    return <div data-testid="position-overlay" />;
  },
}));
vi.mock("../DrawingMoveToast/DrawingMoveToast", () => ({ default: () => null }));
vi.mock("../ChartContextBadges/ChartContextBadges", () => ({ default: () => null }));
vi.mock("../ChartTimezoneBadge/ChartTimezoneBadge", () => ({ default: () => null }));
vi.mock("../../trading/api/dailyCandle", () => ({ getDailyCandle: vi.fn() }));

function Harness({ symbol = "BTCUSDT", revision = 0 }) {
  const refs = useChartRefs();
  const preferences = useAppPreferences();
  const props = {
    ...refs,
    symbol,
    interval: "1m",
    tool: "cursor",
    showCurrentDailyCandle: preferences.showCurrentDailyCandle,
    showCandleCountdown: false,
    isChartLoading: false,
    temporaryTradePrice: null,
    positionPnl: null,
    positionRealizedPnl: null,
    totalPnl: null,
    alerts: [],
    coordTimeToX: () => 200,
  } as unknown as ComponentProps<typeof ChartPanel>;
  return (
    <div data-revision={revision}>
      <label>
        Daily candle
        <input
          type="checkbox"
          checked={preferences.showCurrentDailyCandle}
          onChange={(event) => preferences.setShowCurrentDailyCandle(event.target.checked)}
        />
      </label>
      <ChartPanel {...props} />
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(console, "error").mockImplementation(() => {});
  localStorage.setItem("fyxtez:daily-candle-enabled", "true");
  vi.mocked(getDailyCandle).mockReset().mockResolvedValue(null);
  positionLife.mounts = 0;
  positionLife.cleanups = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

it("retains one daily candle and one position overlay across repeated chart renders", async () => {
  const view = render(<Harness />);
  await act(async () => {});
  const candle = view.container.querySelector("svg");
  for (let revision = 1; revision <= 20; revision++) {
    view.rerender(<Harness revision={revision} />);
    expect(view.container.querySelectorAll("svg")).toHaveLength(1);
    expect(view.container.querySelector("svg")).toBe(candle);
  }
  expect(positionLife.mounts).toBe(1);
  expect(getDailyCandle).toHaveBeenCalledTimes(1);
  expect(console.error).not.toHaveBeenCalled();
  view.unmount();
  expect(positionLife.cleanups).toBe(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(32);
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("removes the candle and stops its polling when Settings disables it without refreshing", async () => {
  const view = render(<Harness />);
  await act(async () => {});
  view.rerender(<Harness revision={1} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Daily candle" }));
  expect(view.container.querySelectorAll("svg")).toHaveLength(0);
  expect(localStorage.getItem("fyxtez:daily-candle-enabled")).toBe("false");
  const calls = vi.mocked(getDailyCandle).mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(getDailyCandle).toHaveBeenCalledTimes(calls);
  expect(positionLife.mounts).toBe(1);
  fireEvent.click(screen.getByRole("checkbox", { name: "Daily candle" }));
  await act(async () => {});
  expect(view.container.querySelectorAll("svg")).toHaveLength(1);
  expect(getDailyCandle).toHaveBeenCalledTimes(calls + 1);
  view.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(32);
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("cleans up old symbol overlays and cancels their outstanding request", async () => {
  vi.mocked(getDailyCandle).mockImplementation(() => new Promise(() => {}));
  const view = render(<Harness />);
  const oldCandle = view.container.querySelector("svg");
  const oldSignal = vi.mocked(getDailyCandle).mock.calls[0][1]!;
  view.rerender(<Harness symbol="ETHUSDT" />);
  expect(oldCandle?.isConnected).toBe(false);
  expect(view.container.querySelectorAll("svg")).toHaveLength(1);
  expect(oldSignal.aborted).toBe(true);
  expect(positionLife.mounts).toBe(2);
  expect(positionLife.cleanups).toBe(1);
  view.unmount();
  expect(positionLife.cleanups).toBe(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(32);
  });
  expect(vi.getTimerCount()).toBe(0);
});
