import type { Time } from "lightweight-charts";

// Use whatever timezone the visitor's browser/OS reports instead of a
// hardcoded one. Falls back to UTC if Intl can't resolve it for some reason.
export const CHART_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

export function timeToDate(time: Time): Date {
  if (typeof time === "number") {
    return new Date(time * 1000);
  }

  if (typeof time === "string") {
    return new Date(time);
  }

  return new Date(Date.UTC(time.year, time.month - 1, time.day));
}

export const localTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: CHART_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export const localDateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: CHART_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
});

// time-axis calendar ticks need calendar labels; formatting every
// intraday chart tick as HH:mm made consecutive future days all read "02:00".
export const localMonthFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: CHART_TIME_ZONE,
  month: "short",
  year: "2-digit",
});

export const localYearFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: CHART_TIME_ZONE,
  year: "numeric",
});

export const localDateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: CHART_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function getLocalZoneLabel() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: CHART_TIME_ZONE,
    timeZoneName: "short",
  }).formatToParts(now);

  const zoneAbbreviation = parts.find((part) => part.type === "timeZoneName")?.value ?? "";

  // Deliberately not showing a city name here: IANA aliases zones that
  // share identical rules to one canonical id (e.g. Europe/Vienna and
  // Europe/Bratislava both resolve to "Europe/Belgrade"), so parsing a
  // city out of the zone id can name the wrong city even though the
  // time itself is correct. The UTC offset has no such ambiguity.
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;
  const offsetLabel = `UTC${sign}${hours}${minutes ? ":" + String(minutes).padStart(2, "0") : ""}`;

  return zoneAbbreviation ? `${zoneAbbreviation} · ${offsetLabel}` : offsetLabel;
}
