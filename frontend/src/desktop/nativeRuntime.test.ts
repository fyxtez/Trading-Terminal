import { afterEach, expect, it, vi } from "vitest";
import { isTauri } from "@tauri-apps/api/core";
import { isNativeTerminal } from "./nativeRuntime";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("retains native behavior in the standalone Terminal window", () => {
  vi.mocked(isTauri).mockReturnValue(true);
  expect(isNativeTerminal()).toBe(true);
});

it("does not call native commands from a WebView2 subframe with Tauri globals", () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.stubGlobal("window", { self: {}, top: {} });
  expect(isNativeTerminal()).toBe(false);
});

it("does not treat an ordinary browser window as native", () => {
  vi.mocked(isTauri).mockReturnValue(false);
  expect(isNativeTerminal()).toBe(false);
});
