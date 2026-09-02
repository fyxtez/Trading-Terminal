import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AppErrorBoundary from "./AppErrorBoundary";

function BrokenView(): never {
  throw new Error("render exploded");
}

describe("AppErrorBoundary", () => {
  it("replaces a crashed interface with an explicit fail-closed recovery view", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <AppErrorBoundary>
        <BrokenView />
      </AppErrorBoundary>,
    );

    expect(
      screen.getByRole("heading", { name: "The terminal could not render safely." }),
    ).toBeVisible();
    expect(screen.getByText("render exploded")).toBeVisible();
    expect(screen.getByRole("button", { name: "RELOAD TERMINAL" })).toBeVisible();
  });
});
