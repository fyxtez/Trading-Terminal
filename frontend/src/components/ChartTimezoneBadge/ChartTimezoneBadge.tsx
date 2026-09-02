import "./ChartTimezoneBadge.css";

type ChartTimezoneBadgeProps = {
  label: string;
};

export default function ChartTimezoneBadge({ label }: ChartTimezoneBadgeProps) {
  return <div className="chart-timezone">{label}</div>;
}
