import type { CandlestickData, UTCTimestamp } from "lightweight-charts";
import {
  getSymbolConfig,
  intervalMs,
  TRADING_API_BASE_URL,
  TRADING_API_TOKEN,
  type Interval,
  type SymbolConfig,
} from "../../config/constants";

const BINANCE_KLINE_LIMIT = 1500;
const MEXC_KLINE_LIMIT = 2000;
const MEXC_PROXY_PATH = "/api/market-data/mexc/klines";
const MEXC_INTERVALS: Record<Interval, string> = {
  "1m": "Min1",
  "5m": "Min5",
  "15m": "Min15",
  "1h": "Min60",
  "4h": "Hour4",
  // MEXC does not expose 12h directly; fetch 4h and aggregate groups of 3.
  "12h": "Hour4",
  "1d": "Day1",
  "1w": "Week1",
  "1M": "Month1",
};

type MexcKlinePayload = {
  success?: boolean;
  code?: number;
  message?: string;
  data?: {
    time?: unknown[];
    open?: unknown[];
    high?: unknown[];
    low?: unknown[];
    close?: unknown[];
  };
};

function normalizeCandles(candles: CandlestickData[]): CandlestickData[] {
  const byTime = new Map<number, CandlestickData>();

  for (const candle of candles) {
    const time = Number(candle.time);
    if (Number.isFinite(time)) byTime.set(time, candle);
  }

  return [...byTime.values()].sort((a, b) => Number(a.time) - Number(b.time));
}

function aggregateCandles(
  candles: CandlestickData[],
  targetIntervalMs: number,
): CandlestickData[] {
  const buckets = new Map<number, CandlestickData[]>();

  for (const candle of candles) {
    const seconds = Number(candle.time);
    const bucketSeconds = Math.floor((seconds * 1000) / targetIntervalMs) *
      (targetIntervalMs / 1000);
    const group = buckets.get(bucketSeconds) ?? [];
    group.push(candle);
    buckets.set(bucketSeconds, group);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([time, group]) => ({
      time: time as UTCTimestamp,
      open: group[0].open,
      high: Math.max(...group.map((candle) => candle.high)),
      low: Math.min(...group.map((candle) => candle.low)),
      close: group[group.length - 1].close,
    }));
}

function parseMexcKlines(payload: MexcKlinePayload): CandlestickData[] {
  if (payload.success === false || (payload.code ?? 0) !== 0) {
    throw new Error(payload.message || `MEXC kline request failed (${payload.code})`);
  }

  const data = payload.data;
  if (!data) return [];

  const length = Math.min(
    data.time?.length ?? 0,
    data.open?.length ?? 0,
    data.high?.length ?? 0,
    data.low?.length ?? 0,
    data.close?.length ?? 0,
  );

  const candles: CandlestickData[] = [];
  for (let index = 0; index < length; index += 1) {
    const time = Number(data.time?.[index]);
    const open = Number(data.open?.[index]);
    const high = Number(data.high?.[index]);
    const low = Number(data.low?.[index]);
    const close = Number(data.close?.[index]);

    if (![time, open, high, low, close].every(Number.isFinite)) continue;
    candles.push({ time: time as UTCTimestamp, open, high, low, close });
  }

  return normalizeCandles(candles);
}

async function fetchMexcRange(
  config: SymbolConfig,
  selectedInterval: Interval,
  startSeconds?: number,
  endSeconds?: number,
): Promise<CandlestickData[]> {
  const normalizedStart = startSeconds === undefined
    ? undefined
    : Math.max(0, Math.floor(startSeconds));
  const normalizedEnd = endSeconds === undefined
    ? undefined
    : Math.max(0, Math.floor(endSeconds));

  // Large requested histories on weekly/monthly charts can extend farther
  // back than the Unix epoch. Do not send an invalid `start=0&end=0` range
  // to the backend when that happens; that range simply contains no candles.
  if (normalizedStart !== undefined && normalizedEnd !== undefined &&
      normalizedStart >= normalizedEnd) {
    return [];
  }

  const params = new URLSearchParams({ interval: MEXC_INTERVALS[selectedInterval] });
  if (normalizedStart !== undefined) params.set("start", String(normalizedStart));
  if (normalizedEnd !== undefined) params.set("end", String(normalizedEnd));

  params.set("symbol", config.sourceSymbol);

  const headers: HeadersInit = { Accept: "application/json" };
  if (TRADING_API_TOKEN) {
    headers.Authorization = `Bearer ${TRADING_API_TOKEN}`;
  }

  const response = await fetch(
    `${TRADING_API_BASE_URL}${MEXC_PROXY_PATH}?${params.toString()}`,
    { headers },
  );

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json() as { error?: unknown; message?: unknown };
      if (typeof body.error === "string") detail = body.error;
      else if (typeof body.message === "string") detail = body.message;
    } catch {
      // Keep the HTTP fallback when the proxy returns a non-JSON body.
    }
    throw new Error(`MEXC kline request failed: ${detail}`);
  }

  return parseMexcKlines((await response.json()) as MexcKlinePayload);
}

async function fetchBinanceKlines(
  config: SymbolConfig,
  selectedInterval: Interval,
  total: number,
): Promise<CandlestickData[]> {
  const numChunks = Math.ceil(total / BINANCE_KLINE_LIMIT);
  const stepMs = intervalMs[selectedInterval];
  const now = Date.now();

  const chunks = await Promise.all(
    Array.from({ length: numChunks }, async (_, chunkIndex) => {
      const newer = chunkIndex * BINANCE_KLINE_LIMIT;
      const limit = Math.min(BINANCE_KLINE_LIMIT, total - newer);
      const params = new URLSearchParams({
        symbol: config.sourceSymbol,
        interval: selectedInterval,
        limit: String(limit),
      });

      if (chunkIndex > 0) {
        const endTime = now - newer * stepMs - 1;
        if (endTime <= 0) return [];
        params.set("endTime", String(endTime));
      }

      const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?${params}`);
      if (!response.ok) throw new Error(`Binance kline request failed: ${response.status}`);
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    }),
  );

  return normalizeCandles(
    chunks.flat().map((kline: unknown[]): CandlestickData => ({
      time: Math.floor(Number(kline[0]) / 1000) as UTCTimestamp,
      open: Number(kline[1]),
      high: Number(kline[2]),
      low: Number(kline[3]),
      close: Number(kline[4]),
    })),
  );
}

async function fetchMexcKlines(
  config: SymbolConfig,
  selectedInterval: Interval,
  total: number,
): Promise<CandlestickData[]> {
  const rawStepMs = selectedInterval === "12h" ? intervalMs["4h"] : intervalMs[selectedInterval];
  const rawTotal = selectedInterval === "12h" ? total * 3 : total;
  const requests = Math.ceil(rawTotal / MEXC_KLINE_LIMIT);
  const endSeconds = Math.floor(Date.now() / 1000);

  const rangeSeconds = Math.floor((MEXC_KLINE_LIMIT * rawStepMs) / 1000);
  const ranges: Array<{ start: number; end: number }> = [];

  for (let index = 0; index < requests; index += 1) {
    const chunkEnd = endSeconds - index * rangeSeconds;
    if (chunkEnd <= 0) break;

    const chunkStart = Math.max(0, chunkEnd - rangeSeconds);
    if (chunkStart >= chunkEnd) break;

    ranges.push({ start: chunkStart, end: chunkEnd });
    if (chunkStart === 0) break;
  }

  const chunks = await Promise.all(
    ranges.map(({ start, end }) =>
      fetchMexcRange(config, selectedInterval, start, end)
    ),
  );

  const merged = normalizeCandles(chunks.flat());
  const normalized = selectedInterval === "12h"
    ? aggregateCandles(merged, intervalMs["12h"])
    : merged;
  return normalized.slice(-total);
}

export async function fetchKlines(
  selectedInterval: Interval,
  total: number,
  symbol: string,
): Promise<CandlestickData[]> {
  const config = getSymbolConfig(symbol);
  return config.source === "mexc"
    ? fetchMexcKlines(config, selectedInterval, total)
    : fetchBinanceKlines(config, selectedInterval, total);
}

export async function fetchOlderKlines(
  selectedInterval: Interval,
  symbol: string,
  beforeTimeMs: number,
  limit: number = 1500,
): Promise<CandlestickData[]> {
  const config = getSymbolConfig(symbol);
  const endTimeMs = beforeTimeMs - 1;
  if (endTimeMs <= 0) return [];

  if (config.source === "mexc") {
    const requested = Math.min(limit, MEXC_KLINE_LIMIT);
    const rawStepMs = selectedInterval === "12h" ? intervalMs["4h"] : intervalMs[selectedInterval];
    const rawRequested = selectedInterval === "12h" ? requested * 3 : requested;
    const endSeconds = Math.floor(endTimeMs / 1000);
    const startSeconds = Math.max(0, endSeconds - Math.floor((rawRequested * rawStepMs) / 1000));
    const rawCandles = await fetchMexcRange(config, selectedInterval, startSeconds, endSeconds);
    const candles = selectedInterval === "12h"
      ? aggregateCandles(rawCandles, intervalMs["12h"])
      : rawCandles;
    return candles.slice(-requested);
  }

  const params = new URLSearchParams({
    symbol: config.sourceSymbol,
    interval: selectedInterval,
    limit: String(Math.min(limit, BINANCE_KLINE_LIMIT)),
    endTime: String(endTimeMs),
  });
  const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?${params}`);
  if (!response.ok) throw new Error(`Binance kline request failed: ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) return [];

  return normalizeCandles(
    data.map((kline: unknown[]): CandlestickData => ({
      time: Math.floor(Number(kline[0]) / 1000) as UTCTimestamp,
      open: Number(kline[1]),
      high: Number(kline[2]),
      low: Number(kline[3]),
      close: Number(kline[4]),
    })),
  );
}

export async function fetchLatestKline(
  selectedInterval: Interval,
  symbol: string,
): Promise<CandlestickData | null> {
  const config = getSymbolConfig(symbol);

  if (config.source === "mexc") {
    const endSeconds = Math.floor(Date.now() / 1000);
    const rawStepMs = selectedInterval === "12h" ? intervalMs["4h"] : intervalMs[selectedInterval];
    const startSeconds = Math.max(0, endSeconds - Math.floor((rawStepMs * 4) / 1000));
    const rawCandles = await fetchMexcRange(config, selectedInterval, startSeconds, endSeconds);
    const candles = selectedInterval === "12h"
      ? aggregateCandles(rawCandles, intervalMs["12h"])
      : rawCandles;
    return candles[candles.length - 1] ?? null;
  }

  const params = new URLSearchParams({
    symbol: config.sourceSymbol,
    interval: selectedInterval,
    limit: "1",
  });
  const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?${params}`);
  if (!response.ok) throw new Error(`Latest Binance kline request failed: ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data) || !data[0]) return null;
  const kline = data[0];

  return {
    time: Math.floor(Number(kline[0]) / 1000) as UTCTimestamp,
    open: Number(kline[1]),
    high: Number(kline[2]),
    low: Number(kline[3]),
    close: Number(kline[4]),
  };
}

export function mergeLatestCandle(
  candles: CandlestickData[],
  latest: CandlestickData | null,
): CandlestickData[] {
  if (!latest) return candles;
  return normalizeCandles([...candles, latest]);
}

/** Retained for callers outside the polling hook; only Binance exposes this URL. */
export function buildMarketStreamUrl(
  selectedInterval: Interval,
  symbol: string,
): string {
  const config = getSymbolConfig(symbol);
  if (config.source !== "binance") {
    throw new Error(`WebSocket market stream is not configured for ${config.source}`);
  }
  const lowerSymbol = config.sourceSymbol.toLowerCase();
  return `wss://fstream.binance.com/stream?streams=${lowerSymbol}@kline_${selectedInterval}/${lowerSymbol}@aggTrade`;
}
