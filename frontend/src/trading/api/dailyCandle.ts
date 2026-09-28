import type { CandlestickData } from "lightweight-charts";
import { fetchLatestKline, fetchOlderKlines } from "./marketData";
import { SnapshotCache } from "./snapshotCache";

const snapshots = new Map<string, SnapshotCache<CandlestickData | null>>();

/** Share daily reads across chart panes and remounts; a cancelled reader cannot restart the request. */
export function getDailyCandle(symbol: string, signal?: AbortSignal) {
  const key = symbol.toUpperCase();
  let cache = snapshots.get(key);
  if (!cache) {
    cache = new SnapshotCache<CandlestickData | null>(1_000);
    snapshots.set(key, cache);
  }
  return cache.get(() => fetchLatestKline("1d", key, AbortSignal.timeout(15_000)), false, signal);
}

const yesterdaySnapshots = new Map<
  string,
  { day: number; cache: SnapshotCache<CandlestickData | null> }
>();

/** Cache completed daily candles across panes, refreshing the selection at UTC midnight. */
export function getYesterdayDailyCandle(symbol: string, signal?: AbortSignal) {
  const key = symbol.toUpperCase();
  const day = Math.floor(Date.now() / 86_400_000) * 86_400;
  let entry = yesterdaySnapshots.get(key);
  if (!entry || entry.day !== day) {
    entry = { day, cache: new SnapshotCache<CandlestickData | null>(60_000) };
    yesterdaySnapshots.set(key, entry);
  }
  return entry.cache.get(
    async () => {
      const candles = await fetchOlderKlines("1d", key, day * 1000, 1);
      return candles.find((candle) => candle.time === day - 86_400) ?? null;
    },
    false,
    signal,
  );
}
