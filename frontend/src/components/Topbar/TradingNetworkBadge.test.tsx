import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import TradingNetworkBadge from "./TradingNetworkBadge";

describe("TradingNetworkBadge", () => {
  it("makes Mainnet unmistakably live", () => {
    render(<TradingNetworkBadge network="mainnet" />);

    expect(screen.getByLabelText("Binance live trading")).toHaveTextContent("LIVE");
    expect(screen.getByLabelText("Binance live trading")).toHaveClass("live");
  });

  it("labels Testnet as demo", () => {
    render(<TradingNetworkBadge network="testnet" />);

    expect(screen.getByLabelText("Binance practice trading")).toHaveTextContent("PRACTICE");
    expect(screen.getByLabelText("Binance practice trading")).toHaveClass("demo");
  });

  it("makes the unconfigured trading state explicit", () => {
    render(<TradingNetworkBadge network={null} />);

    expect(screen.getByLabelText("Binance not connected")).toHaveTextContent("NOT CONNECTED");
    expect(screen.getByLabelText("Binance not connected")).toHaveClass("unavailable");
  });
});
