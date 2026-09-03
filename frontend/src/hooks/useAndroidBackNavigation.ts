import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

export const MOBILE_BACK_EVENT = "fyxtez:mobile-back";
export const DOUBLE_BACK_EXIT_WINDOW_MS = 2_000;

type MobileBackEventDetail = {
  handled: boolean;
};

const HISTORY_GUARD = "__fyxtezAndroidBackGuard";

function isAndroidTauri(): boolean {
  return isTauri() && /Android/i.test(navigator.userAgent);
}

function guardedHistoryState(): Record<string, unknown> {
  const current = history.state;
  const state = current && typeof current === "object" ? current : {};
  return { ...state, [HISTORY_GUARD]: true };
}

function pushHistoryGuard(): void {
  history.pushState(guardedHistoryState(), document.title);
}

export function resolveUnclaimedBack(
  lastBackAt: number | null,
  now: number,
  windowMs = DOUBLE_BACK_EXIT_WINDOW_MS,
): "arm-exit" | "exit" {
  return lastBackAt !== null && now - lastBackAt <= windowMs ? "exit" : "arm-exit";
}

export function claimMobileBack(event: Event, dismiss: () => void): boolean {
  const mobileEvent = event as CustomEvent<MobileBackEventDetail>;
  if (mobileEvent.detail?.handled) return false;

  mobileEvent.detail.handled = true;
  event.preventDefault();
  dismiss();
  return true;
}

/** Registers a dismissible UI layer for Android's system back gesture. */
export function useMobileBackDismissal(active: boolean, dismiss: () => void): void {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useEffect(() => {
    if (!active) return;

    const handleBack = (event: Event) => {
      claimMobileBack(event, () => dismissRef.current());
    };
    window.addEventListener(MOBILE_BACK_EVENT, handleBack);
    return () => window.removeEventListener(MOBILE_BACK_EVENT, handleBack);
  }, [active]);
}

/**
 * Converts Android WebView history-back events into app navigation. A sentinel
 * history entry gives the WebView something to pop; handled UI backs re-arm it,
 * while the second unhandled back exits through native Tauri code.
 */
export function useAndroidBackNavigation(primaryDismiss: () => boolean): boolean {
  const primaryDismissRef = useRef(primaryDismiss);
  primaryDismissRef.current = primaryDismiss;
  const [exitArmed, setExitArmed] = useState(false);

  useEffect(() => {
    if (!isAndroidTauri()) return;

    let exitHintTimer: number | null = null;
    let lastUnclaimedBackAt: number | null = null;

    if (!history.state?.[HISTORY_GUARD]) pushHistoryGuard();

    const clearExitHint = () => {
      lastUnclaimedBackAt = null;
      setExitArmed(false);
      if (exitHintTimer !== null) {
        window.clearTimeout(exitHintTimer);
        exitHintTimer = null;
      }
    };

    const rearmExitHint = () => {
      setExitArmed(true);
      if (exitHintTimer !== null) window.clearTimeout(exitHintTimer);
      exitHintTimer = window.setTimeout(clearExitHint, DOUBLE_BACK_EXIT_WINDOW_MS);
    };

    const handleHistoryBack = () => {
      if (primaryDismissRef.current()) {
        clearExitHint();
        pushHistoryGuard();
        return;
      }

      const detail: MobileBackEventDetail = { handled: false };
      const event = new CustomEvent<MobileBackEventDetail>(MOBILE_BACK_EVENT, {
        cancelable: true,
        detail,
      });
      window.dispatchEvent(event);

      if (detail.handled || event.defaultPrevented) {
        clearExitHint();
        pushHistoryGuard();
        return;
      }

      const now = Date.now();
      if (resolveUnclaimedBack(lastUnclaimedBackAt, now) === "arm-exit") {
        lastUnclaimedBackAt = now;
        rearmExitHint();
        pushHistoryGuard();
        return;
      }

      clearExitHint();
      void invoke("exit_app").catch((error: unknown) => {
        console.error("[mobile] failed to exit application", error);
        lastUnclaimedBackAt = Date.now();
        rearmExitHint();
        pushHistoryGuard();
      });
    };

    window.addEventListener("popstate", handleHistoryBack);
    return () => {
      window.removeEventListener("popstate", handleHistoryBack);
      if (exitHintTimer !== null) window.clearTimeout(exitHintTimer);
    };
  }, []);

  return exitArmed;
}
