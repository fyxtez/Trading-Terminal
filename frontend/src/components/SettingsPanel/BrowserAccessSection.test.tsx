import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BrowserAccessSection from "./BrowserAccessSection";

const invokeMock = vi.hoisted(() => vi.fn());
const runtime = vi.hoisted(() => ({ mode: "native" as "native" | "local-browser" }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../config/constants", () => ({
  getTradingRuntimeMode: () => runtime.mode,
}));

const nativeStatus = {
  supported: true,
  available: true,
  enabled: false,
  browserUrl: "http://127.0.0.1:8658",
  activeSessions: 0,
  unavailableReason: null,
};

describe("BrowserAccessSection", () => {
  beforeEach(() => {
    runtime.mode = "native";
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "browser_access_status") return Promise.resolve(nativeStatus);
      return Promise.resolve(undefined);
    });
  });

  it("enables browser access and opens it through the native command", async () => {
    render(<BrowserAccessSection isExpanded onToggle={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "ENABLE & OPEN" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("open_browser_terminal");
    });
  });

  it("asks before turning off active browser sessions", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "browser_access_status") {
        return Promise.resolve({ ...nativeStatus, enabled: true, activeSessions: 2 });
      }
      return Promise.resolve(undefined);
    });
    render(<BrowserAccessSection isExpanded onToggle={vi.fn()} />);

    expect(await screen.findByText("ON · 2 SESSIONS")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "TURN OFF" }));
    expect(screen.getByRole("group", { name: "Confirm turning off browser access" })).toBeVisible();
    expect(invokeMock).not.toHaveBeenCalledWith("disable_browser_access");

    fireEvent.click(screen.getByRole("button", { name: "CONFIRM TURN OFF" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("disable_browser_access"));
  });

  it("shows a read-only, nontechnical status in the connected browser", () => {
    runtime.mode = "local-browser";
    render(<BrowserAccessSection isExpanded onToggle={vi.fn()} />);

    expect(screen.getByText("CONNECTED")).toBeVisible();
    expect(screen.getByText(/keys are not exposed to the browser interface/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "TURN OFF" })).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("shows a generic unavailable state when the native status check fails", async () => {
    invokeMock.mockRejectedValue(new Error("IPC unavailable"));
    render(<BrowserAccessSection isExpanded onToggle={vi.fn()} />);

    expect(await screen.findByText("UNAVAILABLE")).toBeVisible();
    expect(screen.queryByText("LINUX ONLY")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("could not check browser access");
  });

  it("hides browser access on Android and other unsupported native platforms", async () => {
    invokeMock.mockResolvedValue({ ...nativeStatus, supported: false, available: false });
    const { container } = render(<BrowserAccessSection isExpanded onToggle={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("browser_access_status"));
    expect(container).toBeEmptyDOMElement();
  });
});
