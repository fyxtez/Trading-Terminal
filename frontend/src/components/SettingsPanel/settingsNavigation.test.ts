import { describe, expect, it } from "vitest";
import { buildSettingsSearchModel } from "./settingsSearch";
import { SETTINGS_SECTIONS, selectSettingsSections } from "./settingsNavigation";

const fields = [
  { name: "max_leverage", label: "Maximum leverage", description: "Hard leverage cap" },
];

describe("Settings section navigation", () => {
  it("shows no section content on the home screen and only the selected section after navigation", () => {
    const search = buildSettingsSearchModel("", true, fields);
    const home = selectSettingsSections(search, null, true);
    expect(SETTINGS_SECTIONS.every(({ id }) => !home[id])).toBe(true);
    for (const section of SETTINGS_SECTIONS.filter(({ id }) => search[id])) {
      const selected = selectSettingsSections(search, section.id, true);
      expect(SETTINGS_SECTIONS.filter(({ id }) => selected[id]).map(({ id }) => id)).toEqual([
        section.id,
      ]);
    }
  });

  it("search displays all matching sections even when another section was selected", () => {
    const search = buildSettingsSearchModel("chart", true, fields);
    const result = selectSettingsSections(search, "showMarginSection", true);
    expect(SETTINGS_SECTIONS.filter(({ id }) => result[id]).map(({ id }) => id)).toEqual(
      SETTINGS_SECTIONS.filter(({ id }) => search[id]).map(({ id }) => id),
    );
    expect(result.showDrawingsSection).toBe(true);
    expect(result.showChartDisplaySection).toBe(true);
    expect(result.showMarginSection).toBe(false);
  });

  it("keeps field matching and platform restrictions when searching", () => {
    const leverage = selectSettingsSections(
      buildSettingsSearchModel("Maximum leverage", true, fields),
      null,
      true,
    );
    expect(leverage.matchingSizingFieldNames).toEqual(["max_leverage"]);
    expect(leverage.showMarginSection).toBe(true);
    const browser = selectSettingsSections(
      buildSettingsSearchModel("Browser access", true, fields),
      null,
      false,
    );
    expect(browser.showBrowserAccess).toBe(false);
    expect(browser.hasAnySettingsSearchResult).toBe(false);
    const backup = selectSettingsSections(
      buildSettingsSearchModel("Backup", false, fields),
      "showDataBackup",
      true,
    );
    expect(backup.showDataBackup).toBe(false);
  });
});
