import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_ONBOARDING_KEY } from "../../desktop/credentials";
import { useDesktopCredentials } from "./DesktopCredentialsContext";
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

function BinanceEditorLauncher() {
  const credentials = useDesktopCredentials();
  return <button onClick={() => credentials.openSetup("binance")}>Edit Binance</button>;
}

describe("DesktopSetupGate", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockImplementation((command: string) => {
      if (command === "credential_status") return Promise.resolve(emptyStatus);
      if (command === "save_credentials") return Promise.resolve(emptyStatus);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
  });

  it("preselects the active Binance network when editing the connection", async () => {
    const configuredStatus = {
      ...emptyStatus,
      binanceConfigured: true,
      binanceNetwork: "testnet" as const,
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === "credential_status") return Promise.resolve(configuredStatus);
      if (command === "save_credentials") return Promise.resolve(configuredStatus);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    localStorage.setItem(DESKTOP_ONBOARDING_KEY, "true");

    render(
      <DesktopSetupGate>
        <BinanceEditorLauncher />
      </DesktopSetupGate>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Edit Binance" }));

    expect(screen.getByRole("button", { name: /TESTNET/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /MAINNET/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
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
    expect(screen.getByText("Confirm that Mainnet orders use real funds.")).toBeVisible();

    fireEvent.click(screen.getByLabelText("I understand that this connection can use real funds."));
    fireEvent.click(screen.getByRole("button", { name: "NEXT" }));
    expect(await screen.findByRole("heading", { name: "Connect ntfy" })).toBeVisible();
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

  it("accepts an ntfy topic without requiring the complete publish URL", async () => {
    render(
      <DesktopSetupGate>
        <div>Terminal</div>
      </DesktopSetupGate>,
    );

    await screen.findByRole("heading", { name: "Connect Binance" });
    fireEvent.click(screen.getByRole("button", { name: "SKIP STEP" }));
    fireEvent.change(screen.getByLabelText("Private ntfy topic"), {
      target: { value: "fyxtez_private-42" },
    });
    fireEvent.click(screen.getByRole("button", { name: "NEXT" }));
    fireEvent.click(screen.getByRole("button", { name: "SKIP & FINISH" }));

    await waitFor(() => expect(screen.getByText("Terminal")).toBeVisible());
    expect(invokeMock).toHaveBeenCalledWith("save_credentials", {
      input: expect.objectContaining({ ntfyUrl: "fyxtez_private-42" }),
    });
  });
});
