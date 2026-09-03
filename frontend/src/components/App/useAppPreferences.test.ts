import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppPreferences } from "./useAppPreferences";

describe("useAppPreferences", () => {
  beforeEach(() => localStorage.clear());

  it("keeps display defaults enabled and opt-in features disabled", () => {
    const { result } = renderHook(() => useAppPreferences(false));
    expect(result.current.showDrawings).toBe(true);
    expect(result.current.showWatermark).toBe(true);
    expect(result.current.showNewYorkKillZone).toBe(false);
    expect(result.current.persistentAlertsEnabled).toBe(false);
  });

  it("applies desktop session defaults once and persists later changes", () => {
    const { result } = renderHook(() => useAppPreferences(true));
    expect(result.current.showAsiaSession).toBe(false);
    expect(localStorage.getItem("fyxtez:desktop-session-defaults-v2")).toBe("applied");

    act(() => result.current.setShowAsiaSession(true));
    expect(result.current.showAsiaSession).toBe(true);
    expect(localStorage.getItem("fyxtez:asia-session-enabled")).toBe("true");
  });
});
