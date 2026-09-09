import type { SettingsSearchModel } from "./settingsSearch";

export const SETTINGS_SECTIONS = [
  {
    id: "showExchangeConnections",
    label: "Exchange Connections",
    icon: "M7 7h14l-4-4M17 17H3l4 4M21 7l-4 4M3 17l4-4",
  },
  { id: "showBrowserAccess", label: "Browser access", icon: "M3 5h18v14H3zM3 9h18M7 7h1M10 7h1" },
  { id: "showDiagnostics", label: "App status", icon: "M3 12h4l3-8 4 16 3-8h4" },
  {
    id: "showDataBackup",
    label: "Backup and restore",
    icon: "M4 4h16v16H4zM8 4v6h8V4M8 20v-6h8v6",
  },
  { id: "showMarginSection", label: "Trade sizing", icon: "M4 7h16M4 17h16M8 4v6M16 14v6" },
  { id: "showDrawingSetsSection", label: "Drawing sets", icon: "M3 7V4h7l3 3h8v13H3z" },
  { id: "showDrawingsSection", label: "Drawings", icon: "M4 20l1-5L17 3l4 4L9 19zM14 6l4 4" },
  { id: "showPnlSection", label: "PNL", icon: "M3 3v18h18M6 16l5-6 4 3 6-8" },
  { id: "showAlertsSection", label: "Alerts", icon: "M5 17h14l-2-4V9a5 5 0 0 0-10 0v4zM10 21h4" },
  {
    id: "showChartDisplaySection",
    label: "Chart display",
    icon: "M3 4h18v14H3zM8 22h8M12 18v4M6 13l4-4 4 3 4-5",
  },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/** Search reveals every matching section; normal navigation reveals just the selected section. */
export function selectSettingsSections(
  search: SettingsSearchModel,
  selected: SettingsSectionId | null,
  browserSupported: boolean,
): SettingsSearchModel {
  const result = { ...search };
  for (const { id } of SETTINGS_SECTIONS) {
    result[id] = search[id] && (search.isSearchingSettings || selected === id);
  }
  result.showBrowserAccess = result.showBrowserAccess && browserSupported;
  result.hasAnySettingsSearchResult =
    search.showBalanceCard || SETTINGS_SECTIONS.some(({ id }) => result[id]);
  return result;
}
