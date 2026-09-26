import { useEffect, useRef, type MutableRefObject } from "react";
import type { CandlestickData, IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { fetchLatestKline } from "../../trading/api/marketData";
import { startMarketPoll } from "../../utils/marketPoll";
import { startPacedLoop } from "../../utils/pacedLoop";

type Props = {
  symbol: string;
  chartRef: MutableRefObject<IChartApi | null>;
  candleRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>;
  lastDataTimeRef: MutableRefObject<UTCTimestamp | null>;
  coordTimeToX: (time: UTCTimestamp) => number | null;
  offset: number;
};

export default function CurrentDailyCandleOverlay({
  symbol,
  chartRef,
  candleRef,
  lastDataTimeRef,
  coordTimeToX,
  offset,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dailyRef = useRef<CandlestickData | null>(null);

  useEffect(() => {
    dailyRef.current = null;
    const poll = startMarketPoll(
      async (signal) => {
        const candle = await fetchLatestKline("1d", symbol, signal);
        if (!signal.aborted) dailyRef.current = candle;
      },
      1_000,
      15_000,
      () => {
        // Hide unavailable data until polling recovers instead of displaying a stale candle.
        dailyRef.current = null;
      },
    );
    return () => {
      poll.stop();
      dailyRef.current = null;
    };
  }, [symbol]);

  useEffect(
    () =>
      startPacedLoop(() => {
        const canvas = canvasRef.current;
        const chart = chartRef.current;
        const series = candleRef.current;
        if (!canvas || !chart || !series) return;
        const { width, height } = chart.paneSize();
        const ratio = window.devicePixelRatio || 1;
        const pixelWidth = Math.round(width * ratio);
        const pixelHeight = Math.round(height * ratio);
        if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
          canvas.width = pixelWidth;
          canvas.height = pixelHeight;
          canvas.style.width = `${width}px`;
          canvas.style.height = `${height}px`;
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, width, height);
        const daily = dailyRef.current;
        const lastTime = lastDataTimeRef.current;
        const now = Date.now() / 1000;
        if (
          !daily ||
          lastTime === null ||
          typeof daily.time !== "number" ||
          now < daily.time ||
          now >= daily.time + 86400
        )
          return;
        const anchor = coordTimeToX(lastTime);
        if (anchor === null) return;
        const x = anchor + 100 + offset;
        if (x < -10 || x > width + 10) return;
        const high = series.priceToCoordinate(daily.high);
        const low = series.priceToCoordinate(daily.low);
        const open = series.priceToCoordinate(daily.open);
        const close = series.priceToCoordinate(daily.close);
        if (high === null || low === null || open === null || close === null) return;
        const top = Math.min(open, close);
        const bottom = Math.max(open, close);
        const colors = series.options();
        const isUp = daily.close >= daily.open;
        ctx.fillStyle = isUp ? colors.upColor : colors.downColor;
        ctx.strokeStyle = isUp ? colors.wickUpColor : colors.wickDownColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, high);
        ctx.lineTo(x, top);
        ctx.moveTo(x, bottom);
        ctx.lineTo(x, low);
        ctx.stroke();
        ctx.fillRect(x - 9, top, 18, Math.max(1, bottom - top));
      }, 30),
    [chartRef, candleRef, lastDataTimeRef, coordTimeToX, offset],
  );

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", zIndex: 12 }}
    />
  );
}
