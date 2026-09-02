import "./LoadingIndicator.css";

type LoadingIndicatorProps = {
  label: string;
  detail?: string;
  variant?: "panel" | "compact" | "inline";
};

export default function LoadingIndicator({
  label,
  detail,
  variant = "compact",
}: LoadingIndicatorProps) {
  return (
    <span
      className={`loading-indicator loading-indicator--${variant}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="loading-indicator__spinner" aria-hidden="true" />
      <span className="loading-indicator__copy">
        <span className="loading-indicator__label">{label}</span>
        {detail && (
          <span className="loading-indicator__detail">{detail}</span>
        )}
      </span>
      <span className="loading-indicator__track" aria-hidden="true">
        <span />
      </span>
    </span>
  );
}
