import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopRuntimeGate from "./DesktopRuntimeGate";
import { initializeTradingApiBaseUrl, retryTradingRuntime } from "../../config/constants";
import { LOCAL_BROWSER_SESSION_ENDED_EVENT } from "../../trading/api/http";

const runtime = vi.hoisted(() => ({ mode: "native" as "native" | "local-browser" }));
const browserSession = vi.hoisted(() => ({ proof: null as string | null }));

vi.mock("../../config/constants", () => ({
  LocalBrowserSessionError: class LocalBrowserSessionError extends Error {},
  initializeTradingApiBaseUrl: vi.fn(),
  retryTradingRuntime: vi.fn(),
  validateLocalBrowserSession: vi.fn(),
  getTradingRuntimeMode: () => runtime.mode,
  getLocalBrowserSessionProof: () => browserSession.proof,
}));

const initializeMock = vi.mocked(initializeTradingApiBaseUrl);
const restartMock = vi.mocked(retryTradingRuntime);

describe("DesktopRuntimeGate", () => {
  afterEach(() => vi.useRealTimers());
  it("skips the startup message when initialization finishes quickly", async () => {
    vi.useFakeTimers();
    initializeMock.mockResolvedValueOnce("http://127.0.0.1:12345");
    render(
      <DesktopRuntimeGate>
        <div>terminal</div>
      </DesktopRuntimeGate>,
    );
    expect(screen.queryByText("Getting Terminal ready")).not.toBeInTheDocument();
    await act(async () => {});
    expect(screen.getByText("terminal")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByText("Getting Terminal ready")).not.toBeInTheDocument();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.mode = "native";
    browserSession.proof = null;
  });

  it("requires reopening from the installed app when a local browser session has ended", async () => {
    runtime.mode = "local-browser";
    initializeMock.mockRejectedValueOnce(
      new Error("This browser connection has expired or was turned off."),
    );

    render(
      <DesktopRuntimeGate>
        <div>terminal</div>
      </DesktopRuntimeGate>,
    );

    expect(await screen.findByText("Open this page from Terminal again")).toBeVisible();
    expect(screen.getByText(/Return to the installed Terminal app/i)).toBeVisible();
    expect(screen.getByText(/cannot reconnect by itself/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "CHECK AGAIN" })).not.toBeInTheDocument();
    expect(screen.queryByText("terminal")).not.toBeInTheDocument();
  });

  it("keeps Check Again for a temporary local-browser connection failure", async () => {
    runtime.mode = "local-browser";
    browserSession.proof = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    initializeMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    restartMock.mockResolvedValueOnce("http://127.0.0.1:8658");

    render(
      <DesktopRuntimeGate>
        <div>terminal</div>
      </DesktopRuntimeGate>,
    );

    const retry = await screen.findByRole("button", { name: "CHECK AGAIN" });
    expect(screen.getByText("Browser access needs attention")).toBeVisible();
    expect(
      screen.getByText("Terminal could not check this browser connection. Please try again."),
    ).toBeVisible();
    expect(screen.getByText(/installed Terminal app is still open/i)).toBeVisible();

    fireEvent.click(retry);
    expect(await screen.findByText("terminal")).toBeInTheDocument();
    expect(restartMock).toHaveBeenCalledOnce();
  });

  it("removes retry when an active local-browser session is rejected", async () => {
    runtime.mode = "local-browser";
    browserSession.proof = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    initializeMock.mockResolvedValueOnce("http://127.0.0.1:8658");

    render(
      <DesktopRuntimeGate>
        <div>terminal</div>
      </DesktopRuntimeGate>,
    );
    expect(await screen.findByText("terminal")).toBeInTheDocument();

    browserSession.proof = null;
    act(() => window.dispatchEvent(new Event(LOCAL_BROWSER_SESSION_ENDED_EVENT)));

    expect(await screen.findByText("Open this page from Terminal again")).toBeVisible();
    expect(screen.queryByRole("button", { name: "CHECK AGAIN" })).not.toBeInTheDocument();
    expect(restartMock).not.toHaveBeenCalled();
  });

  it("does not render the terminal before the local backend is ready", async () => {
    vi.useFakeTimers();
    let resolveRuntime: (value: string) => void = () => undefined;
    initializeMock.mockReturnValue(
      new Promise((resolve) => {
        resolveRuntime = resolve;
      }),
    );

    render(
      <DesktopRuntimeGate>
        <div>terminal</div>
      </DesktopRuntimeGate>,
    );
    expect(screen.queryByText("terminal")).not.toBeInTheDocument();
    expect(screen.queryByText("Getting Terminal ready")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByText("Getting Terminal ready")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();

    await act(async () => resolveRuntime("http://127.0.0.1:12345"));
    expect(screen.getByText("terminal")).toBeInTheDocument();
  });

  it("offers an explicit retry after supervisor failure", async () => {
    initializeMock.mockRejectedValueOnce(new Error("sidecar stopped"));
    restartMock.mockResolvedValueOnce("http://127.0.0.1:12345");

    render(
      <DesktopRuntimeGate>
        <div>terminal</div>
      </DesktopRuntimeGate>,
    );
    const retry = await screen.findByRole("button", { name: "TRY AGAIN" });
    expect(screen.getByText("Terminal could not start. Please try again.")).toBeInTheDocument();

    fireEvent.click(retry);
    expect(await screen.findByText("terminal")).toBeInTheDocument();
    expect(restartMock).toHaveBeenCalledOnce();
  });
});
