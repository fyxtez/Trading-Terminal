import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import TradingNetworkBadge from "./TradingNetworkBadge";

describe("TradingNetworkBadge", () => {
  it("makes Mainnet unmistakably live", () => {
    render(<TradingNetworkBadge network="mainnet" />);

    expect(screen.getByLabelText("Binance Live Mainnet")).toHaveTextContent("LIVE");
    expect(screen.getByLabelText("Binance Live Mainnet")).toHaveClass("live");
  });

  it("labels Testnet as demo", () => {
    render(<TradingNetworkBadge network="testnet" />);

    expect(screen.getByLabelText("Binance Demo Testnet")).toHaveTextContent("DEMO");
    expect(screen.getByLabelText("Binance Demo Testnet")).toHaveClass("demo");
  });

  it("makes the unconfigured trading state explicit", () => {
    render(<TradingNetworkBadge network={null} />);

    expect(screen.getByLabelText("Binance not connected")).toHaveTextContent("NO BINANCE");
    expect(screen.getByLabelText("Binance not connected")).toHaveClass("unavailable");
  });
});
