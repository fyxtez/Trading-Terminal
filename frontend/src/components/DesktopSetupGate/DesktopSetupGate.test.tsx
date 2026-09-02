import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DesktopSetupGate from "./DesktopSetupGate";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: () => true,
}));

const emptyStatus = {
  binanceConfigured: false,
  binanceNetwork: null,
  ntfyConfigured: false,
  telegramConfigured: false,
};

describe("DesktopSetupGate", () => {
  beforeEach(() => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "credential_status") return Promise.resolve(emptyStatus);
      if (command === "save_credentials") return Promise.resolve(emptyStatus);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
  });

  it("requires an explicit Binance network and Mainnet confirmation", async () => {
    render(
      <DesktopSetupGate>
        <div>Terminal</div>
      </DesktopSetupGate>,
    );

    await screen.findByRole("heading", { name: "Connect Binance" });
    fireEvent.change(screen.getByLabelText("Binance API key"), {
      target: { value: "api-key" },
    });
    fireEvent.change(screen.getByLabelText("Binance API secret"), {
      target: { value: "api-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "NEXT" }));
    expect(screen.getByText("Choose Binance Mainnet or Testnet.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /MAINNET/ }));
    fireEvent.click(screen.getByRole("button", { name: "NEXT" }));
    expect(
      screen.getByText("Confirm that Mainnet orders use real funds."),
    ).toBeVisible();

    fireEvent.click(
      screen.getByLabelText(
        "I understand that this connection can use real funds.",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "NEXT" }));
    expect(
      await screen.findByRole("heading", { name: "Connect ntfy" }),
    ).toBeVisible();
  });

  it("finishes in chart-only mode when every connection is skipped", async () => {
    render(
      <DesktopSetupGate>
        <div>Terminal</div>
      </DesktopSetupGate>,
    );

    await screen.findByRole("heading", { name: "Connect Binance" });
    fireEvent.click(screen.getByRole("button", { name: "SKIP STEP" }));
    fireEvent.click(screen.getByRole("button", { name: "SKIP STEP" }));
    fireEvent.click(screen.getByRole("button", { name: "SKIP & FINISH" }));

    await waitFor(() => expect(screen.getByText("Terminal")).toBeVisible());
    expect(invokeMock).toHaveBeenCalledWith("save_credentials", {
      input: {
        binanceApiKey: null,
        binanceApiSecret: null,
        binanceNetwork: null,
        confirmMainnet: false,
        ntfyUrl: null,
        telegramBotToken: null,
        telegramChatId: null,
      },
    });
  });
});
