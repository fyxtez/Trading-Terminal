import { useEffect, useState } from "react";
import type { UTCTimestamp } from "lightweight-charts";
import { tradeMarkersStorageKey } from "../config/constants";
import {
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
  const active = filterActiveTradeMarkers(
    loadStoredTradeMarkers(tradeMarkersStorageKey(symbol)),
  );

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
    markers: loadMarkers(normalizedSymbol),
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
    // Do not write the previous symbol's transitional state under the newly
    // selected symbol's storage key.
    if (!isHydrated) return;

    saveTradeMarkers(
      tradeMarkersStorageKey(markerState.symbol),
      markerState.markers,
    );
  }, [isHydrated, markerState]);

  useEffect(() => {
    if (!isHydrated || markers.length === 0) return;

    const delay = millisecondsUntilNextTradeMarkerExpiry(markers);
    if (delay === null) return;

    const id = window.setTimeout(() => {
      setMarkerState((current) => {
        if (current.symbol !== normalizedSymbol) return current;

        const next = filterActiveTradeMarkers(current.markers);
        refs.tradeMarkersRef.current = next;

        return {
          symbol: current.symbol,
          markers: next,
        };
      });
    }, delay);

    return () => window.clearTimeout(id);
  }, [isHydrated, markers, normalizedSymbol, refs.tradeMarkersRef]);

  const addMarker = (fill: MarketOrderFill) => {
    if (!Number.isFinite(fill.time) || !Number.isFinite(fill.price)) return;

    const fillSymbol = normalizeSymbol(fill.symbol);

    // This hook belongs only to the chart's currently selected symbol.
    if (fillSymbol !== normalizedSymbol) return;

    setMarkerState((current) => {
      // Ignore a fill arriving through a stale callback while a symbol switch
      // is in progress. It must never be written into the new symbol's state.
      if (current.symbol !== normalizedSymbol) return current;

      const id = fill.id ?? crypto.randomUUID();
      if (current.markers.some((marker) => marker.id === id)) return current;

      const next = filterActiveTradeMarkers([
        ...current.markers,
        {
          id,
          time: fill.time as UTCTimestamp,
          price: fill.price,
          side: fill.side,
          createdAt: Date.now(),
        },
      ]);

      refs.tradeMarkersRef.current = next;

      return {
        symbol: current.symbol,
        markers: next,
      };
    });
  };

  const addMarkerNow = (side: TradeSide, price?: number) => {
    const fallbackPrice =
      price ??
      refs.currentPriceRef.current ??
      refs.lastCandleRef.current?.close;

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
