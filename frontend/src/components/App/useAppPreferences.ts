import { useEffect, useState } from "react";

const DRAWINGS_VISIBILITY_STORAGE_KEY = "fyxtez:drawings-visible";
const ASIA_SESSION_STORAGE_KEY = "fyxtez:asia-session-enabled";
const LONDON_SESSION_STORAGE_KEY = "fyxtez:london-session-enabled";
const NEW_YORK_SESSION_STORAGE_KEY = "fyxtez:new-york-session-enabled";
const NEW_YORK_KILL_ZONE_STORAGE_KEY = "fyxtez:new-york-kill-zone-enabled";
const DESKTOP_SESSION_DEFAULTS_VERSION_KEY = "fyxtez:desktop-session-defaults-v2";
const PNL_CARD_STORAGE_KEY = "fyxtez:pnl-card-enabled";
const TOTAL_PNL_CARD_STORAGE_KEY = "fyxtez:total-pnl-card-enabled";
const CANDLE_COUNTDOWN_STORAGE_KEY = "fyxtez:candle-countdown-enabled";
const DRAWING_SET_BADGE_STORAGE_KEY = "fyxtez:drawing-set-badge-enabled";
const WATERMARK_VISIBILITY_STORAGE_KEY = "fyxtez:watermark-visible";
const START_OF_DAY_STORAGE_KEY = "fyxtez:start-of-day-enabled";
const START_OF_DAY_LOOKBACK_STORAGE_KEY = "fyxtez:start-of-day-lookback-days";
const PRICE_ALERTS_VISIBLE_STORAGE_KEY = "fyxtez:price-alerts-visible";
const PERSISTENT_ALERTS_ENABLED_STORAGE_KEY = "fyxtez:persistent-alerts-enabled";

function loadBooleanPreference(key: string): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

function loadOptInPreference(key: string): boolean {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function loadSessionPreference(key: string, isDesktop: boolean): boolean {
  try {
    if (isDesktop && localStorage.getItem(DESKTOP_SESSION_DEFAULTS_VERSION_KEY) !== "applied") {
      return false;
    }
  } catch {}
  return loadBooleanPreference(key);
}

function persistBoolean(key: string, enabled: boolean): void {
  try {
    localStorage.setItem(key, String(enabled));
  } catch {
    // Preferences remain usable for the current session when storage is unavailable.
  }
}

function loadStartOfDayLookback(): number {
  try {
    const stored = Number(localStorage.getItem(START_OF_DAY_LOOKBACK_STORAGE_KEY));
    return Number.isFinite(stored) ? Math.min(20, Math.max(1, Math.round(stored))) : 10;
  } catch {
    return 10;
  }
}

/** Owns chart-only preferences and their localStorage lifecycle. */
export function useAppPreferences(isDesktop: boolean) {
  const [showDrawings, setShowDrawingsState] = useState(() =>
    loadBooleanPreference(DRAWINGS_VISIBILITY_STORAGE_KEY),
  );
  const [showAsiaSession, setShowAsiaSessionState] = useState(() =>
    loadSessionPreference(ASIA_SESSION_STORAGE_KEY, isDesktop),
  );
  const [showLondonSession, setShowLondonSessionState] = useState(() =>
    loadSessionPreference(LONDON_SESSION_STORAGE_KEY, isDesktop),
  );
  const [showNewYorkSession, setShowNewYorkSessionState] = useState(() =>
    loadSessionPreference(NEW_YORK_SESSION_STORAGE_KEY, isDesktop),
  );
  const [showNewYorkKillZone, setShowNewYorkKillZoneState] = useState(() =>
    loadOptInPreference(NEW_YORK_KILL_ZONE_STORAGE_KEY),
  );
  const [showPositionPnl, setShowPositionPnlState] = useState(() =>
    loadBooleanPreference(PNL_CARD_STORAGE_KEY),
  );
  const [showTotalPnl, setShowTotalPnlState] = useState(() =>
    loadBooleanPreference(TOTAL_PNL_CARD_STORAGE_KEY),
  );
  const [showCandleCountdown, setShowCandleCountdownState] = useState(() =>
    loadBooleanPreference(CANDLE_COUNTDOWN_STORAGE_KEY),
  );
  const [showWatermark, setShowWatermarkState] = useState(() =>
    loadBooleanPreference(WATERMARK_VISIBILITY_STORAGE_KEY),
  );
  const [showDrawingSetBadge, setShowDrawingSetBadgeState] = useState(() =>
    loadBooleanPreference(DRAWING_SET_BADGE_STORAGE_KEY),
  );
  const [showStartOfDay, setShowStartOfDayState] = useState(() =>
    loadBooleanPreference(START_OF_DAY_STORAGE_KEY),
  );
  const [startOfDayLookbackDays, setStartOfDayLookbackDaysState] = useState(loadStartOfDayLookback);
  const [showPriceAlerts, setShowPriceAlertsState] = useState(() =>
    loadBooleanPreference(PRICE_ALERTS_VISIBLE_STORAGE_KEY),
  );
  const [persistentAlertsEnabled, setPersistentAlertsEnabledState] = useState(() =>
    loadOptInPreference(PERSISTENT_ALERTS_ENABLED_STORAGE_KEY),
  );

  useEffect(() => {
    if (!isDesktop) return;
    try {
      if (localStorage.getItem(DESKTOP_SESSION_DEFAULTS_VERSION_KEY) !== "applied") {
        setShowAsiaSessionState(false);
        setShowLondonSessionState(false);
        setShowNewYorkSessionState(false);
        persistBoolean(ASIA_SESSION_STORAGE_KEY, false);
        persistBoolean(LONDON_SESSION_STORAGE_KEY, false);
        persistBoolean(NEW_YORK_SESSION_STORAGE_KEY, false);
        localStorage.setItem(DESKTOP_SESSION_DEFAULTS_VERSION_KEY, "applied");
      }
    } catch {
      // The one-time defaults will be retried on the next desktop launch.
    }
  }, [isDesktop]);

  const booleanSetter = (setter: (enabled: boolean) => void, key: string) => (enabled: boolean) => {
    setter(enabled);
    persistBoolean(key, enabled);
  };

  const setStartOfDayLookbackDays = (days: number) => {
    if (!Number.isFinite(days)) return;
    const normalized = Math.min(20, Math.max(1, Math.round(days)));
    setStartOfDayLookbackDaysState(normalized);
    try {
      localStorage.setItem(START_OF_DAY_LOOKBACK_STORAGE_KEY, String(normalized));
    } catch {
      // Keep the normalized value in memory.
    }
  };

  return {
    showDrawings,
    setShowDrawings: booleanSetter(setShowDrawingsState, DRAWINGS_VISIBILITY_STORAGE_KEY),
    showAsiaSession,
    setShowAsiaSession: booleanSetter(setShowAsiaSessionState, ASIA_SESSION_STORAGE_KEY),
    showLondonSession,
    setShowLondonSession: booleanSetter(setShowLondonSessionState, LONDON_SESSION_STORAGE_KEY),
    showNewYorkSession,
    setShowNewYorkSession: booleanSetter(setShowNewYorkSessionState, NEW_YORK_SESSION_STORAGE_KEY),
    showNewYorkKillZone,
    setShowNewYorkKillZone: booleanSetter(
      setShowNewYorkKillZoneState,
      NEW_YORK_KILL_ZONE_STORAGE_KEY,
    ),
    showPositionPnl,
    setShowPositionPnl: booleanSetter(setShowPositionPnlState, PNL_CARD_STORAGE_KEY),
    showTotalPnl,
    setShowTotalPnl: booleanSetter(setShowTotalPnlState, TOTAL_PNL_CARD_STORAGE_KEY),
    showCandleCountdown,
    setShowCandleCountdown: booleanSetter(
      setShowCandleCountdownState,
      CANDLE_COUNTDOWN_STORAGE_KEY,
    ),
    showWatermark,
    setShowWatermark: booleanSetter(setShowWatermarkState, WATERMARK_VISIBILITY_STORAGE_KEY),
    showDrawingSetBadge,
    setShowDrawingSetBadge: booleanSetter(
      setShowDrawingSetBadgeState,
      DRAWING_SET_BADGE_STORAGE_KEY,
    ),
    showStartOfDay,
    setShowStartOfDay: booleanSetter(setShowStartOfDayState, START_OF_DAY_STORAGE_KEY),
    startOfDayLookbackDays,
    setStartOfDayLookbackDays,
    showPriceAlerts,
    setShowPriceAlerts: booleanSetter(setShowPriceAlertsState, PRICE_ALERTS_VISIBLE_STORAGE_KEY),
    persistentAlertsEnabled,
    setPersistentAlertsEnabled: booleanSetter(
      setPersistentAlertsEnabledState,
      PERSISTENT_ALERTS_ENABLED_STORAGE_KEY,
    ),
  };
}
