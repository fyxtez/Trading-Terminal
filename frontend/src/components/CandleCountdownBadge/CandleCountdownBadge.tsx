import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { intervals, type Interval } from "../../config/constants";
import "./CandleCountdownBadge.css";

type CandleCountdownBadgeProps = {
  /** Countdown label for the active chart timeframe, e.g. "4:37". */
  label: string;
  /** The active chart timeframe, so its row can be highlighted in the dropdown. */
  interval: Interval;
  /** Countdown label for every timeframe (active one included) - see useCandleCountdown.ts. */
  allLabels: Record<Interval, string>;
  /** Whether the user explicitly unlocked the timer for repositioning. */
  moveArmed: boolean;
  /** Whether the timer is currently following the pointer before the drop click. */
  moving: boolean;
  onMovePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPlacementPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
};

export default function CandleCountdownBadge({
  label,
  interval,
  allLabels,
  moveArmed,
  moving,
  onMovePointerDown,
  onPlacementPointerDown,
}: CandleCountdownBadgeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on an outside click or Escape - the same pattern SymbolSwitcher
  // already uses for its own dropdown.
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    // moving and the timeframe dropdown are mutually exclusive so
    // pointer placement cannot accidentally leave a menu floating behind it.
    if (moveArmed) setIsOpen(false);
  }, [moveArmed]);

  return (
    <div
      className={`candle-countdown ${moveArmed ? "move-armed" : ""} ${moving ? "moving" : ""}`}
      ref={rootRef}
    >
      <button
        className={`candle-countdown-badge ${isOpen ? "open" : ""}`}
        title={
          moveArmed
            ? moving
              ? "Click to place the candle timer"
              : "Click to pick up the candle timer"
            : "Time left until the current candle closes - click for every timeframe"
        }
        onPointerDown={onPlacementPointerDown}
        onClick={(event) => {
          event.stopPropagation();
          // while move mode is armed, timer clicks are reserved for
          // pick-up/drop placement instead of opening the timeframe dropdown.
          if (moveArmed) return;
          setIsOpen((open) => !open);
        }}
      >
        {label}
      </button>

      <button
        type="button"
        className={`candle-countdown-move-button ${moveArmed ? "active" : ""}`}
        title={moveArmed ? "Cancel timer movement" : "Move candle timer"}
        aria-pressed={moveArmed}
        onPointerDown={(event) => {
          /*
           * pressing the move control now picks the timer up immediately.
           * Previously the button only armed movement and required a second
           * click on the timer before pointer movement actually started.
           */
          onMovePointerDown(event);
        }}
      >
        ↗
      </button>

      {isOpen && (
        <div className="candle-countdown-menu" onClick={(event) => event.stopPropagation()}>
          {intervals.map((candidate) => (
            <div
              key={candidate}
              className={`candle-countdown-option ${candidate === interval ? "active" : ""}`}
            >
              <span className="candle-countdown-option-interval">{candidate}</span>
              <span className="candle-countdown-option-time">
                {allLabels[candidate] ?? "--:--"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
