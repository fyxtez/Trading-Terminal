import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OperationalDiagnostics } from "../../hooks/useOperationalDiagnostics";
import DiagnosticsSection from "./DiagnosticsSection";

function diagnostics(overrides: Partial<OperationalDiagnostics> = {}): OperationalDiagnostics {
  return {
    isDesktop: true,
    backendConnection: "connected",
    marketConnection: "connected",
    frontendStreamConnection: "connected",
    backend: null,
    operationSafety: {
      blocksNewExposure: true,
      confirmationPhrase: "I VERIFIED BINANCE",
      unresolved: [
        {
          intentId: "11111111-1111-4111-8111-111111111111",
          method: "POST",
          path: "/api/orders/market",
          createdAtMs: Date.now() - 60_000,
          ageMs: 60_000,
        },
      ],
    },
    isLoading: false,
    error: null,
    refreshedAt: Date.now(),
    notice: null,
    resolvingIntentId: null,
    resolutionError: null,
    dismissNotice: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    resolveIntent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("DiagnosticsSection uncertain operation recovery", () => {
  it("keeps risk reductions available and requires typed operator confirmation", async () => {
    const value = diagnostics();
    render(<DiagnosticsSection diagnostics={value} isExpanded onToggle={vi.fn()} />);

    expect(screen.getByText("New entries and ADD are blocked")).toBeVisible();
    expect(screen.getByText(/Cancel, Reduce, Stop Loss, Close Position/)).toBeVisible();
    const resolveButton = screen.getByRole("button", { name: "RECONCILE & RESOLVE" });
    expect(resolveButton).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: /Confirmation for uncertain/ }), {
      target: { value: "I VERIFIED BINANCE" },
    });
    expect(resolveButton).toBeEnabled();
    fireEvent.click(resolveButton);

    await waitFor(() =>
      expect(value.resolveIntent).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        "I VERIFIED BINANCE",
      ),
    );
  });

  it("shows a styled inline reconciliation error", () => {
    render(
      <DiagnosticsSection
        diagnostics={diagnostics({ resolutionError: "Binance request timed out" })}
        isExpanded
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveClass("settings-intent-recovery-error");
    expect(screen.getByRole("alert")).toHaveTextContent("Binance request timed out");
  });
});
