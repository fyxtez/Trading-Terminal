import React from "react";
import ReactDOM from "react-dom/client";
import App from "./components/App/App";
import "./styles/global.css";
import DesktopSetupGate from "./components/DesktopSetupGate/DesktopSetupGate";
import DesktopRuntimeGate from "./components/DesktopRuntimeGate/DesktopRuntimeGate";
import AppErrorBoundary from "./components/AppErrorBoundary/AppErrorBoundary";

/**
 * Chromium/Brave may restore this document from the back-forward cache
 * instead of booting the current frontend bundle again. That can revive an old
 * in-memory trading API selection (for example 127.0.0.1:8657) even though the
 * currently deployed code is remote-only. A normal reload already fixes the
 * problem, so force exactly one real reload whenever this document is revived
 * by history/BFCache. The subsequent navigation is type "reload", therefore it
 * cannot loop back into this branch.
 */
window.addEventListener("pageshow", (event) => {
  const navigation = performance.getEntriesByType("navigation")[0] as
    PerformanceNavigationTiming | undefined;
  const restoredFromHistory = event.persisted || navigation?.type === "back_forward";

  if (restoredFromHistory) {
    window.location.reload();
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <DesktopRuntimeGate>
        <DesktopSetupGate>
          <App />
        </DesktopSetupGate>
      </DesktopRuntimeGate>
    </AppErrorBoundary>
  </React.StrictMode>,
);
