import {
  activeDrawingSetStorageKey,
  drawingSetsStorageKey,
  drawingsStorageKey,
  priceAlertsStorageKey,
  tradeMarkersStorageKey,
} from "../config/constants";
import { stopStorageKey } from "../trading/stopLoss";

const INTERVAL_STORAGE_KEY = "fyxtez:chart-intervals-by-symbol";
const VIEWPORT_STORAGE_KEY = "fyxtez:chart-viewports-by-symbol-interval";
const CHART_TABS_STORAGE_KEY = "fyxtez:chart-tabs";
const CURRENT_SYMBOL_STORAGE_KEY = "fyxtez:current-symbol";

function removeObjectEntry(storageKey: string, key: string): void {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    if (!(key in parsed)) return;
    delete parsed[key];
    localStorage.setItem(storageKey, JSON.stringify(parsed));
  } catch {
    // Cleanup is best-effort; corrupt preference data should not block deletion.
  }
}

function removeObjectEntriesByPrefix(storageKey: string, prefix: string): void {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

    let changed = false;
    for (const key of Object.keys(parsed)) {
      if (key.startsWith(prefix)) {
        delete parsed[key];
        changed = true;
      }
    }
    if (changed) localStorage.setItem(storageKey, JSON.stringify(parsed));
  } catch {
    // Best-effort only.
  }
}

/** Remove every browser-owned piece of chart state for a deleted market. */
export function clearSymbolLocalMetadata(symbol: string): void {
  const normalized = symbol.trim().toUpperCase();

  try {
    [
      drawingsStorageKey(normalized),
      drawingSetsStorageKey(normalized),
      activeDrawingSetStorageKey(normalized),
      tradeMarkersStorageKey(normalized),
      priceAlertsStorageKey(normalized),
      stopStorageKey(normalized),
      `fyxtez:position-anchor-v2:${normalized}`,
      `fyxtez.chartTags.${normalized}`,
    ].forEach((key) => localStorage.removeItem(key));

    removeObjectEntry(INTERVAL_STORAGE_KEY, normalized);
    removeObjectEntriesByPrefix(VIEWPORT_STORAGE_KEY, `${normalized}:`);

    const rawTabs = localStorage.getItem(CHART_TABS_STORAGE_KEY);
    if (rawTabs) {
      const parsed = JSON.parse(rawTabs);
      if (Array.isArray(parsed)) {
        localStorage.setItem(
          CHART_TABS_STORAGE_KEY,
          JSON.stringify(parsed.filter((value) => String(value).toUpperCase() !== normalized)),
        );
      }
    }

    if (localStorage.getItem(CURRENT_SYMBOL_STORAGE_KEY)?.toUpperCase() === normalized) {
      localStorage.removeItem(CURRENT_SYMBOL_STORAGE_KEY);
    }
  } catch {
    // Symbol deletion itself already succeeded; stale local preferences are non-critical.
  }
}
