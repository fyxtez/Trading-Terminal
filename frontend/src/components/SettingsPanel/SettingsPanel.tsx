import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { getAvailableBalance } from "../../trading/api/account";
import {
  getSizing,
  updateSizing,
  type SizingConfig,
} from "../../trading/api/sizing";
import type { ConnectionState } from "../../hooks/useTradingStream";
import type { PriceAlert } from "../../types/alert";
import type { SavedDrawingSet } from "../../types/drawing";
import { priceAlertsStorageKey } from "../../config/constants";
import { formatSymbolPair } from "../../config/symbols";
import { loadStoredAlerts } from "../../utils/alerts";
import {
  listAllPersistentPriceAlerts,
  type ListedPriceAlert,
} from "../../trading/api/priceAlerts";
import "../../styles/floatingPanel.css";
import { useDesktopCredentials } from "../DesktopSetupGate/DesktopCredentialsContext";
import "./SettingsPanel.css";

type SettingsPanelProps = {
  isOpen: boolean;
  onClose: () => void;
  width: number;
  onWidthChange: (width: number) => void;
  /**
   * Backend REST API health (see useBackendConnection in App.tsx). Used
   * for two things:
   *  1. Disabling the margin configuration fields while the backend is
   *     down (updateSizing would just fail).
   *  2. Re-fetching the available balance and sizing config once the
   *     backend comes back up while this panel happens to still be open -
   *     previously that fetch only ran on the isOpen transition, so a
   *     disconnect/reconnect cycle while the panel stayed open left the
   *     balance stuck on "Unavailable" until the panel was closed and
   *     reopened.
   */
  backendConnection: ConnectionState;
  currentSymbol: string;
  /** FEATURE: all registered symbols plus the live active-symbol list let the
   * settings panel aggregate browser-owned alerts even when persistence is off. */
  availableSymbols: readonly string[];
  activePriceAlerts: PriceAlert[];
  regularDrawingsCount: number;
  drawingSets: SavedDrawingSet[];
  activeDrawingSetId: string | null;
  onSaveCurrentDrawingSet: (name: string) => boolean;
  onLoadDrawingSet: (setId: string) => boolean;
  onRenameDrawingSet: (setId: string, name: string) => boolean;
  onDeleteDrawingSet: (setId: string) => void;
  onClearCurrentDrawings: () => void;
  /** Whether all chart drawings are visible. Purely local preference. */
  showDrawings: boolean;
  onShowDrawingsChange: (enabled: boolean) => void;
  showAsiaSession: boolean;
  onShowAsiaSessionChange: (enabled: boolean) => void;
  showLondonSession: boolean;
  onShowLondonSessionChange: (enabled: boolean) => void;
  showNewYorkSession: boolean;
  onShowNewYorkSessionChange: (enabled: boolean) => void;
  showNewYorkKillZone: boolean;
  onShowNewYorkKillZoneChange: (enabled: boolean) => void;
  /**
   * Whether the top-right "PNL" card (current chart symbol's own
   * unrealized PNL - see ChartPositionPnl.tsx) is shown. Same local,
   * backend-free display preference as sessionZonesEnabled above.
   */
  showPositionPnl: boolean;
  onShowPositionPnlChange: (enabled: boolean) => void;
  /**
   * Whether the "TOTAL" card (sum of unrealized PNL across every open
   * position - see totalPnl in hooks/useChartPositionPnl.ts) is shown.
   */
  showTotalPnl: boolean;
  onShowTotalPnlChange: (enabled: boolean) => void;
  /**
   * Whether the top-left candle-close countdown badge (see
   * CandleCountdownBadge.tsx / hooks/useCandleCountdown.ts) is shown.
   */
  showCandleCountdown: boolean;
  onShowCandleCountdownChange: (enabled: boolean) => void;
  /** FEATURE: chart watermark is independently hideable and remains a local-only display preference. */
  showWatermark: boolean;
  onShowWatermarkChange: (enabled: boolean) => void;
  /** Whether the active drawing-set name badge is shown on the chart. */
  showDrawingSetBadge: boolean;
  onShowDrawingSetBadgeChange: (enabled: boolean) => void;
  /** Whether midnight/start-of-day vertical markers are shown. */
  showStartOfDay: boolean;
  onShowStartOfDayChange: (enabled: boolean) => void;
  startOfDayLookbackDays: number;
  onStartOfDayLookbackDaysChange: (days: number) => void;
  /**
   * Whether pending price alert lines (see AlertLinesOverlay.tsx /
   * usePriceAlerts.ts) are drawn on the chart. Same local, backend-free
   * display preference as sessionZonesEnabled above - the alerts
   * themselves keep monitoring and firing notifications regardless of
   * whether their lines are shown.
   */
  showPriceAlerts: boolean;
  onShowPriceAlertsChange: (enabled: boolean) => void;
  /**
   * Whether newly-created price alerts are stored and monitored by the
   * backend instead of being tracked and fired from this browser tab.
   */
  persistentAlertsEnabled: boolean;
  onPersistentAlertsEnabledChange: (enabled: boolean) => void;
};

type SizingField = keyof SizingConfig;

const FIELD_META: Record<
  SizingField,
  {
    label: string;
    description: string;
    step: number;
    min: number;
    max?: number;
  }
> = {
  margin_pct: {
    label: "Margin percentage",
    description: "Portfolio margin used per trade",
    step: 1,
    min: 1,
    max: 50,
  },
  leverage_safety: {
    label: "Leverage safety",
    description: "Safety multiplier applied to leverage",
    step: 0.01,
    min: 0,
    max: 1,
  },
  max_leverage: {
    label: "Maximum leverage",
    description: "Hard leverage cap",
    step: 1,
    min: 1,
  },
};

const AUTO_SAVE_DELAY_MS = 500;
const MARGIN_SECTION_VISIBLE_KEY = "fyxtez.settings.marginSectionVisible";
const DRAWING_SETS_SECTION_VISIBLE_KEY =
  "fyxtez.settings.drawingSetsSectionVisible";
const CHART_DISPLAY_SECTION_VISIBLE_KEY =
  "fyxtez.settings.chartDisplaySectionVisible";
const DRAWINGS_DISPLAY_SECTION_VISIBLE_KEY =
  "fyxtez.settings.drawingsDisplaySectionVisible";
const PNL_SECTION_VISIBLE_KEY = "fyxtez.settings.pnlSectionVisible";
const ALERTS_SECTION_VISIBLE_KEY = "fyxtez.settings.alertsSectionVisible";

function readStoredSectionVisibility(key: string): boolean {
  try {
    const storedValue = window.localStorage.getItem(key);
    return storedValue === null ? true : storedValue === "true";
  } catch {
    return true;
  }
}

const balanceFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const alertPriceFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 8,
});

export default function SettingsPanel({
  isOpen,
  onClose,
  width,
  onWidthChange,
  backendConnection,
  currentSymbol,
  availableSymbols,
  activePriceAlerts,
  regularDrawingsCount,
  drawingSets,
  activeDrawingSetId,
  onSaveCurrentDrawingSet,
  onLoadDrawingSet,
  onRenameDrawingSet,
  onDeleteDrawingSet,
  onClearCurrentDrawings,
  showDrawings,
  onShowDrawingsChange,
  showAsiaSession,
  onShowAsiaSessionChange,
  showLondonSession,
  onShowLondonSessionChange,
  showNewYorkSession,
  onShowNewYorkSessionChange,
  showNewYorkKillZone,
  onShowNewYorkKillZoneChange,
  showPositionPnl,
  onShowPositionPnlChange,
  showTotalPnl,
  onShowTotalPnlChange,
  showCandleCountdown,
  onShowCandleCountdownChange,
  showWatermark,
  onShowWatermarkChange,
  showDrawingSetBadge,
  onShowDrawingSetBadgeChange,
  showStartOfDay,
  onShowStartOfDayChange,
  startOfDayLookbackDays,
  onStartOfDayLookbackDaysChange,
  showPriceAlerts,
  onShowPriceAlertsChange,
  persistentAlertsEnabled,
  onPersistentAlertsEnabledChange,
}: SettingsPanelProps) {
  const desktopCredentials = useDesktopCredentials();
  const [availableBalance, setAvailableBalance] = useState<number | null>(null);
  const [balanceRevision, setBalanceRevision] = useState(0);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  // FEATURE: the account-wide list has its own loading/error state so a failed
  // refresh never blocks the rest of the settings panel.
  const [listedPriceAlerts, setListedPriceAlerts] = useState<ListedPriceAlert[]>([]);
  const [isLoadingAlerts, setIsLoadingAlerts] = useState(false);
  const [alertsListError, setAlertsListError] = useState<string | null>(null);
  const [alertsListRevision, setAlertsListRevision] = useState(0);

  const [sizing, setSizing] = useState<SizingConfig | null>(null);
  const [draftSizing, setDraftSizing] = useState<SizingConfig | null>(null);
  const [activeField, setActiveField] = useState<SizingField | null>(null);
  const [savingField, setSavingField] = useState<SizingField | null>(null);
  const [sizingError, setSizingError] = useState<string | null>(null);
  const [drawingSetName, setDrawingSetName] = useState("");
  const [drawingSetMessage, setDrawingSetMessage] = useState<string | null>(
    null,
  );
  const [renamingDrawingSetId, setRenamingDrawingSetId] = useState<
    string | null
  >(null);
  const [renamingDrawingSetName, setRenamingDrawingSetName] = useState("");
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<
    string | null
  >(null);
  const [isNewDrawingSetConfirmationOpen, setIsNewDrawingSetConfirmationOpen] =
    useState(false);
  const [isMarginSectionVisible, setIsMarginSectionVisible] = useState(() =>
    readStoredSectionVisibility(MARGIN_SECTION_VISIBLE_KEY),
  );
  const [isDrawingSetsSectionVisible, setIsDrawingSetsSectionVisible] =
    useState(() =>
      readStoredSectionVisibility(DRAWING_SETS_SECTION_VISIBLE_KEY),
    );
  const [isChartDisplaySectionVisible, setIsChartDisplaySectionVisible] =
    useState(() =>
      readStoredSectionVisibility(CHART_DISPLAY_SECTION_VISIBLE_KEY),
    );
  const [isDrawingsDisplaySectionVisible, setIsDrawingsDisplaySectionVisible] =
    useState(() =>
      readStoredSectionVisibility(DRAWINGS_DISPLAY_SECTION_VISIBLE_KEY),
    );
  const [isPnlSectionVisible, setIsPnlSectionVisible] = useState(() =>
    readStoredSectionVisibility(PNL_SECTION_VISIBLE_KEY),
  );
  const [isAlertsSectionVisible, setIsAlertsSectionVisible] = useState(() =>
    readStoredSectionVisibility(ALERTS_SECTION_VISIBLE_KEY),
  );
  // FEATURE: Settings search keeps a large configuration panel usable without
  // changing the user's persisted HIDE/SHOW preferences for each section.
  const [settingsSearchQuery, setSettingsSearchQuery] = useState("");

  const saveTimerRef = useRef<number | null>(null);
  const saveRequestIdRef = useRef(0);

  /*
   * FIX: the previous attempt at this used a CSS transition-delay on the
   * (non-interpolable) overflow-y property to hold off showing the
   * scrollbar until the panel's own 200ms open-width animation finished.
   * That's a "discrete" property transition, which several browsers
   * either don't support at all without an explicit
   * `transition-behavior: allow-discrete` (a fairly new addition) or
   * apply inconsistently - in practice the scrollbar still flashed on
   * immediately, the delay was just never honored. A real timer sidesteps
   * all of that: isFullyOpen flips true exactly 200ms after the panel
   * starts opening (matching .app-main's grid-template-columns
   * transition in App.css), and .settings-body only switches from
   * overflow-y: hidden to auto once that's true - guaranteed timing,
   * no reliance on how a given browser handles transitioning a
   * non-animatable property.
   */
  const [isFullyOpen, setIsFullyOpen] = useState(false);

  useEffect(() => {
    // FEATURE: triggered alerts can belong to a background symbol, so use the
    // existing global event to refresh even when activePriceAlerts did not change.
    const refreshAfterTrigger = () => setAlertsListRevision((value) => value + 1);
    window.addEventListener("persistent-price-alert-triggered", refreshAfterTrigger);
    return () =>
      window.removeEventListener("persistent-price-alert-triggered", refreshAfterTrigger);
  }, []);

  useEffect(() => {
    if (!isOpen || !isAlertsSectionVisible) return;

    const localAlerts = (): ListedPriceAlert[] =>
      availableSymbols.flatMap((symbol) => {
        const normalized = symbol.toUpperCase();
        const alerts = normalized === currentSymbol.toUpperCase()
          ? activePriceAlerts
          : loadStoredAlerts(priceAlertsStorageKey(normalized));
        return alerts.map((alert) => ({ ...alert, symbol: normalized }));
      });

    // FEATURE: persistent mode uses SQLite's account-wide active list; local
    // mode aggregates every registered symbol's per-symbol browser storage.
    if (!persistentAlertsEnabled || backendConnection !== "connected") {
      setListedPriceAlerts(localAlerts());
      setAlertsListError(
        persistentAlertsEnabled && backendConnection !== "connected"
          ? "Backend unavailable — showing locally cached alerts."
          : null,
      );
      setIsLoadingAlerts(false);
      return;
    }

    let cancelled = false;
    const normalizedCurrentSymbol = currentSymbol.toUpperCase();
    const currentSymbolAlerts: ListedPriceAlert[] = activePriceAlerts.map(
      (alert) => ({ ...alert, symbol: normalizedCurrentSymbol }),
    );

    /*
     * FIX: deleting a persistent alert updates usePriceAlerts immediately, but
     * the settings table used to refetch the backend before DELETE had finished.
     * That stale response could reinsert the removed row until a full page
     * refresh. Treat the already-updated active-symbol React state as
     * authoritative immediately, then merge background-symbol rows from the
     * account-wide backend response so removals disappear from this table now.
     */
    setListedPriceAlerts((previous) => [
      ...previous.filter(
        (alert) => alert.symbol.toUpperCase() !== normalizedCurrentSymbol,
      ),
      ...currentSymbolAlerts,
    ]);
    setIsLoadingAlerts(true);
    setAlertsListError(null);
    void listAllPersistentPriceAlerts()
      .then((alerts) => {
        if (cancelled) return;
        setListedPriceAlerts([
          ...alerts.filter(
            (alert) => alert.symbol.toUpperCase() !== normalizedCurrentSymbol,
          ),
          ...currentSymbolAlerts,
        ]);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setListedPriceAlerts(localAlerts());
        setAlertsListError(
          error instanceof Error ? error.message : "Unable to load active alerts",
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoadingAlerts(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    isAlertsSectionVisible,
    persistentAlertsEnabled,
    backendConnection,
    availableSymbols,
    currentSymbol,
    activePriceAlerts,
    alertsListRevision,
  ]);

  const sortedListedPriceAlerts = [...listedPriceAlerts].sort(
    (left, right) =>
      left.symbol.localeCompare(right.symbol) || right.createdAt - left.createdAt,
  );

  useEffect(() => {
    if (!isOpen) {
      setIsFullyOpen(false);
      return;
    }

    const timer = window.setTimeout(() => setIsFullyOpen(true), 200);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  const isBackendConnected = backendConnection === "connected";

  useEffect(() => {
    try {
      window.localStorage.setItem(
        MARGIN_SECTION_VISIBLE_KEY,
        String(isMarginSectionVisible),
      );
    } catch {
      // Keep the preference in memory when localStorage is unavailable.
    }
  }, [isMarginSectionVisible]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        DRAWING_SETS_SECTION_VISIBLE_KEY,
        String(isDrawingSetsSectionVisible),
      );
    } catch {
      // Keep the preference in memory when localStorage is unavailable.
    }
  }, [isDrawingSetsSectionVisible]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        CHART_DISPLAY_SECTION_VISIBLE_KEY,
        String(isChartDisplaySectionVisible),
      );
    } catch {
      // Keep the preference in memory when localStorage is unavailable.
    }
  }, [isChartDisplaySectionVisible]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        DRAWINGS_DISPLAY_SECTION_VISIBLE_KEY,
        String(isDrawingsDisplaySectionVisible),
      );
    } catch {
      // Keep the preference in memory when localStorage is unavailable.
    }
  }, [isDrawingsDisplaySectionVisible]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PNL_SECTION_VISIBLE_KEY,
        String(isPnlSectionVisible),
      );
    } catch {
      // Keep the preference in memory when localStorage is unavailable.
    }
  }, [isPnlSectionVisible]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        ALERTS_SECTION_VISIBLE_KEY,
        String(isAlertsSectionVisible),
      );
    } catch {
      // Keep the preference in memory when localStorage is unavailable.
    }
  }, [isAlertsSectionVisible]);

  useEffect(() => {
    setDrawingSetName("");
    setDrawingSetMessage(null);
    setRenamingDrawingSetId(null);
    setRenamingDrawingSetName("");
    setDeleteConfirmationId(null);
    setIsNewDrawingSetConfirmationOpen(false);
  }, [currentSymbol]);

  const handleSaveDrawingSet = () => {
    if (!drawingSetName.trim()) {
      setDrawingSetMessage("Enter a name for this drawing set.");
      return;
    }

    if (!onSaveCurrentDrawingSet(drawingSetName)) {
      setDrawingSetMessage("There are no drawings to save.");
      return;
    }

    setDrawingSetMessage(`Saved “${drawingSetName.trim()}”.`);
  };

  const handleNewDrawingSet = () => {
    if (regularDrawingsCount === 0) return;

    setIsNewDrawingSetConfirmationOpen(true);
    setDeleteConfirmationId(null);
    setDrawingSetMessage(null);
  };

  const confirmNewDrawingSet = () => {
    onClearCurrentDrawings();
    setDrawingSetName("");
    setIsNewDrawingSetConfirmationOpen(false);
    setDrawingSetMessage("Started a new drawing set.");
  };

  const handleLoadDrawingSet = (setId: string) => {
    if (!onLoadDrawingSet(setId)) {
      setDrawingSetMessage("Unable to load drawing set.");
      return;
    }

    const loadedSet = drawingSets.find((set) => set.id === setId);
    setDrawingSetMessage(
      loadedSet ? `Loaded “${loadedSet.name}”.` : "Drawing set loaded.",
    );
    setDeleteConfirmationId(null);
    setIsNewDrawingSetConfirmationOpen(false);
  };

  const startRenamingDrawingSet = (set: SavedDrawingSet) => {
    setRenamingDrawingSetId(set.id);
    setRenamingDrawingSetName(set.name);
    setDeleteConfirmationId(null);
    setDrawingSetMessage(null);
  };

  const cancelRenamingDrawingSet = () => {
    setRenamingDrawingSetId(null);
    setRenamingDrawingSetName("");
  };

  const commitDrawingSetRename = (setId: string) => {
    const trimmedName = renamingDrawingSetName.trim();
    if (!trimmedName) {
      setDrawingSetMessage("Drawing set name cannot be empty.");
      return;
    }

    if (!onRenameDrawingSet(setId, trimmedName)) {
      setDrawingSetMessage("That drawing set name is already in use.");
      return;
    }

    setRenamingDrawingSetId(null);
    setRenamingDrawingSetName("");
    setDrawingSetMessage(`Renamed drawing set to “${trimmedName}”.`);
  };

  // Fetches balance + sizing whenever the panel is open AND the backend
  // is reachable. Depending on backendConnection (not just isOpen) means
  // this also re-runs the instant a reconnect happens while the panel is
  // still sitting open, instead of only ever fetching once per open.
  useEffect(() => {
    if (!isOpen) return;
    if (backendConnection !== "connected") return;
    if (
      desktopCredentials.isDesktop &&
      !desktopCredentials.status.binanceConfigured
    ) {
      setAvailableBalance(null);
      setBalanceError(null);
      setIsLoadingBalance(false);
      return;
    }

    const controller = new AbortController();

    setIsLoadingBalance(true);
    setBalanceError(null);
    setSizingError(null);

    void getAvailableBalance(controller.signal)
      .then(setAvailableBalance)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        setAvailableBalance(null);
        setBalanceError(
          error instanceof Error ? error.message : "Unable to load balance",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoadingBalance(false);
        }
      });

    void getSizing(controller.signal)
      .then((result) => {
        setSizing(result);
        setDraftSizing(result);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        setSizingError(
          error instanceof Error ? error.message : "Unable to load sizing",
        );
      });

    return () => controller.abort();
  }, [
    isOpen,
    backendConnection,
    balanceRevision,
    desktopCredentials.isDesktop,
    desktopCredentials.status.binanceConfigured,
  ]);

  useEffect(() => {
    let refreshTimer: number | null = null;

    const handleAccountStateChanged = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);

      /*
       * FIX (Settings balance stayed stale after an external Binance funding
       * transfer): the account event is emitted before the backend finishes
       * its short REST reconciliation for availableBalance. Delay this panel's
       * revision just past that window so an already-open Settings panel reads
       * the reconciled value instead of keeping its initial snapshot forever.
       */
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        setBalanceRevision((revision) => revision + 1);
      }, 250);
    };

    window.addEventListener("account-state-changed", handleAccountStateChanged);
    return () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      window.removeEventListener(
        "account-state-changed",
        handleAccountStateChanged,
      );
    };
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  // Backend went down while a field was actively being edited - drop back
  // to read-only and discard any unsaved edit rather than leaving a
  // pending auto-save timer that will only fail once it fires.
  useEffect(() => {
    if (isBackendConnected) return;

    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    setActiveField(null);
    if (sizing) setDraftSizing(sizing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBackendConnected]);

  const saveSizing = async (
    nextSizing: SizingConfig,
    field: SizingField,
  ) => {
    const requestId = ++saveRequestIdRef.current;

    setSavingField(field);
    setSizingError(null);

    try {
      const updated = await updateSizing(nextSizing);

      if (requestId !== saveRequestIdRef.current) {
        return;
      }

      setSizing(updated);
      setDraftSizing(updated);
    } catch (error) {
      if (requestId !== saveRequestIdRef.current) {
        return;
      }

      setSizingError(
        error instanceof Error ? error.message : "Failed to update sizing",
      );

      setDraftSizing(sizing);
    } finally {
      if (requestId === saveRequestIdRef.current) {
        setSavingField(null);
      }
    }
  };

  const scheduleSave = (
    nextSizing: SizingConfig,
    field: SizingField,
  ) => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = window.setTimeout(() => {
      void saveSizing(nextSizing, field);
    }, AUTO_SAVE_DELAY_MS);
  };

  const changeField = (field: SizingField, rawValue: string) => {
    if (!draftSizing || !isBackendConnected) return;

    const displayValue = Number(rawValue);

    if (!Number.isFinite(displayValue)) {
      return;
    }

    const meta = FIELD_META[field];

    if (
      displayValue < meta.min ||
      (meta.max !== undefined && displayValue > meta.max)
    ) {
      setSizingError(
        meta.max !== undefined
          ? `${meta.label} must be between ${meta.min} and ${meta.max}${
              field === "margin_pct" ? "%" : ""
            }`
          : `${meta.label} must be at least ${meta.min}`,
      );
      return;
    }

    let normalizedValue: number;

    if (field === "margin_pct") {
      normalizedValue = displayValue / 100;
    } else if (field === "max_leverage") {
      normalizedValue = Math.round(displayValue);
    } else {
      normalizedValue = displayValue;
    }

    const nextSizing: SizingConfig = {
      ...draftSizing,
      [field]: normalizedValue,
    };

    setDraftSizing(nextSizing);
    setSizingError(null);
    scheduleSave(nextSizing, field);
  };

  const saveImmediately = (field: SizingField) => {
    if (!draftSizing || !isBackendConnected) return;

    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    void saveSizing(draftSizing, field);
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
    field: SizingField,
  ) => {
    if (event.key === "Enter") {
      saveImmediately(field);
      event.currentTarget.blur();
    }

    if (event.key === "Escape" && sizing) {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      setDraftSizing(sizing);
      setActiveField(null);
      setSizingError(null);
      event.currentTarget.blur();
    }
  };

  const handleResizePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (window.matchMedia("(max-width: 720px)").matches || isResizing) return;

    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = width;

    setIsResizing(true);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      // Click once to pick up the divider, then resize just by moving the
      // pointer. Because the drawer is docked to the right, moving left
      // makes it wider and moving right makes it narrower.
      onWidthChange(startWidth + (startX - moveEvent.clientX));
    };

    const stopResizing = (finishEvent?: PointerEvent) => {
      if (finishEvent instanceof PointerEvent) {
        // The finishing click belongs to the resize interaction; don't also
        // activate whatever control happens to be underneath the pointer.
        finishEvent.preventDefault();
        finishEvent.stopPropagation();
      }

      setIsResizing(false);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", handleFinishPointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };

    const handleFinishPointerDown = (finishEvent: PointerEvent) => {
      stopResizing(finishEvent);
    };

    const handleKeyDown = (keyEvent: globalThis.KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      stopResizing();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("keydown", handleKeyDown);

    // Delay registration so the pointerdown that STARTED resizing cannot also
    // be interpreted as the click that finishes it.
    window.setTimeout(() => {
      window.addEventListener("pointerdown", handleFinishPointerDown, true);
    }, 0);
  };

  const normalizedSettingsSearch = settingsSearchQuery.trim().toLowerCase();
  const isSearchingSettings = normalizedSettingsSearch.length > 0;
  const matchesSettingsSearch = (...parts: Array<string | undefined>) =>
    !isSearchingSettings ||
    parts
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(normalizedSettingsSearch);

  // FEATURE: matching sections auto-expand while searching, but their saved
  // collapsed/expanded state is left untouched so clearing search restores the
  // panel exactly as the user had it before typing.
  const marginSectionTitleMatches = matchesSettingsSearch(
    "Margin configuration",
    "margin leverage sizing position order risk",
  );
  const marginFieldMatches = (Object.keys(FIELD_META) as SizingField[]).some(
    (field) =>
      matchesSettingsSearch(
        FIELD_META[field].label,
        FIELD_META[field].description,
        field,
      ),
  );
  const showMarginSection =
    !isSearchingSettings || marginSectionTitleMatches || marginFieldMatches;

  const drawingSetsSectionMatches = matchesSettingsSearch(
    "Drawing sets",
    "save named layouts symbol drawing set rename delete load clear new",
  );
  const showDrawingSetsSection =
    !isSearchingSettings || drawingSetsSectionMatches;

  const drawingsSectionTitleMatches = matchesSettingsSearch(
    "Drawings",
    "chart drawings sessions day candle zones kill zone",
  );
  const drawingOptionMatches = {
    showDrawings: matchesSettingsSearch(
      "Show drawings",
      "Show all saved drawings on the chart",
    ),
    startOfDay: matchesSettingsSearch(
      "Start of day candle",
      "vertical marker start chart day daily",
    ),
    dayHistory: matchesSettingsSearch(
      "Day history",
      "Number of chart days to mark maximum 20 lookback",
    ),
    asia: matchesSettingsSearch(
      "Asia session zone",
      "Asia session boundaries chart",
    ),
    london: matchesSettingsSearch(
      "London session zone",
      "London session boundaries chart",
    ),
    newYork: matchesSettingsSearch(
      "New York session zone",
      "New York session boundaries chart",
    ),
    killZone: matchesSettingsSearch(
      "Show kill zone",
      "Highlight 13:00 16:00 chart time New York",
    ),
  };
  const showDrawingsSection =
    !isSearchingSettings ||
    drawingsSectionTitleMatches ||
    Object.values(drawingOptionMatches).some(Boolean);

  const pnlSectionTitleMatches = matchesSettingsSearch(
    "PNL",
    "profit loss unrealized realized total position",
  );
  const pnlOptionMatches = {
    position: matchesSettingsSearch(
      "Show PNL",
      "active symbol unrealized realized PNL card chart",
    ),
    total: matchesSettingsSearch(
      "Show TOTAL PNL",
      "unrealized PNL total across all open positions chart",
    ),
  };
  const showPnlSection =
    !isSearchingSettings ||
    pnlSectionTitleMatches ||
    Object.values(pnlOptionMatches).some(Boolean);

  const alertsSectionTitleMatches = matchesSettingsSearch(
    "Alerts",
    "price alerts persistent active notifications",
  );
  const alertOptionMatches = {
    show: matchesSettingsSearch(
      "Show price alerts",
      "pending price alert lines chart right click",
    ),
    persistent: matchesSettingsSearch(
      "Use persistent alerts",
      "backend store monitor alerts browser closed",
    ),
    active: matchesSettingsSearch(
      "Active alerts",
      "symbol price side info active alert list",
    ),
  };
  const showAlertsSection =
    !isSearchingSettings ||
    alertsSectionTitleMatches ||
    Object.values(alertOptionMatches).some(Boolean);

  const chartDisplaySectionTitleMatches = matchesSettingsSearch(
    "Chart display",
    "chart display visual appearance",
  );
  const chartDisplayOptionMatches = {
    timer: matchesSettingsSearch(
      "Show candle timer",
      "countdown current candle close chart",
    ),
    watermark: matchesSettingsSearch(
      "Show watermark",
      "Fyxtez watermark chart hide watermark",
    ),
    drawingSetBadge: matchesSettingsSearch(
      "Show active drawing set",
      "currently active drawing set name chart badge",
    ),
  };
  const showChartDisplaySection =
    !isSearchingSettings ||
    chartDisplaySectionTitleMatches ||
    Object.values(chartDisplayOptionMatches).some(Boolean);

  const showBalanceCard = matchesSettingsSearch(
    "Available balance",
    "USDT futures wallet balance",
  );
  const showDesktopConnections = desktopCredentials.isDesktop && matchesSettingsSearch(
    "Desktop connections Binance ntfy Telegram credentials API key notifications",
  );
  const hasAnySettingsSearchResult =
    showDesktopConnections ||
    showBalanceCard ||
    showMarginSection ||
    showDrawingSetsSection ||
    showDrawingsSection ||
    showPnlSection ||
    showAlertsSection ||
    showChartDisplaySection;

  return (
    <>
      {/*
       * Mobile-only dimmed backdrop (see .settings-backdrop in
       * SettingsPanel.css - invisible/inert on desktop, where the panel
       * lives inline in the flex layout instead of overlaying anything).
       * Tapping it closes the drawer the same way the × button does.
       */}
      {isOpen && (
        <div
          className="settings-backdrop"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={`settings-panel ${isOpen ? "open" : ""} ${isResizing ? "resizing" : ""}`}
        onClick={(event) => event.stopPropagation()}
      >
        {isOpen && (
          <div
            className="settings-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize settings panel"
            title="Click, move, then click again to resize settings panel"
            onPointerDown={handleResizePointerDown}
          />
        )}

        <div className="settings-header">
          <div className="settings-title">Settings</div>

          <button className="settings-close" title="Close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* FEATURE: a dedicated search row remains fixed above the scrolling
            settings content so large panels can be filtered immediately. */}
        <div className="settings-search-row">
          <div className="settings-search-box">
            <span className="settings-search-icon" aria-hidden="true">⌕</span>
            <input
              type="search"
              value={settingsSearchQuery}
              placeholder="Search settings…"
              aria-label="Search settings"
              onChange={(event) => setSettingsSearchQuery(event.target.value)}
            />
            {isSearchingSettings && (
              <button
                type="button"
                className="settings-search-clear"
                title="Clear settings search"
                aria-label="Clear settings search"
                onClick={() => setSettingsSearchQuery("")}
              >
                ×
              </button>
            )}
          </div>
        </div>

        <div className={`settings-body ${isFullyOpen ? "scrollable" : ""}`}>
          {showDesktopConnections && <section className="settings-section settings-desktop-connections">
            <div className="settings-section-heading"><h3>Desktop connections</h3><p>Credentials stored securely on this computer.</p></div>
            <div className="settings-connection-statuses">
              <div className={desktopCredentials.status.binanceConfigured ? "connected" : ""}>
                <span>Binance</span>
                <div>
                  <b>{desktopCredentials.status.binanceConfigured ? "CONNECTED" : "NOT SET"}</b>
                  <button type="button" onClick={() => desktopCredentials.openSetup("binance")}>
                    {desktopCredentials.status.binanceConfigured ? "EDIT" : "CONNECT"}
                  </button>
                </div>
              </div>
              <div className={desktopCredentials.status.ntfyConfigured ? "connected" : ""}>
                <span>ntfy</span>
                <div>
                  <b>{desktopCredentials.status.ntfyConfigured ? "CONNECTED" : "NOT SET"}</b>
                  <button type="button" onClick={() => desktopCredentials.openSetup("ntfy")}>
                    {desktopCredentials.status.ntfyConfigured ? "EDIT" : "CONNECT"}
                  </button>
                </div>
              </div>
              <div className={desktopCredentials.status.telegramConfigured ? "connected" : ""}>
                <span>Telegram</span>
                <div>
                  <b>{desktopCredentials.status.telegramConfigured ? "CONNECTED" : "NOT SET"}</b>
                  <button type="button" onClick={() => desktopCredentials.openSetup("telegram")}>
                    {desktopCredentials.status.telegramConfigured ? "EDIT" : "CONNECT"}
                  </button>
                </div>
              </div>
            </div>
            {(!desktopCredentials.status.binanceConfigured ||
              !desktopCredentials.status.ntfyConfigured ||
              !desktopCredentials.status.telegramConfigured) && (
              <button type="button" className="settings-manage-connections" onClick={() => desktopCredentials.openSetup()}>
                SET UP MISSING CONNECTIONS
              </button>
            )}
          </section>}
          {showDesktopConnections && (showBalanceCard || showMarginSection) && <div className="settings-separator" />}

          {showBalanceCard && <section
            className="settings-balance-card"
            aria-label="Available balance"
          >
            <div className="settings-balance-copy">
              <span className="settings-balance-label">Available balance</span>
              <small>USDT futures wallet</small>
            </div>

            <div className="settings-balance-value">
              <strong className={balanceError ? "error" : ""}>
                {isLoadingBalance
                  ? "Loading…"
                  : balanceError
                    ? "Unavailable"
                    : availableBalance !== null
                      ? balanceFormatter.format(availableBalance)
                      : "—"}
              </strong>

              {!isLoadingBalance && !balanceError && (
                <span className="settings-balance-unit">USDT</span>
              )}
            </div>
          </section>}

          {isSearchingSettings && !hasAnySettingsSearchResult && (
            <div className="settings-search-empty">
              No settings match “{settingsSearchQuery.trim()}”.
            </div>
          )}

          {showBalanceCard && (showMarginSection || showDrawingSetsSection || showDrawingsSection || showPnlSection || showAlertsSection || showChartDisplaySection) && (
            <div className="settings-separator" />
          )}

          {showMarginSection && <section className="settings-section">
            <div className="settings-section-heading settings-section-heading-with-action">
              <div>
                <h3>Margin configuration</h3>
                {isMarginSectionVisible && (
                  <p>Select a value to edit it. Changes save automatically.</p>
                )}
              </div>
              <button
                type="button"
                className="settings-section-visibility-button"
                aria-expanded={isSearchingSettings || isMarginSectionVisible}
                onClick={() =>
                  setIsMarginSectionVisible((isVisible) => !isVisible)
                }
              >
                {isSearchingSettings ? "MATCH" : isMarginSectionVisible ? "HIDE" : "SHOW"}
              </button>
            </div>

            {(isSearchingSettings || isMarginSectionVisible) && (
              <>
            {!isBackendConnected && (
              <div className="settings-error settings-backend-warning">
                Backend disconnected — margin settings are read-only until it
                reconnects.
              </div>
            )}

            <div className="settings-fields">
              {(Object.keys(FIELD_META) as SizingField[]).map((field) => {
                const meta = FIELD_META[field];
                if (
                  isSearchingSettings &&
                  !marginSectionTitleMatches &&
                  !matchesSettingsSearch(meta.label, meta.description, field)
                ) {
                  return null;
                }
                const storedValue = draftSizing?.[field];

                const displayValue =
                  field === "margin_pct" && typeof storedValue === "number"
                    ? storedValue * 100
                    : storedValue;

                const isActive = activeField === field;
                const isSaving = savingField === field;
                const isFieldDisabled = !draftSizing || !isBackendConnected;

                return (
                  <label
                    key={field}
                    className={`settings-field ${isActive ? "active" : ""} ${
                      isFieldDisabled ? "disabled" : ""
                    }`}
                  >
                    <div className="settings-field-copy">
                      <span>{meta.label}</span>
                      <small>{meta.description}</small>
                    </div>

                    <div
                      className={`settings-field-value ${
                        field === "margin_pct" ? "percent-field" : ""
                      }`}
                    >
                      <input
                        type="number"
                        value={displayValue ?? ""}
                        step={meta.step}
                        min={meta.min}
                        max={meta.max}
                        disabled={isFieldDisabled}
                        readOnly={!isActive}
                        onClick={() =>
                          isBackendConnected && setActiveField(field)
                        }
                        onFocus={() =>
                          isBackendConnected && setActiveField(field)
                        }
                        onChange={(event) =>
                          changeField(field, event.target.value)
                        }
                        onBlur={() => {
                          setActiveField(null);

                          if (saveTimerRef.current !== null) {
                            saveImmediately(field);
                          }
                        }}
                        onKeyDown={(event) => handleKeyDown(event, field)}
                      />

                      <span className="settings-field-status">
                        {isSaving
                          ? "Saving…"
                          : !isBackendConnected
                            ? "Disconnected"
                            : isActive
                              ? "Editing"
                              : "Edit"}
                      </span>
                    </div>
                  </label>
                );
              })}
            </div>

            {sizingError && (
              <div className="settings-error">{sizingError}</div>
            )}
              </>
            )}
          </section>}

          {showMarginSection && showDrawingSetsSection && <div className="settings-separator" />}

          {showDrawingSetsSection && <section className="settings-section">
            <div className="settings-section-heading settings-section-heading-with-action">
              <div>
                <h3>Drawing sets</h3>
                {isDrawingSetsSectionVisible && (
                  <p>
                    Save named layouts per symbol and switch between them safely.
                  </p>
                )}
              </div>
              <button
                type="button"
                className="settings-section-visibility-button"
                aria-expanded={isSearchingSettings || isDrawingSetsSectionVisible}
                onClick={() =>
                  setIsDrawingSetsSectionVisible((isVisible) => !isVisible)
                }
              >
                {isSearchingSettings ? "MATCH" : isDrawingSetsSectionVisible ? "HIDE" : "SHOW"}
              </button>
            </div>

            {(isSearchingSettings || isDrawingSetsSectionVisible) && (
              <>
            <div className="drawing-set-save-row">
              <input
                type="text"
                className="drawing-set-name-input"
                value={drawingSetName}
                maxLength={48}
                placeholder="name"
                onChange={(event) => {
                  setDrawingSetName(event.target.value);
                  setDrawingSetMessage(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleSaveDrawingSet();
                }}
              />
              <div className="drawing-set-main-actions">
                <button
                  type="button"
                  className="drawing-set-primary-button"
                  disabled={regularDrawingsCount === 0 || !drawingSetName.trim()}
                  onClick={handleSaveDrawingSet}
                >
                  SAVE
                </button>
                <button
                  type="button"
                  className="drawing-set-new-button"
                  disabled={regularDrawingsCount === 0}
                  onClick={handleNewDrawingSet}
                >
                  NEW
                </button>
              </div>
            </div>

            {isNewDrawingSetConfirmationOpen && (
              <div className="drawing-set-new-confirmation">
                <span>Clear current drawings?</span>
                <div className="drawing-set-new-confirmation-actions">
                  <button
                    type="button"
                    className="drawing-set-confirm-new-button"
                    onClick={confirmNewDrawingSet}
                  >
                    YES
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsNewDrawingSetConfirmationOpen(false)}
                  >
                    NO
                  </button>
                </div>
              </div>
            )}

            <div className="drawing-set-current-row">
              <span>
                {regularDrawingsCount} current drawing
                {regularDrawingsCount === 1 ? "" : "s"}
              </span>
              <span className="drawing-set-current-name">
                Active: {drawingSets.find((set) => set.id === activeDrawingSetId)?.name ?? "New / unsaved"}
              </span>
            </div>

            {drawingSetMessage && (
              <div className="drawing-set-message">{drawingSetMessage}</div>
            )}

            <div className="drawing-set-list">
              {drawingSets.length === 0 ? (
                <div className="drawing-set-empty">
                  No saved sets for {currentSymbol}.
                </div>
              ) : (
                drawingSets.map((set) => {
                  const isActive = set.id === activeDrawingSetId;
                  const isRenaming = set.id === renamingDrawingSetId;
                  const isConfirmingDelete = set.id === deleteConfirmationId;

                  return (
                    <div
                      className={`drawing-set-item${isActive ? " is-active" : ""}`}
                      key={set.id}
                    >
                      <div className="drawing-set-item-copy">
                        {isRenaming ? (
                          <input
                            type="text"
                            className="drawing-set-inline-name-input"
                            value={renamingDrawingSetName}
                            maxLength={48}
                            autoFocus
                            onChange={(event) =>
                              setRenamingDrawingSetName(event.target.value)
                            }
                            onBlur={() => commitDrawingSetRename(set.id)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                commitDrawingSetRename(set.id);
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                cancelRenamingDrawingSet();
                              }
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            className="drawing-set-name-button"
                            title={`Rename ${set.name}`}
                            onClick={() => startRenamingDrawingSet(set)}
                          >
                            <strong>{set.name}</strong>
                            {isActive && (
                              <span className="drawing-set-active-badge">ACTIVE</span>
                            )}
                          </button>
                        )}
                        <small>
                          {set.drawings.length} drawing
                          {set.drawings.length === 1 ? "" : "s"}
                        </small>
                      </div>
                      <div className="drawing-set-actions">
                        {isConfirmingDelete ? (
                          <>
                            <button
                              type="button"
                              className="drawing-set-confirm-delete-button"
                              onClick={() => {
                                onDeleteDrawingSet(set.id);
                                setDeleteConfirmationId(null);
                                setDrawingSetMessage(`Deleted “${set.name}”.`);
                              }}
                            >
                              YES
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteConfirmationId(null)}
                            >
                              NO
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              title={`Load ${set.name}`}
                              onClick={() => handleLoadDrawingSet(set.id)}
                            >
                              Load
                            </button>
                            <button
                              type="button"
                              className="drawing-set-delete-button"
                              onClick={() => {
                                setDeleteConfirmationId(set.id);
                                setRenamingDrawingSetId(null);
                                setDrawingSetMessage(null);
                              }}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
              </>
            )}
          </section>}

          {showDrawingSetsSection && showDrawingsSection && <div className="settings-separator" />}

          {/*
           * Split out of what used to be one big "Chart display" section -
           * each of these toggles is a pure local display preference
           * (persisted to localStorage in App.tsx) with no backend concept
           * at all, so none of them need the backendConnection
           * disabled-state treatment the margin fields get. Split into
           * Drawings / PNL / Alerts / Chart display (general) purely to
           * keep this panel scannable as more toggles get added over time
           * - grouping has no functional effect of its own.
           */}
          {showDrawingsSection && <section className="settings-section">
            <div className="settings-section-heading settings-section-heading-with-action">
              <div>
                <h3>Drawings</h3>
              </div>
              <button
                type="button"
                className="settings-section-visibility-button"
                aria-expanded={isSearchingSettings || isDrawingsDisplaySectionVisible}
                onClick={() =>
                  setIsDrawingsDisplaySectionVisible((isVisible) => !isVisible)
                }
              >
                {isSearchingSettings ? "MATCH" : isDrawingsDisplaySectionVisible ? "HIDE" : "SHOW"}
              </button>
            </div>

            {(isSearchingSettings || isDrawingsDisplaySectionVisible) && (
              <>
            {(!isSearchingSettings || drawingsSectionTitleMatches || drawingOptionMatches.showDrawings) && <label className="settings-toggle-field">
              <div className="settings-field-copy">
                <span>Show drawings</span>
                <small>Show all saved drawings on the chart</small>
              </div>

              <input
                type="checkbox"
                className="settings-toggle-input"
                checked={showDrawings}
                onChange={(event) =>
                  onShowDrawingsChange(event.target.checked)
                }
              />
            </label>}

            {(!isSearchingSettings || drawingsSectionTitleMatches || drawingOptionMatches.startOfDay) && <label className="settings-toggle-field">
              <div className="settings-field-copy">
                <span>Start of day candle</span>
                <small>Show a vertical marker at the start of each chart day</small>
              </div>
              <input
                type="checkbox"
                className="settings-toggle-input"
                checked={showStartOfDay}
                onChange={(event) => onShowStartOfDayChange(event.target.checked)}
              />
            </label>}

            {showStartOfDay && (!isSearchingSettings || drawingsSectionTitleMatches || drawingOptionMatches.dayHistory) && (
              <label className="settings-lookback-field">
                <div className="settings-field-copy">
                  <span>Day history</span>
                  <small>Number of chart days to mark (maximum 20)</small>
                </div>
                <div className="settings-lookback-control">
                  <input
                    type="range"
                    min={1}
                    max={20}
                    step={1}
                    value={startOfDayLookbackDays}
                    aria-label="Start of day marker history"
                    onChange={(event) =>
                      onStartOfDayLookbackDaysChange(Number(event.target.value))
                    }
                  />
                  <output>{startOfDayLookbackDays}</output>
                </div>
              </label>
            )}

            {(!isSearchingSettings || drawingsSectionTitleMatches || drawingOptionMatches.asia) && <label className="settings-toggle-field">
              <div className="settings-field-copy">
                <span>Asia session zone</span>
                <small>Show Asia session boundaries on the chart</small>
              </div>
              <input type="checkbox" className="settings-toggle-input" checked={showAsiaSession} onChange={(event) => onShowAsiaSessionChange(event.target.checked)} />
            </label>}

            {(!isSearchingSettings || drawingsSectionTitleMatches || drawingOptionMatches.london) && <label className="settings-toggle-field">
              <div className="settings-field-copy">
                <span>London session zone</span>
                <small>Show London session boundaries on the chart</small>
              </div>
              <input type="checkbox" className="settings-toggle-input" checked={showLondonSession} onChange={(event) => onShowLondonSessionChange(event.target.checked)} />
            </label>}

            {(!isSearchingSettings || drawingsSectionTitleMatches || drawingOptionMatches.newYork || drawingOptionMatches.killZone) && <div className="settings-toggle-field settings-toggle-field-grouped">
              <label className="settings-toggle-group-primary">
                <div className="settings-field-copy">
                  <span>New York session zone</span>
                  <small>Show New York session boundaries on the chart</small>
                </div>
                <input type="checkbox" className="settings-toggle-input" checked={showNewYorkSession} onChange={(event) => onShowNewYorkSessionChange(event.target.checked)} />
              </label>
              <label className={`settings-toggle-suboption ${showNewYorkSession ? "" : "disabled"}`}>
                <div className="settings-field-copy">
                  <span>Show kill zone</span>
                  <small>Highlight 13:00–16:00 in chart time</small>
                </div>
                <input
                  type="checkbox"
                  className="settings-toggle-input"
                  checked={showNewYorkKillZone}
                  disabled={!showNewYorkSession}
                  onChange={(event) => onShowNewYorkKillZoneChange(event.target.checked)}
                />
              </label>
            </div>}
              </>
            )}
          </section>}

          {showDrawingsSection && showPnlSection && <div className="settings-separator" />}

          {showPnlSection && <section className="settings-section">
            <div className="settings-section-heading settings-section-heading-with-action">
              <div>
                <h3>PNL</h3>
              </div>
              <button
                type="button"
                className="settings-section-visibility-button"
                aria-expanded={isSearchingSettings || isPnlSectionVisible}
                onClick={() =>
                  setIsPnlSectionVisible((isVisible) => !isVisible)
                }
              >
                {isSearchingSettings ? "MATCH" : isPnlSectionVisible ? "HIDE" : "SHOW"}
              </button>
            </div>

            {(isSearchingSettings || isPnlSectionVisible) && (
              <>
            {(!isSearchingSettings || pnlSectionTitleMatches || pnlOptionMatches.position) && <label className="settings-toggle-field">
              <div className="settings-field-copy">
                <span>Show PNL</span>
                <small>
                  Show the active symbol's separate <strong>unrealized</strong> and current-position <strong>realized</strong> PNL
                  card on the chart
                </small>
              </div>

              <input
                type="checkbox"
                className="settings-toggle-input"
                checked={showPositionPnl}
                onChange={(event) =>
                  onShowPositionPnlChange(event.target.checked)
                }
              />
            </label>}

            {(!isSearchingSettings || pnlSectionTitleMatches || pnlOptionMatches.total) && <label className="settings-toggle-field">
              <div className="settings-field-copy">
                <span>Show TOTAL PNL</span>
                <small>
                  Show the <strong>unrealized</strong> PNL total across all
                  open positions on the chart
                </small>
              </div>

              <input
                type="checkbox"
                className="settings-toggle-input"
                checked={showTotalPnl}
                onChange={(event) =>
                  onShowTotalPnlChange(event.target.checked)
                }
              />
            </label>}
              </>
            )}
          </section>}

          {showPnlSection && showAlertsSection && <div className="settings-separator" />}

          {showAlertsSection && <section className="settings-section">
            <div className="settings-section-heading settings-section-heading-with-action">
              <div>
                <h3>Alerts</h3>
              </div>
              <button
                type="button"
                className="settings-section-visibility-button"
                aria-expanded={isSearchingSettings || isAlertsSectionVisible}
                onClick={() =>
                  setIsAlertsSectionVisible((isVisible) => !isVisible)
                }
              >
                {isSearchingSettings ? "MATCH" : isAlertsSectionVisible ? "HIDE" : "SHOW"}
              </button>
            </div>

            {(isSearchingSettings || isAlertsSectionVisible) && (
              <>
            {(!isSearchingSettings || alertsSectionTitleMatches || alertOptionMatches.show) && <label className="settings-toggle-field">
              <div className="settings-field-copy">
                <span>Show price alerts</span>
                <small>
                  Show pending price alert lines (see the chart's
                  right-click menu) on the chart
                </small>
              </div>

              <input
                type="checkbox"
                className="settings-toggle-input"
                checked={showPriceAlerts}
                onChange={(event) =>
                  onShowPriceAlertsChange(event.target.checked)
                }
              />
            </label>}

            {(!isSearchingSettings || alertsSectionTitleMatches || alertOptionMatches.persistent) && <label className="settings-toggle-field">
              <div className="settings-field-copy">
                <span>Use persistent alerts</span>
                <small>
                  Store and monitor alerts on the backend, so they remain
                  active and can fire even when this browser tab is closed.
                </small>
              </div>

              <input
                type="checkbox"
                className="settings-toggle-input"
                checked={persistentAlertsEnabled}
                onChange={(event) =>
                  onPersistentAlertsEnabledChange(event.target.checked)
                }
              />
            </label>}

            {/* FEATURE: compact, independently scrollable account-wide alert
                table keeps long alert sets from stretching the settings panel. */}
            {(!isSearchingSettings || alertsSectionTitleMatches || alertOptionMatches.active) && <div className="settings-alert-list-block">
              <div className="settings-alert-list-title">
                <span>Active alerts</span>
                <small>{isLoadingAlerts ? "Loading…" : sortedListedPriceAlerts.length}</small>
              </div>
              {alertsListError && (
                <div className="settings-alert-list-message error">{alertsListError}</div>
              )}
              {sortedListedPriceAlerts.length === 0 && !isLoadingAlerts ? (
                <div className="settings-alert-list-message">No active alerts.</div>
              ) : (
                <div className="settings-alert-list-scroll" role="region" aria-label="Active price alerts" tabIndex={0}>
                  <table className="settings-alert-list-table">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>Price</th>
                        <th>Side</th>
                        <th>Info</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedListedPriceAlerts.map((alert) => (
                        <tr key={alert.id}>
                          <td>{formatSymbolPair(alert.symbol)}</td>
                          <td>{alertPriceFormatter.format(alert.price)}</td>
                          <td>
                            <span className={`settings-alert-side ${alert.side.toLowerCase()}`}>
                              {alert.side}
                            </span>
                          </td>
                          <td title={alert.additionalInfo || undefined}>
                            {alert.additionalInfo || (alert.pattern !== "none" ? alert.pattern.toUpperCase() : "—")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>}
              </>
            )}
          </section>}

          {showAlertsSection && showChartDisplaySection && <div className="settings-separator" />}

          {showChartDisplaySection && <section className="settings-section">
            <div className="settings-section-heading settings-section-heading-with-action">
              <div>
                <h3>Chart display</h3>
              </div>
              <button
                type="button"
                className="settings-section-visibility-button"
                aria-expanded={isSearchingSettings || isChartDisplaySectionVisible}
                onClick={() =>
                  setIsChartDisplaySectionVisible((isVisible) => !isVisible)
                }
              >
                {isSearchingSettings ? "MATCH" : isChartDisplaySectionVisible ? "HIDE" : "SHOW"}
              </button>
            </div>

            {(isSearchingSettings || isChartDisplaySectionVisible) && (
              <>
            {(!isSearchingSettings || chartDisplaySectionTitleMatches || chartDisplayOptionMatches.timer) && <label className="settings-toggle-field">
              <div className="settings-field-copy">
                <span>Show candle timer</span>
                <small>
                  Show the countdown to the current candle's close, top-left
                  of the chart
                </small>
              </div>

              <input
                type="checkbox"
                className="settings-toggle-input"
                checked={showCandleCountdown}
                onChange={(event) =>
                  onShowCandleCountdownChange(event.target.checked)
                }
              />
            </label>}

            {/* FEATURE: watermark visibility belongs with the other chart-only display controls. */}
            {(!isSearchingSettings || chartDisplaySectionTitleMatches || chartDisplayOptionMatches.watermark) && <label className="settings-toggle-field">
              <div className="settings-field-copy">
                <span>Show watermark</span>
                <small>Show the Fyxtez watermark on the chart</small>
              </div>

              <input
                type="checkbox"
                className="settings-toggle-input"
                checked={showWatermark}
                onChange={(event) => onShowWatermarkChange(event.target.checked)}
              />
            </label>}

            {(!isSearchingSettings || chartDisplaySectionTitleMatches || chartDisplayOptionMatches.drawingSetBadge) && <label className="settings-toggle-field">
              <div className="settings-field-copy">
                <span>Show active drawing set</span>
                <small>Show the currently active drawing-set name on the chart</small>
              </div>

              <input
                type="checkbox"
                className="settings-toggle-input"
                checked={showDrawingSetBadge}
                onChange={(event) =>
                  onShowDrawingSetBadgeChange(event.target.checked)
                }
              />
            </label>}

              </>
            )}
          </section>}
        </div>
      </aside>
    </>
  );
}
