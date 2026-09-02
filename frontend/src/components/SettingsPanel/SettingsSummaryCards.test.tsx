import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopCredentialsContextValue } from "../DesktopSetupGate/DesktopCredentialsContext";
import { DesktopConnectionsSection } from "./SettingsSummaryCards";

function ConnectionsHarness({
  credentials,
}: {
  credentials: DesktopCredentialsContextValue;
}) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <DesktopConnectionsSection
      credentials={credentials}
      isExpanded={isExpanded}
      onToggle={() => setIsExpanded((visible) => !visible)}
    />
  );
}

describe("DesktopConnectionsSection", () => {
  it("collapses connection details and exposes them again", () => {
    const credentials: DesktopCredentialsContextValue = {
      isDesktop: true,
      status: {
        binanceConfigured: false,
        binanceNetwork: null,
        ntfyConfigured: false,
        telegramConfigured: false,
      },
      openSetup: vi.fn(),
    };

    render(<ConnectionsHarness credentials={credentials} />);

    expect(
      screen.getByRole("heading", { name: "Third-Party Connections" }),
    ).toBeVisible();
    expect(
      screen.queryByText("Credentials stored securely on this computer."),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "HIDE" }));
    expect(screen.getByRole("button", { name: "SHOW" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("Binance")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "SHOW" }));
    expect(screen.getByText("Binance")).toBeVisible();
  });

  it("opens the editor for the selected connection", () => {
    const openSetup = vi.fn();
    const credentials: DesktopCredentialsContextValue = {
      isDesktop: true,
      status: {
        binanceConfigured: true,
        binanceNetwork: "testnet",
        ntfyConfigured: true,
        telegramConfigured: true,
      },
      openSetup,
    };

    render(<ConnectionsHarness credentials={credentials} />);
    fireEvent.click(screen.getAllByRole("button", { name: "EDIT" })[0]);

    expect(openSetup).toHaveBeenCalledWith("binance");
  });
});
