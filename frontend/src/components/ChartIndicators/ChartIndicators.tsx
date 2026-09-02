import { useEffect, useState } from "react";
import { getTodaysSessions } from "../../utils/sessions";
import "./ChartIndicators.css";

// Session boundaries are hour-granularity, so there's no need to check
// every second - 15s is frequent enough that the label flips onto a new
// session within a moment of the actual boundary, without re-running the
// (cheap, but not free) Intl-based session computation constantly.
const CHECK_INTERVAL_MS = 15_000;

type ActiveSessionState = {
  label: string;
  color: string | null;
};

function computeActiveSessionState(now: Date): ActiveSessionState {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const sessions = getTodaysSessions(now);

  const active = sessions
    .filter(
      (session) => nowSeconds >= session.start && nowSeconds < session.end,
    )
    .sort((a, b) => a.start - b.start);

  if (active.length === 0) {
    return { label: "No active session", color: null };
  }

  if (active.length === 1) {
    return { label: active[0].label, color: active[0].color };
  }

  return {
    label: active.map((session) => session.label).join(" – "),
    color: null,
  };
}

export default function ChartIndicators() {
  const [state, setState] = useState<ActiveSessionState>(() =>
    computeActiveSessionState(new Date()),
  );

  useEffect(() => {
    const tick = () => setState(computeActiveSessionState(new Date()));

    tick();

    const intervalId = window.setInterval(tick, CHECK_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <div className="chart-indicators" aria-label="Chart indicators">
      <div
        className="indicator-chip"
        title="Current session"
      >
        <span
          className="indicator-chip-value"
          style={state.color ? { color: state.color } : undefined}
        >
          {state.label}
        </span>
      </div>
    </div>
  );
}