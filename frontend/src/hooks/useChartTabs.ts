import { useCallback, useEffect, useMemo, useState } from "react";
import { type TradingSymbol } from "../config/constants";

const CHART_TABS_STORAGE_KEY = "fyxtez:chart-tabs";

function loadSavedTabs(activeSymbol: TradingSymbol): TradingSymbol[] {
  try {
    const raw = localStorage.getItem(CHART_TABS_STORAGE_KEY);
    if (!raw) return [activeSymbol];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [activeSymbol];

    // FIX: this used to validate each entry with isTradingSymbol(), which
    // checks against the live symbol registry - but that registry is
    // still just the static built-in list at this exact point (this runs
    // synchronously as the useState initializer, before useSymbol()'s
    // backend fetch for user-added symbols has resolved). Any saved tab
    // for a user-added symbol would look "invalid" and get silently
    // dropped here, before the real registry ever got a chance to
    // confirm it. Trust localStorage optimistically instead - nothing
    // later in this hook prunes tabs against the registry either (see the
    // note below openTab), so a restored tab is never silently lost.
    const valid = parsed.filter(
      (value): value is TradingSymbol => typeof value === "string" && value.trim().length > 0,
    );
    const unique = Array.from(new Set(valid.map((value) => value.toUpperCase())));

    if (!unique.includes(activeSymbol)) unique.push(activeSymbol);
    return unique.length > 0 ? unique : [activeSymbol];
  } catch {
    return [activeSymbol];
  }
}

function persistTabs(tabs: readonly TradingSymbol[]): void {
  try {
    localStorage.setItem(CHART_TABS_STORAGE_KEY, JSON.stringify(tabs));
  } catch {
    // Persistence is best-effort only.
  }
}

/**
 * Keeps a lightweight list of open chart symbols while the application still
 * mounts exactly one chart workspace: the active tab. Hidden tabs are only
 * metadata, so they have no chart instance, animation loop, or market-data
 * websocket until selected.
 */
export function useChartTabs(
  activeSymbol: TradingSymbol,
  onActivateSymbol: (symbol: TradingSymbol) => void,
  availableSymbols: readonly TradingSymbol[],
) {
  const [tabs, setTabs] = useState<TradingSymbol[]>(() =>
    loadSavedTabs(activeSymbol),
  );

  useEffect(() => {
    setTabs((current) => {
      if (current.includes(activeSymbol)) return current;
      const next = [...current, activeSymbol];
      persistTabs(next);
      return next;
    });
  }, [activeSymbol]);

  // NOTE: this hook used to also prune `tabs` down to whatever
  // `availableSymbols` the currently-connected backend reports, once
  // registryReady. That's exactly the wrong behavior here: this app talks
  // to one of two independent backends (a local dev one and an always-on
  // remote one - see initializeTradingApiBaseUrl() in config/constants.ts),
  // each with its own separately-persisted symbol registry file. A symbol
  // added while one backend was active simply isn't known to the other,
  // so pruning against "whichever backend answered" would silently close
  // (and permanently forget, since closeTab persists) a perfectly good tab
  // the instant the app happened to fall back to the other backend.
  // Tabs are only ever closed explicitly now - via closeTab/closeOtherTabs
  // (user-initiated) or the explicit removal wired to SymbolSwitcher's
  // delete action in App.tsx. If a tab's symbol turns out not to be
  // registered on the currently-connected backend, getSymbolConfig()
  // renders it with a safe placeholder and UnregisteredSymbolBanner offers
  // a one-click way to register it there instead of losing the tab.

  const openTab = useCallback(
    (symbol: TradingSymbol) => {
      setTabs((current) => {
        if (current.includes(symbol)) return current;
        const next = [...current, symbol];
        persistTabs(next);
        return next;
      });
      onActivateSymbol(symbol);
    },
    [onActivateSymbol],
  );

  const activateTab = useCallback(
    (symbol: TradingSymbol) => {
      if (!tabs.includes(symbol)) {
        openTab(symbol);
        return;
      }
      onActivateSymbol(symbol);
    },
    [onActivateSymbol, openTab, tabs],
  );

  const closeTab = useCallback(
    (symbol: TradingSymbol) => {
      const closingIndex = tabs.indexOf(symbol);
      if (closingIndex < 0) return;

      let next = tabs.filter((candidate) => candidate !== symbol);

      // FIX: a single open tab used to be impossible to close even when many
      // other backend-tracked symbols were available. Keep the one-chart
      // workspace invariant by replacing that final tab with another tracked
      // symbol; this is a UI-only close and does not delete backend tracking.
      if (next.length === 0) {
        const fallback = availableSymbols.find((candidate) => candidate !== symbol);
        if (!fallback) return;
        next = [fallback];
      }

      setTabs(next);
      persistTabs(next);

      if (symbol === activeSymbol) {
        const fallback = next[Math.min(closingIndex, next.length - 1)] ?? next[0];
        if (fallback) onActivateSymbol(fallback);
      }
    },
    [activeSymbol, availableSymbols, onActivateSymbol, tabs],
  );

  // FEATURE: expose a no-argument active-tab close action for keyboard
  // shortcuts. Delegating to closeTab keeps persistence and adjacent/fallback
  // selection identical to clicking the tab's close button.
  const closeActiveTab = useCallback(() => {
    closeTab(activeSymbol);
  }, [activeSymbol, closeTab]);

  const removeDeletedTab = useCallback(
    (symbol: TradingSymbol, fallbackSymbol?: TradingSymbol) => {
      const closingIndex = tabs.indexOf(symbol);
      if (closingIndex < 0) return;

      let next = tabs.filter((candidate) => candidate !== symbol);

      // FEATURE: deleting a backend-tracked symbol is stronger than merely
      // closing a chart tab. If it was the final tab, replace it with another
      // registered symbol so the chart-tabs invariant (at least one open tab)
      // survives even though the deleted symbol itself must disappear.
      if (next.length === 0 && fallbackSymbol && fallbackSymbol !== symbol) {
        next = [fallbackSymbol];
      }

      // If the backend somehow allowed deleting the only registered symbol,
      // keep the current tab as a last-resort shell rather than leaving the UI
      // with an impossible empty tab list. The registry banner can then explain
      // that the symbol is no longer registered.
      if (next.length === 0) return;

      setTabs(next);
      persistTabs(next);

      if (symbol === activeSymbol) {
        const fallback = next[Math.min(closingIndex, next.length - 1)] ?? next[0];
        if (fallback) onActivateSymbol(fallback);
      }
    },
    [activeSymbol, onActivateSymbol, tabs],
  );

  const closeOtherTabs = useCallback(
    (symbol: TradingSymbol) => {
      const next = [symbol];
      setTabs(next);
      persistTabs(next);
      if (symbol !== activeSymbol) onActivateSymbol(symbol);
    },
    [activeSymbol, onActivateSymbol],
  );

  const reorderTab = useCallback(
    (draggedSymbol: TradingSymbol, targetSymbol: TradingSymbol) => {
      if (draggedSymbol === targetSymbol) return;

      setTabs((current) => {
        const fromIndex = current.indexOf(draggedSymbol);
        const toIndex = current.indexOf(targetSymbol);
        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return current;

        const next = [...current];
        next.splice(fromIndex, 1);
        next.splice(toIndex, 0, draggedSymbol);
        persistTabs(next);
        return next;
      });
    },
    [],
  );

  const closedSymbols = useMemo(
    () => availableSymbols.filter((symbol) => !tabs.includes(symbol)),
    [availableSymbols, tabs],
  );

  const activateAdjacentTab = useCallback(
    (direction: "previous" | "next") => {
      if (tabs.length <= 1) return;

      const activeIndex = tabs.indexOf(activeSymbol);
      if (activeIndex < 0) return;

      const offset = direction === "previous" ? -1 : 1;
      const nextIndex = (activeIndex + offset + tabs.length) % tabs.length;
      const nextSymbol = tabs[nextIndex];

      if (nextSymbol) onActivateSymbol(nextSymbol);
    },
    [activeSymbol, onActivateSymbol, tabs],
  );

  return {
    tabs,
    closedSymbols,
    openTab,
    activateTab,
    closeTab,
    closeActiveTab,
    removeDeletedTab,
    closeOtherTabs,
    reorderTab,
    activateAdjacentTab,
  };
}

export type ChartTabsApi = ReturnType<typeof useChartTabs>;
