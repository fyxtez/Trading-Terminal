import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getSymbolInfo } from "../../config/symbols";
import { getSymbolConfig, type ExchangeSource, type TradingSymbol } from "../../config/constants";
import { addSymbol, deleteSymbol } from "../../trading/api/symbols";
import { clearSymbolLocalMetadata } from "../../utils/symbolMetadata";
import { useFixedPopoverPosition } from "../../hooks/useFixedPopoverPosition";
import SymbolIcon from "../SymbolIcon/SymbolIcon";
import {
  defaultSymbolCategory,
  loadSymbolCategories,
  saveSymbolCategories,
  symbolCategory,
  SYMBOL_CATEGORY_OPTIONS,
  SYMBOL_CATEGORY_ORDER,
  type EditableSymbolCategory,
  type StoredSymbolCategories,
} from "../../config/symbolCategories";
import "./SymbolSwitcher.css";

type SymbolSwitcherProps = {
  symbol: TradingSymbol;
  symbols: readonly TradingSymbol[];
  onChangeSymbol: (symbol: TradingSymbol) => void;
  onRegistryChanged: () => Promise<void>;
  /** Closes that symbol's chart tab (if open) once it's actually been deleted from the registry. */
  onSymbolDeleted: (symbol: TradingSymbol) => void;
};

const SOURCE_LABELS: Record<ExchangeSource, string> = {
  binance: "Binance Futures",
  mexc: "MEXC Futures",
};

function ExchangeLogo({
  source,
  executionEnabled,
}: {
  source: ExchangeSource;
  executionEnabled: boolean;
}) {
  const exchange = SOURCE_LABELS[source];
  const explanation = executionEnabled
    ? `${exchange} market data. Orders execute on ${exchange}.`
    : `${exchange} market data. View only — trading is disabled for this chart.`;

  return (
    <span
      className={`symbol-exchange-logo ${source}`}
      title={explanation}
      aria-label={explanation}
      role="img"
    >
      {source === "binance" ? (
        // Official Binance logomark (four-diamond "B"), per Binance/BNB Chain brand guidelines.
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m7.068 12-2.03 2.03L3.003 12l2.03-2.03zm4.935-4.935 3.482 3.483 2.03-2.03L12.003 3 6.485 8.518l2.03 2.03zm6.964 2.905L16.937 12l2.03 2.03 2.03-2.03zm-6.964 6.965L8.52 13.452l-2.03 2.03L12.003 21l5.512-5.518-2.03-2.03zm0-2.905 2.03-2.03-2.03-2.03L9.967 12z" />
        </svg>
      ) : (
        // Stylized MEXC "M" mark in MEXC's brand blue. No open-license vector of MEXC's exact
        // logomark was available to source verbatim, so this is a close hand-built approximation —
        // swap in MEXC's official SVG asset here if pixel-perfect brand accuracy is required.
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3.2 17.8V8.7c0-1.5 1.2-2.7 2.7-2.7.9 0 1.7.4 2.2 1.1l3.9 5.2 3.9-5.2A2.7 2.7 0 0 1 20.8 8.7v9.1h-3.6v-6.4l-3.8 5a1.8 1.8 0 0 1-2.8 0l-3.8-5v6.4H3.2Z" />
        </svg>
      )}
    </span>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      className={`symbol-pin-icon ${filled ? "filled" : ""}`}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2.5l3.09 6.26 6.91 1-5 4.87 1.18 6.87L12 17.9l-6.18 3.6 1.18-6.87-5-4.87 6.91-1z" />
    </svg>
  );
}

export default function SymbolSwitcher({
  symbol,
  symbols,
  onChangeSymbol,
  onRegistryChanged,
  onSymbolDeleted,
}: SymbolSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [newSymbol, setNewSymbol] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [categories, setCategories] = useState<StoredSymbolCategories>(loadSymbolCategories);
  const [isEditingCategories, setIsEditingCategories] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const highlightedOptionRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const menuStyle = useFixedPopoverPosition(triggerRef, isOpen, 360, 6);
  const info = getSymbolInfo(symbol);
  const activeConfig = getSymbolConfig(symbol);

  useEffect(() => {
    saveSymbolCategories(categories);
  }, [categories]);

  useEffect(() => {
    if (!isOpen) return;

    // Keep desktop keyboard navigation immediate, but do not summon the
    // software keyboard as soon as the menu opens on a phone. It can consume
    // most of the visual viewport before the user has seen any symbols.
    if (window.matchMedia("(pointer: coarse)").matches) return;

    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  const closeMenu = () => {
    // every close path clears transient search/error state so reopening
    // the switcher never shows a failed ticker or its stale backend error.
    setIsOpen(false);
    setNewSymbol("");
    setError(null);
    setHighlightedIndex(0);
  };

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (
        rootRef.current &&
        !rootRef.current.contains(event.target as Node) &&
        !menuRef.current?.contains(event.target as Node)
      ) {
        closeMenu();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const groupedSymbols = useMemo(() => {
    // normalize the search once and match both the short ticker and
    // full display name so typing e.g. "eth" or "ethereum" finds the same row.
    const normalizedSearch = newSymbol.trim().toLocaleLowerCase();

    return SYMBOL_CATEGORY_ORDER.map((category) => ({
      ...category,
      // grouping filters the registry in-place, preserving its order and
      // removing the previous user-selectable sorting behavior entirely.
      symbols: symbols.filter((candidate) => {
        const candidateInfo = getSymbolInfo(candidate);
        const matchesSearch =
          !normalizedSearch ||
          candidateInfo.label.toLocaleLowerCase().includes(normalizedSearch) ||
          candidateInfo.name.toLocaleLowerCase().includes(normalizedSearch);
        if (!matchesSearch) return false;
        if (getSymbolConfig(candidate).protected) return category.value === "primary";
        return symbolCategory(candidate, categories) === category.value;
      }),
    })).filter((group) => group.symbols.length > 0);
  }, [symbols, categories, newSymbol]);

  const matchingSymbols = useMemo(
    () => groupedSymbols.flatMap((group) => group.symbols),
    [groupedSymbols],
  );
  // Add used to be enabled only when the search had zero partial matches.
  // That made one-letter tickers such as D impossible to add whenever an
  // existing symbol (DOGE, MOODENG, ...) happened to contain that letter.
  // Adding is now blocked only by an exact registered base-symbol match.
  const normalizedNewBase = newSymbol
    .trim()
    .toUpperCase()
    .replace(/\/USDT$/, "")
    .replace(/_USDT$/, "")
    .replace(/USDT$/, "");
  const exactRegisteredSymbol = symbols.find(
    (candidate) => getSymbolInfo(candidate).label.toUpperCase() === normalizedNewBase,
  );
  const canAddSymbol = normalizedNewBase.length > 0 && !exactRegisteredSymbol && pending === null;

  useEffect(() => {
    // a changed query starts keyboard navigation at the first visible
    // match, matching the predictable behaviour of native search comboboxes.
    setHighlightedIndex(0);
  }, [newSymbol]);

  useEffect(() => {
    // keep the arrow-key selection visible in long categorized lists.
    highlightedOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  const selectSymbol = (candidate: TradingSymbol) => {
    const isActive = candidate === symbol;
    closeMenu();
    if (!isActive) onChangeSymbol(candidate);
  };

  const setCategory = (candidate: TradingSymbol, category: EditableSymbolCategory) => {
    setCategories((current) => ({ ...current, [candidate]: category }));
  };

  const toggleWatchlist = (candidate: TradingSymbol) => {
    if (getSymbolConfig(candidate).protected) return;
    // the familiar star remains a one-click Watchlist shortcut; a
    // second click returns the symbol to its inferred default category.
    setCategories((current) => ({
      ...current,
      [candidate]:
        (current[candidate] ?? defaultSymbolCategory(candidate)) === "watchlist"
          ? defaultSymbolCategory(candidate)
          : "watchlist",
    }));
  };

  const handleAdd = async () => {
    const value = newSymbol.trim();
    // partial search matches no longer block registration; only an exact
    // existing ticker does. This is what permits one-letter symbols like D.
    if (!value || exactRegisteredSymbol || pending) return;
    setPending("add");
    setError(null);
    try {
      const result = await addSymbol(value);
      await onRegistryChanged();
      setNewSymbol("");
      onChangeSymbol(`${result.symbol.symbol}USDT`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add symbol");
    } finally {
      setPending(null);
    }
  };

  const handleDelete = async (candidate: TradingSymbol) => {
    if (pending) return;
    const candidateInfo = getSymbolInfo(candidate);
    setPending(candidate);
    setError(null);
    try {
      if (candidate === symbol) {
        const fallback = symbols.find((item) => item !== candidate);
        if (fallback) onChangeSymbol(fallback);
      }
      await deleteSymbol(candidateInfo.label);
      clearSymbolLocalMetadata(candidate);
      // remove deleted-symbol category metadata so re-adding the ticker
      // later starts with the current default instead of stale UI state.
      setCategories((current) => {
        const next = { ...current };
        delete next[candidate];
        return next;
      });
      await onRegistryChanged();
      // Now that the delete is confirmed, actually close its tab (if any).
      // useChartTabs no longer auto-prunes tabs against the registry (see
      // its comments) since this app can be pointed at either of two
      // independent backends - so a symbol missing from a sync just means
      // "not on this backend", not "delete its tab". An explicit delete
      // here is the one case that really does mean the tab should go.
      onSymbolDeleted(candidate);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete symbol");
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="symbol-switcher" ref={rootRef}>
      <button
        ref={triggerRef}
        className={`symbol-switcher-trigger ${isOpen ? "open" : ""}`}
        title="Switch chart market"
        onClick={(event) => {
          event.stopPropagation();
          if (isOpen) closeMenu();
          else setIsOpen(true);
        }}
      >
        <SymbolIcon symbol={symbol} className="symbol-switcher-symbol-icon" />
        <span>{info.label}</span>
        <ExchangeLogo
          source={activeConfig.source}
          executionEnabled={activeConfig.executionEnabled}
        />
        <span className="symbol-switcher-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {isOpen &&
        createPortal(
          <div
            className="symbol-switcher-menu"
            ref={menuRef}
            style={menuStyle ?? { visibility: "hidden" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="symbol-category-toolbar">
              <span>Grouped by category</span>
              <button
                type="button"
                className={isEditingCategories ? "active" : ""}
                aria-pressed={isEditingCategories}
                onClick={() => setIsEditingCategories((editing) => !editing)}
              >
                {isEditingCategories ? "Done" : "Edit categories"}
              </button>
            </div>

            <div className="symbol-switcher-list">
              {groupedSymbols.map((group) => (
                <section
                  className="symbol-category-group"
                  key={group.value}
                  aria-labelledby={`symbol-category-${group.value}`}
                >
                  <h3 id={`symbol-category-${group.value}`} className="symbol-category-heading">
                    <span>{group.label}</span>
                    <span aria-hidden="true" />
                  </h3>
                  {group.symbols.map((candidate) => {
                    const candidateInfo = getSymbolInfo(candidate);
                    const config = getSymbolConfig(candidate);
                    const isActive = candidate === symbol;
                    const category = symbolCategory(candidate, categories);
                    const isWatchlisted = category === "watchlist";
                    const candidateIndex = matchingSymbols.indexOf(candidate);
                    const isHighlighted = candidateIndex === highlightedIndex;
                    return (
                      <div
                        key={candidate}
                        ref={isHighlighted ? highlightedOptionRef : undefined}
                        className={`symbol-switcher-option ${isActive ? "active" : ""} ${isHighlighted ? "keyboard-highlighted" : ""}`}
                      >
                        {config.protected ? (
                          <span
                            className="symbol-pin-button locked"
                            title="Primary market — category locked"
                            aria-label={`${candidateInfo.label} is a primary market`}
                          >
                            <StarIcon filled />
                          </span>
                        ) : (
                          <button
                            className="symbol-pin-button"
                            title={
                              isWatchlisted
                                ? `Remove ${candidateInfo.label} from Watchlist`
                                : `Add ${candidateInfo.label} to Watchlist`
                            }
                            aria-label={
                              isWatchlisted
                                ? `Remove ${candidateInfo.label} from Watchlist`
                                : `Add ${candidateInfo.label} to Watchlist`
                            }
                            aria-pressed={isWatchlisted}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleWatchlist(candidate);
                            }}
                          >
                            <StarIcon filled={isWatchlisted} />
                          </button>
                        )}
                        <button
                          className="symbol-switcher-select"
                          onClick={() => selectSymbol(candidate)}
                        >
                          <span className="symbol-switcher-option-symbol">
                            <SymbolIcon symbol={candidate} />
                            <span className="symbol-switcher-option-label">
                              {candidateInfo.label}
                            </span>
                          </span>
                          <span className="symbol-switcher-option-name">{candidateInfo.name}</span>
                        </button>
                        <div className="symbol-switcher-option-actions">
                          {isEditingCategories && !config.protected && (
                            <select
                              className="symbol-category-select"
                              value={category}
                              aria-label={`Category for ${candidateInfo.label}`}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) =>
                                setCategory(candidate, event.target.value as EditableSymbolCategory)
                              }
                            >
                              {SYMBOL_CATEGORY_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          )}
                          <ExchangeLogo
                            source={config.source}
                            executionEnabled={config.executionEnabled}
                          />
                          {!config.protected && (
                            <button
                              className="symbol-delete-button"
                              title={`Delete ${candidateInfo.label}`}
                              aria-label={`Delete ${candidateInfo.label}`}
                              disabled={pending !== null}
                              onClick={() => void handleDelete(candidate)}
                            >
                              <span aria-hidden="true">×</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </section>
              ))}
              {groupedSymbols.length === 0 && (
                // explain an empty filtered list instead of leaving the
                // menu visually blank when no registered symbol contains the text.
                <div className="symbol-search-empty">No matching symbols — ready to add</div>
              )}
            </div>

            <div className="symbol-add-row">
              {/* one field now searches registered symbols as the user
                types and becomes an Add-symbol input only when nothing matches. */}
              <input
                ref={searchInputRef}
                value={newSymbol}
                disabled={pending !== null}
                placeholder="Search or add symbol"
                aria-label="Search or add symbol"
                onChange={(event) => {
                  setNewSymbol(event.target.value.toUpperCase());
                  // editing after a failed Add immediately removes the old
                  // message because it no longer describes the current query.
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" && matchingSymbols.length > 0) {
                    event.preventDefault();
                    setHighlightedIndex((index) => (index + 1) % matchingSymbols.length);
                  } else if (event.key === "ArrowUp" && matchingSymbols.length > 0) {
                    event.preventDefault();
                    setHighlightedIndex(
                      (index) => (index - 1 + matchingSymbols.length) % matchingSymbols.length,
                    );
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    // when the typed ticker is not already registered, Enter
                    // means Add even if partial search results are visible. Exact existing
                    // tickers still open normally; arrows can be used for partial matches.
                    if (exactRegisteredSymbol) selectSymbol(exactRegisteredSymbol);
                    else void handleAdd();
                  }
                }}
              />
              <button
                className="symbol-add-button"
                disabled={!canAddSymbol}
                onClick={() => void handleAdd()}
              >
                {pending === "add" ? "…" : "Add"}
              </button>
            </div>
            {error && (
              <div className="symbol-switcher-error" title={error}>
                {error}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
