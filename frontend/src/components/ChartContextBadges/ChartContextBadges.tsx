import { useEffect, useMemo, useState } from "react";
import { CHART_TIME_ZONE } from "../../utils/time";
import "./ChartContextBadges.css";

type ChartContextBadgesProps = {
  symbol: string;
  activeDrawingSetName: string;
  showDrawingSetBadge: boolean;
  isDrawingSetUnsaved: boolean;
  canSaveDrawingSet: boolean;
  onSaveDrawingSet: (name: string) => boolean;
};

export default function ChartContextBadges({
  symbol,
  activeDrawingSetName,
  showDrawingSetBadge,
  isDrawingSetUnsaved,
  canSaveDrawingSet,
  onSaveDrawingSet,
}: ChartContextBadgesProps) {
  const [dayRefreshTick, setDayRefreshTick] = useState(0);
  const currentDayName = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: CHART_TIME_ZONE,
        weekday: "long",
      }).format(new Date()),
    [dayRefreshTick],
  );
  // ISO weekday number: Monday = 1 ... Sunday = 7
  const isoWeekdayNumber = useMemo(() => {
    const isoOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const index = isoOrder.indexOf(currentDayName);
    return index === -1 ? undefined : index + 1;
  }, [currentDayName]);
  const currentDayLabel =
    isoWeekdayNumber !== undefined ? `${currentDayName} (${isoWeekdayNumber})` : currentDayName;

  useEffect(() => {
    const intervalId = window.setInterval(() => setDayRefreshTick((tick) => tick + 1), 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  const [isDrawingSetSaveOpen, setIsDrawingSetSaveOpen] = useState(false);
  const [drawingSetName, setDrawingSetName] = useState("");
  const [drawingSetSaveError, setDrawingSetSaveError] = useState<string | null>(null);

  useEffect(() => {
    /*
     * UX UPDATE: editable chart tags were removed completely because they did
     * not contribute useful chart context. Symbol changes now reset only the
     * drawing-set quick-save draft; no tag state or localStorage is maintained.
     */
    setIsDrawingSetSaveOpen(false);
    setDrawingSetName("");
    setDrawingSetSaveError(null);
  }, [symbol]);

  useEffect(() => {
    if (isDrawingSetUnsaved) return;
    setIsDrawingSetSaveOpen(false);
    setDrawingSetName("");
    setDrawingSetSaveError(null);
  }, [isDrawingSetUnsaved]);

  const saveUnsavedDrawingSet = () => {
    const trimmedName = drawingSetName.trim();
    if (!trimmedName) {
      setDrawingSetSaveError("Enter a name.");
      return;
    }
    if (!canSaveDrawingSet) {
      setDrawingSetSaveError("Add at least one drawing first.");
      return;
    }
    if (!onSaveDrawingSet(trimmedName)) {
      setDrawingSetSaveError("Unable to save this drawing set.");
      return;
    }
    setIsDrawingSetSaveOpen(false);
    setDrawingSetName("");
    setDrawingSetSaveError(null);
  };

  return (
    <div className="chart-context-badges">
      <div className="current-day-badge" title={`Current day: ${currentDayLabel}`}>
        {currentDayLabel}
      </div>

      {showDrawingSetBadge && (
        <div className="drawing-set-badge-wrap">
          {isDrawingSetUnsaved ? (
            <button
              type="button"
              className="active-drawing-set-badge active-drawing-set-badge-action"
              title="This drawing set is unsaved. Click to save it."
              aria-expanded={isDrawingSetSaveOpen}
              onClick={(event) => {
                event.stopPropagation();
                setIsDrawingSetSaveOpen((open) => !open);
                setDrawingSetSaveError(null);
              }}
            >
              New / unsaved — click to save
            </button>
          ) : (
            <div
              className="active-drawing-set-badge"
              title={`Active drawing set: ${activeDrawingSetName}`}
            >
              {activeDrawingSetName}
            </div>
          )}

          {isDrawingSetUnsaved && isDrawingSetSaveOpen && (
            <form
              className="drawing-set-quick-save"
              onClick={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                saveUnsavedDrawingSet();
              }}
            >
              <input
                autoFocus
                value={drawingSetName}
                maxLength={80}
                placeholder="Drawing set name"
                aria-label="Drawing set name"
                onChange={(event) => {
                  setDrawingSetName(event.target.value);
                  setDrawingSetSaveError(null);
                }}
              />
              <button type="submit" disabled={!drawingSetName.trim() || !canSaveDrawingSet}>
                Save
              </button>
              {drawingSetSaveError && <span>{drawingSetSaveError}</span>}
              {!canSaveDrawingSet && !drawingSetSaveError && (
                <span>Add at least one drawing first.</span>
              )}
            </form>
          )}
        </div>
      )}
    </div>
  );
}
