import { getSymbolConfig, type TradingSymbol } from "./constants";
import { getSymbolInfo } from "./symbols";

export type SymbolCategory = "primary" | "watchlist" | "altcoins" | "traditional" | "other";
export type EditableSymbolCategory = Exclude<SymbolCategory, "primary">;
export type StoredSymbolCategories = Partial<Record<TradingSymbol, EditableSymbolCategory>>;

export const SYMBOL_CATEGORY_OPTIONS: readonly { value: EditableSymbolCategory; label: string }[] = [
  { value: "watchlist", label: "Watchlist" },
  { value: "altcoins", label: "Altcoins" },
  { value: "traditional", label: "Traditional Markets" },
  { value: "other", label: "Other" },
];

export const SYMBOL_CATEGORY_ORDER: readonly { value: SymbolCategory; label: string }[] = [
  { value: "primary", label: "Primary" },
  { value: "watchlist", label: "Watchlist" },
  { value: "altcoins", label: "Altcoins" },
  { value: "traditional", label: "Traditional Markets" },
  { value: "other", label: "Other" },
];

const CATEGORY_STORAGE_KEY = "fyxtez:symbol-categories";
const LEGACY_PINNED_SYMBOLS_STORAGE_KEY = "fyxtez:pinned-symbols";
const TRADITIONAL_MARKET_SYMBOLS = new Set([
  "SPCX", "SPX", "NDX", "DJI", "GOLD", "XAU", "SILVER", "XAG", "OIL", "WTI", "BRENT",
]);

export function loadSymbolCategories(): StoredSymbolCategories {
  try {
    const raw = localStorage.getItem(CATEGORY_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return Object.fromEntries(
          Object.entries(parsed).filter((entry): entry is [string, EditableSymbolCategory] =>
            typeof entry[0] === "string"
              && SYMBOL_CATEGORY_OPTIONS.some((option) => option.value === entry[1]),
          ),
        );
      }
    }

    // FEATURE: preserve the legacy star list as Watchlist while sharing one
    // category source between the symbol switcher and chart-tab add menu.
    const legacyRaw = localStorage.getItem(LEGACY_PINNED_SYMBOLS_STORAGE_KEY);
    if (!legacyRaw) return {};
    const parsed: unknown = JSON.parse(legacyRaw);
    return Array.isArray(parsed)
      ? Object.fromEntries(parsed.filter((item): item is string => typeof item === "string").map((item) => [item, "watchlist"]))
      : {};
  } catch {
    return {};
  }
}

export function saveSymbolCategories(categories: StoredSymbolCategories): void {
  try {
    localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(categories));
  } catch {}
}

export function defaultSymbolCategory(candidate: TradingSymbol): EditableSymbolCategory {
  // FEATURE: share the exact market-kind fallback between both symbol menus so
  // a newly registered token never appears under two different categories.
  return getSymbolConfig(candidate).marketKind === "traditional"
    || TRADITIONAL_MARKET_SYMBOLS.has(getSymbolInfo(candidate).label.toUpperCase())
    ? "traditional"
    : "altcoins";
}

export function symbolCategory(
  candidate: TradingSymbol,
  categories: StoredSymbolCategories,
): SymbolCategory {
  return getSymbolConfig(candidate).protected
    ? "primary"
    : (categories[candidate] ?? defaultSymbolCategory(candidate));
}
