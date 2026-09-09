import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPanel from "./SettingsPanel";

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
    showCandleCountdown: false,
    onShowCandleCountdownChange: vi.fn(),
    showWatermark: true,
    onShowWatermarkChange: vi.fn(),
    showDrawingSetBadge: false,
    onShowDrawingSetBadgeChange: vi.fn(),
    showStartOfDay: false,
    onShowStartOfDayChange: vi.fn(),
    startOfDayLookbackDays: 0,
    onStartOfDayLookbackDaysChange: vi.fn(),
    showPriceAlerts: false,
    onShowPriceAlertsChange: vi.fn(),
    persistentAlertsEnabled: false,
    onPersistentAlertsEnabledChange: vi.fn(),
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

  it("the Binance shortcut opens Exchange Connections directly", () => {
    render(<SettingsPanel {...props()} exchangeConnectionsRequest={1} />);
    expect(screen.getByRole("heading", { name: "Exchange Connections" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull();
  });
});
