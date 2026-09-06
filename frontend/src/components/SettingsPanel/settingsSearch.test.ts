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
    expect(model.showExchangeConnections).toBe(true);
    expect(model.showDataBackup).toBe(true);
  });

  it("limits a kill-zone search to the drawings section", () => {
    const model = buildSettingsSearchModel("kill zone", true, sizingFields);
    expect(model.showDrawingsSection).toBe(true);
    expect(model.drawingOptionMatches.killZone).toBe(true);
    expect(model.showMarginSection).toBe(false);
    expect(model.showAlertsSection).toBe(false);
  });

  it("keeps exchange connection guidance discoverable in browser mode", () => {
    const model = buildSettingsSearchModel("Binance", false, sizingFields);
    expect(model.showExchangeConnections).toBe(true);
    expect(model.hasAnySettingsSearchResult).toBe(true);
  });

  it("does not expose dormant alert or notification settings", () => {
    const alerts = buildSettingsSearchModel("alerts", true, sizingFields);
    const telegram = buildSettingsSearchModel("telegram", true, sizingFields);

    expect(alerts.showAlertsSection).toBe(false);
    expect(alerts.hasAnySettingsSearchResult).toBe(false);
    expect(telegram.showExchangeConnections).toBe(false);
    expect(telegram.hasAnySettingsSearchResult).toBe(false);
  });

  it("finds the previous-action check under app status", () => {
    const model = buildSettingsSearchModel("previous action", true, sizingFields);
    expect(model.showDiagnostics).toBe(true);
    expect(model.hasAnySettingsSearchResult).toBe(true);
  });

  it("finds native backup and restore without exposing it in browser mode", () => {
    expect(buildSettingsSearchModel("restore", true, sizingFields).showDataBackup).toBe(true);
    expect(buildSettingsSearchModel("restore", false, sizingFields).showDataBackup).toBe(false);
  });
});
