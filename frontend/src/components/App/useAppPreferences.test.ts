import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppPreferences } from "./useAppPreferences";

describe("useAppPreferences", () => {
  beforeEach(() => localStorage.clear());

  it("keeps core display defaults enabled and optional overlays disabled", () => {
    const { result } = renderHook(() => useAppPreferences());
    expect(result.current.showDrawings).toBe(true);
    expect(result.current.showWatermark).toBe(true);
    expect(result.current.showAsiaSession).toBe(false);
    expect(result.current.showLondonSession).toBe(false);
    expect(result.current.showNewYorkSession).toBe(false);
    expect(result.current.showStartOfDay).toBe(false);
    expect(result.current.showNewYorkKillZone).toBe(false);
    expect(result.current.persistentAlertsEnabled).toBe(false);
  });

  it("persists explicit session and start-of-day choices", () => {
    const { result, unmount } = renderHook(() => useAppPreferences());

    act(() => result.current.setShowAsiaSession(true));
    act(() => result.current.setShowStartOfDay(true));
    expect(result.current.showAsiaSession).toBe(true);
    expect(result.current.showStartOfDay).toBe(true);
    expect(localStorage.getItem("fyxtez:asia-session-enabled")).toBe("true");
    expect(localStorage.getItem("fyxtez:start-of-day-enabled")).toBe("true");

    unmount();
    const restored = renderHook(() => useAppPreferences());
    expect(restored.result.current.showAsiaSession).toBe(true);
    expect(restored.result.current.showStartOfDay).toBe(true);
  });
});
