import { useEffect, useRef, useState } from "react";
import { intervals, type Interval, type TradingSymbol } from "../../config/constants";
import type { ConnectionState } from "../../hooks/useTradingStream";
import SymbolSwitcher from "../SymbolSwitcher/SymbolSwitcher";
import "./Topbar.css";

type TopbarProps = {
  /** The currently active trading symbol (e.g. "BTCUSDT"). */
  symbol: TradingSymbol;
  /** Every symbol the switcher dropdown should offer. */
  availableSymbols: readonly TradingSymbol[];
  /** Called when the user picks a different symbol from the dropdown. */
  onChangeSymbol: (symbol: TradingSymbol) => void;
  /** Refresh symbol metadata after add/delete. */
  onSymbolRegistryChanged: () => Promise<void>;
  /** Closes that symbol's chart tab (if open) once it's actually been deleted from the registry. */
  onSymbolDeleted: (symbol: TradingSymbol) => void;
  interval: Interval;
  onChangeInterval: (interval: Interval) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
  isOrdersOpen: boolean;
  onToggleOrders: () => void;
  /**
   * Backend REST API health, from useBackendConnection(). Previously only
   * shown inside the drawing toolbar's connection-status-stack, which sits
   * behind the collapsed toolbar's "show toolbar" button and is easy to
   * miss. Rendered here instead so it's visible at all times regardless of
   * whether the toolbar is expanded.
   */
  backendConnection: ConnectionState;
  /** Explicit desktop recovery after native automatic retries are exhausted. */
  onRetryBackend?: () => void;
  /** Trading websocket (order-fill stream) health, from useTradingStream(). */
  websocketConnection: ConnectionState;
  /**
   * Live kline/aggTrade market-data websocket health, from
   * useMarketData()'s marketConnection. Distinct from websocketConnection
   * above (that's the trading/order-fill stream, a completely separate
   * socket to a different endpoint) - this is specifically whether the
   * chart's OWN price/candle feed is alive, since a chart that looks
   * "stuck" with no visible error is otherwise impossible to diagnose
   * from the UI alone.
   */
  marketConnection: ConnectionState;
};

const intervalGroups: { label: string; values: readonly Interval[] }[] = [
  { label: "Minutes", values: ["1m", "5m", "15m"] },
  { label: "Hours", values: ["1h", "4h", "12h"] },
  { label: "Other", values: ["1d", "1w", "1M"] },
];

export default function Topbar({
  symbol,
  availableSymbols,
  onChangeSymbol,
  onSymbolRegistryChanged,
  onSymbolDeleted,
  interval,
  onChangeInterval,
  onZoomIn,
  onZoomOut,
  isSettingsOpen,
  onToggleSettings,
  isOrdersOpen,
  onToggleOrders,
  backendConnection,
  onRetryBackend,
  websocketConnection,
  marketConnection,
}: TopbarProps) {
  const [isIntervalMenuOpen, setIsIntervalMenuOpen] = useState(false);
  const intervalMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isIntervalMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (intervalMenuRef.current && !intervalMenuRef.current.contains(event.target as Node)) {
        setIsIntervalMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsIntervalMenuOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isIntervalMenuOpen]);

  return (
    <div className="topbar">
      <SymbolSwitcher
        symbol={symbol}
        symbols={availableSymbols}
        onChangeSymbol={onChangeSymbol}
        onRegistryChanged={onSymbolRegistryChanged}
        onSymbolDeleted={onSymbolDeleted}
      />

      <div className="buttons desktop-timeframe-buttons">
        {intervals.map((timeframe) => (
          <button
            key={timeframe}
            className={interval === timeframe ? "active" : ""}
            onClick={() => onChangeInterval(timeframe)}
          >
            {timeframe}
          </button>
        ))}

        <div className="topbar-divider" />

        <button onClick={onZoomIn}>+</button>
        <button onClick={onZoomOut}>−</button>
      </div>

      <div className="mobile-timeframe-control" ref={intervalMenuRef}>
        <button
          className={`mobile-timeframe-trigger ${isIntervalMenuOpen ? "open" : ""}`}
          aria-label={`Timeframe ${interval}`}
          aria-expanded={isIntervalMenuOpen}
          onClick={(event) => {
            event.stopPropagation();
            setIsIntervalMenuOpen((open) => !open);
          }}
        >
          <span>{interval}</span>
          <span className="mobile-timeframe-caret" aria-hidden="true">
            ▾
          </span>
        </button>

        {isIntervalMenuOpen && (
          <div className="mobile-timeframe-menu" onClick={(event) => event.stopPropagation()}>
            {intervalGroups.map((group) => (
              <section className="mobile-timeframe-group" key={group.label}>
                <div className="mobile-timeframe-group-label">{group.label}</div>
                <div className="mobile-timeframe-grid">
                  {group.values.map((timeframe) => (
                    <button
                      key={timeframe}
                      className={interval === timeframe ? "active" : ""}
                      onClick={() => {
                        setIsIntervalMenuOpen(false);
                        if (timeframe !== interval) onChangeInterval(timeframe);
                      }}
                    >
                      {timeframe}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      <div className="topbar-spacer" />

      <div className="topbar-connection-group" aria-label="Connection status">
        <button
          type="button"
          className={`topbar-connection-item ${backendConnection}`}
          title={
            backendConnection === "disconnected" && onRetryBackend
              ? "Backend disconnected — click to retry"
              : `Backend: ${backendConnection}`
          }
          disabled={backendConnection !== "disconnected" || !onRetryBackend}
          onClick={onRetryBackend}
        >
          <span className="topbar-connection-dot" />
          <span>BACKEND</span>
        </button>

        <div
          className={`topbar-connection-item ${marketConnection}`}
          title={`Market data (klines): ${marketConnection}`}
        >
          <span className="topbar-connection-dot" />
          <span>MARKET</span>
        </div>

        <div
          className={`topbar-connection-item ${websocketConnection}`}
          title={
            websocketConnection === "disabled"
              ? "Connect Binance in Settings to enable account streaming"
              : `Trading WebSocket: ${websocketConnection}`
          }
        >
          <span className="topbar-connection-dot" />
          <span>{websocketConnection === "disabled" ? "CHART ONLY" : "STREAM"}</span>
        </div>
      </div>

      <button
        className={`orders-button ${isOrdersOpen ? "active" : ""}`}
        title="Positions and open orders"
        onClick={(event) => {
          event.stopPropagation();
          onToggleOrders();
        }}
      >
        <span className="orders-icon">▤</span>
        Orders
      </button>

      <button
        className={`options-button ${isSettingsOpen ? "active" : ""}`}
        title="Options"
        onClick={(event) => {
          event.stopPropagation();
          onToggleSettings();
        }}
      >
        <span className="options-icon">⚙</span>
        Options
      </button>
    </div>
  );
}
