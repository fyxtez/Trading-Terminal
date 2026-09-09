import { loadSavedInterval } from "../../hooks/marketDataPersistence";
import { intervals, type Interval } from "../../config/constants";

export type ChartPaneState = {
  id: string;
  symbol: string;
  tabs: string[];
  intervals: Record<string, Interval>;
};
export type ChartWorkspaceState = { panes: ChartPaneState[]; activeId: string };
export const WORKSPACE_STORAGE_KEY = "fyxtez:chart-workspace";

export function loadChartWorkspace(symbol: string): ChartWorkspaceState {
  try {
    const saved = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "null");
    if (
      Array.isArray(saved?.panes) &&
      new Set(saved.panes.map((pane: ChartPaneState) => pane?.id)).size === saved.panes.length &&
      saved?.panes?.length >= 1 &&
      saved.panes.length <= 2 &&
      saved.panes.every(
        (pane: ChartPaneState, index: number) =>
          pane &&
          pane.id === (index === 0 ? "left" : "right") &&
          typeof pane.symbol === "string" &&
          Array.isArray(pane.tabs) &&
          pane.tabs.length > 0 &&
          pane.tabs.every((tab) => typeof tab === "string" && tab.length > 0) &&
          pane.tabs.includes(pane.symbol) &&
          pane.intervals &&
          Object.values(pane.intervals).every((interval) => intervals.includes(interval)),
      )
    ) {
      return {
        panes: saved.panes,
        activeId: saved.panes.some((p: ChartPaneState) => p.id === saved.activeId)
          ? saved.activeId
          : saved.panes[0].id,
      };
    }
  } catch {
    /* Fall back to the existing single-chart workspace. */
  }
  let tabs = [symbol];
  try {
    const saved = JSON.parse(localStorage.getItem("fyxtez:chart-tabs") ?? "null");
    if (Array.isArray(saved))
      tabs = [
        ...new Set([
          ...saved.filter((tab): tab is string => typeof tab === "string" && tab.length > 0),
          symbol,
        ]),
      ];
  } catch {
    /* Keep the active chart. */
  }
  return {
    panes: [
      {
        id: "left",
        symbol,
        tabs,
        intervals: Object.fromEntries(tabs.map((tab) => [tab, loadSavedInterval(tab)])),
      },
    ],
    activeId: "left",
  };
}

export function splitWorkspace(state: ChartWorkspaceState): ChartWorkspaceState {
  if (state.panes.length === 2) return state;
  const left = state.panes[0];
  return {
    panes: [left, { ...left, id: "right", tabs: [...left.tabs], intervals: { ...left.intervals } }],
    activeId: left.id,
  };
}

export function unifyWorkspace(state: ChartWorkspaceState): ChartWorkspaceState {
  if (state.panes.length === 1) return state;
  const [left, right] = state.panes;
  return {
    activeId: left.id,
    panes: [
      {
        ...left,
        tabs: [...new Set([...left.tabs, ...right.tabs])],
        intervals: {
          ...right.intervals,
          ...Object.fromEntries(
            left.tabs.map((symbol) => [
              symbol,
              left.intervals[symbol] ?? loadSavedInterval(symbol),
            ]),
          ),
        },
      },
    ],
  };
}

export function moveWorkspaceTab(
  state: ChartWorkspaceState,
  sourceId: string,
  symbol: string,
): ChartWorkspaceState {
  if (state.panes.length !== 2) return state;
  const source = state.panes.find((pane) => pane.id === sourceId)!;
  const target = state.panes.find((pane) => pane.id !== sourceId)!;
  if (!source || !target || !source.tabs.includes(symbol)) return state;
  const moved = {
    ...target,
    symbol,
    tabs: [...new Set([...target.tabs, symbol])],
    intervals: {
      ...target.intervals,
      [symbol]: source.intervals[symbol] ?? target.intervals[symbol] ?? loadSavedInterval(symbol),
    },
  };
  const remaining = source.tabs.filter((tab) => tab !== symbol);
  // Moving the last tab collapses the empty pane instead of silently recreating the moved tab.
  if (!remaining.length) return { panes: [{ ...moved, id: "left" }], activeId: "left" };
  return {
    panes: state.panes.map((pane) =>
      pane.id === sourceId
        ? {
            ...source,
            tabs: remaining,
            symbol:
              source.symbol === symbol
                ? adjacentTabAfterRemoval(source.tabs, symbol, remaining)
                : source.symbol,
          }
        : moved,
    ),
    activeId: target.id,
  };
}

/** The next tab occupies the removed tab's index; at the end, use its left neighbor. */
export function adjacentTabAfterRemoval(
  tabs: readonly string[],
  symbol: string,
  remaining: readonly string[],
): string {
  return remaining[Math.min(Math.max(0, tabs.indexOf(symbol)), remaining.length - 1)];
}
