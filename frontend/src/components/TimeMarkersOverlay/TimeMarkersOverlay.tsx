import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import {
  getDailyTimeMarkers,
  type TimeMarkerLine,
} from "../../utils/timeMarkers";
import { localDayKey } from "../../utils/sessions";
import { startPacedLoop } from "../../utils/pacedLoop";
import "./TimeMarkersOverlay.css";

type TimeMarkersOverlayProps = {
  chartWrapRef: MutableRefObject<HTMLDivElement | null>;
  chartRef: MutableRefObject<IChartApi | null>;
  candleRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>;
  /** Hour (0-23) of the chosen chart-local time of day. */
  hour: number;
  /** Minute (0-59) of the chosen chart-local time of day. */
  minute: number;
  /** Number of previous days to include. */
  daysBack: number;
  /**
   * Same time->pixel conversion the candles/drawings and
   * SessionZonesOverlay already use (see useCoordinateMapping.ts) - the
   * chart's underlying time axis is UTC epoch seconds no matter what
   * timezone its tick labels are formatted in, so positioning through
   * this exact function is what guarantees these lines land in the right
   * spot relative to the chart's (locally-formatted) time labels.
   */
  coordTimeToX: (time: UTCTimestamp) => number | null;
};

type PositionedLine = {
  id: string;
  x: number;
};

export default function TimeMarkersOverlay({
  chartWrapRef,
  chartRef,
  candleRef,
  hour,
  minute,
  daysBack,
  coordTimeToX,
}: TimeMarkersOverlayProps) {
  const [marks, setMarks] = useState<TimeMarkerLine[]>(() =>
    getDailyTimeMarkers(hour, minute, daysBack),
  );
  const dayKeyRef = useRef(localDayKey());

  const [lines, setLines] = useState<PositionedLine[]>([]);
  const [paneHeight, setPaneHeight] = useState(0);

  // Recompute the 11 mark timestamps whenever the chosen time changes,
  // and once a minute so the window slides forward a day right after the
  // chart's local calendar day rolls over (same pattern as
  // SessionZonesOverlay - the rollover only ever happens once daily, so
  // there's no need for a precise midnight timer).
  useEffect(() => {
    const recompute = () => {
      dayKeyRef.current = localDayKey();
      setMarks(getDailyTimeMarkers(hour, minute, daysBack));
    };

    recompute();

    const intervalId = window.setInterval(() => {
      const currentKey = localDayKey();
      if (currentKey === dayKeyRef.current) return;
      recompute();
    }, 60_000);

    return () => window.clearInterval(intervalId);
  }, [hour, minute, daysBack]);

  // Recomputes each line's on-screen x at a bounded cadence, the same way
  // SessionZonesOverlay tracks its own session-boundary lines - needed so
  // the marks stay aligned while panning, zooming, or switching
  // timeframes.
  useEffect(() => {
    const update = () => {
      const chart = chartRef.current;
      const series = candleRef.current;

      if (!chart || !series) {
        return;
      }

      const paneSize = chart.paneSize();
      const nextLines: PositionedLine[] = [];

      for (const mark of marks) {
        const x = coordTimeToX(mark.time);

        if (x !== null && x >= 0 && x <= paneSize.width) {
          nextLines.push({ id: mark.id, x });
        }
      }

      setLines((current) => {
        if (
          current.length === nextLines.length &&
          current.every((item, index) => {
            const next = nextLines[index];
            return item.id === next.id && Math.abs(item.x - next.x) <= 0.25;
          })
        ) {
          return current;
        }

        return nextLines;
      });
      setPaneHeight((current) =>
        Math.abs(current - paneSize.height) <= 0.25 ? current : paneSize.height,
      );

    };

    return startPacedLoop(update);
  }, [marks, chartWrapRef, chartRef, candleRef, coordTimeToX]);

  if (lines.length === 0 || paneHeight <= 0) return null;

  return (
    <div className="time-markers-overlay" aria-hidden="true">
      {lines.map((line) => (
        <div
          key={line.id}
          className="time-marker-line"
          style={{ left: line.x, height: paneHeight }}
        />
      ))}
    </div>
  );
}
