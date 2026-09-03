const SETTINGS_PANEL_WIDTH_KEY = "fyxtez.settings.panelWidth";
const DEFAULT_SETTINGS_PANEL_WIDTH = 440;
export const MIN_SETTINGS_PANEL_WIDTH = 360;
export const MAX_SETTINGS_PANEL_WIDTH = 720;

const POSITIONS_PANEL_HEIGHT_KEY = "fyxtez.positions.panelHeight";
const DEFAULT_POSITIONS_PANEL_HEIGHT = 280;
export const MIN_POSITIONS_PANEL_HEIGHT = 120;
export const MAX_POSITIONS_PANEL_HEIGHT = 640;

function readStoredDimension(
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  try {
    const stored = Number(window.localStorage.getItem(key));
    if (Number.isFinite(stored) && stored > 0) {
      return Math.min(maximum, Math.max(minimum, stored));
    }
  } catch {
    // Use the default when localStorage is unavailable.
  }
  return fallback;
}

export function readStoredSettingsPanelWidth(): number {
  return readStoredDimension(
    SETTINGS_PANEL_WIDTH_KEY,
    DEFAULT_SETTINGS_PANEL_WIDTH,
    MIN_SETTINGS_PANEL_WIDTH,
    MAX_SETTINGS_PANEL_WIDTH,
  );
}

export function readStoredPositionsPanelHeight(): number {
  return readStoredDimension(
    POSITIONS_PANEL_HEIGHT_KEY,
    DEFAULT_POSITIONS_PANEL_HEIGHT,
    MIN_POSITIONS_PANEL_HEIGHT,
    MAX_POSITIONS_PANEL_HEIGHT,
  );
}

export function persistSettingsPanelWidth(width: number): void {
  try {
    window.localStorage.setItem(SETTINGS_PANEL_WIDTH_KEY, String(width));
  } catch {
    // Resizing remains available for the current session.
  }
}

export function persistPositionsPanelHeight(height: number): void {
  try {
    window.localStorage.setItem(POSITIONS_PANEL_HEIGHT_KEY, String(height));
  } catch {
    // Resizing remains available for the current session.
  }
}
