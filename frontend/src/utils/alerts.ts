import { formatSymbolPair, getSymbolInfo } from "../config/symbols";
import type { AlertPattern, PriceAlert } from "../types/alert";

const DEFAULT_PUBLIC_TERMINAL_URL = "https://demo.terminal.fyxtez.com";
const NTFY_URL = import.meta.env.VITE_NTFY_URL?.trim() ?? "";

function alertChartUrl(symbol: string): string {
  // FEATURE: use the same base-ticker route as App/useSymbol (`/BTC`, not
  // `/BTCUSDT`) so tapping an ntfy notification opens the intended chart.
  const baseUrl = (
    import.meta.env.VITE_PUBLIC_TERMINAL_URL ?? DEFAULT_PUBLIC_TERMINAL_URL
  ).replace(/\/+$/, "");
  return `${baseUrl}/${encodeURIComponent(getSymbolInfo(symbol).label)}`;
}

const VALID_PATTERNS: readonly AlertPattern[] = [
  "none",
  "breakout",
  "breakdown",
  "support",
  "resistance",
  "retest",
  "sweep",
];

export function loadStoredAlerts(storageKey: string): PriceAlert[] {
  try {
    const raw = localStorage.getItem(storageKey);

    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    // Backward compat: alerts created before the LONG/SHORT setup field
    // and the pattern field existed are sitting in localStorage without
    // them at all - same reasoning as the optional `timeframe` field on
    // Drawing in types/drawing.ts. Default them rather than leaving the
    // field undefined, which would crash anything that reads it (e.g.
    // AlertLinesOverlay.tsx's `alert.side.toLowerCase()`).
    return (parsed as PriceAlert[]).map((alert) => ({
      ...alert,
      side: alert.side === "SHORT" ? "SHORT" : "LONG",
      pattern: VALID_PATTERNS.includes(alert.pattern) ? alert.pattern : "none",
      // FIX: alerts saved before additionalInfo existed need an empty-string
      // default so the inline editor remains controlled after an upgrade.
      additionalInfo: typeof alert.additionalInfo === "string" ? alert.additionalInfo : "",
      locked: alert.locked === true,
      hidden: alert.hidden === true,
    }));
  } catch (error) {
    console.error("Failed to load price alerts", error);
    return [];
  }
}

export function saveAlerts(storageKey: string, alerts: PriceAlert[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(alerts));
  } catch (error) {
    console.error("Failed to save price alerts", error);
  }
}

/**
 * Fires the actual notification once a price alert's level has been
 * crossed (see usePriceAlerts.ts).
 *
 * There is no backend for this at all - a "backend" here would just be
 * a thin pass-through that receives a request from the browser and
 * immediately forwards it to ntfy.sh with a curl call, so the browser
 * calls ntfy.sh's publish endpoint directly instead:
 *
 *   curl -H "Title: Telegram" -d "Your message here" \
 *     https://ntfy.sh/<topic>
 *
 * ntfy.sh's publish endpoint accepts plain CORS POSTs from a browser
 * (it's designed to be used from web apps), so no server is required
 * to make this work.
 */
export async function sendPriceAlertNotification(
  symbol: string,
  triggeredPrice: number,
  side: "LONG" | "SHORT",
  pattern: AlertPattern,
  additionalInfo: string,
): Promise<void> {
  if (!NTFY_URL) {
    console.error(
      "Price alert notification skipped: VITE_NTFY_URL is not configured",
    );
    return;
  }

  const displaySymbol = formatSymbolPair(symbol);
  const chartUrl = alertChartUrl(symbol);

  const lines = [
    `${displaySymbol} reached ${triggeredPrice}`,
    `SETUP: ${side}`,
  ];

  if (pattern !== "none") {
    lines.push(`PATTERN: ${pattern.toUpperCase()}`);
  }

  // FEATURE: match persistent backend alerts by appending user context only
  // when supplied; blank notes add no empty line or placeholder text.
  const normalizedInfo = additionalInfo.trim();
  if (normalizedInfo) lines.push(normalizedInfo);

  // FEATURE: keep a visible URL in the message for copy/share clients, while
  // the Click header below makes tapping the notification open it directly.
  lines.push(chartUrl);

  try {
    await fetch(NTFY_URL, {
      method: "POST",
      headers: {
        Title: `${displaySymbol} price alert`,
        Click: chartUrl,
      },
      body: lines.join("\n"),
    });
  } catch (error) {
    // Best-effort - a failed notification shouldn't crash the chart, and
    // there's nothing more useful to do here than log it.
    console.error("Failed to send price alert notification", error);
  }
}
