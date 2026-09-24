import { useEffect, useRef, useState } from "react";
import { priceAlertsStorageKey } from "../config/constants";
import { loadStoredAlerts, saveAlerts } from "../utils/alerts";
import { publishSystemNotice } from "../diagnostics/events";
import { userFacingError } from "../utils/userFacingError";
import {
  cancelPersistentPriceAlert,
  createPersistentPriceAlert,
  listPersistentPriceAlerts,
  updatePersistentPriceAlert,
} from "../trading/api/priceAlerts";
import type { AlertHistoryAction, AlertPattern, PriceAlert } from "../types/alert";
import type { ChartRefs } from "./useChartRefs";

const presentationKey = (symbol: string) => `${priceAlertsStorageKey(symbol)}:server`;

type Session = {
  symbol: string;
  active: boolean;
  busy: boolean;
  revision: number;
  alerts: PriceAlert[];
  triggered: Set<string>;
  refresh: () => void;
};

/** Server-confirmed alerts only. The device never monitors prices or delivers notifications. */
export function usePriceAlerts(
  refs: ChartRefs,
  symbol: string,
  lastPrice: number | null,
  enabled = true,
) {
  const normalizedSymbol = symbol.toUpperCase();
  const [state, setState] = useState<{ symbol: string; alerts: PriceAlert[] }>({
    symbol: normalizedSymbol,
    alerts: [],
  });
  const sessionRef = useRef<Session | null>(null);

  const commit = (session: Session, alerts: PriceAlert[]) => {
    if (!session.active || sessionRef.current !== session) return;
    session.alerts = alerts.filter((alert) => !session.triggered.has(alert.id));
    saveAlerts(presentationKey(session.symbol), session.alerts);
    setState({ symbol: session.symbol, alerts: session.alerts });
  };

  useEffect(() => {
    if (!enabled) return;
    const session: Session = {
      symbol: normalizedSymbol,
      active: true,
      busy: false,
      revision: 0,
      alerts: [],
      triggered: new Set(),
      refresh: () => {},
    };
    sessionRef.current = session;
    refs.alertUndoRef.current = [];
    refs.alertRedoRef.current = [];
    setState({ symbol: normalizedSymbol, alerts: [] });
    let loading = false;
    let reload = false;
    let reportedError = false;
    const sync = async () => {
      if (!session.active) return;
      if (loading || session.busy) {
        reload = true;
        return;
      }
      loading = true;
      reload = false;
      const revision = session.revision;
      try {
        const remote = await listPersistentPriceAlerts(session.symbol);
        if (!session.active) return;
        if (session.revision !== revision || session.busy) {
          reload = true;
          return;
        }
        // Retained browser alerts are never uploaded or re-armed automatically.
        const presentation = new Map(
          loadStoredAlerts(presentationKey(session.symbol)).map((alert) => [alert.id, alert]),
        );
        commit(
          session,
          remote.map((alert) => {
            const local = presentation.get(alert.id);
            return local ? { ...alert, locked: local.locked, hidden: local.hidden } : alert;
          }),
        );
        reportedError = false;
      } catch (error) {
        if (session.active && !reportedError) {
          reportedError = true;
          publishSystemNotice({
            kind: "warning",
            title: "Alert sync unavailable",
            message: userFacingError(
              error,
              "Could not refresh alerts. Server monitoring continues; retrying automatically.",
            ),
          });
        }
      } finally {
        loading = false;
        if (reload && session.active && !session.busy) void sync();
      }
    };
    session.refresh = () => {
      void sync();
    };
    const triggered = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; symbol: string }>).detail;
      if (detail.symbol.toUpperCase() !== session.symbol) return;
      session.revision += 1;
      session.triggered.add(detail.id);
      commit(
        session,
        session.alerts.filter((alert) => alert.id !== detail.id),
      );
      const keep = (action: AlertHistoryAction) =>
        (action.type === "update" ? action.before.id : action.alert.id) !== detail.id;
      refs.alertUndoRef.current = refs.alertUndoRef.current.filter(keep);
      refs.alertRedoRef.current = refs.alertRedoRef.current.filter(keep);
    };
    const visible = () => {
      if (document.visibilityState === "visible") session.refresh();
    };
    session.refresh();
    const timer = window.setInterval(session.refresh, 15_000);
    window.addEventListener("price-alerts-changed", session.refresh);
    window.addEventListener("persistent-price-alert-triggered", triggered);
    window.addEventListener("online", session.refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      session.active = false;
      window.clearInterval(timer);
      window.removeEventListener("price-alerts-changed", session.refresh);
      window.removeEventListener("persistent-price-alert-triggered", triggered);
      window.removeEventListener("online", session.refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [enabled, normalizedSymbol, refs.alertUndoRef, refs.alertRedoRef]);

  const mutate = (operation: (session: Session) => Promise<void>) => {
    const session = sessionRef.current;
    if (!enabled || !session?.active || session.symbol !== normalizedSymbol) return;
    if (session.busy) {
      publishSystemNotice({
        kind: "warning",
        title: "Saving alert",
        message: "Wait for the current alert change to finish.",
      });
      return;
    }
    session.busy = true;
    session.revision += 1;
    void operation(session)
      .catch((error: unknown) => {
        publishSystemNotice({
          kind: "error",
          title: "Alert change not confirmed",
          message: userFacingError(
            error,
            "Could not save the alert. Reconnecting to the server before retrying.",
          ),
        });
      })
      .finally(() => {
        session.busy = false;
        if (session.active) session.refresh();
        window.dispatchEvent(new Event("price-alerts-changed"));
      });
  };

  const pushHistory = (
    action:
      | Omit<Extract<AlertHistoryAction, { type: "add" | "delete" }>, "seq">
      | Omit<Extract<AlertHistoryAction, { type: "update" }>, "seq">,
  ) => {
    refs.historySeqRef.current += 1;
    refs.alertUndoRef.current.push({
      ...action,
      seq: refs.historySeqRef.current,
    } as AlertHistoryAction);
    refs.alertRedoRef.current = [];
  };

  const addAlert = (price: number) =>
    mutate(async (session) => {
      if (lastPrice === null || !Number.isFinite(lastPrice) || lastPrice <= 0) {
        throw new Error("Wait for a live price before creating an alert.");
      }
      const isAbove = price > lastPrice;
      const created = await createPersistentPriceAlert(session.symbol, {
        id: "",
        price,
        createdAt: Date.now(),
        side: isAbove ? "SHORT" : "LONG",
        crossing: isAbove ? "CROSS_UP" : "CROSS_DOWN",
        pattern: isAbove ? "resistance" : "support",
        additionalInfo: "",
        locked: true,
        hidden: true,
      });
      if (!session.active || session.triggered.has(created.id)) return;
      commit(session, [...session.alerts.filter((alert) => alert.id !== created.id), created]);
      pushHistory({ type: "add", alert: created });
    });

  const removeAlert = (id: string) =>
    mutate(async (session) => {
      const alert = session.alerts.find((item) => item.id === id);
      if (!alert) return;
      await cancelPersistentPriceAlert(id);
      if (!session.active) return;
      commit(
        session,
        session.alerts.filter((item) => item.id !== id),
      );
      pushHistory({ type: "delete", alert });
    });

  const update = (id: string, change: (alert: PriceAlert) => PriceAlert) =>
    mutate(async (session) => {
      const before = session.alerts.find((item) => item.id === id);
      if (!before) return;
      const requested = change(before);
      const saved = await updatePersistentPriceAlert(requested);
      if (!session.active || session.triggered.has(id)) return;
      const after = { ...saved, locked: requested.locked, hidden: requested.hidden };
      commit(
        session,
        session.alerts.map((item) => (item.id === id ? after : item)),
      );
      pushHistory({ type: "update", before, after });
    });

  const presentation = (id: string, change: (alert: PriceAlert) => PriceAlert) => {
    const session = sessionRef.current;
    if (!enabled || !session?.active || session.symbol !== normalizedSymbol || session.busy) return;
    const before = session.alerts.find((item) => item.id === id);
    if (!before) return;
    const after = change(before);
    session.revision += 1;
    commit(
      session,
      session.alerts.map((item) => (item.id === id ? after : item)),
    );
    pushHistory({ type: "update", before, after });
  };

  const replay = (reverse: boolean) =>
    mutate(async (session) => {
      const source = reverse ? refs.alertUndoRef.current : refs.alertRedoRef.current;
      const action = source[source.length - 1];
      if (!action) return;
      const restoring =
        (action.type === "delete" && reverse) || (action.type === "add" && !reverse);
      if (action.type === "update") {
        const desired = reverse ? action.before : action.after;
        const prior = reverse ? action.after : action.before;
        // Lock/dim changes are presentation only and must not overwrite another device's edits.
        const onlyPresentation =
          desired.price === prior.price &&
          desired.side === prior.side &&
          desired.pattern === prior.pattern &&
          desired.additionalInfo === prior.additionalInfo &&
          desired.crossing === prior.crossing;
        const saved = onlyPresentation ? null : await updatePersistentPriceAlert(desired);
        if (!session.active || session.triggered.has(desired.id)) return;
        commit(
          session,
          session.alerts.map((item) =>
            item.id === desired.id
              ? { ...(saved ?? item), locked: desired.locked, hidden: desired.hidden }
              : item,
          ),
        );
      } else if (restoring) {
        const restored = await createPersistentPriceAlert(session.symbol, action.alert);
        if (!session.active) return;
        if (session.triggered.has(restored.id)) {
          // It fired before POST completed: this restoration must not remain redoable.
          refs.alertUndoRef.current = refs.alertUndoRef.current.filter((entry) => entry !== action);
          refs.alertRedoRef.current = refs.alertRedoRef.current.filter((entry) => entry !== action);
          return;
        }
        const previousId = action.alert.id;
        // Recreating a deleted alert gets a new backend ID; older undo entries follow it.
        for (const entry of [...refs.alertUndoRef.current, ...refs.alertRedoRef.current]) {
          for (const alert of entry.type === "update"
            ? [entry.before, entry.after]
            : [entry.alert]) {
            if (alert.id === previousId) alert.id = restored.id;
          }
        }
        commit(session, [...session.alerts, restored]);
      } else {
        await cancelPersistentPriceAlert(action.alert.id);
        if (!session.active) return;
        commit(
          session,
          session.alerts.filter((item) => item.id !== action.alert.id),
        );
      }
      // Trigger events can replace both history arrays while the request is in flight.
      const currentSource = reverse ? refs.alertUndoRef.current : refs.alertRedoRef.current;
      const currentDestination = reverse ? refs.alertRedoRef.current : refs.alertUndoRef.current;
      if (currentSource[currentSource.length - 1] === action) {
        currentSource.pop();
        currentDestination.push(action);
      }
    });

  return {
    alerts: enabled && state.symbol === normalizedSymbol ? state.alerts : [],
    addAlert,
    removeAlert,
    updateAlertPrice: (id: string, price: number) =>
      update(id, (alert) => ({
        ...alert,
        price,
        crossing:
          lastPrice !== null ? (price > lastPrice ? "CROSS_UP" : "CROSS_DOWN") : alert.crossing,
      })),
    toggleAlertSide: (id: string) =>
      update(id, (alert) => ({ ...alert, side: alert.side === "LONG" ? "SHORT" : "LONG" })),
    setAlertPattern: (id: string, pattern: AlertPattern) =>
      update(id, (alert) => ({ ...alert, pattern })),
    setAlertAdditionalInfo: (id: string, additionalInfo: string) =>
      update(id, (alert) => ({ ...alert, additionalInfo: additionalInfo.trim() })),
    toggleAlertLocked: (id: string) =>
      presentation(id, (alert) => ({
        ...alert,
        locked: !alert.locked,
        hidden: alert.locked ? false : alert.hidden,
      })),
    toggleAlertHidden: (id: string) =>
      presentation(id, (alert) => ({
        ...alert,
        hidden: alert.locked ? alert.hidden : !alert.hidden,
      })),
    undo: () => replay(true),
    redo: () => replay(false),
  };
}

export type PriceAlertsApi = ReturnType<typeof usePriceAlerts>;
