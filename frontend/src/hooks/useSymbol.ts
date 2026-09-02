import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_SYMBOL,
  getAvailableSymbols,
  replaceSymbolConfigs,
  SYMBOL_CONFIGS,
  type SymbolConfig,
  type TradingSymbol,
} from "../config/constants";
import { getSymbolInfo, refreshSymbolMetadata } from "../config/symbols";
import { listSymbols, type BackendSymbol } from "../trading/api/symbols";

const SYMBOL_STORAGE_KEY = "fyxtez:current-symbol";

export function isTradingSymbol(value: string): value is TradingSymbol {
  return getAvailableSymbols().includes(value.toUpperCase());
}

const BUILT_IN_ORDER = ["BTC", "ETH", "SOL", "XRP", "PLUME", "ZEC"] as const;

function configFromBackend(entry: BackendSymbol): SymbolConfig {
  const symbol = `${entry.symbol.toUpperCase()}USDT`;
  const existing = SYMBOL_CONFIGS.find((candidate) => candidate.symbol === symbol);
  return {
    symbol,
    source: entry.data_source,
    sourceSymbol: entry.market_symbol,
    executionEnabled: entry.data_source === "binance",
    chartDecimals: existing?.chartDecimals ?? (entry.data_source === "mexc" ? 5 : 4),
    protected: entry.protected,
    // FEATURE: retain Binance's underlying-asset classification so every UI
    // consumer uses the same answer instead of separate ticker guesses.
    marketKind: entry.market_kind ?? "crypto",
  };
}

function sortRegistry(entries: readonly BackendSymbol[]): BackendSymbol[] {
  return [...entries].sort((a, b) => {
    const ai = BUILT_IN_ORDER.indexOf(a.symbol.toUpperCase() as (typeof BUILT_IN_ORDER)[number]);
    const bi = BUILT_IN_ORDER.indexOf(b.symbol.toUpperCase() as (typeof BUILT_IN_ORDER)[number]);
    if (ai >= 0 || bi >= 0) {
      if (ai < 0) return 1;
      if (bi < 0) return -1;
      return ai - bi;
    }
    return a.symbol.localeCompare(b.symbol);
  });
}

function loadSavedSymbol(): TradingSymbol {
  try {
    const saved = localStorage.getItem(SYMBOL_STORAGE_KEY)?.toUpperCase();
    // FIX: this used to gate on isTradingSymbol(saved), which reads the
    // live symbol registry - still just the static built-in list at this
    // point, since useSymbol()'s backend fetch for user-added symbols
    // hasn't resolved yet (this runs synchronously, before any effect
    // does). If the last-active symbol was a user-added one, it would
    // incorrectly look invalid and fall back to DEFAULT_SYMBOL here - and
    // that fallback then sticks permanently, because syncRegistry()'s own
    // fallback check only fires when the *current* symbol turns out to be
    // missing from the real registry, and DEFAULT_SYMBOL is always
    // present. Trust the saved value optimistically; syncRegistry()
    // still falls back correctly once the real registry loads, if the
    // symbol genuinely no longer exists.
    if (saved) return saved;
  } catch {}
  return DEFAULT_SYMBOL;
}

function saveSymbol(symbol: TradingSymbol): void {
  try { localStorage.setItem(SYMBOL_STORAGE_KEY, symbol); } catch {}
}

function parseSymbolFromPath(): TradingSymbol | null {
  try {
    const segment = window.location.pathname.split("/").filter(Boolean)[0];
    if (!segment) return null;
    const upper = segment.toUpperCase();
    if (isTradingSymbol(upper)) return upper;
    return getAvailableSymbols().find((s) => getSymbolInfo(s).label === upper) ?? null;
  } catch { return null; }
}

function writeSymbolToPath(symbol: TradingSymbol): void {
  try {
    const path = `/${getSymbolInfo(symbol).label}`;
    if (window.location.pathname !== path) {
      window.history.replaceState(null, "", path + window.location.search);
    }
  } catch {}
}

function resolveInitialSymbol(): TradingSymbol {
  const fromUrl = parseSymbolFromPath();
  if (fromUrl) { saveSymbol(fromUrl); return fromUrl; }
  return loadSavedSymbol();
}

export function useSymbol() {
  const [symbol, setSymbolState] = useState<TradingSymbol>(resolveInitialSymbol);
  const [availableSymbols, setAvailableSymbols] = useState<readonly TradingSymbol[]>(getAvailableSymbols());
  const [symbolRegistryError, setSymbolRegistryError] = useState<string | null>(null);
  /**
   * False until syncRegistry() succeeds for the first time. Before that,
   * `availableSymbols` is just the static built-in list - it doesn't yet
   * include symbols a user has added, which only live on the backend.
   * Consumers that prune/persist state based on `availableSymbols` (see
   * useChartTabs) need to know not to treat that placeholder list as
   * authoritative, or they'll wrongly drop - and persist the drop of -
   * tabs for user-added symbols before the real registry has loaded (or
   * while the backend is briefly unreachable - see syncRegistry below,
   * which only sets this on success, never on failure).
   */
  const [registryReady, setRegistryReady] = useState(false);

  const syncRegistry = useCallback(async () => {
    try {
      const entries = await listSymbols();
      const configs = sortRegistry(entries).map(configFromBackend);
      replaceSymbolConfigs(configs);
      const next = getAvailableSymbols();
      setAvailableSymbols(next);
      setSymbolRegistryError(null);

      // Cosmetic metadata must never delay the registry/chart itself. Refresh
      // names/icons in the background and nudge consumers once it arrives.
      void refreshSymbolMetadata().then(() => {
        setAvailableSymbols((current) => [...current]);
      });

      setSymbolState((current) => {
        if (next.includes(current)) return current;
        const fallback = next.includes(DEFAULT_SYMBOL) ? DEFAULT_SYMBOL : next[0] ?? DEFAULT_SYMBOL;
        saveSymbol(fallback);
        writeSymbolToPath(fallback);
        return fallback;
      });

      // Only a successful fetch counts as "ready". On failure (e.g. the
      // backend is temporarily unreachable) `availableSymbols` never
      // actually reflects the real registry, so treating that as
      // authoritative would make useChartTabs's registryReady-gated prune
      // effect wrongly conclude a user-added symbol "doesn't exist" and
      // drop its tab - when really we just don't know yet. Leaving
      // registryReady false here means tabs are left alone until a real
      // answer comes back (this effect re-runs on remount/retry).
      setRegistryReady(true);
    } catch (error) {
      setSymbolRegistryError(error instanceof Error ? error.message : "Failed to load symbols");
    }
  }, []);

  useEffect(() => { void syncRegistry(); }, [syncRegistry]);

  const setSymbol = useCallback((next: TradingSymbol) => {
    setSymbolState((current) => {
      if (current === next) return current;
      saveSymbol(next);
      writeSymbolToPath(next);
      return next;
    });
  }, []);

  return { symbol, setSymbol, availableSymbols, syncRegistry, symbolRegistryError, registryReady };
}

export type SymbolApi = ReturnType<typeof useSymbol>;
