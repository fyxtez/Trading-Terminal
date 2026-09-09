import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useId, useRef } from "react";
import { claimMobileBack, MOBILE_BACK_EVENT } from "./useAndroidBackNavigation";

const HISTORY_KEY = "__terminalSettingsSection";

/** Gives the open Settings section one Back step before closing the panel or leaving the page. */
export function useSettingsBackNavigation(active: boolean, onBack: () => void) {
  const id = useId();
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const cleanupTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    if (cleanupTimer.current !== null) {
      window.clearTimeout(cleanupTimer.current);
      cleanupTimer.current = null;
    }
    let handled = false;
    const back = () => {
      if (handled) return;
      handled = true;
      onBackRef.current();
    };
    // Capture before App's general dismissal so a section returns to the index first.
    const mobileBack = (event: Event) => claimMobileBack(event, back);
    window.addEventListener(MOBILE_BACK_EVENT, mobileBack, true);

    const native = isTauri();
    let popped = false;
    const historyBack = () => {
      if (history.state?.[HISTORY_KEY] === id) return;
      popped = true;
      back();
    };
    const mouseBack = (event: MouseEvent) => {
      if (event.button !== 3) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "mouseup") back();
    };

    if (native) {
      // Native Android already owns a history guard; desktop WebViews need the mouse event.
      window.addEventListener("mousedown", mouseBack, true);
      window.addEventListener("mouseup", mouseBack, true);
      window.addEventListener("auxclick", mouseBack, true);
    } else {
      // Browser edge gestures and mouse Back both traverse this same history entry.
      if (history.state?.[HISTORY_KEY] !== id) {
        history.pushState({ ...history.state, [HISTORY_KEY]: id }, "");
      }
      window.addEventListener("popstate", historyBack);
    }

    return () => {
      window.removeEventListener(MOBILE_BACK_EVENT, mobileBack, true);
      window.removeEventListener("popstate", historyBack);
      window.removeEventListener("mousedown", mouseBack, true);
      window.removeEventListener("mouseup", mouseBack, true);
      window.removeEventListener("auxclick", mouseBack, true);
      if (!native && !popped && history.state?.[HISTORY_KEY] === id) {
        // Defer so StrictMode's immediate effect replay can retain the same entry.
        cleanupTimer.current = window.setTimeout(() => {
          cleanupTimer.current = null;
          if (history.state?.[HISTORY_KEY] === id) history.back();
        }, 0);
      }
    };
  }, [active, id]);
}
