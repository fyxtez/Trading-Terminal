import { describe, expect, it } from "vitest";
import { buildSettingsSearchModel } from "./settingsSearch";

const sizingFields = [
  { name: "margin_pct", label: "Margin per trade", description: "Portfolio risk" },
];

describe("buildSettingsSearchModel", () => {
  it("shows all ordinary sections when the query is empty", () => {
    const model = buildSettingsSearchModel("", true, sizingFields);
    expect(model.showMarginSection).toBe(true);
    expect(model.showDrawingSetsSection).toBe(true);
    expect(model.showDesktopConnections).toBe(true);
  });

  it("limits a kill-zone search to the drawings section", () => {
    const model = buildSettingsSearchModel("kill zone", true, sizingFields);
    expect(model.showDrawingsSection).toBe(true);
    expect(model.drawingOptionMatches.killZone).toBe(true);
    expect(model.showMarginSection).toBe(false);
    expect(model.showAlertsSection).toBe(false);
  });

  it("never exposes desktop connections in browser mode", () => {
    const model = buildSettingsSearchModel("telegram", false, sizingFields);
    expect(model.showDesktopConnections).toBe(false);
    expect(model.hasAnySettingsSearchResult).toBe(false);
  });

  it("does not expose dormant alert or notification settings", () => {
    const alerts = buildSettingsSearchModel("alerts", true, sizingFields);
    const telegram = buildSettingsSearchModel("telegram", true, sizingFields);

    expect(alerts.showAlertsSection).toBe(false);
    expect(alerts.hasAnySettingsSearchResult).toBe(false);
    expect(telegram.showDesktopConnections).toBe(false);
    expect(telegram.hasAnySettingsSearchResult).toBe(false);
  });

  it("finds uncertain operation recovery under diagnostics", () => {
    const model = buildSettingsSearchModel("uncertain operation", true, sizingFields);
    expect(model.showDiagnostics).toBe(true);
    expect(model.hasAnySettingsSearchResult).toBe(true);
  });
});
