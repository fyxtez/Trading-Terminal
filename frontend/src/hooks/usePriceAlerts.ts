import { useEffect, useRef, useState } from "react";
import { priceAlertsStorageKey } from "../config/constants";
import {
  loadStoredAlerts,
  saveAlerts,
  sendPriceAlertNotification,
} from "../utils/alerts";
import {
  cancelPersistentPriceAlert,
  createPersistentPriceAlert,
  listPersistentPriceAlerts,
  updatePersistentPriceAlert,
} from "../trading/api/priceAlerts";
import type { AlertHistoryAction, AlertPattern, PriceAlert } from "../types/alert";
import type { ChartRefs } from "./useChartRefs";

/**
 * Same per-symbol-scoping shape as useDrawings.ts's SymbolDrawingsState -
 * alerts are persisted under a per-symbol storage key, so switching from
 * BTC to SOL shows SOL's own alerts instead of continuing to show/persist
 * BTC's.
 */
type SymbolAlertsState = {
  symbol: string;
  alerts: PriceAlert[];
};

const normalizeSymbol = (symbol: string) => symbol.toUpperCase();

/**
 * Owns the list of price alerts for the active symbol, and watches the
 * live market price stream for one crossing an alert's level.
 *
 * `persistentAlertsEnabled` (the "Use persistent alerts" setting - see
 * SettingsPanel.tsx) controls WHO is responsible for actually notifying
 * the user once that happens:
 *
 * - OFF (default): this hook is the one firing the ntfy.sh notification
 *   itself (see utils/alerts.ts) the moment a crossing is detected -
 *   this only works while this browser tab is open and connected.
 * - ON: the backend owns price detection, deletion, and notification.
 *   The chart waits for the backend's ALERT_TRIGGERED event before
 *   removing the line, keeping browser and SQLite state authoritative
 *   and preventing the frontend from appearing to trigger earlier.
 *
 * `refs` (the same shared bag used by useDrawings.ts/useDrawingCanvas.ts)
 * is where this hook's undo/redo stacks and its shared `seq` counter
 * with drawings live (refs.alertUndoRef/alertRedoRef/historySeqRef) -
 * see the long comment on HistoryAction in types/drawing.ts for why
 * that counter is shared rather than each system having its own.
 */
export function usePriceAlerts(
  refs: ChartRefs,
  symbol: string,
  lastPrice: number | null,
  persistentAlertsEnabled: boolean,
) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const [state, setState] = useState<SymbolAlertsState>(() => ({
    symbol: normalizedSymbol,
    alerts: loadStoredAlerts(priceAlertsStorageKey(normalizedSymbol)),
  }));
  const isHydrated = state.symbol === normalizedSymbol;
  const alerts = isHydrated ? state.alerts : [];

  /*
   * Mirrors the current alert list into a ref so the price-watching
   * effect below can always read the latest alerts without needing to
   * re-run every time the list itself changes (it only needs to re-run
   * when the PRICE changes) - same reasoning as refs.drawingsRef in
   * useChartRefs.ts/useDrawings.ts.
   */
  const alertsRef = useRef<PriceAlert[]>(alerts);
  useEffect(() => {
    alertsRef.current = alerts;
  }, [alerts]);

  /*
   * Same reasoning as alertsRef above, but for the persistent-alerts
   * toggle itself: the price-watching effect's dependency array is
   * intentionally just [lastPrice, normalizedSymbol] (see below), so a
   * mid-session flip of this setting needs a ref to be seen immediately
   * rather than only on the next price tick after the effect happens to
   * re-run for some other reason.
   */
  const persistentAlertsEnabledRef = useRef(persistentAlertsEnabled);
  useEffect(() => {
    persistentAlertsEnabledRef.current = persistentAlertsEnabled;
  }, [persistentAlertsEnabled]);

  // The previous tick's price, used to detect which direction (if any)
  // the price just crossed an alert's level from.
  const previousPriceRef = useRef<number | null>(null);
  const previousPriceSymbolRef = useRef<string | null>(null);

  /**
   * Stamps an action with the shared seq counter and pushes it onto
   * this hook's own undo stack, clearing redo - same shape as
   * useDrawings.ts's pushHistory, deliberately kept in lockstep with it
   * (shared counter, same push/clear-redo behavior) so Ctrl+Z/Ctrl+Y in
   * useHotkeys.ts can treat both stacks as one combined, correctly
   * ordered history.
   */
  const pushAlertHistory = (
    action:
      | { type: "add"; alert: PriceAlert }
      | { type: "delete"; alert: PriceAlert }
      | { type: "update"; before: PriceAlert; after: PriceAlert },
  ) => {
    refs.historySeqRef.current += 1;
    refs.alertUndoRef.current.push({
      ...action,
      seq: refs.historySeqRef.current,
    } as AlertHistoryAction);
    refs.alertRedoRef.current = [];
  };

  const addAlert = (price: number) => {
    // Automatic LONG/SHORT guess: a price below the current market is
    // read as "waiting to go long from here", above as "waiting to go
    // short from here" - the same directional assumption a trader
    // placing a limit order at that level would usually have. Falls
    // back to LONG when there's no live price to compare against yet.
    // The default pattern mirrors the same comparison - a price below
    // market defaults to "support", above to "resistance" - since
    // that's the most common reason to place a level there in the
    // first place. Both remain freely overridable afterwards.
    const isAbove = lastPrice !== null && price > lastPrice;
    const side: PriceAlert["side"] = isAbove ? "SHORT" : "LONG";
    const pattern: AlertPattern = isAbove ? "resistance" : "support";

    const alert: PriceAlert = {
      id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      price,
      createdAt: Date.now(),
      side,
      pattern,
      additionalInfo: "",
      locked: true,
      hidden: true,
    };

    setState((previous) => {
      const nextAlerts = [...previous.alerts, alert];
      saveAlerts(priceAlertsStorageKey(normalizedSymbol), nextAlerts);
      return { symbol: normalizedSymbol, alerts: nextAlerts };
    });

    pushAlertHistory({ type: "add", alert });

    if (persistentAlertsEnabled) {
      void createPersistentPriceAlert(normalizedSymbol, alert)
        .then((created) => {
          setState((previous) => {
            const nextAlerts = previous.alerts.map((item) =>
              item.id === alert.id ? created : item,
            );
            saveAlerts(priceAlertsStorageKey(normalizedSymbol), nextAlerts);
            return { symbol: normalizedSymbol, alerts: nextAlerts };
          });
        })
        .catch((error) => console.error("Failed to persist price alert", error));
    }
  };

  const removeAlert = (id: string) => {
    const removed = alertsRef.current.find((alert) => alert.id === id);

    setState((previous) => {
      const nextAlerts = previous.alerts.filter((alert) => alert.id !== id);
      saveAlerts(priceAlertsStorageKey(normalizedSymbol), nextAlerts);
      return { symbol: normalizedSymbol, alerts: nextAlerts };
    });

    if (removed) {
      pushAlertHistory({ type: "delete", alert: removed });
    }

    if (persistentAlertsEnabled) {
      void cancelPersistentPriceAlert(id).catch((error) =>
        console.error("Failed to delete persistent price alert", error),
      );
    }
  };

  /**
   * Called when the user drags an alert line to a new price on the
   * chart (see AlertLinesOverlay.tsx) - the same "click, move, click"
   * interaction TP/SL placement already uses (see
   * PositionBracketOverlay.tsx's beginDrag/finishDrag).
   */
  const updateAlertPrice = (id: string, price: number) => {
    const before = alertsRef.current.find((alert) => alert.id === id);
    if (!before) return;

    const after: PriceAlert = { ...before, price };

    setState((previous) => {
      const nextAlerts = previous.alerts.map((alert) =>
        alert.id === id ? after : alert,
      );
      saveAlerts(priceAlertsStorageKey(normalizedSymbol), nextAlerts);
      return { symbol: normalizedSymbol, alerts: nextAlerts };
    });

    pushAlertHistory({ type: "update", before, after });
    if (persistentAlertsEnabledRef.current) {
      void updatePersistentPriceAlert(after).catch((error) =>
        console.error("Failed to update persistent price alert", error),
      );
    }
  };

  /**
   * Flips an alert's LONG/SHORT setup label - see the LONG/SHORT button
   * on AlertLinesOverlay.tsx. Purely a label; it never changes the
   * alert's price or firing behavior.
   */
  const toggleAlertSide = (id: string) => {
    const before = alertsRef.current.find((alert) => alert.id === id);
    if (!before) return;

    const after: PriceAlert = {
      ...before,
      side: before.side === "LONG" ? "SHORT" : "LONG",
    };

    setState((previous) => {
      const nextAlerts = previous.alerts.map((alert) =>
        alert.id === id ? after : alert,
      );
      saveAlerts(priceAlertsStorageKey(normalizedSymbol), nextAlerts);
      return { symbol: normalizedSymbol, alerts: nextAlerts };
    });

    pushAlertHistory({ type: "update", before, after });
    if (persistentAlertsEnabledRef.current) {
      void updatePersistentPriceAlert(after).catch((error) =>
        console.error("Failed to update persistent price alert", error),
      );
    }
  };

  /**
   * Sets an alert's price-action pattern label (breakout, support,
   * etc.) - see the pattern button/popover on AlertLinesOverlay.tsx.
   * Purely a label, same as toggleAlertSide above; it never changes the
   * alert's price or firing behavior, and is never sent to the backend
   * even when persistent alerts are on (there's nothing there yet to
   * receive an update to an already-created alert).
   */
  const setAlertPattern = (id: string, pattern: AlertPattern) => {
    const before = alertsRef.current.find((alert) => alert.id === id);
    if (!before) return;

    const after: PriceAlert = { ...before, pattern };

    setState((previous) => {
      const nextAlerts = previous.alerts.map((alert) =>
        alert.id === id ? after : alert,
      );
      saveAlerts(priceAlertsStorageKey(normalizedSymbol), nextAlerts);
      return { symbol: normalizedSymbol, alerts: nextAlerts };
    });

    pushAlertHistory({ type: "update", before, after });
    if (persistentAlertsEnabledRef.current) {
      void updatePersistentPriceAlert(after).catch((error) =>
        console.error("Failed to update persistent price alert", error),
      );
    }
  };

  /**
   * FEATURE: saves free-form alert context locally and, in persistent mode,
   * updates SQLite so the backend-owned notification can append it later.
   */
  const setAlertAdditionalInfo = (id: string, additionalInfo: string) => {
    const before = alertsRef.current.find((alert) => alert.id === id);
    if (!before) return;

    const after: PriceAlert = { ...before, additionalInfo: additionalInfo.trim() };
    if (after.additionalInfo === before.additionalInfo) return;

    setState((previous) => {
      const nextAlerts = previous.alerts.map((alert) =>
        alert.id === id ? after : alert,
      );
      saveAlerts(priceAlertsStorageKey(normalizedSymbol), nextAlerts);
      return { symbol: normalizedSymbol, alerts: nextAlerts };
    });
    pushAlertHistory({ type: "update", before, after });
    if (persistentAlertsEnabledRef.current) {
      void updatePersistentPriceAlert(after).catch((error) =>
        console.error("Failed to update persistent price alert", error),
      );
    }
  };

  const toggleAlertLocked = (id: string) => {
    const before = alertsRef.current.find((alert) => alert.id === id);
    if (!before) return;

    // FEATURE: unlocking also restores full opacity so controls never become
    // available on a still-dimmed line that the user must restore separately.
    const after: PriceAlert = {
      ...before,
      locked: !before.locked,
      hidden: before.locked ? false : before.hidden,
    };
    setState((previous) => {
      const nextAlerts = previous.alerts.map((alert) =>
        alert.id === id ? after : alert,
      );
      saveAlerts(priceAlertsStorageKey(normalizedSymbol), nextAlerts);
      return { symbol: normalizedSymbol, alerts: nextAlerts };
    });
    pushAlertHistory({ type: "update", before, after });
  };

  const toggleAlertHidden = (id: string) => {
    const before = alertsRef.current.find((alert) => alert.id === id);
    if (!before || before.locked) return;

    const after: PriceAlert = { ...before, hidden: !before.hidden };
    setState((previous) => {
      const nextAlerts = previous.alerts.map((alert) =>
        alert.id === id ? after : alert,
      );
      saveAlerts(priceAlertsStorageKey(normalizedSymbol), nextAlerts);
      return { symbol: normalizedSymbol, alerts: nextAlerts };
    });
    pushAlertHistory({ type: "update", before, after });
  };

  const reverseAlertAction = (action: AlertHistoryAction) => {
    if (action.type === "add") {
      setState((previous) => {
        const nextAlerts = previous.alerts.filter(
          (alert) => alert.id !== action.alert.id,
        );
        saveAlerts(priceAlertsStorageKey(normalizedSymbol), nextAlerts);
        return { symbol: normalizedSymbol, alerts: nextAlerts };
      });
      return;
    }

    if (action.type === "delete") {
      setState((previous) => {
        const nextAlerts = [...previous.alerts, action.alert];
        saveAlerts(priceAlertsStorageKey(normalizedSymbol), nextAlerts);
        return { symbol: normalizedSymbol, alerts: nextAlerts };
      });
      return;
    }

    setState((previous) => {
      const nextAlerts = previous.alerts.map((alert) =>
        alert.id === action.before.id ? action.before : alert,
      );
      saveAlerts(priceAlertsStorageKey(normalizedSymbol), nextAlerts);
      return { symbol: normalizedSymbol, alerts: nextAlerts };
    });
  };

  const applyAlertAction = (action: AlertHistoryAction) => {
    if (action.type === "add") {
      setState((previous) => {
        const nextAlerts = [...previous.alerts, action.alert];
        saveAlerts(priceAlertsStorageKey(normalizedSymbol), nextAlerts);
        return { symbol: normalizedSymbol, alerts: nextAlerts };
      });
      return;
    }

    if (action.type === "delete") {
      setState((previous) => {
        const nextAlerts = previous.alerts.filter(
          (alert) => alert.id !== action.alert.id,
        );
        saveAlerts(priceAlertsStorageKey(normalizedSymbol), nextAlerts);
        return { symbol: normalizedSymbol, alerts: nextAlerts };
      });
      return;
    }

    setState((previous) => {
      const nextAlerts = previous.alerts.map((alert) =>
        alert.id === action.after.id ? action.after : alert,
      );
      saveAlerts(priceAlertsStorageKey(normalizedSymbol), nextAlerts);
      return { symbol: normalizedSymbol, alerts: nextAlerts };
    });
  };

  /**
   * Undoes this hook's own most recent action. Ctrl+Z (useHotkeys.ts)
   * only calls this when comparing refs.alertUndoRef's top `seq`
   * against refs.undoRef's (drawings') top `seq` says this one is more
   * recent - see the long comment on HistoryAction in
   * types/drawing.ts for why that comparison is correct.
   */
  const undo = () => {
    const action = refs.alertUndoRef.current.pop();
    if (!action) return;

    reverseAlertAction(action);
    refs.alertRedoRef.current.push(action);
  };

  /** Redo counterpart to undo() above - see the same useHotkeys.ts routing. */
  const redo = () => {
    const action = refs.alertRedoRef.current.pop();
    if (!action) return;

    applyAlertAction(action);
    refs.alertUndoRef.current.push(action);
  };

  // Reload from storage whenever the active symbol changes - same
  // reasoning as the matching effect in useDrawings.ts. Also clears
  // this symbol-scoped undo/redo history, since it refers to alerts
  // that belonged to whichever symbol was active before.
  useEffect(() => {
    const next = loadStoredAlerts(priceAlertsStorageKey(normalizedSymbol));
    setState({ symbol: normalizedSymbol, alerts: next });
    previousPriceRef.current = null;
    previousPriceSymbolRef.current = null;
    refs.alertUndoRef.current = [];
    refs.alertRedoRef.current = [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalizedSymbol]);

  // When persistent mode is enabled, restore backend alerts and hand any
  // local-only alerts to the backend. Backend-generated UUIDs replace the
  // temporary browser IDs so later PUT/DELETE requests target the right row.
  useEffect(() => {
    if (!persistentAlertsEnabled || !isHydrated) return;
    let cancelled = false;

    const sync = async () => {
      try {
        const remote = await listPersistentPriceAlerts(normalizedSymbol);
        const remoteIds = new Set(remote.map((alert) => alert.id));
        const localOnly = alertsRef.current.filter(
          (alert) => alert.id.startsWith("alert-") && !remoteIds.has(alert.id),
        );
        const created = await Promise.all(
          localOnly.map((alert) =>
            createPersistentPriceAlert(normalizedSymbol, alert),
          ),
        );
        if (cancelled) return;
        const localById = new Map(
          alertsRef.current.map((alert) => [alert.id, alert]),
        );
        const nextAlerts = [...remote, ...created].map((alert) => {
          const local = localById.get(alert.id);
          return local
            ? { ...alert, locked: local.locked, hidden: local.hidden }
            : alert;
        });
        setState({ symbol: normalizedSymbol, alerts: nextAlerts });
        saveAlerts(priceAlertsStorageKey(normalizedSymbol), nextAlerts);
      } catch (error) {
        console.error("Failed to synchronize persistent price alerts", error);
      }
    };

    void sync();
    return () => {
      cancelled = true;
    };
  }, [persistentAlertsEnabled, normalizedSymbol, isHydrated]);

  // Persistent alerts are removed only when the backend confirms the
  // trigger through the trading WebSocket.
  useEffect(() => {
    const handleTriggeredAlert = (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<{ id: string; symbol: string }>;
      if (normalizeSymbol(event.detail.symbol) !== normalizedSymbol) return;

      setState((previous) => {
        if (previous.symbol !== normalizedSymbol) return previous;
        const nextAlerts = previous.alerts.filter(
          (alert) => alert.id !== event.detail.id,
        );
        if (nextAlerts.length === previous.alerts.length) return previous;
        saveAlerts(priceAlertsStorageKey(normalizedSymbol), nextAlerts);
        return { symbol: normalizedSymbol, alerts: nextAlerts };
      });
    };

    window.addEventListener(
      "persistent-price-alert-triggered",
      handleTriggeredAlert,
    );
    return () => {
      window.removeEventListener(
        "persistent-price-alert-triggered",
        handleTriggeredAlert,
      );
    };
  }, [normalizedSymbol]);

  // Watches every incoming price tick for a crossing of any alert's
  // level, in either direction, and removes each one that fired -
  // additionally firing the ntfy notification itself, but only when
  // persistent alerts are OFF (see the comment on the hook above).
  //
  // Deliberately does NOT push undo history for this removal - it's
  // the alert doing its job (the price was reached), not a user
  // mistake to offer "undo" for; only the direct user actions above
  // (create, drag, remove, flip side, set pattern) are undoable.
  useEffect(() => {
    if (lastPrice === null || persistentAlertsEnabledRef.current) return;

    // FIX: `lastPrice` is React state owned by useMarketData and can survive for
    // one render while a symbol switch is in progress. Without symbol-tagging
    // the crossing baseline, opening TRX after NVDA could compare NVDA's last
    // price (e.g. 218) with TRX's first tick (e.g. 0.34) and falsely fire every
    // TRX alert crossed by that artificial 218 -> 0.34 jump. A newly selected
    // symbol therefore gets its own fresh baseline before crossings are allowed.
    if (previousPriceSymbolRef.current !== normalizedSymbol) {
      previousPriceSymbolRef.current = normalizedSymbol;
      previousPriceRef.current = null;
      return;
    }

    const previousPrice = previousPriceRef.current;
    previousPriceRef.current = lastPrice;

    // Nothing to compare against yet (first tick since mount/symbol
    // change) - never treat that as a crossing.
    if (previousPrice === null) return;

    const currentAlerts = alertsRef.current;
    if (currentAlerts.length === 0) return;

    const triggered = currentAlerts.filter((alert) => {
      const crossedUpward =
        previousPrice < alert.price && lastPrice >= alert.price;
      const crossedDownward =
        previousPrice > alert.price && lastPrice <= alert.price;
      return crossedUpward || crossedDownward;
    });

    if (triggered.length === 0) return;

    const triggeredIds = new Set(triggered.map((alert) => alert.id));
    setState((previous) => {
      const nextAlerts = previous.alerts.filter(
        (alert) => !triggeredIds.has(alert.id),
      );
      saveAlerts(priceAlertsStorageKey(normalizedSymbol), nextAlerts);
      return { symbol: normalizedSymbol, alerts: nextAlerts };
    });

    for (const alert of triggered) {
      void sendPriceAlertNotification(
        normalizedSymbol,
        lastPrice,
        alert.side,
        alert.pattern,
        alert.additionalInfo,
      );
    }
  }, [lastPrice, normalizedSymbol]);

  return {
    alerts,
    addAlert,
    removeAlert,
    updateAlertPrice,
    toggleAlertSide,
    setAlertPattern,
    setAlertAdditionalInfo,
    toggleAlertLocked,
    toggleAlertHidden,
    undo,
    redo,
  };
}

export type PriceAlertsApi = ReturnType<typeof usePriceAlerts>;
