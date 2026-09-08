import { describe, expect, it } from "vitest";
import { userFacingError } from "./userFacingError";

describe("userFacingError", () => {
  it("shows missing Practice prices without hiding validation guidance", () => {
    const guidance =
      "Binance Practice has no usable last-traded price for PUMPUSDT. Try again when a quote is available.";
    expect(userFacingError(new Error(`Invalid request: ${guidance}`))).toBe(guidance);
    expect(
      userFacingError(new Error("Invalid request: invalid JSON payload"), "Cannot continue."),
    ).toBe("Cannot continue.");
  });
  it("replaces connection implementation details with a useful next step", () => {
    expect(
      userFacingError(
        new Error("embedded backend stopped: HTTP connection failed at 127.0.0.1"),
        "Terminal could not start. Please try again.",
      ),
    ).toBe("Terminal could not start. Please try again.");
  });

  it("explains protected-storage failures without naming the storage technology", () => {
    expect(userFacingError(new Error("credential store unavailable"))).toBe(
      "Terminal could not open your saved connections. Unlock your device and try again.",
    );
  });

  it("keeps already-readable Binance guidance", () => {
    const guidance = "This Binance key allows withdrawals. Create a new Futures-only key.";
    expect(userFacingError(new Error(guidance))).toBe(guidance);
  });
});
