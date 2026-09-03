import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import TradeMenu from "./TradeMenu";

function createProps(
  overrides: Partial<ComponentProps<typeof TradeMenu>> = {},
): ComponentProps<typeof TradeMenu> {
  return {
    symbol: "BTCUSDT",
    pricePrecision: 1,
    tradeMenu: { x: 100, y: 100, selectedPrice: 76_500, marketPrice: 76_510 },
    isSubmittingTrade: false,
    pendingTradeAction: null,
    availableBalance: 1_000,
    marginPct: 0.02,
    isLoadingBalance: false,
    balanceError: null,
    positionSide: null,
    positionQuantity: 0,
    reservedReduceQuantity: 0,
    isLoadingPosition: false,
    reducePct: 100,
    onReducePctChange: vi.fn(),
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    onAutoMarket: vi.fn(),
    onAdd: vi.fn(),
    onReduce: vi.fn(),
    onReverse: vi.fn(),
    backendConnection: "connected",
    leverage: 10,
    maxLeverage: 20,
    isUpdatingLeverage: false,
    leverageError: null,
    onLeverageChange: vi.fn(),
    onLeverageCommit: vi.fn(),
    ...overrides,
  };
}

describe("TradeMenu", () => {
  it("requires an explicit order type and direction before submitting", () => {
    const onSubmit = vi.fn();
    render(<TradeMenu {...createProps({ onSubmit })} />);

    fireEvent.click(screen.getByRole("button", { name: /LIMIT ORDER/ }));
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "LONG" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith("LIMIT", "BUY");
  });

  it("fails closed when the backend degrades during a trading session", () => {
    const onSubmit = vi.fn();
    render(<TradeMenu {...createProps({ backendConnection: "disconnected", onSubmit })} />);

    expect(
      screen.getByText("Backend disconnected — trading actions are disabled until it reconnects."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /LIMIT ORDER/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /MARKET ORDER/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /AUTO MARKET/ })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
