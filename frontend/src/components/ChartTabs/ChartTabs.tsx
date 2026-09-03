import { useEffect, useMemo, useRef, useState } from "react";
import { getSymbolConfig, type TradingSymbol } from "../../config/constants";
import { getSymbolInfo } from "../../config/symbols";
import { useViewportClampOffset } from "../../hooks/useViewportClampOffset";
import SymbolIcon from "../SymbolIcon/SymbolIcon";
import {
  loadSymbolCategories,
  symbolCategory,
  SYMBOL_CATEGORY_ORDER,
} from "../../config/symbolCategories";
import "./ChartTabs.css";

type ChartTabsProps = {
  tabs: readonly TradingSymbol[];
  activeSymbol: TradingSymbol;
  availableToOpen: readonly TradingSymbol[];
  onActivate: (symbol: TradingSymbol) => void;
  onOpen: (symbol: TradingSymbol) => void;
  onClose: (symbol: TradingSymbol) => void;
  onCloseOthers: (symbol: TradingSymbol) => void;
  onDeleteTracked: (symbol: TradingSymbol) => Promise<void>;
  onReorder: (draggedSymbol: TradingSymbol, targetSymbol: TradingSymbol) => void;
};

export default function ChartTabs({
  tabs,
  activeSymbol,
  availableToOpen,
  onActivate,
  onOpen,
  onClose,
  onCloseOthers,
  onDeleteTracked,
  onReorder,
}: ChartTabsProps) {
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const [addHighlightedIndex, setAddHighlightedIndex] = useState(0);
  const [categories, setCategories] = useState(loadSymbolCategories);
  const [draggedSymbol, setDraggedSymbol] = useState<TradingSymbol | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<{
    symbol: TradingSymbol;
    x: number;
    y: number;
  } | null>(null);
  const [deletingSymbol, setDeletingSymbol] = useState<TradingSymbol | null>(null);
  const [deleteConfirmSymbol, setDeleteConfirmSymbol] = useState<TradingSymbol | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const addMenuPopoverRef = useRef<HTMLDivElement | null>(null);
  const addSearchRef = useRef<HTMLInputElement | null>(null);
  const addHighlightedOptionRef = useRef<HTMLButtonElement | null>(null);
  const tabContextMenuRef = useRef<HTMLDivElement | null>(null);
  // With few tabs open, the "+" button (and this popover's anchor) can sit
  // far from the screen edge - see useViewportClampOffset for why that
  // otherwise clips the icon/ticker columns off-screen.
  const addMenuOffset = useViewportClampOffset(addMenuPopoverRef, isAddOpen);

  const groupedAvailableSymbols = useMemo(() => {
    // the chart-tab picker now mirrors the main symbol switcher's
    // category order and saved assignments instead of presenting one flat list.
    const query = addSearch.trim().toLocaleLowerCase();
    return SYMBOL_CATEGORY_ORDER.map((category) => ({
      ...category,
      symbols: availableToOpen.filter((symbol) => {
        const info = getSymbolInfo(symbol);
        // tab search matches both ticker and full display name so
        // users can find e.g. ETH by typing either "ETH" or "Ethereum".
        const matchesSearch =
          !query ||
          info.label.toLocaleLowerCase().includes(query) ||
          info.name.toLocaleLowerCase().includes(query);
        return matchesSearch && symbolCategory(symbol, categories) === category.value;
      }),
    })).filter((category) => category.symbols.length > 0);
  }, [availableToOpen, categories, addSearch]);

  const availableSymbolsInDisplayOrder = useMemo(
    () => groupedAvailableSymbols.flatMap((group) => group.symbols),
    [groupedAvailableSymbols],
  );

  useEffect(() => {
    if (!isAddOpen) return;

    // wait until the popover/input has actually mounted before focusing it.
    // This makes opening the + picker immediately keyboard-ready on every render.
    const frame = window.requestAnimationFrame(() => addSearchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isAddOpen]);

  useEffect(() => {
    // every new filter starts arrow-key navigation at the first visible
    // symbol, matching the main symbol switcher's predictable keyboard behavior.
    setAddHighlightedIndex(0);
  }, [addSearch]);

  useEffect(() => {
    // keep the keyboard-selected symbol visible while navigating a long
    // categorized list without moving focus away from the search input.
    addHighlightedOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [addHighlightedIndex]);

  const openSymbolFromAddMenu = (symbol: TradingSymbol) => {
    setIsAddOpen(false);
    setAddSearch("");
    setAddHighlightedIndex(0);
    onOpen(symbol);
  };

  useEffect(() => {
    if (!isAddOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(event.target as Node)) {
        setIsAddOpen(false);
        setAddSearch("");
        setAddHighlightedIndex(0);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsAddOpen(false);
        setAddSearch("");
        setAddHighlightedIndex(0);
      }
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isAddOpen]);

  useEffect(() => {
    if (!tabContextMenu) return;

    const closeContextMenu = (event: PointerEvent) => {
      // this listener runs in capture phase, before React button handlers.
      // The old unconditional close unmounted the menu on pointer-down, so the
      // later Click for Close/Delete never existed. Ignore presses inside the
      // menu and only dismiss when the pointer really lands outside it.
      if (tabContextMenuRef.current?.contains(event.target as Node)) return;
      setTabContextMenu(null);
      setDeleteConfirmSymbol(null);
      setDeleteError(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setTabContextMenu(null);
        setDeleteConfirmSymbol(null);
        setDeleteError(null);
      }
    };

    // the tab context menu acts like a native compact menu: clicking
    // anywhere else or pressing Escape dismisses it without affecting charts.
    window.addEventListener("pointerdown", closeContextMenu, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", closeContextMenu, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [tabContextMenu]);

  return (
    <div className="chart-tabs-bar" aria-label="Open chart tabs">
      <div className="chart-tabs-scroll">
        {tabs.map((symbol) => {
          const info = getSymbolInfo(symbol);
          const config = getSymbolConfig(symbol);
          const active = symbol === activeSymbol;

          return (
            <div
              key={symbol}
              className={`chart-tab ${active ? "active" : ""} ${draggedSymbol === symbol ? "dragging" : ""}`}
              draggable
              onDragStart={(event) => {
                setDraggedSymbol(symbol);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", symbol);
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                if (draggedSymbol && draggedSymbol !== symbol) {
                  onReorder(draggedSymbol, symbol);
                }
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDraggedSymbol(null);
              }}
              onDragEnd={() => setDraggedSymbol(null)}
              onDoubleClick={() => onCloseOthers(symbol)}
              onContextMenu={(event) => {
                // right-clicking a chart tab opens an app-owned menu
                // instead of the browser context menu, exposing Close vs Delete
                // as two intentionally different operations.
                event.preventDefault();
                event.stopPropagation();
                setDeleteConfirmSymbol(null);
                setDeleteError(null);
                setTabContextMenu({ symbol, x: event.clientX, y: event.clientY });
              }}
            >
              <button
                className="chart-tab-select"
                onClick={() => onActivate(symbol)}
                title={`${info.name} · ${config.source === "binance" ? "Binance" : "MEXC"}${active ? " · active" : ""}`}
              >
                <SymbolIcon symbol={symbol} className="chart-tab-symbol-icon" />
                <span>{info.label}</span>
              </button>

              <button
                className="chart-tab-close"
                aria-label={`Close ${info.label} chart tab`}
                title={
                  tabs.length === 1 && availableToOpen.length === 0
                    ? "At least one chart tab must remain open"
                    : `Close ${info.label}`
                }
                disabled={tabs.length === 1 && availableToOpen.length === 0}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(symbol);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      <div className="chart-tab-add-wrap" ref={addMenuRef}>
        <button
          className="chart-tab-add"
          aria-label="Open another chart tab"
          title="Open chart tab"
          disabled={availableToOpen.length === 0}
          onClick={(event) => {
            event.stopPropagation();
            setIsAddOpen((open) => {
              // categories may have changed in the symbol switcher since
              // this menu last rendered; reload them whenever it is opened.
              if (!open) {
                setCategories(loadSymbolCategories());
                setAddSearch("");
                setAddHighlightedIndex(0);
              }
              return !open;
            });
          }}
        >
          +
        </button>

        {isAddOpen && availableToOpen.length > 0 && (
          <div
            className="chart-tab-add-menu"
            ref={addMenuPopoverRef}
            style={addMenuOffset ? { transform: `translateX(${addMenuOffset}px)` } : undefined}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="chart-tab-add-search-wrap">
              <input
                ref={addSearchRef}
                className="chart-tab-add-search"
                value={addSearch}
                onChange={(event) => setAddSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" && availableSymbolsInDisplayOrder.length > 0) {
                    event.preventDefault();
                    event.stopPropagation();
                    setAddHighlightedIndex(
                      (index) => (index + 1) % availableSymbolsInDisplayOrder.length,
                    );
                  } else if (event.key === "ArrowUp" && availableSymbolsInDisplayOrder.length > 0) {
                    event.preventDefault();
                    event.stopPropagation();
                    setAddHighlightedIndex(
                      (index) =>
                        (index - 1 + availableSymbolsInDisplayOrder.length) %
                        availableSymbolsInDisplayOrder.length,
                    );
                  } else if (event.key === "Enter" && availableSymbolsInDisplayOrder.length > 0) {
                    event.preventDefault();
                    event.stopPropagation();
                    // Enter opens the currently highlighted search result
                    // while focus stays in the input for fast keyboard-only tab creation.
                    const highlighted =
                      availableSymbolsInDisplayOrder[addHighlightedIndex] ??
                      availableSymbolsInDisplayOrder[0];
                    if (highlighted) openSymbolFromAddMenu(highlighted);
                  }
                }}
                placeholder="Search symbol"
                aria-label="Search symbols to open"
              />
            </div>
            {groupedAvailableSymbols.map((group) => (
              <section className="chart-tab-add-category" key={group.value}>
                <h3 className="chart-tab-add-category-heading">
                  <span>{group.label}</span>
                  <span aria-hidden="true" />
                </h3>
                {group.symbols.map((symbol) => {
                  const info = getSymbolInfo(symbol);
                  const symbolIndex = availableSymbolsInDisplayOrder.indexOf(symbol);
                  const isHighlighted = symbolIndex === addHighlightedIndex;
                  return (
                    <button
                      key={symbol}
                      ref={isHighlighted ? addHighlightedOptionRef : undefined}
                      className={isHighlighted ? "keyboard-highlighted" : undefined}
                      onMouseEnter={() => setAddHighlightedIndex(symbolIndex)}
                      onClick={() => openSymbolFromAddMenu(symbol)}
                    >
                      <SymbolIcon symbol={symbol} className="chart-tab-add-icon" />
                      <span className="chart-tab-add-label">{info.label}</span>
                      <span className="chart-tab-add-name">{info.name}</span>
                    </button>
                  );
                })}
              </section>
            ))}
            {groupedAvailableSymbols.length === 0 && (
              <div className="chart-tab-add-empty">No matching symbols</div>
            )}
          </div>
        )}
      </div>

      {tabContextMenu &&
        (() => {
          const menuInfo = getSymbolInfo(tabContextMenu.symbol);
          return (
            <div
              ref={tabContextMenuRef}
              className="chart-tab-context-menu"
              style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <button
                type="button"
                disabled={tabs.length === 1 && availableToOpen.length === 0}
                onClick={() => {
                  // closing the only visible tab is still useful when
                  // other tracked symbols exist; useChartTabs swaps in a tracked
                  // fallback instead of leaving the workspace without a chart.
                  onClose(tabContextMenu.symbol);
                  setTabContextMenu(null);
                  setDeleteConfirmSymbol(null);
                }}
              >
                Close
              </button>

              {deleteConfirmSymbol === tabContextMenu.symbol ? (
                <div
                  className="chart-tab-delete-confirm"
                  role="group"
                  aria-label={`Delete ${menuInfo.label}?`}
                >
                  <div className="chart-tab-delete-confirm-label">Delete {menuInfo.label}?</div>
                  <div className="chart-tab-delete-confirm-actions">
                    <button
                      type="button"
                      className="danger"
                      disabled={deletingSymbol !== null}
                      onClick={() => {
                        const symbol = tabContextMenu.symbol;
                        setDeletingSymbol(symbol);
                        setDeleteError(null);
                        // only the explicit Yes action may call the backend.
                        // A successful DELETE also removes the chart tab in App.tsx;
                        // failures leave the confirmation open so the user can retry.
                        void onDeleteTracked(symbol)
                          .then(() => {
                            setTabContextMenu(null);
                            setDeleteConfirmSymbol(null);
                          })
                          .catch((error: unknown) => {
                            setDeleteError(
                              error instanceof Error
                                ? error.message
                                : `Could not delete ${menuInfo.label}`,
                            );
                          })
                          .finally(() => setDeletingSymbol(null));
                      }}
                    >
                      {deletingSymbol === tabContextMenu.symbol ? "Deleting…" : "Yes"}
                    </button>
                    <button
                      type="button"
                      disabled={deletingSymbol !== null}
                      onClick={() => {
                        setDeleteConfirmSymbol(null);
                        setDeleteError(null);
                      }}
                    >
                      No
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="danger"
                  disabled={deletingSymbol !== null}
                  onClick={() => {
                    // Delete is intentionally two-step because it removes
                    // the ticker from backend tracking, not just from this UI tab.
                    setDeleteConfirmSymbol(tabContextMenu.symbol);
                    setDeleteError(null);
                  }}
                >
                  Delete
                </button>
              )}

              {deleteError && <div className="chart-tab-context-error">{deleteError}</div>}
            </div>
          );
        })()}
    </div>
  );
}
