import type { UTCTimestamp } from "lightweight-charts";
import { CHART_TIME_ZONE } from "./time";

/** Default number of chart days whose start marker is shown. */
export const DEFAULT_TIME_MARKER_DAYS_BACK = 10;
export const MAX_TIME_MARKER_DAYS_BACK = 20;

export type TimeMarkerLine = {
  id: string;
  time: UTCTimestamp;
};

/**
 * Same tz-safe offset lookup used by sessions.ts (see the big comment on
 * zonedDateTimeToUtcSeconds over there for why this two-step "guess, then
 * correct" approach is needed instead of a hardcoded UTC offset table).
 * Duplicated here rather than imported so this file has no dependency on
 * sessions.ts's trading-session concept - a custom time-of-day marker
 * isn't a trading session, it's a much simpler standalone idea.
 */
function getZoneOffsetMinutes(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(utcMs));

  const raw =
    parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+0";
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(raw);

  if (!match) return 0;

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;

  return sign * (hours * 60 + minutes);
}

function getLocalDateParts(
  now: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const read = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? NaN);

  return { year: read("year"), month: read("month"), day: read("day") };
}

function zonedDateTimeToUtcSeconds(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): UTCTimestamp {
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMinutes = getZoneOffsetMinutes(guessMs, timeZone);

  return Math.floor(
    (guessMs - offsetMinutes * 60 * 1000) / 1000,
  ) as UTCTimestamp;
}

/**
 * Parses a "HH:MM" string (e.g. "14:00", "23:11", "00:00") into its hour
 * and minute parts. Returns null for anything outside 00:00-23:59 so
 * callers can reject a bad/partial value from a text input instead of
 * silently drawing a wrong line - not needed for the <input type="time">
 * control itself (that widget only ever emits well-formed values or an
 * empty string), but kept here so the parsing logic has a single home if
 * a plain text field ever replaces it.
 */
export function parseTimeOfDay(
  value: string,
): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;

  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * One vertical-line timestamp per selected chart day, at the given
 * chart-local wall-clock hour/minute. The selected value is the exact total
 * number of markers: 1 means today only, 2 means today plus yesterday, etc.
 *
 * Each mark is computed independently on its own calendar date directly
 * in CHART_TIME_ZONE (the same two-pass approach getTodaysSessions() uses
 * in sessions.ts), so a DST transition falling inside the 10-day window
 * doesn't shift any of the earlier marks by an hour relative to the
 * chosen time - "14:00" ten days ago reads as 14:00 on that day's own
 * local clock, not "14:00 today's-offset applied to a ten-day-old
 * instant".
 */
export function getDailyTimeMarkers(
  hour: number,
  minute: number,
  daysBack: number = DEFAULT_TIME_MARKER_DAYS_BACK,
  now: Date = new Date(),
): TimeMarkerLine[] {
  const marks: TimeMarkerLine[] = [];

  const normalizedDaysBack = Number.isFinite(daysBack)
    ? Math.min(MAX_TIME_MARKER_DAYS_BACK, Math.max(1, Math.round(daysBack)))
    : DEFAULT_TIME_MARKER_DAYS_BACK;

  for (let daysAgo = 0; daysAgo < normalizedDaysBack; daysAgo++) {
    const dayDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
    const { year, month, day } = getLocalDateParts(dayDate, CHART_TIME_ZONE);

    marks.push({
      id: `time-mark-${year}-${month}-${day}`,
      time: zonedDateTimeToUtcSeconds(
        year,
        month,
        day,
        hour,
        minute,
        CHART_TIME_ZONE,
      ),
    });
  }

  return marks;
}
