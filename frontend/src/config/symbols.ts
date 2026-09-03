import btcIcon from "../assets/symbols/btc.svg";
import ethIcon from "../assets/symbols/eth.svg";
import solIcon from "../assets/symbols/sol.svg";
import xrpIcon from "../assets/symbols/xrp.svg";
import plumeIcon from "../assets/symbols/plume.svg";
import zecIcon from "../assets/symbols/zec.svg";
import xauIcon from "../assets/symbols/xau.svg";
import xagIcon from "../assets/symbols/xag.svg";
import powerIcon from "../assets/symbols/power.jpg";
import { fetchIconImageUrl, listIcons, type BackendIcon } from "../trading/api/symbols";
import { TRADING_API_BASE_URL, TRADING_API_BASE_URL_CHANGED_EVENT } from "./constants";

/**
 * Maps a trading pair symbol (e.g. "BTCUSDT", "SOLUSDC") down to a short
 * display label ("BTC", "SOL") and its full name, by stripping the quote
 * asset suffix and looking up the remaining base asset.
 *
 * Only BTC is wired up right now (that's all the app trades), but the
 * mapping already works for any USDT/USDC/etc. pair - add more base
 * assets to BASE_ASSET_NAMES as they're supported.
 */

const QUOTE_ASSET_SUFFIXES = ["USDT", "USDC", "BUSD", "FDUSD", "USD"] as const;

const BASE_ASSET_NAMES: Record<string, string> = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
  BNB: "BNB",
  XRP: "XRP",
  PLUME: "Plume",
  ZEC: "Zcash",
  XAU: "Gold",
  XAG: "Silver",
  ADA: "Cardano",
  DOGE: "Dogecoin",
  POWER: "Power Protocol",
};
const BASE_ASSET_ICONS: Record<string, string> = {
  BTC: btcIcon,
  ETH: ethIcon,
  SOL: solIcon,
  XRP: xrpIcon,
  PLUME: plumeIcon,
  ZEC: zecIcon,
  XAU: xauIcon,
  XAG: xagIcon,
  POWER: powerIcon,
};

type RuntimeAssetMetadata = {
  name?: string;
  icon?: string;
};

const runtimeAssetMetadata: Record<string, RuntimeAssetMetadata> = {};

const ICON_METADATA_CACHE_PREFIX = "fyxtez:symbol-icon-metadata:v1:";

type PersistedIconMetadata = {
  cachedAtMs: number;
};

type PersistedIconMetadataCache = {
  icons: Record<string, PersistedIconMetadata>;
};

function iconMetadataCacheKey(): string {
  // icon URLs are backend-specific, so each backend gets its own
  // metadata cache. This prevents a fast local-cache hydrate from pointing an
  // icon at the previously selected local/remote API after a backend switch.
  return `${ICON_METADATA_CACHE_PREFIX}${TRADING_API_BASE_URL.replace(/\/+$/, "")}`;
}

async function applyIconMetadata(icons: readonly BackendIcon[]): Promise<void> {
  await Promise.all(
    icons.map(async (icon) => {
      const code = icon.symbol.trim().toUpperCase();
      if (!code || !Number.isFinite(icon.cached_at_ms)) return;
      try {
        const previous = runtimeAssetMetadata[code]?.icon;
        const next = await fetchIconImageUrl(code, icon.cached_at_ms);
        if (previous?.startsWith("blob:")) URL.revokeObjectURL(previous);
        runtimeAssetMetadata[code] = {
          ...runtimeAssetMetadata[code],
          icon: next,
        };
      } catch {
        // A missing cosmetic icon never blocks symbol/chart loading.
      }
    }),
  );
}

async function hydratePersistedIconMetadata(): Promise<void> {
  if (typeof window === "undefined") return;

  try {
    const raw = window.localStorage.getItem(iconMetadataCacheKey());
    if (!raw) return;

    const parsed = JSON.parse(raw) as PersistedIconMetadataCache;
    await applyIconMetadata(
      Object.entries(parsed.icons ?? {}).map(([symbol, cached]) => ({
        symbol,
        cached_at_ms: Number(cached?.cachedAtMs),
        source_url: "",
        url: "",
      })),
    );
  } catch {
    // Cosmetic cache only: malformed/unavailable localStorage must never block
    // the symbol registry or chart from loading.
  }
}

function persistIconMetadata(icons: readonly BackendIcon[]): void {
  if (typeof window === "undefined") return;

  try {
    const persisted: PersistedIconMetadataCache = { icons: {} };
    for (const icon of icons) {
      const code = icon.symbol.trim().toUpperCase();
      if (!code || !Number.isFinite(icon.cached_at_ms)) continue;
      persisted.icons[code] = { cachedAtMs: icon.cached_at_ms };
    }
    window.localStorage.setItem(iconMetadataCacheKey(), JSON.stringify(persisted));
  } catch {
    // localStorage can be disabled or full; the in-memory/backend path remains
    // the source of truth and continues to work normally.
  }
}

// Deduped in-flight guard only - NOT a permanent cache. The previous
// implementation kept this promise around forever once resolved, so any
// symbol added after the very first refresh (e.g. via SymbolSwitcher's
// "Add" flow) never got its icon fetched again: every later call just
// returned the same already-resolved promise instead of re-hitting the
// backend. Clearing it in `finally` (same pattern already used for
// `backendSelectionCheck` in config/constants.ts) fixes that: concurrent
// callers still dedupe into one in-flight request, but the NEXT call
// after that genuinely re-fetches.
let iconRefreshPromise: Promise<void> | null = null;

/**
 * Best-effort enrichment for dynamically added symbols, using the
 * backend's own icon cache (see GET /api/icons) rather than calling
 * Binance directly from the browser. Calling Binance's asset directory
 * client-side (the previous implementation) depends on Binance sending
 * CORS headers for this app's origin, which it generally does not for
 * arbitrary third-party frontends - the backend, which faces no such
 * restriction, is the reliable source now. The same cache now dynamically
 * resolves MEXC-only tokens through its CoinGecko provider, so every venue
 * follows this single refresh path instead of frontend-specific URL guesses.
 *
 * Failure here never blocks charts: bundled icons / ticker-label
 * fallbacks (see getSymbolInfo below) continue to work regardless.
 */
export async function refreshSymbolMetadata(): Promise<void> {
  if (iconRefreshPromise) return iconRefreshPromise;

  iconRefreshPromise = (async () => {
    try {
      const { icons } = await listIcons();

      // hydrate icon metadata into memory and persist only the tiny
      // symbol/version map. The actual image bytes stay in the browser HTTP
      // cache rather than localStorage (which is synchronous, quota-limited,
      // and a poor fit for binary/base64 image data). On the next app start the
      // search list can therefore render known icon URLs immediately, while
      // this background refresh still discovers newly-added/repaired icons.
      await applyIconMetadata(icons);
      persistIconMetadata(icons);
    } catch {
      // Optional cosmetic enrichment only.
    }
  })().finally(() => {
    iconRefreshPromise = null;
  });

  return iconRefreshPromise;
}

// The backend switch (local <-> remote, see config/constants.ts) changes
// TRADING_API_BASE_URL, which iconImageUrl bakes into an ABSOLUTE URL -
// unlike Binance's own URLs, those are backend-specific. Without this,
// icons cached from the previously-selected backend would keep pointing
// at an origin that may now be unreachable (or, worse, coincidentally
// serving something else entirely) after a switch. Clearing the map and
// re-running the fetch keeps icons pointed at whichever backend is
// actually active.
if (typeof window !== "undefined") {
  // populate runtime metadata synchronously from the last successful
  // backend response so opening/searching the symbol list does not briefly show
  // generic placeholders while GET /api/icons is still in flight.
  window.addEventListener(TRADING_API_BASE_URL_CHANGED_EVENT, () => {
    for (const code of Object.keys(runtimeAssetMetadata)) {
      const previous = runtimeAssetMetadata[code].icon;
      if (previous?.startsWith("blob:")) URL.revokeObjectURL(previous);
      delete runtimeAssetMetadata[code].icon;
    }
    iconRefreshPromise = null;

    // Load the selected backend's own cached metadata first, then reconcile in
    // the background. This preserves instant icons across local/remote switches
    // without ever reusing URLs from the wrong backend.
    void hydratePersistedIconMetadata();
    void refreshSymbolMetadata();
  });
}

export type SymbolInfo = {
  /** Short ticker to show in the UI, e.g. "BTC". */
  label: string;
  /** Full name, e.g. "Bitcoin" - falls back to the label if unknown. */
  name: string;
  /** Local asset icon URL when one is available. */
  icon?: string;
};

function getBaseAsset(symbol: string): string {
  const quote = QUOTE_ASSET_SUFFIXES.find((suffix) => symbol.endsWith(suffix));
  return quote ? symbol.slice(0, symbol.length - quote.length) : symbol;
}

export function getSymbolInfo(symbol: string): SymbolInfo {
  const base = getBaseAsset(symbol);

  const runtime = runtimeAssetMetadata[base];

  return {
    label: base,
    name: BASE_ASSET_NAMES[base] ?? runtime?.name ?? base,
    // the backend now selects separate verified crypto/TradFi icon
    // sources, so both asset classes can safely use the same cached-image path.
    icon: BASE_ASSET_ICONS[base] ?? runtime?.icon,
  };
}

/**
 * Formats a trading pair symbol as "BASE/QUOTE" (e.g. "BTCUSDT" ->
 * "BTC/USDT") for places that want the more readable slashed form -
 * currently just the ntfy price-alert notification (see
 * utils/alerts.ts). Falls back to the symbol unchanged if its quote
 * suffix isn't recognized.
 */
export function formatSymbolPair(symbol: string): string {
  const quote = QUOTE_ASSET_SUFFIXES.find((suffix) => symbol.endsWith(suffix));
  if (!quote) return symbol;

  const base = symbol.slice(0, symbol.length - quote.length);
  return `${base}/${quote}`;
}
