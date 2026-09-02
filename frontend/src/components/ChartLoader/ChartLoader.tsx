import type { Interval } from "../../config/constants";
import "./ChartLoader.css";

type ChartLoaderProps = {
  interval: Interval;
};

export default function ChartLoader({ interval }: ChartLoaderProps) {
  return (
    <div className="chart-loader">
      <div className="chart-loader-spinner" />
      <div>Loading {interval} candles…</div>
    </div>
  );
}
