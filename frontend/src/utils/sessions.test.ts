import { describe, expect, it, vi } from "vitest";
import { getTodaysSessions, localDayKey } from "./sessions";

vi.mock("./time", () => ({ CHART_TIME_ZONE: "UTC" }));

describe("session formatter reuse", () => {
  it("resolves offsets for each date, including different US and UK DST transition dates", () => {
    for (const [date, londonHour, newYorkHour] of [
      ["2026-01-15", "08", "13"],
      ["2026-03-15", "08", "12"],
      ["2026-07-15", "07", "12"],
      ["2026-01-15", "08", "13"],
    ]) {
      const now = new Date(`${date}T12:00:00Z`);
      const sessions = getTodaysSessions(now);
      expect(sessions.find((session) => session.id === "london")?.start).toBe(
        Date.parse(`${date}T${londonHour}:00:00Z`) / 1000,
      );
      expect(sessions.find((session) => session.id === "newyork")?.start).toBe(
        Date.parse(`${date}T${newYorkHour}:00:00Z`) / 1000,
      );
      expect(localDayKey(now)).toBe(date.split("-").map(Number).join("-"));
    }
  });
});
