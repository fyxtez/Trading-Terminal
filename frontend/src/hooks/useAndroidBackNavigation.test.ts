import { describe, expect, it, vi } from "vitest";
import {
  DOUBLE_BACK_EXIT_WINDOW_MS,
  claimMobileBack,
  resolveUnclaimedBack,
} from "./useAndroidBackNavigation";

describe("Android back navigation", () => {
  it("arms exit on the first unclaimed back and exits on a quick second back", () => {
    expect(resolveUnclaimedBack(null, 10_000)).toBe("arm-exit");
    expect(resolveUnclaimedBack(10_000, 10_000 + DOUBLE_BACK_EXIT_WINDOW_MS)).toBe("exit");
    expect(resolveUnclaimedBack(10_000, 10_001 + DOUBLE_BACK_EXIT_WINDOW_MS)).toBe("arm-exit");
  });

  it("allows only the first active UI layer to claim a back event", () => {
    const event = new CustomEvent("test", {
      cancelable: true,
      detail: { handled: false },
    });
    const first = vi.fn();
    const second = vi.fn();

    expect(claimMobileBack(event, first)).toBe(true);
    expect(claimMobileBack(event, second)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });
});
