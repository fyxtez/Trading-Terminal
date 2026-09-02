import type { UTCTimestamp } from "lightweight-charts";
import { CHART_TIME_ZONE } from "./time";

export type TradingSessionId = "asia" | "london" | "newyork";

export type TradingSession = {
  id: TradingSessionId;
  label: string;
  color: string;
  start: UTCTimestamp;
  end: UTCTimestamp;
};

export type KillZone = {
  label: string;
  color: string;
  start: UTCTimestamp;
  end: UTCTimestamp;
};

type SessionDefinition = {
  id: TradingSessionId;
  label: string;
  color: string;
  /** Real IANA timezone for this session's home market. */
  timeZone: string;
  /** Local wall-clock trading hours in that timezone. */
  startHour: number;
  endHour: number;
};

/*
 * Real regional trading hours, converted through each session's actual
 * timezone rather than a fixed UTC-hour table. That distinction matters:
 * Japan never observes daylight saving, but the UK and US do, on
 * different calendars from each other (US DST starts/ends about a week
 * before the UK's each year) - a hardcoded "London = 08:00-17:00 UTC"
 * table would be an hour wrong for a chunk of the year on one or both
 * sessions. Going through Intl's real timezone data below is what
 * guarantees these track correctly year-round.
 */
const SESSION_DEFINITIONS: SessionDefinition[] = [
  {
    id: "asia",
    label: "ASIA",
    color: "#3b82f6",
    timeZone: "Asia/Tokyo",
    startHour: 8,
    endHour: 17,
  },
  {
    id: "london",
    label: "LONDON",
    color: "#a78bfa",
    timeZone: "Europe/London",
    startHour: 8,
    endHour: 17,
  },
  {
    id: "newyork",
    label: "NEW YORK",
    color: "#2dd4bf",
    timeZone: "America/New_York",
    startHour: 8,
    endHour: 17,
  },
];

/**
 * Offset (minutes, UTC ahead) of `timeZone` at the instant `utcMs`.
 * "GMT" (Intl's shortOffset form for exactly UTC+0, e.g. London in
 * winter) has no +/- digits at all - the regex simply won't match it,
 * and the `0` fallback below is the correct value for that case anyway.
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

/**
 * UTC timestamp (seconds) for `hour`:00 local wall-clock time on the
 * calendar date (year/month/day) given, evaluated DIRECTLY in
 * `timeZone`.
 *
 * FIX: an earlier version of this file computed one shared "day start"
 * instant anchored to CHART_TIME_ZONE, then tried to reach each
 * session's own hour by adding `hour * 3600000` to that anchor before
 * asking what the SESSION's zone read there. That only works if the
 * anchor is itself UTC midnight - adding "9 hours" to a Berlin-midnight
 * instant and then asking what Tokyo's clock reads at that point mixes
 * two unrelated zones' arithmetic. Verified against real dates: it put
 * Tokyo's session two hours early (Berlin's own UTC+2 leaking in) in
 * summer. This version avoids the problem entirely by resolving the
 * year/month/day parts once (in CHART_TIME_ZONE, which just tells us
 * *which* calendar date to use) and then converting that date's hour
 * straight into UTC using each session's OWN zone, independently, with
 * no shared numeric anchor between zones at all.
 *
 * Two-pass: guess the UTC instant assuming the zone's offset were zero,
 * read that zone's REAL offset at roughly that instant, then apply it.
 * One pass is enough here because every session's start/end hour used
 * above falls in the middle of a normal working day, nowhere near the
 * one or two clock-hours a year where a region is actually mid-DST-jump.
 */
function zonedDateTimeToUtcSeconds(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): UTCTimestamp {
  const guessMs = Date.UTC(year, month - 1, day, hour, 0, 0);
  const offsetMinutes = getZoneOffsetMinutes(guessMs, timeZone);

  return Math.floor((guessMs - offsetMinutes * 60 * 1000) / 1000) as UTCTimestamp;
}

/**
 * Today's three session windows, "today" meaning the chart's own
 * displayed calendar date (read from CHART_TIME_ZONE - the same value
 * that drives the "CEST · UTC+2" badge in ChartTimezoneBadge). Each
 * session's start/end is then computed on THAT calendar date directly
 * in the session's own real timezone (see zonedDateTimeToUtcSeconds
 * above), so the boundaries are correct local trading hours regardless
 * of which zone "today" was anchored in.
 *
 * Because all three sessions fall within a single day's 0-24h range
 * (none of them wrap past midnight), this naturally satisfies "all
 * three should be visible in advance" - London and New York's lines are
 * computed and drawn immediately even while Asia's session is the only
 * one currently active, since nothing here depends on what time it
 * currently is.
 */
export function getTodaysSessions(now: Date = new Date()): TradingSession[] {
  const { year, month, day } = getLocalDateParts(now, CHART_TIME_ZONE);

  return SESSION_DEFINITIONS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    color: definition.color,
    start: zonedDateTimeToUtcSeconds(
      year,
      month,
      day,
      definition.startHour,
      definition.timeZone,
    ),
    end: zonedDateTimeToUtcSeconds(
      year,
      month,
      day,
      definition.endHour,
      definition.timeZone,
    ),
  }));
}

/**
 * FEATURE: New York kill-zone planning window expressed in the chart's own
 * displayed timezone, as requested. Keeping this separate from regional
 * sessions prevents it from being mistaken for a fourth active market by
 * ChartIndicators.tsx.
 */
export function getTodaysNewYorkKillZone(now: Date = new Date()): KillZone {
  const { year, month, day } = getLocalDateParts(now, CHART_TIME_ZONE);

  return {
    label: "NY KILL ZONE",
    color: "#f59e0b",
    start: zonedDateTimeToUtcSeconds(year, month, day, 13, CHART_TIME_ZONE),
    end: zonedDateTimeToUtcSeconds(year, month, day, 16, CHART_TIME_ZONE),
  };
}

/**
 * A key that changes exactly once per chart-local calendar day. Used to
 * detect a day rollover (see SessionZonesOverlay.tsx) so yesterday's
 * session lines are swapped out for today's instead of lingering.
 */
export function localDayKey(now: Date = new Date()): string {
  const { year, month, day } = getLocalDateParts(now, CHART_TIME_ZONE);
  return `${year}-${month}-${day}`;
}
