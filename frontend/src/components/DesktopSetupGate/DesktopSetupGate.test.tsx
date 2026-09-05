import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canUseTradingAccount,
  DESKTOP_ONBOARDING_KEY,
  setDesktopCredentialStatus,
} from "../../desktop/credentials";
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
    setDesktopCredentialStatus(emptyStatus);
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
    fireEvent.click(screen.getByRole("button", { name: "FINISH" }));
    expect(screen.getByText("Choose Binance Mainnet or Testnet.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /MAINNET/ }));
    fireEvent.click(screen.getByRole("button", { name: "FINISH" }));
    expect(screen.getByText("Confirm that Mainnet orders use real funds.")).toBeVisible();

    fireEvent.click(screen.getByLabelText("I understand that this connection can use real funds."));
    fireEvent.click(screen.getByRole("button", { name: "FINISH" }));
    await waitFor(() => expect(screen.getByText("Terminal")).toBeVisible());
    expect(screen.queryByText("Connect ntfy")).not.toBeInTheDocument();
    expect(screen.queryByText("Connect Telegram")).not.toBeInTheDocument();
  });

  it("shows rejected Mainnet credentials in the styled setup error without closing setup", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "credential_status") return Promise.resolve(emptyStatus);
      if (command === "save_credentials") {
        return Promise.reject(
          new Error(
            "This Binance Mainnet API key has withdrawals enabled. It was not saved. Disable this key and create a new Futures-only key with withdrawals disabled.",
          ),
        );
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(
      <DesktopSetupGate>
        <div>Terminal</div>
      </DesktopSetupGate>,
    );

    await screen.findByRole("heading", { name: "Connect Binance" });
    fireEvent.change(screen.getByLabelText("Binance API key"), {
      target: { value: "withdrawal-enabled-key" },
    });
    fireEvent.change(screen.getByLabelText("Binance API secret"), {
      target: { value: "api-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /MAINNET/ }));
    fireEvent.click(screen.getByLabelText("I understand that this connection can use real funds."));
    fireEvent.click(screen.getByRole("button", { name: "FINISH" }));

    const error = await screen.findByText(/withdrawals enabled\. It was not saved/);
    expect(error).toHaveClass("desktop-setup-error");
    expect(screen.getByRole("heading", { name: "Connect Binance" })).toBeVisible();
    expect(screen.queryByText("Terminal")).not.toBeInTheDocument();
  });

  it("shows credential-store failures in the styled editor and recovers without replacing keys", async () => {
    localStorage.setItem(DESKTOP_ONBOARDING_KEY, "true");
    const recoveredStatus = {
      ...emptyStatus,
      binanceConfigured: true,
      binanceNetwork: "testnet" as const,
    };
    let statusAttempts = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "credential_status") {
        statusAttempts += 1;
        if (statusAttempts === 1) {
          return Promise.reject(
            new Error(
              "Stored Binance credentials are incomplete. Trading is blocked; reopen Settings and replace or clear the complete Binance connection",
            ),
          );
        }
        return Promise.resolve(recoveredStatus);
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(
      <DesktopSetupGate>
        <div>Terminal</div>
      </DesktopSetupGate>,
    );

    const error = await screen.findByText(/credentials are incomplete\. Trading is blocked/);
    expect(error).toHaveClass("desktop-setup-error");
    expect(screen.getByRole("heading", { name: "Connect binance" })).toBeVisible();
    expect(screen.getByText("Terminal")).toBeVisible();
    expect(canUseTradingAccount()).toBe(false);
    expect(screen.getByRole("button", { name: "SAVE REPLACEMENT" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "RETRY CREDENTIAL STORE" }));
    await waitFor(() =>
      expect(screen.queryByText(/credentials are incomplete/)).not.toBeInTheDocument(),
    );
    expect(statusAttempts).toBe(2);
    expect(screen.queryByRole("heading", { name: "Connect binance" })).not.toBeInTheDocument();
    expect(canUseTradingAccount()).toBe(true);
  });

  it("allows an incomplete credential set to be replaced from the recovery panel", async () => {
    localStorage.setItem(DESKTOP_ONBOARDING_KEY, "true");
    const recoveredStatus = {
      ...emptyStatus,
      binanceConfigured: true,
      binanceNetwork: "testnet" as const,
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === "credential_status") {
        return Promise.reject(new Error("Stored Binance credentials are incomplete"));
      }
      if (command === "save_credentials") return Promise.resolve(recoveredStatus);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(
      <DesktopSetupGate>
        <div>Terminal</div>
      </DesktopSetupGate>,
    );

    await screen.findByText("Stored Binance credentials are incomplete");
    fireEvent.click(screen.getByRole("button", { name: /TESTNET/ }));
    fireEvent.change(screen.getByLabelText("Binance API key"), {
      target: { value: "replacement-key" },
    });
    fireEvent.change(screen.getByLabelText("Binance API secret"), {
      target: { value: "replacement-secret" },
    });

    const save = screen.getByRole("button", { name: "SAVE REPLACEMENT" });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(save).not.toBeInTheDocument());
    expect(invokeMock).toHaveBeenCalledWith("save_credentials", {
      input: {
        binanceApiKey: "replacement-key",
        binanceApiSecret: "replacement-secret",
        binanceNetwork: "testnet",
        confirmMainnet: false,
        ntfyUrl: null,
        telegramBotToken: null,
        telegramChatId: null,
      },
    });
    expect(canUseTradingAccount()).toBe(true);
  });

  it("finishes in chart-only mode when every connection is skipped", async () => {
    render(
      <DesktopSetupGate>
        <div>Terminal</div>
      </DesktopSetupGate>,
    );

    await screen.findByRole("heading", { name: "Connect Binance" });
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

  it("does not expose dormant ntfy or Telegram setup steps", async () => {
    render(
      <DesktopSetupGate>
        <div>Terminal</div>
      </DesktopSetupGate>,
    );

    await screen.findByRole("heading", { name: "Connect Binance" });
    expect(screen.getByText("STEP 01 OF 01")).toBeVisible();
    expect(screen.queryByText(/ntfy/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/telegram/i)).not.toBeInTheDocument();
  });
});
