import { isTauri } from "@tauri-apps/api/core";

export type DesktopCredentialStatus = {
  binanceConfigured: boolean;
  binanceNetwork: "mainnet" | "testnet" | null;
  ntfyConfigured: boolean;
  telegramConfigured: boolean;
};

export type DesktopConnection = "binance" | "ntfy" | "telegram";

export const DESKTOP_SETUP_EVENT = "fyxtez:open-desktop-setup";
export const DESKTOP_CREDENTIALS_CHANGED_EVENT = "fyxtez:desktop-credentials-changed";
export const DESKTOP_ONBOARDING_KEY = "fyxtez:desktop-onboarding-complete";

let currentStatus: DesktopCredentialStatus = {
  binanceConfigured: false,
  binanceNetwork: null,
  ntfyConfigured: false,
  telegramConfigured: false,
};

export function setDesktopCredentialStatus(status: DesktopCredentialStatus) {
  currentStatus = status;
  window.dispatchEvent(new CustomEvent(DESKTOP_CREDENTIALS_CHANGED_EVENT, { detail: status }));
}

export function canUseTradingAccount(): boolean {
  return isTauri() && currentStatus.binanceConfigured;
}
