import { describe, expect, it, vi } from "vitest";
import { financialMutationFingerprint, runFinancialMutation } from "./financialMutation";

describe("financial mutation intents", () => {
  it("coalesces duplicate in-flight actions under one intent", async () => {
    let release: ((value: string) => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const fingerprint = financialMutationFingerprint("/api/orders/market", {
      symbol: "BTCUSDT",
      side: "BUY",
    });

    const first = runFinancialMutation(fingerprint, execute);
    const second = runFinancialMutation(fingerprint, execute);
    expect(execute).toHaveBeenCalledTimes(1);
    release?.("ok");
    await expect(first).resolves.toBe("ok");
    await expect(second).resolves.toBe("ok");
  });

  it("reuses the intent after an uncertain transport failure", async () => {
    const ids: string[] = [];
    const fingerprint = financialMutationFingerprint("/api/orders/limit", { price: 100 });
    await expect(
      runFinancialMutation(fingerprint, async (intentId) => {
        ids.push(intentId);
        throw new TypeError("Failed to fetch");
      }),
    ).rejects.toThrow("Failed to fetch");

    await runFinancialMutation(fingerprint, async (intentId) => {
      ids.push(intentId);
      return "replayed";
    });
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });
});
