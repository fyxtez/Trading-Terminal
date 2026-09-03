import { invoke, isTauri } from "@tauri-apps/api/core";
import { formatSymbolPair, getSymbolInfo } from "../config/symbols";
import type { AlertPattern, PriceAlert } from "../types/alert";
import { publishSystemNotice } from "../diagnostics/events";

const DEFAULT_PUBLIC_TERMINAL_URL = "https://demo.terminal.fyxtez.com";

function alertChartUrl(symbol: string): string {
  // use the same base-ticker route as App/useSymbol (`/BTC`, not
  // `/BTCUSDT`) so tapping an ntfy notification opens the intended chart.
  const baseUrl = (import.meta.env.VITE_PUBLIC_TERMINAL_URL ?? DEFAULT_PUBLIC_TERMINAL_URL).replace(
    /\/+$/,
    "",
  );
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
      // alerts saved before additionalInfo existed need an empty-string
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
 * Notification destinations are desktop credentials. JavaScript sends only
 * the rendered message to Tauri; the native command reads ntfy/Telegram
 * secrets from the OS credential store and performs the outbound requests.
 */
export async function sendPriceAlertNotification(
  symbol: string,
  triggeredPrice: number,
  side: "LONG" | "SHORT",
  pattern: AlertPattern,
  additionalInfo: string,
): Promise<void> {
  if (!isTauri()) {
    console.error(
      "Price alert notification skipped: notifications are available only in the desktop app",
    );
    return;
  }

  const displaySymbol = formatSymbolPair(symbol);
  const chartUrl = alertChartUrl(symbol);

  const lines = [`${displaySymbol} reached ${triggeredPrice}`, `SETUP: ${side}`];

  if (pattern !== "none") {
    lines.push(`PATTERN: ${pattern.toUpperCase()}`);
  }

  // match persistent backend alerts by appending user context only
  // when supplied; blank notes add no empty line or placeholder text.
  const normalizedInfo = additionalInfo.trim();
  if (normalizedInfo) lines.push(normalizedInfo);

  // keep a visible URL in the message for copy/share clients, while
  // the Click header below makes tapping the notification open it directly.
  lines.push(chartUrl);

  try {
    await invoke("send_notification", {
      input: {
        title: `${displaySymbol} price alert`,
        body: lines.join("\n"),
        clickUrl: chartUrl,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Notification request failed";
    publishSystemNotice({
      kind: "warning",
      title: "Notification delivery failed",
      message: `${message}. The price alert still triggered successfully.`,
    });
    // Delivery is best-effort: the alert crossing remains completed and is
    // never rolled back merely because ntfy/Telegram could not be reached.
    console.error("Failed to send price alert notification", error);
  }
}
