import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getTradingRuntimeMode } from "../../config/constants";
import { userFacingError } from "../../utils/userFacingError";

type BrowserAccessStatus = {
  supported: boolean;
  available: boolean;
  enabled: boolean;
  browserUrl: string | null;
  activeSessions: number;
  unavailableReason: string | null;
};

type BrowserAccessSectionProps = {
  isExpanded: boolean;
  forceExpanded?: boolean;
  onToggle: () => void;
};

const unavailableStatus: BrowserAccessStatus = {
  // Used only when the native IPC status check itself fails. Keep the label
  // generic instead of incorrectly claiming a Linux app is an unsupported OS.
  supported: true,
  available: false,
  enabled: false,
  browserUrl: null,
  activeSessions: 0,
  unavailableReason: null,
};

function browserAccessMessage(reason: unknown, fallback: string): string {
  const raw = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  const normalized = raw.toLowerCase();
  if (normalized.includes("already in use") || normalized.includes("address is in use")) {
    return "Another program is using browser access. Close it, then restart Terminal.";
  }
  if (normalized.includes("browser files") || normalized.includes("reinstall")) {
    return "Browser files are missing. Reinstall Terminal to restore browser access.";
  }
  if (normalized.includes("starting"))
    return "Browser access is still starting. Try again shortly.";
  if (normalized.includes("ipc") || normalized.includes("command")) return fallback;
  return userFacingError(reason, fallback);
}

export default function BrowserAccessSection({
  isExpanded,
  forceExpanded = false,
  onToggle,
}: BrowserAccessSectionProps) {
  const runtimeMode = getTradingRuntimeMode();
  const expanded = forceExpanded || isExpanded;
  const [status, setStatus] = useState<BrowserAccessStatus | null>(
    runtimeMode === "native" ? null : unavailableStatus,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disableConfirmationOpen, setDisableConfirmationOpen] = useState(false);

  const refresh = async () => {
    const next = await invoke<BrowserAccessStatus>("browser_access_status");
    setStatus(next);
    return next;
  };

  useEffect(() => {
    if (runtimeMode !== "native") return;
    let current = true;
    void invoke<BrowserAccessStatus>("browser_access_status").then(
      (next) => current && setStatus(next),
      (reason: unknown) => {
        if (current) {
          setStatus(unavailableStatus);
          setError(browserAccessMessage(reason, "Terminal could not check browser access."));
        }
      },
    );
    return () => {
      current = false;
    };
  }, [runtimeMode]);

  useEffect(() => {
    if (runtimeMode !== "native" || !expanded) return;
    const refreshAfterFocus = () => {
      void refresh().catch((reason: unknown) => {
        setError(browserAccessMessage(reason, "Terminal could not check browser access."));
      });
    };
    refreshAfterFocus();
    window.addEventListener("focus", refreshAfterFocus);
    return () => window.removeEventListener("focus", refreshAfterFocus);
  }, [expanded, runtimeMode]);

  const runAction = (action: "enable" | "open" | "disable") => {
    setBusy(true);
    setError(null);
    setDisableConfirmationOpen(false);
    const command =
      action === "enable" || action === "open" ? "open_browser_terminal" : "disable_browser_access";
    void invoke(command)
      .then(refresh)
      .catch((reason: unknown) => {
        setError(browserAccessMessage(reason, "Terminal could not change browser access."));
      })
      .finally(() => setBusy(false));
  };

  return (
    <section className="settings-section settings-browser-access">
      <div className="settings-section-heading settings-section-heading-with-action">
        <div>
          <h3>Browser access</h3>
          {expanded && <p>Use this terminal in your normal browser on the same computer.</p>}
        </div>
        <button
          type="button"
          className="settings-section-visibility-button"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {forceExpanded ? "MATCH" : isExpanded ? "HIDE" : "SHOW"}
        </button>
      </div>

      {expanded && (
        <div className="settings-browser-access-card">
          {runtimeMode === "local-browser" ? (
            <>
              <div className="settings-browser-access-status enabled">
                <span>THIS BROWSER</span>
                <b>CONNECTED</b>
              </div>
              <p>
                Terminal is running on this computer and securely handling trading for this browser.
                Manage Binance keys or turn browser access off in the installed app.
              </p>
              <small>Your Binance keys are not exposed to the browser interface.</small>
            </>
          ) : runtimeMode === "public-browser" ? (
            <>
              <div className="settings-browser-access-status">
                <span>BROWSER TRADING</span>
                <b>INSTALLED APP REQUIRED</b>
              </div>
              <p>
                Install and open Terminal on Linux, then enable Browser access there. This public
                browser remains chart-only.
              </p>
            </>
          ) : !status ? (
            <p className="settings-browser-access-loading">Checking browser access…</p>
          ) : status.supported && status.available ? (
            <>
              <div className={`settings-browser-access-status ${status.enabled ? "enabled" : ""}`}>
                <span>THIS COMPUTER</span>
                <b>
                  {status.enabled
                    ? `ON${
                        status.activeSessions > 0
                          ? ` · ${status.activeSessions} ${status.activeSessions === 1 ? "SESSION" : "SESSIONS"}`
                          : ""
                      }`
                    : "OFF"}
                </b>
              </div>
              <p>
                {status.enabled
                  ? "Closing this window keeps Terminal available in the background. Quit the app to stop it completely."
                  : "Turn this on to open the full terminal in your normal browser. It works only on this computer."}
              </p>
              <small>Your Binance keys stay in the protected storage of this computer.</small>
              <div className="settings-browser-access-actions">
                {status.enabled ? (
                  <>
                    <button type="button" disabled={busy} onClick={() => runAction("open")}>
                      {busy ? "PLEASE WAIT…" : "OPEN IN BROWSER"}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() => setDisableConfirmationOpen(true)}
                    >
                      TURN OFF
                    </button>
                  </>
                ) : (
                  <button type="button" disabled={busy} onClick={() => runAction("enable")}>
                    {busy ? "PLEASE WAIT…" : "ENABLE & OPEN"}
                  </button>
                )}
              </div>
              {disableConfirmationOpen && (
                <div
                  className="settings-browser-access-confirmation"
                  role="group"
                  aria-label="Confirm turning off browser access"
                >
                  <div>
                    <strong>Turn off browser access?</strong>
                    <span>Trading and account updates will stop. The chart tab may stay open.</span>
                  </div>
                  <div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setDisableConfirmationOpen(false)}
                    >
                      CANCEL
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() => runAction("disable")}
                    >
                      CONFIRM TURN OFF
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="settings-browser-access-status">
                <span>{status.supported ? "THIS COMPUTER" : "BROWSER TRADING"}</span>
                <b>{status.supported ? "UNAVAILABLE" : "LINUX ONLY"}</b>
              </div>
              <p>
                {status.supported
                  ? "Browser access could not start. Terminal itself remains available in this window."
                  : "Browser access is available in the Linux app. Keep using the installed Android app on this device."}
              </p>
              {status.unavailableReason && (
                <small>
                  {browserAccessMessage(
                    status.unavailableReason,
                    "Restart Terminal and try browser access again.",
                  )}
                </small>
              )}
            </>
          )}

          {error && (
            <div className="settings-browser-access-error" role="alert">
              {error}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
