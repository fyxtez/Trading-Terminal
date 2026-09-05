import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppCache: 16 },
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

import { collectFyxtezLocalStorage, replaceFyxtezLocalStorage } from "./localBackup";

describe("portable Fyxtez local storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("includes drawings and preferences but excludes alerts, icon cache and unrelated data", () => {
    localStorage.setItem("drawings-BTCUSDT", "[]");
    localStorage.setItem("drawing-sets-BTCUSDT", "[]");
    localStorage.setItem("fyxtez.settings.marginSectionVisible", "true");
    localStorage.setItem("price-alerts-BTCUSDT", "private-alert");
    localStorage.setItem("fyxtez:symbol-icon-metadata:v1:local", "cache");
    localStorage.setItem("other-app", "untouched");

    expect(collectFyxtezLocalStorage()).toEqual({
      "drawing-sets-BTCUSDT": "[]",
      "drawings-BTCUSDT": "[]",
      "fyxtez.settings.marginSectionVisible": "true",
    });
  });

  it("replaces only portable Fyxtez entries", () => {
    localStorage.setItem("drawings-BTCUSDT", "old");
    localStorage.setItem("other-app", "keep");

    replaceFyxtezLocalStorage({
      "drawings-ETHUSDT": "new",
      "fyxtez:current-symbol": "ETHUSDT",
    });

    expect(localStorage.getItem("drawings-BTCUSDT")).toBeNull();
    expect(localStorage.getItem("drawings-ETHUSDT")).toBe("new");
    expect(localStorage.getItem("other-app")).toBe("keep");
  });

  it("rejects unsupported incoming keys before changing current data", () => {
    localStorage.setItem("drawings-BTCUSDT", "keep");
    expect(() => replaceFyxtezLocalStorage({ "other-app": "bad" })).toThrow("unsupported");
    expect(localStorage.getItem("drawings-BTCUSDT")).toBe("keep");
  });
});
