import { describe, expect, it } from "vitest";
import {
  adjacentTabAfterRemoval,
  loadChartWorkspace,
  splitWorkspace,
  supportsSplitCharts,
  unifyWorkspace,
  moveWorkspaceTab,
  WORKSPACE_STORAGE_KEY,
  type ChartWorkspaceState,
} from "./chartWorkspace";

const single = (): ChartWorkspaceState => ({
  activeId: "left",
  panes: [
    {
      id: "left",
      symbol: "BTCUSDT",
      tabs: ["BTCUSDT", "SOLUSDT"],
      intervals: { BTCUSDT: "15m", SOLUSDT: "1h" },
    },
  ],
});
describe("chart workspace", () => {
  it("duplicates all tabs and timeframes without sharing mutable state", () => {
    const state = splitWorkspace(single());
    expect(state.panes[1]).toEqual({ ...state.panes[0], id: "right" });
    state.panes[1].tabs.pop();
    state.panes[1].intervals.BTCUSDT = "1h";
    expect(state.panes[0].tabs).toEqual(["BTCUSDT", "SOLUSDT"]);
    expect(state.panes[0].intervals.BTCUSDT).toBe("15m");
  });
  it("unifies the union of open tabs using the left timeframe only for tabs still open there", () => {
    const state = splitWorkspace(single());
    state.panes[0].tabs = ["BTCUSDT"];
    state.panes[1].tabs.push("ETHUSDT");
    state.panes[1].intervals.SOLUSDT = "4h";
    state.panes[1].intervals.BTCUSDT = "1d";
    const result = unifyWorkspace(state);
    expect(result.panes[0].tabs).toEqual(["BTCUSDT", "SOLUSDT", "ETHUSDT"]);
    expect(result.panes[0].intervals).toMatchObject({ BTCUSDT: "15m", SOLUSDT: "4h" });
  });
  it("moves a tab, its timeframe and focus, deduplicating the destination", () => {
    const state = splitWorkspace(single());
    state.panes[1].intervals.BTCUSDT = "1d";
    const result = moveWorkspaceTab(state, "left", "BTCUSDT");
    expect(result.activeId).toBe("right");
    expect(result.panes[0].tabs).toEqual(["SOLUSDT"]);
    expect(result.panes[0].symbol).toBe("SOLUSDT");
    expect(result.panes[1].tabs).toEqual(["BTCUSDT", "SOLUSDT"]);
    expect(result.panes[1].intervals.BTCUSDT).toBe("15m");
  });
  it("collapses an empty pane after moving its final tab", () => {
    let state = moveWorkspaceTab(splitWorkspace(single()), "left", "BTCUSDT");
    state = moveWorkspaceTab(state, "left", "SOLUSDT");
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0].tabs).toEqual(["BTCUSDT", "SOLUSDT"]);
    expect(state.panes[0].symbol).toBe("SOLUSDT");
  });
  it("restores legacy tabs and per-symbol timeframes, then the full split layout", () => {
    localStorage.setItem("fyxtez:chart-tabs", JSON.stringify(["BTCUSDT", "SOLUSDT"]));
    localStorage.setItem(
      "fyxtez:chart-intervals-by-symbol",
      JSON.stringify({ BTCUSDT: "15m", SOLUSDT: "1h" }),
    );
    expect(loadChartWorkspace("BTCUSDT")).toEqual(single());
    const state = moveWorkspaceTab(splitWorkspace(single()), "right", "SOLUSDT");
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(state));
    expect(loadChartWorkspace("BTCUSDT")).toEqual(state);
  });
  it("falls back for corrupt storage and duplicate pane identities", () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ panes: [null] }));
    expect(loadChartWorkspace("BTCUSDT").panes).toHaveLength(1);
    localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({ panes: [single().panes[0], single().panes[0]] }),
    );
    expect(loadChartWorkspace("BTCUSDT").panes).toHaveLength(1);
  });
});

describe("neighbor selection after closing a tab", () => {
  it("prefers the immediate right neighbor, then the left at the end", () => {
    const tabs = ["BTC", "ETH", "SOL", "XRP"];
    expect(adjacentTabAfterRemoval(tabs, "ETH", ["BTC", "SOL", "XRP"])).toBe("SOL");
    expect(adjacentTabAfterRemoval(tabs, "XRP", ["BTC", "ETH", "SOL"])).toBe("SOL");
    expect(adjacentTabAfterRemoval(tabs, "BTC", ["ETH", "SOL", "XRP"])).toBe("ETH");
  });
});

describe("Android workspace support", () => {
  it("disables split on Android browsers and WebViews while retaining desktop support", () => {
    expect(supportsSplitCharts("Mozilla/5.0 (Linux; Android 14) Chrome/125 Mobile")).toBe(false);
    expect(supportsSplitCharts("Mozilla/5.0 (Linux; Android 14; wv)")).toBe(false);
    expect(supportsSplitCharts("Mozilla/5.0 (X11; Linux x86_64)")).toBe(true);
  });
  it("merges restored Android panes without dropping tabs or timeframes", () => {
    const saved = splitWorkspace(single());
    saved.panes[1].tabs.push("ETHUSDT");
    saved.panes[1].intervals.ETHUSDT = "4h";
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(saved));
    try {
      const restored = loadChartWorkspace("BTCUSDT", false);
      expect(restored.panes).toHaveLength(1);
      expect(restored.panes[0].tabs).toEqual(["BTCUSDT", "SOLUSDT", "ETHUSDT"]);
      expect(restored.panes[0].intervals.ETHUSDT).toBe("4h");
    } finally {
      localStorage.removeItem(WORKSPACE_STORAGE_KEY);
    }
  });
});
