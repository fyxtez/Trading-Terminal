import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceAlert } from "../types/alert";
import { useChartRefs } from "./useChartRefs";
import { usePriceAlerts } from "./usePriceAlerts";
import { SYSTEM_NOTICE_EVENT } from "../diagnostics/events";

const api = vi.hoisted(() => ({
  cancel: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
}));
vi.mock("../trading/api/priceAlerts", () => ({
  cancelPersistentPriceAlert: api.cancel,
  createPersistentPriceAlert: api.create,
  listPersistentPriceAlerts: api.list,
  updatePersistentPriceAlert: api.update,
}));
const alert: PriceAlert = {
  id: "server-id",
  price: 77_000,
  createdAt: 1,
  side: "SHORT",
  crossing: "CROSS_UP",
  pattern: "resistance",
  additionalInfo: "",
  locked: false,
  hidden: false,
};
const mount = (symbol = "BTCUSDT") =>
  renderHook(({ symbol }) => usePriceAlerts(useChartRefs(), symbol, 76_000), {
    initialProps: { symbol },
  });
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe("server-owned price alerts", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetAllMocks();
    api.list.mockResolvedValue([]);
    api.cancel.mockResolvedValue(undefined);
    api.update.mockImplementation(async (value) => value);
  });

  it("waits for server confirmation and does not resurrect an alert triggered during creation", async () => {
    let resolve!: (value: PriceAlert) => void;
    api.create.mockReturnValue(
      new Promise<PriceAlert>((done) => {
        resolve = done;
      }),
    );
    const { result } = mount();
    await flush();
    act(() => result.current.addAlert(77_000));
    expect(result.current.alerts).toEqual([]);
    act(() =>
      window.dispatchEvent(
        new CustomEvent("persistent-price-alert-triggered", {
          detail: { id: alert.id, symbol: "BTCUSDT" },
        }),
      ),
    );
    await act(async () => resolve(alert));
    expect(result.current.alerts).toEqual([]);
  });

  it("reports failed creation without leaving a fake active alert or uploading legacy data", async () => {
    localStorage.setItem(
      "price-alerts-BTCUSDT",
      JSON.stringify([{ ...alert, id: "alert-legacy" }]),
    );
    const notice = vi.fn();
    window.addEventListener(SYSTEM_NOTICE_EVENT, notice);
    api.create.mockRejectedValue(new Error("Server unavailable"));
    const { result } = mount();
    await flush();
    expect(api.create).not.toHaveBeenCalled();
    expect(localStorage.getItem("price-alerts-BTCUSDT")).toContain("alert-legacy");
    act(() => result.current.addAlert(77_000));
    await waitFor(() => expect(notice).toHaveBeenCalled());
    expect(result.current.alerts).toEqual([]);
    window.removeEventListener(SYSTEM_NOTICE_EVENT, notice);
  });

  it("refreshes changes from another device and after reconnection", async () => {
    const { result } = mount();
    await flush();
    api.list.mockResolvedValue([alert]);
    act(() => window.dispatchEvent(new Event("price-alerts-changed")));
    await waitFor(() => expect(result.current.alerts).toEqual([alert]));
    api.list.mockResolvedValue([]);
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(result.current.alerts).toEqual([]));
  });

  it("does not let a delayed request overwrite another symbol", async () => {
    let resolve!: (value: PriceAlert) => void;
    api.create.mockReturnValue(
      new Promise<PriceAlert>((done) => {
        resolve = done;
      }),
    );
    const { result, rerender } = mount();
    await flush();
    act(() => result.current.addAlert(77_000));
    rerender({ symbol: "ETHUSDT" });
    await flush();
    await act(async () => resolve(alert));
    expect(result.current.alerts).toEqual([]);
    expect(localStorage.getItem("price-alerts-ETHUSDT:server")).toBe("[]");
  });

  it("keeps the line when deletion fails and leaves the trigger direction unchanged when flipping side", async () => {
    api.list.mockResolvedValue([alert]);
    api.cancel.mockRejectedValue(new Error("offline"));
    api.update.mockImplementation(async (next) => {
      api.list.mockResolvedValue([next]);
      return next;
    });
    const { result } = mount();
    await waitFor(() => expect(result.current.alerts).toHaveLength(1));
    act(() => result.current.removeAlert(alert.id));
    await flush();
    expect(result.current.alerts).toEqual([alert]);
    act(() => result.current.toggleAlertSide(alert.id));
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(
        expect.objectContaining({ side: "LONG", crossing: "CROSS_UP" }),
      ),
    );
  });

  it("undoes and redoes persisted creation using real backend IDs", async () => {
    let count = 0;
    api.create.mockImplementation(async (_symbol, value) => {
      const created = { ...value, id: `server-${++count}` };
      api.list.mockResolvedValue([created]);
      return created;
    });
    api.cancel.mockImplementation(async () => {
      api.list.mockResolvedValue([]);
    });
    const { result } = mount();
    await flush();
    act(() => result.current.addAlert(77_000));
    await waitFor(() => expect(result.current.alerts[0]?.id).toBe("server-1"));
    await flush();
    act(() => result.current.undo());
    await waitFor(() => expect(result.current.alerts).toEqual([]));
    expect(api.cancel).toHaveBeenCalledWith("server-1");
    await flush();
    act(() => result.current.redo());
    await waitFor(() => expect(result.current.alerts[0]?.id).toBe("server-2"));
    await flush();
    act(() => result.current.undo());
    await waitFor(() => expect(api.cancel).toHaveBeenLastCalledWith("server-2"));
  });

  it("keeps redo usable when another alert triggers during an undo request", async () => {
    let remote: PriceAlert[] = [];
    let count = 0;
    api.list.mockImplementation(async () => remote);
    api.create.mockImplementation(async (_symbol, value) => {
      const created = { ...value, id: `server-${++count}` };
      remote = [...remote, created];
      return created;
    });
    let finishDelete!: () => void;
    api.cancel.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        }),
    );
    const { result } = mount();
    await flush();
    act(() => result.current.addAlert(77_000));
    await flush();
    act(() => result.current.addAlert(78_000));
    await flush();
    act(() => result.current.undo());
    act(() =>
      window.dispatchEvent(
        new CustomEvent("persistent-price-alert-triggered", {
          detail: { id: "server-1", symbol: "BTCUSDT" },
        }),
      ),
    );
    remote = [];
    await act(async () => finishDelete());
    await flush();
    act(() => result.current.redo());
    await waitFor(() => expect(result.current.alerts[0]?.id).toBe("server-3"));
    expect(api.create).toHaveBeenCalledTimes(3);
  });

  it("does not leave a restore redoable if it triggers before the create response", async () => {
    api.create.mockResolvedValueOnce(alert);
    api.list.mockResolvedValue([alert]);
    const { result } = mount();
    await flush();
    act(() => result.current.removeAlert(alert.id));
    api.list.mockResolvedValue([]);
    await flush();
    let finishRestore!: (value: PriceAlert) => void;
    api.create.mockReset().mockReturnValue(
      new Promise<PriceAlert>((resolve) => {
        finishRestore = resolve;
      }),
    );
    act(() => result.current.undo());
    act(() =>
      window.dispatchEvent(
        new CustomEvent("persistent-price-alert-triggered", {
          detail: { id: "restored-id", symbol: "BTCUSDT" },
        }),
      ),
    );
    await act(async () => finishRestore({ ...alert, id: "restored-id" }));
    await flush();
    act(() => result.current.undo());
    await flush();
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(result.current.alerts).toEqual([]);
  });

  it("does nothing for an unsupported or disabled market", () => {
    const { result } = renderHook(() => usePriceAlerts(useChartRefs(), "BTCUSDT", 76_000, false));
    act(() => result.current.addAlert(77_000));
    expect(api.list).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
  });
});
