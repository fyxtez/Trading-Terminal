import { isTauri } from "@tauri-apps/api/core";

/** A hosted frame must never use its containing application's native commands. */
export function isNativeTerminal(): boolean {
  // WebView2 runs Tauri's initialization scripts in subframes too. The marker
  // alone therefore also appears in the Terminal embedded inside OpCore.
  return typeof window !== "undefined" && window.self === window.top && isTauri();
}
