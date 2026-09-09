import { useEffect, useState } from "react";
import { tradeMarkersStorageKey } from "../config/constants";
import {
  TRADE_MARKERS_CHANGED_EVENT,
  appendTradeMarkerForSymbol,
  filterActiveTradeMarkers,
  loadStoredTradeMarkers,
  millisecondsUntilNextTradeMarkerExpiry,
  saveTradeMarkers,
} from "../utils/tradeMarkers";
import type { MarketOrderFill, TradeMarker, TradeSide } from "../trading/types";
import type { ChartRefs } from "./useChartRefs";

type SymbolMarkerState = {
  symbol: string;
  markers: TradeMarker[];
};

const normalizeSymbol = (symbol: string) => symbol.toUpperCase();

function loadMarkers(symbol: string): TradeMarker[] {
  const active = filterActiveTradeMarkers(loadStoredTradeMarkers(tradeMarkersStorageKey(symbol)));

  saveTradeMarkers(tradeMarkersStorageKey(symbol), active);
  return active;
}

/**
 * Owns the chart's B/S execution markers.
 *
 * The symbol is stored together with the marker array deliberately. React
 * renders once with the new symbol before effects run, while ordinary state
 * still contains the previous symbol's value. Keeping the owner symbol beside
 * the array lets us expose an empty list during that transition instead of
 * publishing/saving BTC markers as SOL markers (or vice versa).
 */
export function useTradeMarkers(refs: ChartRefs, symbol: string) {
  const normalizedSymbol = normalizeSymbol(symbol);

  const [markerState, setMarkerState] = useState<SymbolMarkerState>(() => ({
    symbol: normalizedSymbol,
    markers: filterActiveTradeMarkers(
      loadStoredTradeMarkers(tradeMarkersStorageKey(normalizedSymbol)),
    ),
  }));

  const isHydrated = markerState.symbol === normalizedSymbol;
  const markers = isHydrated ? markerState.markers : [];

  // The canvas and PositionBracketOverlay read this ref directly. Never leave
  // the previous symbol's markers in it while the new symbol is hydrating.
  if (isHydrated) {
    if (refs.tradeMarkersRef.current !== markerState.markers) {
      refs.tradeMarkersRef.current = markerState.markers;
    }
  } else if (refs.tradeMarkersRef.current.length !== 0) {
    refs.tradeMarkersRef.current = [];
  }

  useEffect(() => {
    const next = loadMarkers(normalizedSymbol);

    refs.tradeMarkersRef.current = next;
    setMarkerState({
      symbol: normalizedSymbol,
      markers: next,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalizedSymbol]);

  useEffect(() => {
    const update = () => {
      const next = filterActiveTradeMarkers(
        loadStoredTradeMarkers(tradeMarkersStorageKey(normalizedSymbol)),
      );
      refs.tradeMarkersRef.current = next;
      setMarkerState({ symbol: normalizedSymbol, markers: next });
    };
    const receive = (event: Event) => {
      if (
        (event as CustomEvent<{ storageKey: string }>).detail.storageKey ===
        tradeMarkersStorageKey(normalizedSymbol)
      )
        update();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === tradeMarkersStorageKey(normalizedSymbol)) update();
    };
    window.addEventListener(TRADE_MARKERS_CHANGED_EVENT, receive);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener(TRADE_MARKERS_CHANGED_EVENT, receive);
      window.removeEventListener("storage", storage);
    };
  }, [normalizedSymbol, refs.tradeMarkersRef]);

  useEffect(() => {
    if (!isHydrated || markers.length === 0) return;

    const delay = millisecondsUntilNextTradeMarkerExpiry(markers);
    if (delay === null) return;

    const id = window.setTimeout(() => {
      saveTradeMarkers(
        tradeMarkersStorageKey(normalizedSymbol),
        filterActiveTradeMarkers(loadStoredTradeMarkers(tradeMarkersStorageKey(normalizedSymbol))),
      );
    }, delay);

    return () => window.clearTimeout(id);
  }, [isHydrated, markers, normalizedSymbol, refs.tradeMarkersRef]);

  const addMarker = (fill: MarketOrderFill) => {
    if (!Number.isFinite(fill.time) || !Number.isFinite(fill.price)) return;

    const fillSymbol = normalizeSymbol(fill.symbol);

    // This hook belongs only to the chart's currently selected symbol.
    if (fillSymbol !== normalizedSymbol) return;

    appendTradeMarkerForSymbol(normalizedSymbol, fill);
  };

  const addMarkerNow = (side: TradeSide, price?: number) => {
    const fallbackPrice =
      price ?? refs.currentPriceRef.current ?? refs.lastCandleRef.current?.close;

    if (fallbackPrice == null || !Number.isFinite(fallbackPrice)) return;

    addMarker({
      symbol: normalizedSymbol,
      side,
      time: Math.floor(Date.now() / 1000),
      price: fallbackPrice,
    });
  };

  const clearMarkers = () => {
    refs.tradeMarkersRef.current = [];
    setMarkerState({
      symbol: normalizedSymbol,
      markers: [],
    });
    saveTradeMarkers(tradeMarkersStorageKey(normalizedSymbol), []);
  };

  return {
    markers,
    isHydrated,
    addMarker,
    addMarkerNow,
    clearMarkers,
  };
}

export type TradeMarkersApi = ReturnType<typeof useTradeMarkers>;
