import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DesktopRuntimeGate from "./DesktopRuntimeGate";
import { initializeTradingApiBaseUrl, restartDesktopBackend } from "../../config/constants";

vi.mock("../../config/constants", () => ({
  initializeTradingApiBaseUrl: vi.fn(),
  restartDesktopBackend: vi.fn(),
}));

const initializeMock = vi.mocked(initializeTradingApiBaseUrl);
const restartMock = vi.mocked(restartDesktopBackend);

describe("DesktopRuntimeGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not render the terminal before the local backend is ready", async () => {
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
    expect(screen.getByText("Starting local backend")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();

    resolveRuntime("http://127.0.0.1:12345");
    expect(await screen.findByText("terminal")).toBeInTheDocument();
  });

  it("offers an explicit retry after supervisor failure", async () => {
    initializeMock.mockRejectedValueOnce(new Error("sidecar stopped"));
    restartMock.mockResolvedValueOnce("http://127.0.0.1:12345");

    render(
      <DesktopRuntimeGate>
        <div>terminal</div>
      </DesktopRuntimeGate>,
    );
    const retry = await screen.findByRole("button", { name: "RETRY BACKEND" });
    expect(screen.getByText("sidecar stopped")).toBeInTheDocument();

    fireEvent.click(retry);
    expect(await screen.findByText("terminal")).toBeInTheDocument();
    expect(restartMock).toHaveBeenCalledOnce();
  });
});
