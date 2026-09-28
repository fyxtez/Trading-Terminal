import { useEffect, useRef, type MutableRefObject } from "react";
import type { CandlestickData, IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { getDailyCandle, getYesterdayDailyCandle } from "../../trading/api/dailyCandle";
import { startMarketPoll } from "../../utils/marketPoll";
import { startPacedLoop } from "../../utils/pacedLoop";

type Props = {
  symbol: string;
  dayOffset?: 0 | 1;
  chartRef: MutableRefObject<IChartApi | null>;
  candleRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>;
  lastDataTimeRef: MutableRefObject<UTCTimestamp | null>;
  coordTimeToX: (time: UTCTimestamp) => number | null;
};

export default function CurrentDailyCandleOverlay({
  symbol,
  dayOffset = 0,
  chartRef,
  candleRef,
  lastDataTimeRef,
  coordTimeToX,
}: Props) {
  const clipRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const candleGroupRef = useRef<SVGGElement>(null);
  const bodyRef = useRef<SVGRectElement>(null);
  const wickRef = useRef<SVGPathElement>(null);
  const dailyRef = useRef<CandlestickData | null>(null);

  useEffect(() => {
    dailyRef.current = null;
    const poll = startMarketPoll(
      async (signal) => {
        const candle = await (dayOffset === 1 ? getYesterdayDailyCandle : getDailyCandle)(
          symbol,
          signal,
        );
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
  }, [symbol, dayOffset]);

  useEffect(
    () =>
      startPacedLoop(() => {
        const clip = clipRef.current;
        const svg = svgRef.current;
        const group = candleGroupRef.current;
        const body = bodyRef.current;
        const wick = wickRef.current;
        if (!clip || !svg || !group || !body || !wick) return;
        const hide = () => {
          if (group.style.display !== "none") group.style.display = "none";
        };
        const chart = chartRef.current;
        const series = candleRef.current;
        if (!chart || !series) return hide();
        const { width, height } = chart.paneSize();
        if (!(width > 0 && height > 0) || !Number.isFinite(width + height)) return hide();
        if (clip.style.width !== `${width}px`) clip.style.width = `${width}px`;
        if (clip.style.height !== `${height}px`) clip.style.height = `${height}px`;
        const setAttribute = (element: SVGElement, name: string, value: string | number) => {
          const next = String(value);
          if (element.getAttribute(name) !== next) element.setAttribute(name, next);
        };
        setAttribute(svg, "height", height);
        const daily = dailyRef.current;
        const lastTime = lastDataTimeRef.current;
        const now = Date.now() / 1000;
        if (
          !daily ||
          lastTime === null ||
          typeof daily.time !== "number" ||
          now < daily.time + dayOffset * 86400 ||
          now >= daily.time + (dayOffset + 1) * 86400
        )
          return hide();
        const anchor = coordTimeToX(lastTime);
        if (anchor === null || !Number.isFinite(anchor)) return hide();
        const x = anchor + 100 - dayOffset * 30;
        if (x < -11 || x > width + 11) return hide();
        const high = series.priceToCoordinate(daily.high);
        const low = series.priceToCoordinate(daily.low);
        const open = series.priceToCoordinate(daily.open);
        const close = series.priceToCoordinate(daily.close);
        if (high === null || low === null || open === null || close === null) return hide();
        if (![high, low, open, close].every(Number.isFinite)) return hide();
        const top = Math.min(open, close);
        const bottom = Math.max(open, close);
        const bound = (y: number) => Math.max(0, Math.min(height, y));
        const colors = series.options();
        const isUp = daily.close >= daily.open;

        // Keep the painted surface narrow and its geometry inside the pane.
        // A daily range can extend far beyond a zoomed intraday viewport.
        // Horizontal panning only translates this retained layer; it does not
        // rewrite paths or repaint a chart-sized SVG on every frame.
        const transform = `translate3d(${x - 11}px, 0, 0)`;
        if (svg.style.transform !== transform) svg.style.transform = transform;
        setAttribute(body, "y", bound(top));
        setAttribute(body, "height", bound(Math.max(top + 1, bottom)) - bound(top));
        setAttribute(body, "fill", isUp ? colors.upColor : colors.downColor);
        setAttribute(
          wick,
          "d",
          `M 11 ${bound(high)} L 11 ${bound(top)} M 11 ${bound(bottom)} L 11 ${bound(low)}`,
        );
        setAttribute(wick, "stroke", isUp ? colors.wickUpColor : colors.wickDownColor);
        if (group.style.display !== "") group.style.display = "";
      }),
    [chartRef, candleRef, lastDataTimeRef, coordTimeToX, dayOffset],
  );

  return (
    <div
      ref={clipRef}
      aria-hidden="true"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        overflow: "hidden",
        contain: "strict",
        pointerEvents: "none",
        zIndex: 12,
      }}
    >
      <svg
        ref={svgRef}
        width={22}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          overflow: "hidden",
          willChange: "transform",
        }}
      >
        <g ref={candleGroupRef} style={{ display: "none" }}>
          <path ref={wickRef} fill="none" strokeWidth={1.5} />
          <rect ref={bodyRef} x={2} width={18} />
        </g>
      </svg>
    </div>
  );
}
