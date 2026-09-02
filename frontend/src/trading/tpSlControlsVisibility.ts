const STORAGE_PREFIX = "fyxtez:tp-sl-controls-visible-v1:";

/**
 * FEATURE: TP/SL chart controls can be hidden per symbol for long-held
 * positions. The preference lives in localStorage so a deliberate hide does
 * not come back after a refresh/restart, and a small custom event keeps the
 * chart overlay and account-wide Positions panel in sync immediately.
 */
export const TP_SL_CONTROLS_VISIBILITY_EVENT =
  "fyxtez:tp-sl-controls-visibility-changed";

function storageKey(symbol: string): string {
  return `${STORAGE_PREFIX}${symbol.trim().toUpperCase()}`;
}

export function areTpSlControlsVisible(symbol: string): boolean {
  try {
    return localStorage.getItem(storageKey(symbol)) !== "hidden";
  } catch {
    // If storage is unavailable, fail open so trading controls never vanish
    // merely because the browser blocked localStorage.
    return true;
  }
}

export function setTpSlControlsVisible(
  symbol: string,
  visible: boolean,
): void {
  const normalizedSymbol = symbol.trim().toUpperCase();

  try {
    localStorage.setItem(
      storageKey(normalizedSymbol),
      visible ? "visible" : "hidden",
    );
  } catch {
    // The event still updates the current tab even if persistence is blocked.
  }

  window.dispatchEvent(
    new CustomEvent(TP_SL_CONTROLS_VISIBILITY_EVENT, {
      detail: { symbol: normalizedSymbol, visible },
    }),
  );
}
