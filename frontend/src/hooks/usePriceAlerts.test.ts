import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceAlert } from "../types/alert";
import { useChartRefs } from "./useChartRefs";
import { usePriceAlerts } from "./usePriceAlerts";

const apiMocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../trading/api/priceAlerts", () => ({
  cancelPersistentPriceAlert: apiMocks.cancel,
  createPersistentPriceAlert: apiMocks.create,
  listPersistentPriceAlerts: apiMocks.list,
  updatePersistentPriceAlert: apiMocks.update,
}));

describe("usePriceAlerts persistent trigger reconciliation", () => {
  beforeEach(() => {
    apiMocks.cancel.mockReset();
    apiMocks.create.mockReset();
    apiMocks.list.mockReset().mockResolvedValue([]);
    apiMocks.update.mockReset();
  });

  it("does not resurrect an alert that triggers before its create request resolves", async () => {
    let resolveCreate!: (alert: PriceAlert) => void;
    apiMocks.create.mockReturnValueOnce(
      new Promise<PriceAlert>((resolve) => {
        resolveCreate = resolve;
      }),
    );

    const { result } = renderHook(() => {
      const refs = useChartRefs();
      return usePriceAlerts(refs, "BTCUSDT", 76_000, true);
    });

    await waitFor(() => expect(apiMocks.list).toHaveBeenCalledWith("BTCUSDT"));

    act(() => result.current.addAlert(77_000));
    expect(result.current.alerts).toHaveLength(1);

    act(() => {
      window.dispatchEvent(
        new CustomEvent("persistent-price-alert-triggered", {
          detail: { id: "backend-alert-id", symbol: "BTCUSDT" },
        }),
      );
    });

    act(() => {
      resolveCreate({
        ...result.current.alerts[0],
        id: "backend-alert-id",
      });
    });

    await waitFor(() => expect(result.current.alerts).toEqual([]));
    expect(localStorage.getItem("price-alerts-BTCUSDT")).toBe("[]");
  });
});
