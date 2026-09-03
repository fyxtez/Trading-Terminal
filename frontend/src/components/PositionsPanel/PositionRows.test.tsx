import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OpenPosition } from "../../trading/api/positions";
import { PositionRow } from "./PositionRows";

const position: OpenPosition = {
  symbol: "BTCUSDT",
  side: "LONG",
  leverage: 10,
  quantity: 0.1,
  size: 7_700,
  entry_price: 76_000,
  mark_price: 77_000,
  liquidation_price: 69_000,
  margin: 770,
  unrealized_pnl: 100,
  realized_pnl: 20,
  roi_pct: 12.99,
};

function renderPositionRow(isInteractive = true) {
  const actions = {
    onCloseMarket: vi.fn(),
    onToggleTpSlControls: vi.fn(),
    onFocus: vi.fn(),
    onSwitchSymbol: vi.fn(),
  };

  render(
    <PositionRow
      position={position}
      isClosing={false}
      fullTakeProfitPrice={80_000}
      stopLossPrice={74_000}
      areTpSlControlsShown
      isFocused={false}
      isInteractive={isInteractive}
      {...actions}
    />,
  );

  return actions;
}

describe("PositionRow touch-safe activation", () => {
  it("keeps row navigation separate from nested TP/SL and market actions", () => {
    const actions = renderPositionRow();

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(actions.onToggleTpSlControls).toHaveBeenCalledOnce();
    expect(actions.onFocus).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Market" }));
    expect(actions.onCloseMarket).toHaveBeenCalledOnce();
    expect(actions.onFocus).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /BTCUSDT/ }));
    expect(actions.onFocus).toHaveBeenCalledOnce();
    expect(actions.onSwitchSymbol).not.toHaveBeenCalled();
  });

  it("switches an inactive symbol before focusing it and disables market close", () => {
    const actions = renderPositionRow(false);

    expect(screen.getByRole("button", { name: "Market" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /BTCUSDT/ }));

    expect(actions.onSwitchSymbol).toHaveBeenCalledOnce();
    expect(actions.onFocus).toHaveBeenCalledOnce();
    expect(actions.onCloseMarket).not.toHaveBeenCalled();
  });
});
