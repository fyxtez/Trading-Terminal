import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopCredentialsContextValue } from "../DesktopSetupGate/DesktopCredentialsContext";
import { ExchangeConnectionsSection } from "./SettingsSummaryCards";

function ConnectionsHarness({ credentials }: { credentials: DesktopCredentialsContextValue }) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <ExchangeConnectionsSection
      credentials={credentials}
      isExpanded={isExpanded}
      onToggle={() => setIsExpanded((visible) => !visible)}
    />
  );
}

describe("ExchangeConnectionsSection", () => {
  it("collapses connection details and exposes them again", () => {
    const credentials: DesktopCredentialsContextValue = {
      isDesktop: true,
      runtimeMode: "native",
      canTrade: false,
      status: {
        binanceConfigured: false,
        binanceNetwork: null,
        ntfyConfigured: false,
        telegramConfigured: false,
      },
      openSetup: vi.fn(),
      disconnectBinance: vi.fn(),
    };

    render(<ConnectionsHarness credentials={credentials} />);

    expect(screen.getByRole("heading", { name: "Exchange Connections" })).toBeVisible();
    expect(
      screen.queryByText("Credentials stored securely on this computer."),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "HIDE" }));
    expect(screen.getByRole("button", { name: "SHOW" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Binance")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "SHOW" }));
    expect(screen.getByText("Binance")).toBeVisible();
    expect(screen.queryByText("ntfy")).not.toBeInTheDocument();
    expect(screen.queryByText("Telegram")).not.toBeInTheDocument();
  });

  it("opens the editor for the selected connection", () => {
    const openSetup = vi.fn();
    const credentials: DesktopCredentialsContextValue = {
      isDesktop: true,
      runtimeMode: "native",
      canTrade: true,
      status: {
        binanceConfigured: true,
        binanceNetwork: "testnet",
        ntfyConfigured: true,
        telegramConfigured: true,
      },
      openSetup,
      disconnectBinance: vi.fn(),
    };

    render(<ConnectionsHarness credentials={credentials} />);
    fireEvent.click(screen.getAllByRole("button", { name: "EDIT" })[0]);

    expect(openSetup).toHaveBeenCalledWith("binance");
  });

  it("explains where Binance is connected when Settings is opened in a browser", () => {
    const openSetup = vi.fn();
    const credentials: DesktopCredentialsContextValue = {
      isDesktop: false,
      runtimeMode: "public-browser",
      canTrade: false,
      status: {
        binanceConfigured: false,
        binanceNetwork: null,
        ntfyConfigured: false,
        telegramConfigured: false,
      },
      openSetup,
      disconnectBinance: vi.fn(),
    };

    render(<ConnectionsHarness credentials={credentials} />);

    expect(screen.getByText("INSTALLED APP ONLY")).toBeVisible();
    expect(screen.getByText(/browser window is for charts only/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "CONNECT" })).not.toBeInTheDocument();
    expect(openSetup).not.toHaveBeenCalled();
  });

  it("requires styled confirmation before disconnecting Binance", async () => {
    const disconnectBinance = vi.fn().mockResolvedValue(undefined);
    const credentials: DesktopCredentialsContextValue = {
      isDesktop: true,
      runtimeMode: "native",
      canTrade: true,
      status: {
        binanceConfigured: true,
        binanceNetwork: "mainnet",
        ntfyConfigured: false,
        telegramConfigured: false,
      },
      openSetup: vi.fn(),
      disconnectBinance,
    };

    render(<ConnectionsHarness credentials={credentials} />);
    fireEvent.click(screen.getByRole("button", { name: "DISCONNECT" }));

    expect(screen.getByRole("group", { name: "Confirm Binance disconnect" })).toBeVisible();
    expect(screen.getByText(/Trading will be disabled immediately/)).toBeVisible();
    expect(disconnectBinance).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "CONFIRM DISCONNECT" }));
    await waitFor(() => expect(disconnectBinance).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: "Confirm Binance disconnect" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps the confirmation open and shows a styled native error on failure", async () => {
    const credentials: DesktopCredentialsContextValue = {
      isDesktop: true,
      runtimeMode: "native",
      canTrade: true,
      status: {
        binanceConfigured: true,
        binanceNetwork: "testnet",
        ntfyConfigured: false,
        telegramConfigured: false,
      },
      openSetup: vi.fn(),
      disconnectBinance: vi.fn().mockRejectedValue(new Error("credential store locked")),
    };

    render(<ConnectionsHarness credentials={credentials} />);
    fireEvent.click(screen.getByRole("button", { name: "DISCONNECT" }));
    fireEvent.click(screen.getByRole("button", { name: "CONFIRM DISCONNECT" }));

    const error = await screen.findByRole("alert");
    expect(error).toHaveClass("settings-disconnect-error");
    expect(error).toHaveTextContent(
      "Fyxtez could not open your saved connections. Unlock your device and try again.",
    );
    expect(screen.getByRole("group", { name: "Confirm Binance disconnect" })).toBeVisible();
  });

  it("shows safe Binance status in the local browser without key controls", () => {
    const credentials: DesktopCredentialsContextValue = {
      isDesktop: false,
      runtimeMode: "local-browser",
      canTrade: true,
      status: {
        binanceConfigured: true,
        binanceNetwork: "testnet",
        ntfyConfigured: false,
        telegramConfigured: false,
      },
      openSetup: vi.fn(),
      disconnectBinance: vi.fn(),
    };

    render(<ConnectionsHarness credentials={credentials} />);

    expect(screen.getByText("CONNECTED · TESTNET")).toBeVisible();
    expect(screen.getByText(/keys are not exposed to the browser interface/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "EDIT" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "DISCONNECT" })).not.toBeInTheDocument();
  });
});
