import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { UTCTimestamp } from "lightweight-charts";
import {
  PENDING_LIMIT_LONG_COLOR,
  PENDING_LIMIT_SHORT_COLOR,
  getSymbolConfig,
  isSymbolUnconfirmed,
  restartDesktopBackend,
} from "../../config/constants";
import { getLocalZoneLabel } from "../../utils/time";
import { getSymbolInfo } from "../../config/symbols";
import { deleteSymbol } from "../../trading/api/symbols";
import { clearSymbolLocalMetadata } from "../../utils/symbolMetadata";
import { parseReduceMetadata } from "../../trading/reduceMetadata";
import { useChartRefs } from "../../hooks/useChartRefs";
import { useCoordinateMapping } from "../../hooks/useCoordinateMapping";
import { useDrawings } from "../../hooks/useDrawings";
import { usePriceAlerts } from "../../hooks/usePriceAlerts";
import { useChartInstance } from "../../hooks/useChartInstance";
import { useMarketData } from "../../hooks/useMarketData";
import { useSymbol, isTradingSymbol } from "../../hooks/useSymbol";
import { useChartTabs } from "../../hooks/useChartTabs";
import { useTradeMenu } from "../../hooks/useTradeMenu";
import { useTradeMarkers } from "../../hooks/useTradeMarkers";
import { appendTradeMarkerForSymbol } from "../../utils/tradeMarkers";
import { useDrawingCanvas } from "../../hooks/useDrawingCanvas";
import { useHotkeys } from "../../hooks/useHotkeys";
import { useOpenOrders } from "../../hooks/useOpenOrders";
import { useTradingStream } from "../../hooks/useTradingStream";
import { useChartPositionPnl } from "../../hooks/useChartPositionPnl";
import { useBackendConnection } from "../../hooks/useBackendConnection";
import { useOperationalDiagnostics } from "../../hooks/useOperationalDiagnostics";
import { getPositions } from "../../trading/api/positions";
import { getCurrentLeverage } from "../../trading/api/leverage";
import { estimatePendingLimitLiquidation } from "../../trading/estimatedLiquidation";
import type { OpenOrder } from "../../trading/api/orders";
import type { MarketOrderFill, TradeSide } from "../../trading/types";

import Topbar from "../Topbar/Topbar";
import ChartTabs from "../ChartTabs/ChartTabs";
import DrawingToolbar from "../DrawingToolbar/DrawingToolbar";
import ChartPanel from "../ChartPanel/ChartPanel";
import SettingsPanel from "../SettingsPanel/SettingsPanel";
import HotkeysPopup from "../HotkeysPopup/HotkeysPopup";
import ContextMenu from "../ContextMenu/ContextMenu";
import TradeMenu from "../TradeMenu/TradeMenu";
import PositionsPanel from "../PositionsPanel/PositionsPanel";
import UnregisteredSymbolBanner from "../UnregisteredSymbolBanner/UnregisteredSymbolBanner";
import { useDesktopCredentials } from "../DesktopSetupGate/DesktopCredentialsContext";
import SystemNotice from "../SystemNotice/SystemNotice";

import "./App.css";

const SETTINGS_PANEL_WIDTH_KEY = "fyxtez.settings.panelWidth";
const DEFAULT_SETTINGS_PANEL_WIDTH = 440;
const MIN_SETTINGS_PANEL_WIDTH = 360;
const MAX_SETTINGS_PANEL_WIDTH = 720;

const POSITIONS_PANEL_HEIGHT_KEY = "fyxtez.positions.panelHeight";
const DEFAULT_POSITIONS_PANEL_HEIGHT = 280;
const MIN_POSITIONS_PANEL_HEIGHT = 120;
const MAX_POSITIONS_PANEL_HEIGHT = 640;

function readStoredSettingsPanelWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(SETTINGS_PANEL_WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) {
      return Math.min(MAX_SETTINGS_PANEL_WIDTH, Math.max(MIN_SETTINGS_PANEL_WIDTH, stored));
    }
  } catch {
    // Ignore storage failures and fall back to the default width.
  }

  return DEFAULT_SETTINGS_PANEL_WIDTH;
}

function readStoredPositionsPanelHeight(): number {
  try {
    const stored = Number(window.localStorage.getItem(POSITIONS_PANEL_HEIGHT_KEY));
    if (Number.isFinite(stored) && stored > 0) {
      return Math.min(
        MAX_POSITIONS_PANEL_HEIGHT,
        Math.max(MIN_POSITIONS_PANEL_HEIGHT, stored),
      );
    }
  } catch {
    // Ignore storage failures and fall back to the default height.
  }

  return DEFAULT_POSITIONS_PANEL_HEIGHT;
}

const LIMIT_REDUCE_COLOR = "#f5a623";
const FULL_STOP_STORAGE_PREFIX = "fyxtez:full-stop:";

/**
 * Whether the Asia/London/New York session boundary lines (see
 * SessionZonesOverlay.tsx) are shown on the chart. Purely a local
 * display preference - there's no backend concept of this at all, so
 * unlike the margin/leverage settings this never needs to be gated on
 * backendConnection or sent anywhere; it just persists to localStorage.
 * Deliberately NOT per-symbol - it's a chart display preference, not
 * trade data.
 */
const DRAWINGS_VISIBILITY_STORAGE_KEY = "fyxtez:drawings-visible";
const ASIA_SESSION_STORAGE_KEY = "fyxtez:asia-session-enabled";
const LONDON_SESSION_STORAGE_KEY = "fyxtez:london-session-enabled";
const NEW_YORK_SESSION_STORAGE_KEY = "fyxtez:new-york-session-enabled";
const NEW_YORK_KILL_ZONE_STORAGE_KEY = "fyxtez:new-york-kill-zone-enabled";
const DESKTOP_SESSION_DEFAULTS_VERSION_KEY = "fyxtez:desktop-session-defaults-v2";

/**
 * Same idea as SESSION_ZONES_STORAGE_KEY above - purely local display
 * preferences for the two chart-corner PNL cards (see
 * ChartPositionPnl.tsx), no backend concept, default to shown.
 */
const PNL_CARD_STORAGE_KEY = "fyxtez:pnl-card-enabled";
const TOTAL_PNL_CARD_STORAGE_KEY = "fyxtez:total-pnl-card-enabled";
const CANDLE_COUNTDOWN_STORAGE_KEY = "fyxtez:candle-countdown-enabled";
const DRAWING_SET_BADGE_STORAGE_KEY = "fyxtez:drawing-set-badge-enabled";
// FEATURE: keep watermark visibility as a local display preference so users can hide branding without affecting chart state.
const WATERMARK_VISIBILITY_STORAGE_KEY = "fyxtez:watermark-visible";

/** Whether midnight/start-of-day marker lines are shown. */
const START_OF_DAY_STORAGE_KEY = "fyxtez:start-of-day-enabled";
const START_OF_DAY_LOOKBACK_STORAGE_KEY = "fyxtez:start-of-day-lookback-days";

/**
 * Same idea as SESSION_ZONES_STORAGE_KEY above - purely local display
 * preference for whether pending price alert lines (see
 * AlertLinesOverlay.tsx) are drawn on the chart. Defaults to shown, like
 * loadBooleanPreference's other consumers below.
 */
const PRICE_ALERTS_VISIBLE_STORAGE_KEY = "fyxtez:price-alerts-visible";

/**
 * Whether newly-created price alerts are handed off to the backend
 * instead of being tracked and fired straight from this browser tab.
 * Deliberately does NOT default to true via loadBooleanPreference
 * (whose "absent key" default is true), keeping backend-managed alerts
 * as an explicit user preference.
 */
const PERSISTENT_ALERTS_ENABLED_STORAGE_KEY =
  "fyxtez:persistent-alerts-enabled";

function loadPersistentAlertsEnabled(): boolean {
  try {
    return (
      localStorage.getItem(PERSISTENT_ALERTS_ENABLED_STORAGE_KEY) === "true"
    );
  } catch {
    return false;
  }
}

function loadBooleanPreference(key: string): boolean {
  try {
    const raw = localStorage.getItem(key);
    // Default to shown - absent key means "never set", not "turned off".
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

function loadSessionPreference(key: string, isDesktop: boolean): boolean {
  try {
    // Tauri dev uses a persistent localhost WebView origin, which can inherit
    // old browser values. Hide session overlays exactly once, then honor
    // every explicit Settings change normally on subsequent launches.
    if (
      isDesktop &&
      localStorage.getItem(DESKTOP_SESSION_DEFAULTS_VERSION_KEY) !== "applied"
    ) {
      return false;
    }
  } catch {}
  return loadBooleanPreference(key);
}

function loadFullStopPrice(symbol: string): number | null {
  try {
    const raw = localStorage.getItem(
      `${FULL_STOP_STORAGE_PREFIX}${symbol.toUpperCase()}`,
    );
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { triggerPrice?: unknown };
    const price = Number(parsed.triggerPrice);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

function classifyLimitOrder(
  clientOrderId?: string | null,
  reduceOnly?: boolean,
): "ENTRY" | "ADD" | "REDUCE" | undefined {
  if (reduceOnly || clientOrderId?.startsWith("fe-red-")) return "REDUCE";
  if (clientOrderId?.startsWith("fe-entry-")) return "ENTRY";
  if (clientOrderId?.startsWith("fe-add-")) return "ADD";
  return undefined;
}

function App() {
  const desktopCredentials = useDesktopCredentials();
  const refs = useChartRefs();
  const coord = useCoordinateMapping(refs);

  // The one piece of state everything below is scoped to. Renamed from
  // the old hardcoded `SYMBOL` constant to `currentSymbol` (rather than
  // plain `symbol`) so it never collides with the several local `symbol`
  // parameters used further down (e.g. PositionsPanel's onPositionClosed
  // callback, which receives its own `symbol` argument for the position
  // that was actually closed).
  const {
    symbol: currentSymbol,
    setSymbol: setCurrentSymbol,
    availableSymbols,
    syncRegistry: syncSymbolRegistry,
    registryReady: symbolRegistryReady,
    symbolRegistryError,
  } = useSymbol();

  /**
   * Clicking a Positions-tab row for a symbol other than the active one
   * switches the whole app to it (see PositionsPanel's onSwitchSymbol).
   * position.symbol is a plain string straight from the account API, not
   * the TradingSymbol union setCurrentSymbol expects, so this validates
   * it's actually one of AVAILABLE_SYMBOLS first - in practice always
   * true (this app only ever opens positions in symbols it itself
   * offers), but a stray/unsupported symbol on the account should just
   * be a no-op here rather than a runtime type violation.
   */
  const chartTabs = useChartTabs(currentSymbol, setCurrentSymbol, availableSymbols);

  const switchToPositionSymbol = (symbol: string) => {
    if (isTradingSymbol(symbol)) {
      chartTabs.openTab(symbol);
    }
  };

  const removeDeletedSymbolTab = (symbol: typeof currentSymbol) => {
    // FEATURE: backend deletion must also remove the stale chart tab. When it
    // is the last open chart, pick another registered symbol as a replacement
    // instead of violating the app's at-least-one-tab invariant.
    const fallback = availableSymbols.find((candidate) => candidate !== symbol);
    chartTabs.removeDeletedTab(symbol, fallback);
  };

  const deleteTrackedSymbolFromTab = async (symbol: typeof currentSymbol) => {
    // FEATURE: tab-context Delete reuses the same backend contract as the
    // Symbol Switcher delete action, then clears per-symbol browser metadata
    // and refreshes the authoritative registry before removing the chart tab.
    await deleteSymbol(getSymbolInfo(symbol).label);
    clearSymbolLocalMetadata(symbol);
    await syncSymbolRegistry();
    removeDeletedSymbolTab(symbol);
  };

  const drawingsApi = useDrawings(refs, currentSymbol);

  useChartInstance(refs, coord.logicalToTime);

  // FIX: gate market loading on the authoritative symbol registry so a saved
  // MEXC tab never performs an initial Binance request after page refresh.
  const marketData = useMarketData(refs, currentSymbol, symbolRegistryReady);
  const { positionPnl, totalPnl, clearPositionPnl } = useChartPositionPnl(currentSymbol);

  const backendConnection = useBackendConnection();

  const [showDrawings, setShowDrawingsState] = useState<boolean>(() =>
    loadBooleanPreference(DRAWINGS_VISIBILITY_STORAGE_KEY),
  );

  const setShowDrawings = (enabled: boolean) => {
    setShowDrawingsState(enabled);
    try {
      localStorage.setItem(DRAWINGS_VISIBILITY_STORAGE_KEY, String(enabled));
    } catch {
      // Ignore - the preference just won't persist across reloads.
    }
  };

  const [showAsiaSession, setShowAsiaSessionState] = useState<boolean>(() =>
    loadSessionPreference(ASIA_SESSION_STORAGE_KEY, desktopCredentials.isDesktop),
  );
  const [showLondonSession, setShowLondonSessionState] = useState<boolean>(() =>
    loadSessionPreference(LONDON_SESSION_STORAGE_KEY, desktopCredentials.isDesktop),
  );
  const [showNewYorkSession, setShowNewYorkSessionState] = useState<boolean>(() =>
    loadSessionPreference(NEW_YORK_SESSION_STORAGE_KEY, desktopCredentials.isDesktop),
  );
  useEffect(() => {
    if (!desktopCredentials.isDesktop) return;
    try {
      if (
        localStorage.getItem(DESKTOP_SESSION_DEFAULTS_VERSION_KEY) !== "applied"
      ) {
        setShowAsiaSessionState(false);
        setShowLondonSessionState(false);
        setShowNewYorkSessionState(false);
        localStorage.setItem(ASIA_SESSION_STORAGE_KEY, "false");
        localStorage.setItem(LONDON_SESSION_STORAGE_KEY, "false");
        localStorage.setItem(NEW_YORK_SESSION_STORAGE_KEY, "false");
        localStorage.setItem(DESKTOP_SESSION_DEFAULTS_VERSION_KEY, "applied");
      }
    } catch {
      // Ignore - the defaults will be applied again on the next launch.
    }
  }, [desktopCredentials.isDesktop]);
  const [showNewYorkKillZone, setShowNewYorkKillZoneState] = useState<boolean>(
    () => {
      try {
        // FEATURE: the new overlay is opt-in; missing storage must not enable
        // it for every existing user during the first upgraded load.
        return localStorage.getItem(NEW_YORK_KILL_ZONE_STORAGE_KEY) === "true";
      } catch {
        return false;
      }
    },
  );

  const setBooleanPreference = (
    setter: (enabled: boolean) => void,
    key: string,
    enabled: boolean,
  ) => {
    setter(enabled);
    try {
      localStorage.setItem(key, String(enabled));
    } catch {
      // Ignore - the preference just won't persist across reloads.
    }
  };

  const [showPositionPnl, setShowPositionPnlState] = useState<boolean>(() =>
    loadBooleanPreference(PNL_CARD_STORAGE_KEY),
  );

  const setShowPositionPnl = (enabled: boolean) => {
    setShowPositionPnlState(enabled);
    try {
      localStorage.setItem(PNL_CARD_STORAGE_KEY, String(enabled));
    } catch {
      // Ignore - the preference just won't persist across reloads.
    }
  };

  const [showTotalPnl, setShowTotalPnlState] = useState<boolean>(() =>
    loadBooleanPreference(TOTAL_PNL_CARD_STORAGE_KEY),
  );

  const setShowTotalPnl = (enabled: boolean) => {
    setShowTotalPnlState(enabled);
    try {
      localStorage.setItem(TOTAL_PNL_CARD_STORAGE_KEY, String(enabled));
    } catch {
      // Ignore - the preference just won't persist across reloads.
    }
  };

  const [showCandleCountdown, setShowCandleCountdownState] = useState<boolean>(
    () => loadBooleanPreference(CANDLE_COUNTDOWN_STORAGE_KEY),
  );

  const setShowCandleCountdown = (enabled: boolean) => {
    setShowCandleCountdownState(enabled);
    try {
      localStorage.setItem(CANDLE_COUNTDOWN_STORAGE_KEY, String(enabled));
    } catch {
      // Ignore - the preference just won't persist across reloads.
    }
  };

  // FEATURE: watermark visibility follows the same persistent, backend-free settings pattern as other chart display toggles.
  const [showWatermark, setShowWatermarkState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(WATERMARK_VISIBILITY_STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });

  const setShowWatermark = (enabled: boolean) => {
    setShowWatermarkState(enabled);
    try {
      localStorage.setItem(WATERMARK_VISIBILITY_STORAGE_KEY, String(enabled));
    } catch {
      // Ignore - the preference just won't persist across reloads.
    }
  };

  const [showDrawingSetBadge, setShowDrawingSetBadgeState] = useState<boolean>(
    () => loadBooleanPreference(DRAWING_SET_BADGE_STORAGE_KEY),
  );

  const setShowDrawingSetBadge = (enabled: boolean) => {
    setShowDrawingSetBadgeState(enabled);
    try {
      localStorage.setItem(DRAWING_SET_BADGE_STORAGE_KEY, String(enabled));
    } catch {
      // Ignore - the preference just won't persist across reloads.
    }
  };

  const [showStartOfDay, setShowStartOfDayState] = useState<boolean>(() =>
    loadBooleanPreference(START_OF_DAY_STORAGE_KEY),
  );

  const setShowStartOfDay = (enabled: boolean) =>
    setBooleanPreference(
      setShowStartOfDayState,
      START_OF_DAY_STORAGE_KEY,
      enabled,
    );

  const [startOfDayLookbackDays, setStartOfDayLookbackDaysState] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem(START_OF_DAY_LOOKBACK_STORAGE_KEY));
      return Number.isFinite(stored) ? Math.min(20, Math.max(1, Math.round(stored))) : 10;
    } catch {
      return 10;
    }
  });

  const setStartOfDayLookbackDays = (days: number) => {
    if (!Number.isFinite(days)) return;
    const normalized = Math.min(20, Math.max(1, Math.round(days)));
    setStartOfDayLookbackDaysState(normalized);
    try {
      localStorage.setItem(START_OF_DAY_LOOKBACK_STORAGE_KEY, String(normalized));
    } catch {
      // Ignore - the preference just won't persist across reloads.
    }
  };

  const [showPriceAlerts, setShowPriceAlertsState] = useState<boolean>(() =>
    loadBooleanPreference(PRICE_ALERTS_VISIBLE_STORAGE_KEY),
  );

  const setShowPriceAlerts = (enabled: boolean) => {
    setShowPriceAlertsState(enabled);
    try {
      localStorage.setItem(PRICE_ALERTS_VISIBLE_STORAGE_KEY, String(enabled));
    } catch {
      // Ignore - the preference just won't persist across reloads.
    }
  };

  const [persistentAlertsEnabled, setPersistentAlertsEnabledState] =
    useState<boolean>(() => loadPersistentAlertsEnabled());

  const setPersistentAlertsEnabled = (enabled: boolean) => {
    setPersistentAlertsEnabledState(enabled);
    try {
      localStorage.setItem(
        PERSISTENT_ALERTS_ENABLED_STORAGE_KEY,
        String(enabled),
      );
    } catch {
      // Ignore - the preference just won't persist across reloads.
    }
  };

  const priceAlertsApi = usePriceAlerts(
    refs,
    currentSymbol,
    marketData.lastPrice,
    persistentAlertsEnabled,
  );

  const tradeMarkersApi = useTradeMarkers(refs, currentSymbol);

  /*
   * FIX (duplicate market markers after accepting Binance-side fills): market
   * orders submitted by this UI are recorded immediately from their REST
   * response, then Binance reports the same execution again over the user
   * stream. Keep a short-lived fingerprint of those locally confirmed fills
   * so the stream handler below can consume the echo without drawing a second
   * marker. A fill made directly on Binance has no local fingerprint and is
   * therefore recorded normally.
   */
  const locallyRecordedMarketFillsRef = useRef<MarketOrderFill[]>([]);

  const addLocallyConfirmedMarketMarker = (fill: MarketOrderFill) => {
    const normalizedFill = {
      ...fill,
      symbol: fill.symbol.toUpperCase(),
    };
    const cutoff = Math.floor(Date.now() / 1000) - 15;

    locallyRecordedMarketFillsRef.current = [
      ...locallyRecordedMarketFillsRef.current.filter(
        (candidate) => candidate.time >= cutoff,
      ),
      normalizedFill,
    ];

    if (normalizedFill.symbol === currentSymbol.toUpperCase()) {
      tradeMarkersApi.addMarker(normalizedFill);
    } else {
      appendTradeMarkerForSymbol(normalizedFill.symbol, normalizedFill);
    }
  };

  // Fetch account-wide orders once. The chart derives its symbol-specific
  // subset locally instead of issuing a second Binance openOrders request.
  const allOpenOrdersApi = useOpenOrders(null, (fill) => {
    addLocallyConfirmedMarketMarker(fill);
  });
  const openOrdersApi = {
    ...allOpenOrdersApi,
    orders: allOpenOrdersApi.orders.filter(
      (order) => order.symbol.toUpperCase() === currentSymbol.toUpperCase(),
    ),
  };

  const [stopLossPrice, setStopLossPrice] = useState<number | null>(() =>
    loadFullStopPrice(currentSymbol),
  );

  useEffect(() => {
    const refreshProtection = () => {
      setStopLossPrice(loadFullStopPrice(currentSymbol));
    };

    window.addEventListener("trading-state-changed", refreshProtection);
    window.addEventListener("storage", refreshProtection);

    return () => {
      window.removeEventListener("trading-state-changed", refreshProtection);
      window.removeEventListener("storage", refreshProtection);
    };
    // Re-subscribing on every symbol change is cheap and guarantees these
    // closures always read the CURRENTLY active symbol's stop, instead of
    // whichever symbol was selected when the effect first ran.
  }, [currentSymbol]);

  const fullTakeProfitPrice = useMemo(() => {
    // FIX (snap-back bug, real root cause): moving the Full TP line goes
    // through useDrawingCanvas's submitOrderLineMove, which calls
    // repriceReduceOrder - and that can come back with a brand NEW
    // orderId (see RepriceReduceOrderResponse / the .then() in
    // useDrawingCanvas.ts), since a Binance price amend is really a
    // cancel-and-replace under the hood. The previous version of this
    // memo found the confirmed order first, then looked for a drawing
    // whose orderId matched THAT order's orderId - but the instant the
    // reprice resolves, the drawing's orderId flips to the new one while
    // openOrdersApi.orders still shows the OLD order (it only refreshes
    // on the next poll/event, which can be several seconds later). For
    // that whole window the orderId match failed, so this fell back to
    // the stale Number(fullTakeProfit.price) - the exact "snap back to
    // the old spot, then jump to the new one" the zone rectangle showed.
    //
    // Checking for a pending drawing FIRST, using the same
    // isFullTakeProfit classification useDrawingCanvas uses (reduce
    // intent + reducePct 100 / remainingPct 0) instead of an orderId
    // lookup, means the fresh price is used the entire time regardless
    // of whether openOrdersApi.orders has caught up yet.
    const pendingDrawing = drawingsApi.drawings.find(
      (drawing) =>
        drawing.type === "horizontal" &&
        drawing.orderPricePending &&
        (drawing.orderIntent === "REDUCE" ||
          drawing.clientOrderId?.startsWith("fe-red-") === true) &&
        (drawing.orderReducePct === 100 || drawing.orderRemainingPct === 0),
    );

    if (pendingDrawing?.type === "horizontal") {
      return Number.isFinite(pendingDrawing.price) && pendingDrawing.price > 0
        ? pendingDrawing.price
        : null;
    }

    const fullTakeProfit = openOrdersApi.orders.find((order) => {
      if (!(order.type === "LIMIT" || order.origType === "LIMIT")) {
        return false;
      }

      const intent = classifyLimitOrder(
        order.clientOrderId,
        order.reduceOnly,
      );
      if (intent !== "REDUCE") return false;

      const metadata = parseReduceMetadata(order.clientOrderId);
      return metadata.reducePct === 100 || metadata.remainingPct === 0;
    });

    if (!fullTakeProfit) return null;

    const price = Number(fullTakeProfit.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  }, [openOrdersApi.orders, drawingsApi.drawings]);

  const fullTakeProfitOrderId = useMemo(() => {
    const fullTakeProfit = openOrdersApi.orders.find((order) => {
      if (!(order.type === "LIMIT" || order.origType === "LIMIT")) {
        return false;
      }

      const intent = classifyLimitOrder(
        order.clientOrderId,
        order.reduceOnly,
      );
      if (intent !== "REDUCE") return false;

      const metadata = parseReduceMetadata(order.clientOrderId);
      return metadata.reducePct === 100 || metadata.remainingPct === 0;
    });

    return fullTakeProfit?.orderId ?? null;
  }, [openOrdersApi.orders, drawingsApi.isHydrated, currentSymbol]);

  const websocketConnection = useTradingStream({
    enabled:
      desktopCredentials.isDesktop &&
      desktopCredentials.status.binanceConfigured,
    onOrderExecuted: (event) => {
      const normalizedSymbol = event.symbol.toUpperCase();
      const eventTime = Math.floor(event.event_time / 1000);

      if (event.order_type !== "LIMIT") {
        const duplicateIndex = locallyRecordedMarketFillsRef.current.findIndex(
          (fill) => {
            const priceTolerance = Math.max(1e-8, event.price * 0.001);
            return (
              fill.symbol === normalizedSymbol &&
              fill.side === event.side &&
              Math.abs(fill.time - eventTime) <= 5 &&
              Math.abs(fill.price - event.price) <= priceTolerance
            );
          },
        );

        if (duplicateIndex >= 0) {
          // Consume the fingerprint once: a second genuine Binance fill must
          // not be hidden merely because it happens soon after the first one.
          locallyRecordedMarketFillsRef.current.splice(duplicateIndex, 1);
          return;
        }
      }

      /*
       * FIX (missing S/B marker when a position is closed on Binance): this
       * handler previously rejected every execution except LIMIT, because UI
       * market orders already add their marker from the REST response. That
       * also rejected MARKET fills created outside this frontend, including a
       * manual Binance position close. Record every non-duplicate execution;
       * if another symbol is open, persist it under the executed symbol so its
       * marker appears when that chart is selected later.
       */
      const marker = {
        symbol: normalizedSymbol,
        id: `binance-execution-${event.event_id}`,
        side: event.side,
        time: eventTime,
        price: event.price,
      };

      if (normalizedSymbol !== currentSymbol.toUpperCase()) {
        appendTradeMarkerForSymbol(normalizedSymbol, marker);
        return;
      }

      tradeMarkersApi.addMarker(marker);
    },
  });

  const diagnostics = useOperationalDiagnostics({
    isDesktop: desktopCredentials.isDesktop,
    backendConnection,
    marketConnection: marketData.marketConnection,
    frontendStreamConnection: websocketConnection,
  });

  const currentSymbolConfig = getSymbolConfig(currentSymbol);

  const tradeMenuApi = useTradeMenu(
    currentSymbol,
    (order) => {
      drawingsApi.addDrawing({
        id: `order-${order.orderId}`,
        type: "horizontal",
        price: order.price,
        color:
          order.intent === "REDUCE"
            ? LIMIT_REDUCE_COLOR
            : order.side === "BUY"
              ? PENDING_LIMIT_LONG_COLOR
              : PENDING_LIMIT_SHORT_COLOR,
        orderSide: order.side,
        orderId: order.orderId,
        clientOrderId: order.clientOrderId ?? undefined,
        orderSymbol: order.symbol,
        orderQuantity: order.quantity,
        timeInForce: order.timeInForce,
        orderIntent: order.intent,
        orderReducePct: order.reducePct,
        orderRemainingPct: order.remainingPct,
        // FEATURE: this estimate exists only before Binance has a real position
        // liquidationPrice, so keep it on the runtime order drawing itself.
        estimatedLiquidationPrice: order.estimatedLiquidationPrice,
      });

      void allOpenOrdersApi.refresh(true);
    },
    (fill) => {
      addLocallyConfirmedMarketMarker(fill);
    },
    backendConnection,
    currentSymbolConfig.executionEnabled && desktopCredentials.status.binanceConfigured,
  );

  useEffect(() => {
    // On a symbol switch, useDrawings intentionally exposes no drawings until
    // that symbol's storage has been loaded. Do not reconcile order lines
    // against that transitional empty list or manual boxes/lines can be lost.
    if (!drawingsApi.isHydrated) return;

    const manualDrawings = drawingsApi.drawings.filter(
      (drawing) => !(drawing.type === "horizontal" && drawing.orderId !== undefined),
    );

    const orderDrawings = openOrdersApi.orders
      .filter((order) => order.type === "LIMIT" || order.origType === "LIMIT")
      .map((order) => {
        const orderIntent = classifyLimitOrder(
          order.clientOrderId,
          order.reduceOnly,
        );
        const reduceMetadata =
          orderIntent === "REDUCE"
            ? parseReduceMetadata(order.clientOrderId)
            : {};
        const currentDrawing = drawingsApi.drawings.find(
          (drawing) =>
            drawing.type === "horizontal" &&
            drawing.id === `order-${order.orderId}`,
        );
        const serverPrice = Number(order.price);
        const wasPending =
          currentDrawing?.type === "horizontal"
            ? currentDrawing.orderPricePending
            : false;

        const stillPending =
          wasPending &&
          currentDrawing?.type === "horizontal" &&
          serverPrice !== currentDrawing.price;

        const displayPrice =
          stillPending && currentDrawing?.type === "horizontal"
            ? currentDrawing.price
            : serverPrice;

        return {
          id: `order-${order.orderId}`,
          type: "horizontal" as const,
          price: displayPrice,
          color:
            orderIntent === "REDUCE"
              ? LIMIT_REDUCE_COLOR
              : order.side === "BUY"
                ? PENDING_LIMIT_LONG_COLOR
                : PENDING_LIMIT_SHORT_COLOR,
          orderSide: order.side,
          orderId: order.orderId,
          clientOrderId: order.clientOrderId,
          orderSymbol: order.symbol,
          orderQuantity: Number(order.origQty),
          timeInForce: order.timeInForce,
          orderIntent,
          orderReducePct: reduceMetadata.reducePct,
          orderRemainingPct: reduceMetadata.remainingPct,
          orderPricePending: stillPending,
          // FEATURE: openOrders does not expose leverage/liquidation for a
          // resting order. Preserve the estimate and its visibility state from
          // the locally-created drawing instead of dropping them every 4s poll.
          estimatedLiquidationPrice:
            currentDrawing?.type === "horizontal"
              ? currentDrawing.estimatedLiquidationPrice
              : undefined,
          estimatedLiquidationHidden:
            currentDrawing?.type === "horizontal"
              ? currentDrawing.estimatedLiquidationHidden
              : undefined,
        };
      });

    const nextDrawings = [...manualDrawings, ...orderDrawings];
    const currentOrderDrawings = drawingsApi.drawings.filter(
      (drawing) => drawing.type === "horizontal" && drawing.orderId !== undefined,
    );

    const unchanged =
      currentOrderDrawings.length === orderDrawings.length &&
      orderDrawings.every((next) => {
        const current = currentOrderDrawings.find(
          (drawing) => drawing.id === next.id && drawing.type === "horizontal",
        );

        return (
          current?.type === "horizontal" &&
          current.price === next.price &&
          current.orderSide === next.orderSide &&
          current.orderSymbol === next.orderSymbol &&
          current.orderQuantity === next.orderQuantity &&
          current.timeInForce === next.timeInForce &&
          current.orderIntent === next.orderIntent &&
          current.orderReducePct === next.orderReducePct &&
          current.orderRemainingPct === next.orderRemainingPct &&
          current.orderPricePending === next.orderPricePending &&
          current.estimatedLiquidationPrice === next.estimatedLiquidationPrice &&
          current.estimatedLiquidationHidden === next.estimatedLiquidationHidden
        );
      });

    if (!unchanged) {
      drawingsApi.syncDrawings(nextDrawings);
    }
  }, [openOrdersApi.orders]);

  useEffect(() => {
    if (!drawingsApi.isHydrated) return;

    const missingEstimateOrders = openOrdersApi.orders.filter((order) => {
      if (order.reduceOnly) return false;
      if (order.type !== "LIMIT" && order.origType !== "LIMIT") return false;

      const drawing = drawingsApi.drawings.find(
        (candidate) =>
          candidate.type === "horizontal" &&
          candidate.id === `order-${order.orderId}`,
      );

      return (
        drawing?.type === "horizontal" &&
        drawing.estimatedLiquidationPrice == null
      );
    });

    if (missingEstimateOrders.length === 0) return;

    let cancelled = false;

    // FIX: openOrders does not contain the transient EST. LIQ value returned
    // when the LIMIT was first created. After reload (or for an order that
    // existed before this feature) the canvas therefore had no value to draw,
    // even though the order line itself was restored correctly. Rebuild a
    // fallback from Binance's current symbol leverage; a fresh backend-provided
    // bracket-aware estimate still wins whenever it is already on the drawing.
    void getCurrentLeverage(currentSymbol)
      .then(({ leverage }) => {
        if (cancelled) return;

        for (const order of missingEstimateOrders) {
          const estimate = estimatePendingLimitLiquidation(
            Number(order.price),
            Number(leverage),
            order.side,
          );
          if (estimate == null) continue;

          drawingsApi.updateDrawing(`order-${order.orderId}`, (drawing) =>
            drawing.type === "horizontal" &&
            drawing.estimatedLiquidationPrice == null
              ? { ...drawing, estimatedLiquidationPrice: estimate }
              : drawing,
          );
        }
      })
      .catch((error) => {
        console.warn(
          `[est-liq] unable to rebuild pending LIMIT estimate for ${currentSymbol}`,
          error,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [openOrdersApi.orders, drawingsApi.drawings, drawingsApi.isHydrated, currentSymbol]);

  const previousOrdersByIdRef = useRef<Map<string, OpenOrder>>(new Map());
  const knownPositionQuantityRef = useRef<{ LONG: number; SHORT: number }>({
    LONG: 0,
    SHORT: 0,
  });
  const hasSeededKnownQuantityRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const reconcileMissedFills = async () => {
      const previousOrdersById = previousOrdersByIdRef.current;
      const currentOrdersById = new Map(
        openOrdersApi.orders.map((order) => [order.orderId, order] as const),
      );

      const disappearedOrders = [...previousOrdersById.values()].filter(
        (order) =>
          !currentOrdersById.has(order.orderId) &&
          (order.type === "LIMIT" || order.origType === "LIMIT"),
      );

      try {
        const positions = await getPositions();
        if (cancelled) return;

        const longQuantity =
          positions.find(
            (item) =>
              item.symbol.toUpperCase() === currentSymbol.toUpperCase() &&
              item.side === "LONG",
          )?.quantity ?? 0;
        const shortQuantity =
          positions.find(
            (item) =>
              item.symbol.toUpperCase() === currentSymbol.toUpperCase() &&
              item.side === "SHORT",
          )?.quantity ?? 0;

        if (hasSeededKnownQuantityRef.current) {
          const previousQuantity = knownPositionQuantityRef.current;
          const QUANTITY_EPSILON = 1e-9;

          for (const order of disappearedOrders) {
            const isReduce =
              order.reduceOnly ||
              order.clientOrderId?.startsWith("fe-red-") === true;

            const affectedSide: "LONG" | "SHORT" =
              order.side === "BUY"
                ? isReduce
                  ? "SHORT"
                  : "LONG"
                : isReduce
                  ? "LONG"
                  : "SHORT";

            const before = previousQuantity[affectedSide];
            const after =
              affectedSide === "LONG" ? longQuantity : shortQuantity;

            const filled = isReduce
              ? after < before - QUANTITY_EPSILON
              : after > before + QUANTITY_EPSILON;

            if (filled) {
              const price = Number(order.price);

              if (Number.isFinite(price) && price > 0) {
                tradeMarkersApi.addMarker({
                  symbol: order.symbol,
                  id: `reconciled-fill-${order.orderId}`,
                  side: order.side,
                  time: Math.floor(Date.now() / 1000),
                  price,
                });
              }
            }
          }
        }

        knownPositionQuantityRef.current = {
          LONG: longQuantity,
          SHORT: shortQuantity,
        };
        hasSeededKnownQuantityRef.current = true;
      } catch {
        // Positions request failed - leave the baseline untouched.
      } finally {
        if (!cancelled) {
          previousOrdersByIdRef.current = currentOrdersById;
        }
      }
    };

    void reconcileMissedFills();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openOrdersApi.orders, currentSymbol]);

  const [isHotkeysOpen, setIsHotkeysOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsPanelWidth, setSettingsPanelWidth] = useState(
    readStoredSettingsPanelWidth,
  );
  const [isOrdersOpen, setIsOrdersOpen] = useState(false);
  const [positionsPanelHeight, setPositionsPanelHeight] = useState(
    readStoredPositionsPanelHeight,
  );

  const handleSettingsPanelWidthChange = (nextWidth: number) => {
    const viewportMax = Math.max(
      MIN_SETTINGS_PANEL_WIDTH,
      window.innerWidth - 480,
    );
    const width = Math.min(
      MAX_SETTINGS_PANEL_WIDTH,
      viewportMax,
      Math.max(MIN_SETTINGS_PANEL_WIDTH, Math.round(nextWidth)),
    );

    setSettingsPanelWidth(width);

    try {
      window.localStorage.setItem(SETTINGS_PANEL_WIDTH_KEY, String(width));
    } catch {
      // Resizing should still work if localStorage is unavailable.
    }
  };

  const handlePositionsPanelHeightChange = (nextHeight: number) => {
    // Always leave a useful amount of chart visible above the dock. The hard
    // maximum also prevents a previously stored value from taking over a
    // smaller display after moving the app between monitors.
    const viewportMax = Math.max(
      MIN_POSITIONS_PANEL_HEIGHT,
      window.innerHeight - 260,
    );
    const height = Math.min(
      MAX_POSITIONS_PANEL_HEIGHT,
      viewportMax,
      Math.max(MIN_POSITIONS_PANEL_HEIGHT, Math.round(nextHeight)),
    );

    setPositionsPanelHeight(height);

    try {
      window.localStorage.setItem(POSITIONS_PANEL_HEIGHT_KEY, String(height));
    } catch {
      // Resizing should still work if localStorage is unavailable.
    }
  };

  const [isToolbarCollapsed, setIsToolbarCollapsed] = useState(true);

  const [focusedOrderId, setFocusedOrderId] = useState<string | null>(null);
  const focusTimeoutRef = useRef<number | null>(null);

  const focusOrderLine = (orderId: string) => {
    const highlightDurationMs = 1_800;
    const highlightUntil = Date.now() + highlightDurationMs;

    refs.highlightedOrderIdRef.current = orderId;
    refs.highlightedOrderUntilRef.current = highlightUntil;
    setFocusedOrderId(orderId);

    if (focusTimeoutRef.current !== null) {
      window.clearTimeout(focusTimeoutRef.current);
    }

    focusTimeoutRef.current = window.setTimeout(() => {
      if (refs.highlightedOrderUntilRef.current !== highlightUntil) return;

      refs.highlightedOrderIdRef.current = null;
      refs.highlightedOrderUntilRef.current = 0;
      setFocusedOrderId(null);
      focusTimeoutRef.current = null;
    }, highlightDurationMs);
  };

  const [focusedPositionKey, setFocusedPositionKey] = useState<string | null>(
    null,
  );
  const positionFocusTimeoutRef = useRef<number | null>(null);

  const focusPosition = (key: string) => {
    const highlightDurationMs = 1_800;
    const highlightUntil = Date.now() + highlightDurationMs;

    refs.highlightedPositionKeyRef.current = key;
    refs.highlightedPositionUntilRef.current = highlightUntil;
    setFocusedPositionKey(key);

    if (positionFocusTimeoutRef.current !== null) {
      window.clearTimeout(positionFocusTimeoutRef.current);
    }

    positionFocusTimeoutRef.current = window.setTimeout(() => {
      if (refs.highlightedPositionUntilRef.current !== highlightUntil) return;

      refs.highlightedPositionUntilRef.current = 0;
      setFocusedPositionKey(null);
      positionFocusTimeoutRef.current = null;
    }, highlightDurationMs);
  };

  /**
   * Shared by both places a position can be closed and needs its trade
   * marker/PNL card handled: PositionsPanel's Market-close button, and
   * PositionBracketOverlay's own quick-close X (see its own comment for
   * why that exists). Extracted so both call sites stay in sync instead
   * of duplicating this same branch.
   */
  const handlePositionClosed = (
    side: TradeSide,
    symbol: string,
    price?: number,
  ) => {
    if (symbol.toUpperCase() !== currentSymbol.toUpperCase()) {
      /*
       * FIX: this used to just `return` here, silently dropping
       * the marker entirely for any symbol other than whatever
       * chart happened to be open - e.g. an ETH position closed
       * via "Close Everything FULL" while looking at BTC never
       * got a marker recorded anywhere, so switching to ETH
       * later showed nothing at the close. tradeMarkersApi is
       * bound to the *active* chart symbol only (it can't write
       * a marker for a different one), so this writes straight
       * to that other symbol's own storage instead - see
       * appendTradeMarkerForSymbol's own comment for the full
       * story. Requires a real fill price for that other
       * symbol (not this chart's own current price, which
       * would be meaningless for it) - if none was provided,
       * there's nothing accurate to place, so skip rather than
       * guess.
       */
      if (price !== undefined && Number.isFinite(price)) {
        appendTradeMarkerForSymbol(symbol, {
          time: Math.floor(Date.now() / 1000),
          price,
          side,
        });
      }

      return;
    }

    const fallbackPrice =
      price ?? refs.currentPriceRef.current ?? refs.lastCandleRef.current?.close;

    if (fallbackPrice !== undefined && Number.isFinite(fallbackPrice)) {
      addLocallyConfirmedMarketMarker({
        symbol,
        side,
        time: Math.floor(Date.now() / 1000),
        price: fallbackPrice,
      });
    }
    clearPositionPnl();
  };

  useEffect(() => {
    return () => {
      if (focusTimeoutRef.current !== null) {
        window.clearTimeout(focusTimeoutRef.current);
      }

      if (positionFocusTimeoutRef.current !== null) {
        window.clearTimeout(positionFocusTimeoutRef.current);
      }
    };
  }, []);

  // --- Reset on symbol switch --------------------------------------------
  //
  // Chart data, drawings, and trade markers already reset themselves
  // (useMarketData/useDrawings/useTradeMarkers all key off currentSymbol
  // directly), and PositionBracketOverlay is remounted via key={symbol}
  // in ChartPanel - so what's left here is exactly the UI/interaction
  // state that wouldn't otherwise be cleared: open menus/popups, focus
  // highlights, the previous symbol's stop-loss price, and the
  // fill-reconciliation baseline (which would otherwise compare the NEW
  // symbol's orders against the OLD symbol's known quantities and report
  // false fills).
  const previousSymbolRef = useRef(currentSymbol);

  useEffect(() => {
    if (previousSymbolRef.current === currentSymbol) return;
    previousSymbolRef.current = currentSymbol;

    drawingsApi.setContextMenu(null);
    drawingsApi.setSelectedId(null);
    drawingsApi.setTool("cursor");
    setIsHotkeysOpen(false);
    tradeMenuApi.closeTradeMenu();
    tradeMenuApi.cancelAutoMarket();
    setFocusedOrderId(null);
    setFocusedPositionKey(null);
    setStopLossPrice(loadFullStopPrice(currentSymbol));

    previousOrdersByIdRef.current = new Map();
    knownPositionQuantityRef.current = { LONG: 0, SHORT: 0 };
    hasSeededKnownQuantityRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSymbol]);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | null = null;
    let requestGeneration = 0;

    const clearRetryTimer = () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const syncOrdersPanelVisibility = async (
      options: {
        retryForNewPosition?: boolean;
        attempt?: number;
      } = {},
    ) => {
      const { retryForNewPosition = false, attempt = 0 } = options;
      const generation = requestGeneration;

      try {
        const positions = await getPositions();

        if (disposed || generation !== requestGeneration) return;

        if (positions.length > 0) {
          clearRetryTimer();
          setIsOrdersOpen(true);
          return;
        }

        // A market-order execution event can arrive before the backend's
        // position snapshot reflects the newly opened position. Retry for a
        // short window instead of treating that first empty response as final.
        const MAX_POSITION_OPEN_ATTEMPTS = 12;
        const POSITION_OPEN_RETRY_MS = 250;

        if (
          retryForNewPosition &&
          attempt < MAX_POSITION_OPEN_ATTEMPTS - 1
        ) {
          clearRetryTimer();
          retryTimer = window.setTimeout(() => {
            retryTimer = null;
            void syncOrdersPanelVisibility({
              retryForNewPosition: true,
              attempt: attempt + 1,
            });
          }, POSITION_OPEN_RETRY_MS);
          return;
        }

        if (allOpenOrdersApi.orders.length === 0) {
          setIsOrdersOpen(false);
        }
      } catch {
        // The positions panel itself displays API errors when opened manually.
      }
    };

    void syncOrdersPanelVisibility();

    const handleAccountStateChanged = () => {
      requestGeneration += 1;
      clearRetryTimer();
      void syncOrdersPanelVisibility({
        retryForNewPosition: true,
        attempt: 0,
      });
    };

    window.addEventListener(
      "account-state-changed",
      handleAccountStateChanged,
    );

    return () => {
      disposed = true;
      requestGeneration += 1;
      clearRetryTimer();
      window.removeEventListener(
        "account-state-changed",
        handleAccountStateChanged,
      );
    };
  }, [allOpenOrdersApi.orders.length]);

  const drawingCanvas = useDrawingCanvas(
    refs,
    coord,
    drawingsApi,
    marketData,
    tradeMenuApi,
    isHotkeysOpen,
    setIsHotkeysOpen,
    // FIX: visibility is handled inside the shared canvas so trading order
    // lines remain visible even when the user hides regular drawings.
    showDrawings,
  );

  useHotkeys(refs, drawingsApi, priceAlertsApi, tradeMenuApi, chartTabs);

  const chartTimeZoneLabel = getLocalZoneLabel();

  return (
    <div
      className="app"
      style={{
        "--settings-panel-width": `${settingsPanelWidth}px`,
        "--positions-panel-height": `${positionsPanelHeight}px`,
      } as CSSProperties}
      onClick={() => {
        drawingsApi.setContextMenu(null);
        setIsHotkeysOpen(false);
        tradeMenuApi.closeTradeMenu();
      }}
    >
      <Topbar
        symbol={currentSymbol}
        availableSymbols={availableSymbols}
        onChangeSymbol={chartTabs.openTab}
        onSymbolRegistryChanged={syncSymbolRegistry}
        onSymbolDeleted={removeDeletedSymbolTab}
        interval={marketData.interval}
        onChangeInterval={marketData.changeInterval}
        onZoomIn={marketData.zoomIn}
        onZoomOut={marketData.zoomOut}
        isSettingsOpen={isSettingsOpen}
        onToggleSettings={() => setIsSettingsOpen((open) => !open)}
        isOrdersOpen={isOrdersOpen}
        onToggleOrders={() => setIsOrdersOpen((open) => !open)}
        backendConnection={backendConnection}
        onRetryBackend={
          desktopCredentials.isDesktop
            ? () => {
                void restartDesktopBackend().catch((error: unknown) => {
                  console.error("[backend] manual restart failed", error);
                });
              }
            : undefined
        }
        websocketConnection={websocketConnection}
        marketConnection={marketData.marketConnection}
      />

      <ChartTabs
        tabs={chartTabs.tabs}
        activeSymbol={currentSymbol}
        availableToOpen={chartTabs.closedSymbols}
        onActivate={chartTabs.activateTab}
        onOpen={chartTabs.openTab}
        onClose={chartTabs.closeTab}
        onCloseOthers={chartTabs.closeOtherTabs}
        onDeleteTracked={deleteTrackedSymbolFromTab}
        onReorder={chartTabs.reorderTab}
      />

      {/*
        Gated on having heard back from the registry at least once
        (success or failure) - otherwise this could flash on for a
        perfectly valid symbol in the instant before the very first sync
        resolves, since getSymbolConfig() can't tell "not checked yet"
        from "checked, not found" on its own.
      */}
      {(symbolRegistryReady || symbolRegistryError) && isSymbolUnconfirmed(currentSymbol) && (
        <UnregisteredSymbolBanner symbol={currentSymbol} onRegistered={syncSymbolRegistry} />
      )}

      <div className={`app-main ${isSettingsOpen ? "settings-open" : ""}`}>
        <div className="workspace">
          <DrawingToolbar
            tool={drawingsApi.tool}
            onSetTool={drawingsApi.setTool}
            onUndo={drawingsApi.undo}
            onRedo={drawingsApi.redo}
            isHotkeysOpen={isHotkeysOpen}
            onToggleHotkeys={() => {
              drawingsApi.setContextMenu(null);
              setIsHotkeysOpen((open) => !open);
            }}
            onCollapseToolbar={() => setIsToolbarCollapsed(true)}
            isCollapsed={isToolbarCollapsed}
          />

        {/* FEATURE: wire the chart TP-size editor from the canvas interaction hook
            into ChartPanel so existing reduce orders can be resized in place. */}
        <ChartPanel
          symbol={currentSymbol}
          chartWrapRef={refs.chartWrapRef}
          containerRef={refs.containerRef}
          canvasRef={refs.canvasRef}
          chartRef={refs.chartRef}
          candleRef={refs.candleRef}
          futureScaleRef={refs.futureScaleRef}
          lastDataTimeRef={refs.lastDataTimeRef}
          currentPriceRef={refs.currentPriceRef}
          liveMarketPriceRef={refs.liveMarketPriceRef}
          temporaryTradePrice={tradeMenuApi.tradeMenu?.selectedPrice ?? null}
          pricePrecision={marketData.pricePrecision}
          fullTakeProfitPrice={fullTakeProfitPrice}
          fullTakeProfitOrderId={fullTakeProfitOrderId}
          coordTimeToX={coord.timeToX}
          highlightedOrderIdRef={refs.highlightedOrderIdRef}
          highlightedOrderUntilRef={refs.highlightedOrderUntilRef}
          highlightedPositionUntilRef={refs.highlightedPositionUntilRef}
          highlightedPositionKeyRef={refs.highlightedPositionKeyRef}
          tradeMarkersRef={refs.tradeMarkersRef}
          onPositionClosed={handlePositionClosed}
          onOpenAlertSymbol={chartTabs.openTab}
          showDrawings={showDrawings}
          showAsiaSession={showAsiaSession}
          showLondonSession={showLondonSession}
          showNewYorkSession={showNewYorkSession}
          showNewYorkKillZone={showNewYorkKillZone}
          showStartOfDay={showStartOfDay}
          startOfDayLookbackDays={startOfDayLookbackDays}
          hoveredDrawingInfo={drawingCanvas.hoveredDrawingInfo}
          reduceOrderEditor={drawingCanvas.reduceOrderEditor}
          onReduceOrderEditorPctChange={drawingCanvas.setReduceOrderEditorPct}
          onSubmitReduceOrderEditor={drawingCanvas.submitReduceOrderEditor}
          onCloseReduceOrderEditor={drawingCanvas.closeReduceOrderEditor}
          editingText={drawingCanvas.editingText}
          onEditingTextChange={drawingCanvas.setEditingTextValue}
          onCommitTextEditing={drawingCanvas.commitTextEditing}
          onCancelTextEditing={drawingCanvas.cancelTextEditing}
          alerts={priceAlertsApi.alerts}
          showAlerts={showPriceAlerts}
          onRemoveAlert={priceAlertsApi.removeAlert}
          onUpdateAlertPrice={priceAlertsApi.updateAlertPrice}
          onToggleAlertSide={priceAlertsApi.toggleAlertSide}
          onSetAlertPattern={priceAlertsApi.setAlertPattern}
          onSetAlertAdditionalInfo={priceAlertsApi.setAlertAdditionalInfo}
          onToggleAlertLocked={priceAlertsApi.toggleAlertLocked}
          onToggleAlertHidden={priceAlertsApi.toggleAlertHidden}
          autoMarketDraft={tradeMenuApi.autoMarketDraft}
          isSubmittingAutoMarket={
            tradeMenuApi.pendingTradeAction === "AUTO_MARKET_BUY" ||
            tradeMenuApi.pendingTradeAction === "AUTO_MARKET_SELL"
          }
          onAutoMarketStopLossChange={tradeMenuApi.updateAutoMarketStopLoss}
          onSubmitAutoMarket={tradeMenuApi.submitAutoMarket}
          onCancelAutoMarket={tradeMenuApi.cancelAutoMarket}
          tradeToast={tradeMenuApi.tradeToast}
          onSetTradeToast={tradeMenuApi.setTradeToast}
          tool={drawingsApi.tool}
          isHoveringDrawing={drawingCanvas.isHoveringDrawing}
          isHoveringHorizontalDrawing={drawingCanvas.isHoveringHorizontalDrawing}
          isChartLoading={marketData.isChartLoading}
          marketDataError={marketData.marketDataError}
          onRetryMarketData={marketData.retryMarketData}
          interval={marketData.interval}
          chartTimeZoneLabel={chartTimeZoneLabel}
          cancelTooltip={drawingCanvas.cancelTooltip}
          chaseTooltip={drawingCanvas.chaseTooltip}
          estimatedLiquidationTooltip={drawingCanvas.estimatedLiquidationTooltip}
          positionPnl={showPositionPnl ? positionPnl?.unrealizedPnl ?? null : null}
          positionRealizedPnl={showPositionPnl ? positionPnl?.realizedPnl ?? null : null}
          totalPnl={showTotalPnl ? totalPnl : null}
          showCandleCountdown={showCandleCountdown}
          showWatermark={showWatermark}
          showDrawingSetBadge={showDrawingSetBadge}
          activeDrawingSetName={
            drawingsApi.drawingSets.find(
              (set) => set.id === drawingsApi.activeDrawingSetId,
            )?.name ?? "New / unsaved"
          }
          isDrawingSetUnsaved={drawingsApi.activeDrawingSetId === null}
          canSaveDrawingSet={drawingsApi.regularDrawingsCount > 0}
          onSaveDrawingSet={drawingsApi.saveCurrentDrawingSet}
          isToolbarCollapsed={isToolbarCollapsed}
          onShowToolbar={() => setIsToolbarCollapsed(false)}
          onPointerDownCapture={drawingCanvas.handlePointerDownCapture}
          onPointerMoveCapture={drawingCanvas.handlePointerMoveCapture}
          onPointerUpCapture={drawingCanvas.handlePointerUpCapture}
          onPointerLeave={drawingCanvas.handlePointerLeave}
          onContextMenuCapture={drawingCanvas.handleContextMenuCapture}
          onDoubleClick={drawingCanvas.handleChartDoubleClick}
          onMobileDoubleTap={drawingCanvas.handleChartDoubleTap}
        />
        </div>

        <SettingsPanel
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          width={settingsPanelWidth}
          onWidthChange={handleSettingsPanelWidthChange}
          backendConnection={backendConnection}
          diagnostics={diagnostics}
          currentSymbol={currentSymbol}
          availableSymbols={availableSymbols}
          activePriceAlerts={priceAlertsApi.alerts}
          regularDrawingsCount={drawingsApi.regularDrawingsCount}
          drawingSets={drawingsApi.drawingSets}
          activeDrawingSetId={drawingsApi.activeDrawingSetId}
          onSaveCurrentDrawingSet={drawingsApi.saveCurrentDrawingSet}
          onLoadDrawingSet={drawingsApi.loadDrawingSet}
          onRenameDrawingSet={drawingsApi.renameDrawingSet}
          onDeleteDrawingSet={drawingsApi.deleteDrawingSet}
          onClearCurrentDrawings={drawingsApi.deleteAllDrawings}
          showDrawings={showDrawings}
          onShowDrawingsChange={setShowDrawings}
          showAsiaSession={showAsiaSession}
          onShowAsiaSessionChange={(enabled) =>
            setBooleanPreference(setShowAsiaSessionState, ASIA_SESSION_STORAGE_KEY, enabled)
          }
          showLondonSession={showLondonSession}
          onShowLondonSessionChange={(enabled) =>
            setBooleanPreference(setShowLondonSessionState, LONDON_SESSION_STORAGE_KEY, enabled)
          }
          showNewYorkSession={showNewYorkSession}
          onShowNewYorkSessionChange={(enabled) =>
            setBooleanPreference(setShowNewYorkSessionState, NEW_YORK_SESSION_STORAGE_KEY, enabled)
          }
          showNewYorkKillZone={showNewYorkKillZone}
          onShowNewYorkKillZoneChange={(enabled) =>
            setBooleanPreference(setShowNewYorkKillZoneState, NEW_YORK_KILL_ZONE_STORAGE_KEY, enabled)
          }
          showPositionPnl={showPositionPnl}
          onShowPositionPnlChange={setShowPositionPnl}
          showTotalPnl={showTotalPnl}
          onShowTotalPnlChange={setShowTotalPnl}
          showCandleCountdown={showCandleCountdown}
          onShowCandleCountdownChange={setShowCandleCountdown}
          showWatermark={showWatermark}
          onShowWatermarkChange={setShowWatermark}
          showDrawingSetBadge={showDrawingSetBadge}
          onShowDrawingSetBadgeChange={setShowDrawingSetBadge}
          showStartOfDay={showStartOfDay}
          onShowStartOfDayChange={setShowStartOfDay}
          startOfDayLookbackDays={startOfDayLookbackDays}
          onStartOfDayLookbackDaysChange={setStartOfDayLookbackDays}
          showPriceAlerts={showPriceAlerts}
          onShowPriceAlertsChange={setShowPriceAlerts}
          persistentAlertsEnabled={persistentAlertsEnabled}
          onPersistentAlertsEnabledChange={setPersistentAlertsEnabled}
        />

        <div className={`bottom-dock ${isOrdersOpen ? "open" : ""}`}>
          <PositionsPanel
            isOpen={isOrdersOpen}
            onClose={() => setIsOrdersOpen(false)}
            height={positionsPanelHeight}
            onHeightChange={handlePositionsPanelHeightChange}
            activeSymbol={currentSymbol}
            onPositionClosed={handlePositionClosed}
            openOrdersApi={allOpenOrdersApi}
            focusedOrderId={focusedOrderId}
            onFocusOrder={focusOrderLine}
            focusedPositionKey={focusedPositionKey}
            onFocusPosition={focusPosition}
            onSwitchSymbol={switchToPositionSymbol}
            protection={{
              symbol: currentSymbol,
              fullTakeProfitPrice,
              stopLossPrice,
            }}
          />
        </div>
      </div>


      {isHotkeysOpen && (
        <HotkeysPopup onClose={() => setIsHotkeysOpen(false)} />
      )}

      {tradeMenuApi.tradeMenu && (
        <TradeMenu
          symbol={currentSymbol}
          pricePrecision={marketData.pricePrecision}
          tradeMenu={tradeMenuApi.tradeMenu}
          isSubmittingTrade={tradeMenuApi.isSubmittingTrade}
          pendingTradeAction={tradeMenuApi.pendingTradeAction}
          availableBalance={tradeMenuApi.availableBalance}
          marginPct={tradeMenuApi.marginPct}
          isLoadingBalance={tradeMenuApi.isLoadingBalance}
          balanceError={tradeMenuApi.balanceError}
          positionSide={tradeMenuApi.positionSide}
          positionQuantity={tradeMenuApi.positionQuantity}
          reservedReduceQuantity={tradeMenuApi.reservedReduceQuantity}
          isLoadingPosition={tradeMenuApi.isLoadingPosition}
          reducePct={tradeMenuApi.reducePct}
          onReducePctChange={tradeMenuApi.setReducePct}
          onClose={tradeMenuApi.closeTradeMenu}
          onSubmit={tradeMenuApi.submitTrade}
          onAutoMarket={tradeMenuApi.beginAutoMarket}
          onAdd={tradeMenuApi.submitAdd}
          onReduce={tradeMenuApi.submitReduce}
          onReverse={tradeMenuApi.submitReverse}
          backendConnection={backendConnection}
          leverage={tradeMenuApi.leverage}
          maxLeverage={tradeMenuApi.maxLeverage}
          isUpdatingLeverage={tradeMenuApi.isUpdatingLeverage}
          leverageError={tradeMenuApi.leverageError}
          onLeverageChange={tradeMenuApi.changeLeverage}
          onLeverageCommit={tradeMenuApi.commitLeverage}
        />
      )}

      {drawingsApi.contextMenu && (
        <ContextMenu
          contextMenu={drawingsApi.contextMenu}
          hasPenDrawings={drawingsApi.drawings.some(
            (drawing) => drawing.type === "pen",
          )}
          hasDrawings={drawingsApi.drawings.some(
            (drawing) => !(drawing.type === "horizontal" && drawing.orderSide),
          )}
          hasTradeMarkers={tradeMarkersApi.markers.length > 0}
          drawingCountsByTimeframe={drawingsApi.drawingCountsByTimeframe}
          targetDrawing={
            drawingsApi.contextMenu.drawingId
              ? (drawingsApi.drawings.find(
                  (drawing) => drawing.id === drawingsApi.contextMenu!.drawingId,
                ) ?? null)
              : null
          }
          onDeleteDrawing={drawingsApi.deleteDrawing}
          onChangeColor={drawingsApi.changeDrawingColor}
          onChangeAlign={drawingsApi.changeTextAlign}
          onStraightenOnXAxis={drawingsApi.straightenTrendOnXAxis}
          onStraightenSelectionOnXAxis={drawingsApi.straightenTrendsOnXAxis}
          onResetView={drawingsApi.resetChartView}
          onDeleteAllPen={drawingsApi.deleteAllPenDrawings}
          onDeleteAllDrawings={drawingsApi.deleteAllDrawings}
          onDeleteDrawingsByTimeframe={drawingsApi.deleteDrawingsByTimeframe}
          onDeleteAllTradeMarkers={tradeMarkersApi.clearMarkers}
          onCreateAlert={priceAlertsApi.addAlert}
          onCreateCoordinateMarker={(time, price) =>
            drawingsApi.addDrawing({
              id: crypto.randomUUID(),
              type: "coordinate-marker",
              time: time as UTCTimestamp,
              price,
              color: "#f5a623",
            })
          }
          onClose={() => drawingsApi.setContextMenu(null)}
        />
      )}

      {diagnostics.notice && (
        <SystemNotice
          notice={diagnostics.notice}
          onDismiss={diagnostics.dismissNotice}
        />
      )}
    </div>
  );
}

export default App;
