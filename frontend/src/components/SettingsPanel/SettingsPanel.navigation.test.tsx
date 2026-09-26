import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPanel from "./SettingsPanel";
import { DesktopCredentialsContext } from "../DesktopSetupGate/DesktopCredentialsContext";
import { getSizing, updateSizing } from "../../trading/api/sizing";
vi.mock("../../trading/api/sizing", () => ({
  getSizing: vi.fn().mockResolvedValue({ margin_pct: 0.01, max_leverage: 50 }),
  updateSizing: vi.fn().mockImplementation(async (value) => value),
}));

vi.mock("../../trading/api/priceAlerts", () => ({
  listAllPersistentPriceAlerts: vi.fn().mockResolvedValue([
    {
      id: "server-alert",
      symbol: "SOLUSDT",
      price: 150,
      createdAt: 1,
      side: "LONG",
      crossing: "CROSS_DOWN",
      pattern: "support",
      additionalInfo: "server-owned note",
      locked: false,
      hidden: false,
    },
  ]),
  getAlertDeliveryStatus: vi.fn().mockResolvedValue({
    ntfyConfigured: true,
    telegramConfigured: false,
    pendingDeliveries: 1,
  }),
}));

function props(): ComponentProps<typeof SettingsPanel> {
  return {
    isOpen: true,
    onClose: vi.fn(),
    width: 400,
    onWidthChange: vi.fn(),
    backendConnection: "disconnected",
    currentSymbol: "SOLUSDT",
    availableSymbols: [],
    activePriceAlerts: [],
    regularDrawingsCount: 0,
    drawingSets: [],
    activeDrawingSetId: null,
    onSaveCurrentDrawingSet: vi.fn().mockReturnValue(true),
    onLoadDrawingSet: vi.fn().mockReturnValue(true),
    onRenameDrawingSet: vi.fn().mockReturnValue(true),
    onDeleteDrawingSet: vi.fn(),
    onClearCurrentDrawings: vi.fn(),
    showDrawings: false,
    onShowDrawingsChange: vi.fn(),
    showAsiaSession: false,
    onShowAsiaSessionChange: vi.fn(),
    showLondonSession: false,
    onShowLondonSessionChange: vi.fn(),
    showNewYorkSession: false,
    onShowNewYorkSessionChange: vi.fn(),
    showNewYorkKillZone: false,
    onShowNewYorkKillZoneChange: vi.fn(),
    showPositionPnl: false,
    onShowPositionPnlChange: vi.fn(),
    showTotalPnl: false,
    onShowTotalPnlChange: vi.fn(),
    candleTimerInHeader: false,
    onCandleTimerInHeaderChange: vi.fn(),
    showCandleCountdown: false,
    onShowCandleCountdownChange: vi.fn(),
    showWatermark: true,
    onShowWatermarkChange: vi.fn(),
    showDrawingSetBadge: false,
    onShowDrawingSetBadgeChange: vi.fn(),
    showCurrentDailyCandle: false,
    onShowCurrentDailyCandleChange: vi.fn(),
    showStartOfDay: false,
    onShowStartOfDayChange: vi.fn(),
    startOfDayLookbackDays: 0,
    onStartOfDayLookbackDaysChange: vi.fn(),
    showPriceAlerts: false,
    onShowPriceAlertsChange: vi.fn(),
    diagnostics: {
      isDesktop: false,
      backendConnection: "disconnected",
      marketConnection: "disconnected",
      frontendStreamConnection: "disconnected",
      backend: null,
      operationSafety: null,
      isLoading: false,
      error: null,
      refreshedAt: null,
      notice: null,
      resolvingIntentId: null,
      resolutionError: null,
      dismissNotice: vi.fn(),
      refresh: vi.fn(),
      resolveIntent: vi.fn(),
    },
  };
}

describe("Settings section picker", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });
  it("opens a section with working controls and returns to the icon menu", () => {
    const values = props();
    render(<SettingsPanel {...values} />);
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Chart display" })).toBeNull();
    expect(screen.getByRole("region", { name: "Available balance" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Available balance" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Chart display" }));
    expect(screen.getByRole("region", { name: "Available balance" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Chart display" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Show watermark/ }));
    expect(values.onShowWatermarkChange).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: /All settings/ }));
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeInTheDocument();
  });

  it("search reveals multiple matches and clearing it restores the selected section", () => {
    render(<SettingsPanel {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "PNL" }));
    const search = screen.getByPlaceholderText("Search settings…");
    fireEvent.change(search, { target: { value: "chart" } });
    expect(screen.getByRole("region", { name: "Available balance" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Drawings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Chart display" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear settings search" }));
    expect(screen.getByRole("heading", { name: "PNL" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Chart display" })).toBeNull();
  });

  it.each(["picker", "search"])(
    "loads server alerts through %s even when the saved section was collapsed",
    async (entry) => {
      localStorage.setItem("fyxtez.settings.alertsSectionVisible", "false");
      render(<SettingsPanel {...props()} backendConnection="connected" />);
      if (entry === "picker") {
        fireEvent.click(screen.getByRole("button", { name: "Alerts" }));
      } else {
        fireEvent.change(screen.getByPlaceholderText("Search settings…"), {
          target: { value: "alerts" },
        });
      }
      expect(await screen.findByText("server-owned note")).toBeInTheDocument();
      expect(screen.getByText(/ntfy: Configured.*Telegram: Not configured/)).toBeInTheDocument();
    },
  );

  it("the Binance shortcut opens Exchange Connections directly", () => {
    render(<SettingsPanel {...props()} exchangeConnectionsRequest={1} />);
    expect(screen.getByRole("heading", { name: "Exchange Connections" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull();
  });
});

it("saves 0.1% margin as 0.001 and rejects values below the new minimum", async () => {
  vi.mocked(getSizing).mockResolvedValue({ margin_pct: 0.01, max_leverage: 50 });
  vi.mocked(updateSizing).mockClear();
  render(
    <DesktopCredentialsContext.Provider
      value={{
        isDesktop: false,
        runtimeMode: "remote-browser",
        canTrade: true,
        status: {
          binanceConfigured: true,
          binanceNetwork: "mainnet",
          ntfyConfigured: false,
          telegramConfigured: false,
        },
        openSetup: vi.fn(),
        disconnectBinance: vi.fn(),
      }}
    >
      <SettingsPanel {...props()} backendConnection="connected" />
    </DesktopCredentialsContext.Provider>,
  );
  fireEvent.change(screen.getByPlaceholderText("Search settings…"), {
    target: { value: "Margin percentage" },
  });
  const input = await screen.findByRole("spinbutton");
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "0" } });
  expect(input).toHaveValue(0);
  fireEvent.change(input, { target: { value: "0.1" } });
  expect(input).toHaveAttribute("min", "0.1");
  expect(input).toHaveAttribute("step", "0.1");
  fireEvent.blur(input);
  await waitFor(() =>
    expect(updateSizing).toHaveBeenCalledWith({ margin_pct: 0.001, max_leverage: 50 }),
  );
  vi.mocked(updateSizing).mockClear();
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "0.05" } });
  expect(screen.getByText("Margin percentage must be between 0.1 and 50%")).toBeInTheDocument();
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.blur(input);
  expect(updateSizing).not.toHaveBeenCalled();
});
