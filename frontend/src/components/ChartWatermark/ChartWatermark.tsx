import "./ChartWatermark.css";

export default function ChartWatermark() {
  return (
    <div className="chart-watermark">
      <div className="watermark-mark" aria-hidden="true" />
      <div className="watermark-text">Terminal</div>
    </div>
  );
}
