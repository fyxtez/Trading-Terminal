export type SettingsSearchModel = ReturnType<typeof buildSettingsSearchModel>;

type SearchableSizingField = {
  name: string;
  label: string;
  description: string;
};

/** Builds the section/field visibility model without coupling it to rendering. */
export function buildSettingsSearchModel(
  query: string,
  isDesktop: boolean,
  sizingFields: SearchableSizingField[],
) {
  const normalizedQuery = query.trim().toLowerCase();
  const isSearchingSettings = normalizedQuery.length > 0;
  const matches = (...parts: Array<string | undefined>) =>
    !isSearchingSettings || parts.filter(Boolean).join(" ").toLowerCase().includes(normalizedQuery);

  const marginSectionTitleMatches = matches(
    "Margin configuration",
    "margin leverage sizing position order risk",
  );
  const matchingSizingFieldNames = sizingFields
    .filter((field) => matches(field.label, field.description, field.name))
    .map((field) => field.name);
  const marginFieldMatches = matchingSizingFieldNames.length > 0;
  const showMarginSection = !isSearchingSettings || marginSectionTitleMatches || marginFieldMatches;

  const drawingSetsSectionMatches = matches(
    "Drawing sets",
    "save named layouts symbol drawing set rename delete load clear new",
  );
  const showDrawingSetsSection = !isSearchingSettings || drawingSetsSectionMatches;

  const drawingsSectionTitleMatches = matches(
    "Drawings",
    "chart drawings sessions day candle zones kill zone",
  );
  const drawingOptionMatches = {
    showDrawings: matches("Show drawings", "Show all saved drawings on the chart"),
    startOfDay: matches("Start of day candle", "vertical marker start chart day daily"),
    dayHistory: matches("Day history", "Number of chart days to mark maximum 20 lookback"),
    asia: matches("Asia session zone", "Asia session boundaries chart"),
    london: matches("London session zone", "London session boundaries chart"),
    newYork: matches("New York session zone", "New York session boundaries chart"),
    killZone: matches("Show kill zone", "Highlight 13:00 16:00 chart time New York"),
  };
  const showDrawingsSection =
    !isSearchingSettings ||
    drawingsSectionTitleMatches ||
    Object.values(drawingOptionMatches).some(Boolean);

  const pnlSectionTitleMatches = matches("PNL", "profit loss unrealized realized total position");
  const pnlOptionMatches = {
    position: matches("Show PNL", "active symbol unrealized realized PNL card chart"),
    total: matches("Show TOTAL PNL", "unrealized PNL total across all open positions chart"),
  };
  const showPnlSection =
    !isSearchingSettings || pnlSectionTitleMatches || Object.values(pnlOptionMatches).some(Boolean);

  const alertsSectionTitleMatches = matches(
    "Alerts",
    "price alerts persistent active notifications",
  );
  const alertOptionMatches = {
    show: matches("Show price alerts", "pending price alert lines chart right click"),
    persistent: matches("Use persistent alerts", "backend store monitor alerts browser closed"),
    active: matches("Active alerts", "symbol price side info active alert list"),
  };
  const showAlertsSection =
    !isSearchingSettings ||
    alertsSectionTitleMatches ||
    Object.values(alertOptionMatches).some(Boolean);

  const chartDisplaySectionTitleMatches = matches(
    "Chart display",
    "chart display visual appearance",
  );
  const chartDisplayOptionMatches = {
    timer: matches("Show candle timer", "countdown current candle close chart"),
    watermark: matches("Show watermark", "Fyxtez watermark chart hide watermark"),
    drawingSetBadge: matches(
      "Show active drawing set",
      "currently active drawing set name chart badge",
    ),
  };
  const showChartDisplaySection =
    !isSearchingSettings ||
    chartDisplaySectionTitleMatches ||
    Object.values(chartDisplayOptionMatches).some(Boolean);

  const showBalanceCard = matches("Available balance", "USDT futures wallet balance");
  const showDesktopConnections =
    isDesktop &&
    matches("Third-Party Connections Binance ntfy Telegram credentials API key notifications");
  const showDiagnostics = matches(
    "Diagnostics sidecar backend exchange connectivity market data user stream freshness reconciliation drift rejected duplicate requests notification failures health",
  );
  const hasAnySettingsSearchResult =
    showDesktopConnections ||
    showDiagnostics ||
    showBalanceCard ||
    showMarginSection ||
    showDrawingSetsSection ||
    showDrawingsSection ||
    showPnlSection ||
    showAlertsSection ||
    showChartDisplaySection;

  return {
    isSearchingSettings,
    marginSectionTitleMatches,
    matchingSizingFieldNames,
    showMarginSection,
    drawingSetsSectionMatches,
    showDrawingSetsSection,
    drawingsSectionTitleMatches,
    drawingOptionMatches,
    showDrawingsSection,
    pnlSectionTitleMatches,
    pnlOptionMatches,
    showPnlSection,
    alertsSectionTitleMatches,
    alertOptionMatches,
    showAlertsSection,
    chartDisplaySectionTitleMatches,
    chartDisplayOptionMatches,
    showChartDisplaySection,
    showBalanceCard,
    showDesktopConnections,
    showDiagnostics,
    hasAnySettingsSearchResult,
  };
}
