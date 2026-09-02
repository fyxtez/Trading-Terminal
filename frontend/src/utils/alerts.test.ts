import { describe, expect, it, vi } from "vitest";
import { SYSTEM_NOTICE_EVENT, type SystemNotice } from "../diagnostics/events";
import { sendPriceAlertNotification } from "./alerts";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: () => true,
}));

describe("sendPriceAlertNotification", () => {
  it("surfaces delivery failure without rejecting the completed alert", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    invokeMock.mockRejectedValueOnce(new Error("ntfy request failed"));
    const notices: SystemNotice[] = [];
    const listener = (event: Event) => {
      notices.push((event as CustomEvent<SystemNotice>).detail);
    };
    window.addEventListener(SYSTEM_NOTICE_EVENT, listener);

    await expect(
      sendPriceAlertNotification("BTCUSDT", 76_500, "LONG", "breakout", ""),
    ).resolves.toBeUndefined();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "warning",
      title: "Notification delivery failed",
    });
    expect(notices[0].message).toContain("price alert still triggered successfully");
    window.removeEventListener(SYSTEM_NOTICE_EVENT, listener);
  });
});
