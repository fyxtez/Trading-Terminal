import ChartWorkspaceLayout from "./ChartWorkspaceLayout";
import { createPositionBindingsStore, SharedPositionsPanel } from "./sharedPositions";
import {
  MAX_POSITIONS_PANEL_HEIGHT,
  MIN_POSITIONS_PANEL_HEIGHT,
  readStoredPositionsPanelHeight,
  persistPositionsPanelHeight,
} from "./appPanelLayout";
import type { MarketOrderFill } from "../../trading/types";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useSymbol } from "../../hooks/useSymbol";
import { useBackendConnection } from "../../hooks/useBackendConnection";
import { useTradingStream } from "../../hooks/useTradingStream";
import { useOperationalDiagnostics } from "../../hooks/useOperationalDiagnostics";
import { useDesktopCredentials } from "../DesktopSetupGate/DesktopCredentialsContext";
import { loadSavedInterval } from "../../hooks/marketDataPersistence";
import ChartWorkspacePane from "./ChartWorkspacePane";
import { WorkspaceRuntimeContext, WORKSPACE_ORDER_EVENT } from "./workspaceRuntimeContext";
import {
  adjacentTabAfterRemoval,
  loadChartWorkspace,
  splitWorkspace,
  supportsSplitCharts,
  unifyWorkspace,
  moveWorkspaceTab,
  WORKSPACE_STORAGE_KEY,
  type ChartPaneState,
} from "./chartWorkspace";
import type { ChartTabsApi } from "../../hooks/useChartTabs";
import type { Interval } from "../../config/constants";
import "./App.css";

export default function App() {
  const registry = useSymbol();
  const allowSplit = supportsSplitCharts();
  const [topbarHost, setTopbarHost] = useState<HTMLDivElement | null>(null);
  const [positionsStore] = useState(createPositionBindingsStore);
  const [isOrdersOpen, setIsOrdersOpen] = useState(false);
  const [hasMountedPositionsPanel, setHasMountedPositionsPanel] = useState(false);
  const [positionsPanelHeight, setPositionsPanelHeight] = useState(readStoredPositionsPanelHeight);
  useEffect(() => {
    if (isOrdersOpen) setHasMountedPositionsPanel(true);
  }, [isOrdersOpen]);
  const changePositionsHeight = (next: number) => {
    const height = Math.min(
      MAX_POSITIONS_PANEL_HEIGHT,
      Math.max(MIN_POSITIONS_PANEL_HEIGHT, window.innerHeight - 260),
      Math.max(MIN_POSITIONS_PANEL_HEIGHT, Math.round(next)),
    );
    setPositionsPanelHeight(height);
    persistPositionsPanelHeight(height);
  };
  const credentials = useDesktopCredentials();
  const backend = useBackendConnection();
  const localMarketFills = useRef<MarketOrderFill[]>([]);
  const stream = useTradingStream({
    enabled: credentials.canTrade,
    onOrderExecuted: (event) => {
      if (event.order_type !== "LIMIT") {
        const time = Math.floor(event.event_time / 1000);
        const match = localMarketFills.current.findIndex(
          (fill) =>
            fill.symbol === event.symbol.toUpperCase() &&
            fill.side === event.side &&
            Math.abs(fill.time - time) <= 5 &&
            Math.abs(fill.price - event.price) <= Math.max(1e-8, event.price * 0.001),
        );
        if (match >= 0) {
          localMarketFills.current.splice(match, 1);
          return;
        }
      }
      window.dispatchEvent(new CustomEvent(WORKSPACE_ORDER_EVENT, { detail: event }));
    },
  });
  const diagnostics = useOperationalDiagnostics({
    isDesktop: credentials.runtimeMode !== "public-browser",
    backendConnection: backend,
    marketConnection: "connecting",
    frontendStreamConnection: stream,
  });
  const [workspace, setWorkspace] = useState(() => {
    const restored = loadChartWorkspace(registry.symbol);
    // An explicit symbol URL still opens in the restored active pane.
    if (window.location.pathname !== "/") {
      const pane = restored.panes.find((pane) => pane.id === restored.activeId)!;
      pane.symbol = registry.symbol;
      pane.tabs = [...new Set([...pane.tabs, registry.symbol])];
    }
    return restored;
  });
  const split = workspace.panes.length === 2;
  useEffect(() => {
    try {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
    } catch {
      /* Storage is best effort. */
    }
  }, [workspace]);
  const active =
    workspace.panes.find((pane) => pane.id === workspace.activeId) ?? workspace.panes[0];
  useEffect(() => {
    registry.setSymbol(active.symbol);
  }, [active.symbol, registry.setSymbol]);

  const update = (id: string, change: (pane: ChartPaneState) => ChartPaneState) => {
    setWorkspace((state) => ({
      ...state,
      panes: state.panes.map((pane) => (pane.id === id ? change(pane) : pane)),
    }));
  };
  const remove = (id: string, symbol: string, fallback?: string) =>
    update(id, (pane) => {
      let tabs = pane.tabs.filter((tab) => tab !== symbol);
      if (!tabs.length) {
        const next =
          fallback ?? registry.availableSymbols.find((candidate) => candidate !== symbol);
        if (!next) return pane;
        tabs = [next];
      }
      return {
        ...pane,
        tabs,
        symbol:
          pane.symbol === symbol ? adjacentTabAfterRemoval(pane.tabs, symbol, tabs) : pane.symbol,
      };
    });

  return (
    <WorkspaceRuntimeContext.Provider
      value={{
        backend,
        stream,
        diagnostics,
        localMarketFills,
        topbarHost,
        positions: { isOpen: isOrdersOpen, setOpen: setIsOrdersOpen, store: positionsStore },
      }}
    >
      <div
        className="terminal-workspace"
        style={{ "--positions-panel-height": `${positionsPanelHeight}px` } as CSSProperties}
      >
        <div className="terminal-topbar" ref={setTopbarHost} />
        <ChartWorkspaceLayout split={split}>
          {workspace.panes.map((pane, index) => {
            const open = (symbol: string) =>
              update(pane.id, (current) => ({
                ...current,
                symbol,
                tabs: [...new Set([...current.tabs, symbol])],
              }));
            const tabsApi: ChartTabsApi = {
              tabs: pane.tabs,
              closedSymbols: registry.availableSymbols.filter(
                (symbol) => !pane.tabs.includes(symbol),
              ),
              openTab: open,
              activateTab: open,
              closeTab: (symbol) => remove(pane.id, symbol),
              closeActiveTab: () => remove(pane.id, pane.symbol),
              removeDeletedTab: (symbol, fallback) => {
                for (const current of workspace.panes) remove(current.id, symbol, fallback);
              },
              closeOtherTabs: (symbol) =>
                update(pane.id, (current) => ({ ...current, symbol, tabs: [symbol] })),
              reorderTab: (symbol, target) =>
                update(pane.id, (current) => {
                  const from = current.tabs.indexOf(symbol),
                    to = current.tabs.indexOf(target);
                  if (from < 0 || to < 0) return current;
                  const tabs = [...current.tabs];
                  tabs.splice(from, 1);
                  tabs.splice(to, 0, symbol);
                  return { ...current, tabs };
                }),
              activateAdjacentTab: (direction) =>
                open(
                  pane.tabs[
                    (pane.tabs.indexOf(pane.symbol) +
                      (direction === "next" ? 1 : -1) +
                      pane.tabs.length) %
                      pane.tabs.length
                  ],
                ),
            };
            const setInterval = (interval: Interval) =>
              update(pane.id, (current) =>
                current.intervals[pane.symbol] === interval
                  ? current
                  : { ...current, intervals: { ...current.intervals, [pane.symbol]: interval } },
              );
            return (
              <div
                key={pane.id}
                className={`chart-workspace-pane ${pane.id === active.id ? "active" : ""}`}
                onPointerDownCapture={() => {
                  if (active.id !== pane.id)
                    setWorkspace((state) => ({ ...state, activeId: pane.id }));
                }}
                onFocusCapture={() => {
                  if (active.id !== pane.id)
                    setWorkspace((state) => ({ ...state, activeId: pane.id }));
                }}
              >
                <ChartWorkspacePane
                  registry={{ ...registry, symbol: pane.symbol, setSymbol: open }}
                  chartTabs={tabsApi}
                  paneId={pane.id}
                  active={pane.id === active.id}
                  split={split}
                  initialInterval={pane.intervals[pane.symbol] ?? loadSavedInterval(pane.symbol)}
                  onIntervalChange={setInterval}
                  onToggleSplit={
                    allowSplit
                      ? () =>
                          setWorkspace((state) =>
                            state.panes.length === 2
                              ? unifyWorkspace(state)
                              : splitWorkspace(state),
                          )
                      : undefined
                  }
                  moveLabel={index === 0 ? "Switch to right" : "Switch to left"}
                  onMoveTab={(symbol) =>
                    setWorkspace((state) => moveWorkspaceTab(state, pane.id, symbol))
                  }
                />
              </div>
            );
          })}
        </ChartWorkspaceLayout>
        <div className={`bottom-dock shared-positions-dock ${isOrdersOpen ? "open" : ""}`}>
          {(isOrdersOpen || hasMountedPositionsPanel) && (
            <SharedPositionsPanel
              store={positionsStore}
              activeId={active.id}
              isOpen={isOrdersOpen}
              onClose={() => setIsOrdersOpen(false)}
              height={positionsPanelHeight}
              onHeightChange={changePositionsHeight}
            />
          )}
        </div>
      </div>
    </WorkspaceRuntimeContext.Provider>
  );
}
