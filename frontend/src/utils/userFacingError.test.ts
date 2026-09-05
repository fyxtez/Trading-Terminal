import { describe, expect, it } from "vitest";
import { userFacingError } from "./userFacingError";

describe("userFacingError", () => {
  it("replaces connection implementation details with a useful next step", () => {
    expect(
      userFacingError(
        new Error("embedded backend stopped: HTTP connection failed at 127.0.0.1"),
        "Fyxtez could not start. Please try again.",
      ),
    ).toBe("Fyxtez could not start. Please try again.");
  });

  it("explains protected-storage failures without naming the storage technology", () => {
    expect(userFacingError(new Error("credential store unavailable"))).toBe(
      "Fyxtez could not open your saved connections. Unlock your device and try again.",
    );
  });

  it("keeps already-readable Binance guidance", () => {
    const guidance = "This Binance key allows withdrawals. Create a new Futures-only key.";
    expect(userFacingError(new Error(guidance))).toBe(guidance);
  });
});
