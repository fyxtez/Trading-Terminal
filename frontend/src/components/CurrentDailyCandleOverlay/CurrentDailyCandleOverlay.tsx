import { useEffect, useRef, type MutableRefObject } from "react";
import type { CandlestickData, IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { getDailyCandle } from "../../trading/api/dailyCandle";
import { startMarketPoll } from "../../utils/marketPoll";
import { startPacedLoop } from "../../utils/pacedLoop";

type Props = {
  symbol: string;
  chartRef: MutableRefObject<IChartApi | null>;
  candleRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>;
  lastDataTimeRef: MutableRefObject<UTCTimestamp | null>;
  coordTimeToX: (time: UTCTimestamp) => number | null;
};

export default function CurrentDailyCandleOverlay({
  symbol,
  chartRef,
  candleRef,
  lastDataTimeRef,
  coordTimeToX,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const candleGroupRef = useRef<SVGGElement>(null);
  const bodyRef = useRef<SVGRectElement>(null);
  const wickRef = useRef<SVGPathElement>(null);
  const dailyRef = useRef<CandlestickData | null>(null);

  useEffect(() => {
    dailyRef.current = null;
    const poll = startMarketPoll(
      async (signal) => {
        const candle = await getDailyCandle(symbol, signal);
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
        const svg = svgRef.current;
        const group = candleGroupRef.current;
        const body = bodyRef.current;
        const wick = wickRef.current;
        if (!svg || !group || !body || !wick) return;
        const chart = chartRef.current;
        const series = candleRef.current;
        if (!chart || !series) {
          group.style.display = "none";
          return;
        }
        const { width, height } = chart.paneSize();
        svg.setAttribute("width", String(width));
        svg.setAttribute("height", String(height));
        const hide = () => {
          group.style.display = "none";
        };
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
          return hide();
        const anchor = coordTimeToX(lastTime);
        if (anchor === null) return hide();
        const x = anchor + 100;
        if (x < -10 || x > width + 10) return hide();
        const high = series.priceToCoordinate(daily.high);
        const low = series.priceToCoordinate(daily.low);
        const open = series.priceToCoordinate(daily.open);
        const close = series.priceToCoordinate(daily.close);
        if (high === null || low === null || open === null || close === null) return hide();
        const top = Math.min(open, close);
        const bottom = Math.max(open, close);
        const colors = series.options();
        const isUp = daily.close >= daily.open;
        // Update one retained shape instead of accumulating canvas pixels while dragging.
        body.setAttribute("x", String(x - 9));
        body.setAttribute("y", String(top));
        body.setAttribute("height", String(Math.max(1, bottom - top)));
        body.setAttribute("fill", isUp ? colors.upColor : colors.downColor);
        wick.setAttribute("d", `M ${x} ${high} L ${x} ${top} M ${x} ${bottom} L ${x} ${low}`);
        wick.setAttribute("stroke", isUp ? colors.wickUpColor : colors.wickDownColor);
        group.style.display = "";
      }, 30),
    [chartRef, candleRef, lastDataTimeRef, coordTimeToX],
  );

  return (
    <svg
      ref={svgRef}
      aria-hidden="true"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 12,
      }}
    >
      <g ref={candleGroupRef} style={{ display: "none" }}>
        <path ref={wickRef} fill="none" strokeWidth={1.5} />
        <rect ref={bodyRef} width={18} />
      </g>
    </svg>
  );
}
