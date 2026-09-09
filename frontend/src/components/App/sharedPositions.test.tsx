import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  createPositionBindingsStore,
  SharedPositionsPanel,
  type PanePositionBindings,
} from "./sharedPositions";

vi.mock("../PositionsPanel/PositionsPanel", () => ({
  default: ({ activeSymbol, onSwitchSymbol }: PanePositionBindings) => {
    const [tab, setTab] = useState("positions");
    return (
      <div data-testid="positions-panel">
        <span>{activeSymbol}</span>
        <button onClick={() => setTab("orders")}>{tab}</button>
        <button onClick={() => onSwitchSymbol("ETHUSDT")}>Navigate</button>
      </div>
    );
  },
}));
const bindings = (symbol: string, navigate = vi.fn()) =>
  ({ activeSymbol: symbol, onSwitchSymbol: navigate }) as unknown as PanePositionBindings;

describe("shared positions dock", () => {
  it("retains one panel and its selected tab while routing actions to the active chart", async () => {
    const store = createPositionBindingsStore();
    const left = vi.fn(),
      right = vi.fn();
    store.set("left", bindings("BTCUSDT", left));
    store.set("right", bindings("SOLUSDT", right));
    const controls = {
      store,
      isOpen: true,
      height: 280,
      onHeightChange: vi.fn(),
      onClose: vi.fn(),
    };
    const view = render(<SharedPositionsPanel {...controls} activeId="left" />);
    await screen.findByText("BTCUSDT");
    fireEvent.click(screen.getByText("positions"));
    view.rerender(<SharedPositionsPanel {...controls} activeId="right" />);
    expect(screen.getAllByTestId("positions-panel")).toHaveLength(1);
    expect(screen.getByText("orders")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Navigate"));
    expect(right).toHaveBeenCalledWith("ETHUSDT");
    expect(left).not.toHaveBeenCalled();
    act(() => store.set("right", bindings("XRPUSDT", right)));
    expect(screen.getByText("XRPUSDT")).toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();
  });
});
