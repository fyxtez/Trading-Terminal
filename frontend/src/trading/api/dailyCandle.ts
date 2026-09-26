import type { CandlestickData } from "lightweight-charts";
import { fetchLatestKline } from "./marketData";
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
