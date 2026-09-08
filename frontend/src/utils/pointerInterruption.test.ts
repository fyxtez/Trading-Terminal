import { describe, expect, it, vi } from "vitest";
import { watchPointerInterruption } from "./pointerInterruption";

describe("interrupted chart pointers", () => {
  it("cancels lost capture, pointer cancellation, blur and Escape but leaves normal pointer-up alone", () => {
    const cancel = vi.fn();
    const stop = watchPointerInterruption(cancel);
    try {
      window.dispatchEvent(new Event("pointerup"));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "F5" }));
      expect(cancel).not.toHaveBeenCalled();
      for (const type of ["pointercancel", "lostpointercapture", "blur"]) {
        window.dispatchEvent(new Event(type));
      }
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(cancel).toHaveBeenCalledTimes(4);
      stop();
      window.dispatchEvent(new Event("blur"));
      expect(cancel).toHaveBeenCalledTimes(4);
    } finally {
      stop();
    }
  });
  it("cancels when the tab is hidden, not when it becomes visible", () => {
    const cancel = vi.fn();
    const stop = watchPointerInterruption(cancel);
    try {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(cancel).toHaveBeenCalledTimes(1);
      vi.spyOn(document, "hidden", "get").mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      vi.restoreAllMocks();
    }
  });
});
