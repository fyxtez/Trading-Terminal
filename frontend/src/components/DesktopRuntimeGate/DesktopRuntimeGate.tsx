import { useEffect, useState, type ReactNode } from "react";
import {
  getLocalBrowserSessionProof,
  getTradingRuntimeMode,
  initializeTradingApiBaseUrl,
  LocalBrowserSessionError,
  retryTradingRuntime,
  validateLocalBrowserSession,
} from "../../config/constants";
import LoadingIndicator from "../LoadingIndicator/LoadingIndicator";
import { userFacingError } from "../../utils/userFacingError";
import { LOCAL_BROWSER_SESSION_ENDED_EVENT } from "../../trading/api/http";
import "./DesktopRuntimeGate.css";

type RuntimeState =
  | { kind: "starting" }
  | { kind: "ready" }
  | {
      kind: "failed";
      message: string;
      browserAccess: boolean;
      retryAvailable: boolean;
    };

function errorMessage(reason: unknown, browserAccess = false): string {
  return userFacingError(
    reason,
    browserAccess
      ? "Terminal could not check this browser connection. Please try again."
      : "Terminal could not start. Please try again.",
  );
}

function failedRuntimeState(reason: unknown): RuntimeState {
  const runtimeMode = getTradingRuntimeMode();
  const browserAccess =
    reason instanceof LocalBrowserSessionError || runtimeMode === "local-browser";

  return {
    kind: "failed",
    message: errorMessage(reason, browserAccess),
    browserAccess,
    // A browser tab can retry a temporary connection failure only while it
    // still holds its half of the active session. Once that proof is gone, a
    // fresh one-use launch ticket must come from the installed app.
    retryAvailable:
      !browserAccess || (runtimeMode === "local-browser" && getLocalBrowserSessionProof() !== null),
  };
}

export default function DesktopRuntimeGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RuntimeState>({ kind: "starting" });

  useEffect(() => {
    let current = true;
    void initializeTradingApiBaseUrl().then(
      () => current && setState({ kind: "ready" }),
      (reason: unknown) => current && setState(failedRuntimeState(reason)),
    );
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (state.kind !== "ready" || getTradingRuntimeMode() !== "local-browser") return;

    let current = true;
    const checkSession = () => {
      void validateLocalBrowserSession().catch((reason: unknown) => {
        if (current) {
          setState(failedRuntimeState(reason));
        }
      });
    };
    const handleSessionEnded = () => {
      if (current) {
        setState({
          kind: "failed",
          message: "This browser connection has expired or was turned off.",
          browserAccess: true,
          retryAvailable: false,
        });
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") checkSession();
    };

    const interval = window.setInterval(checkSession, 30_000);
    window.addEventListener(LOCAL_BROWSER_SESSION_ENDED_EVENT, handleSessionEnded);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      current = false;
      window.clearInterval(interval);
      window.removeEventListener(LOCAL_BROWSER_SESSION_ENDED_EVENT, handleSessionEnded);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [state.kind]);

  const retry = () => {
    setState({ kind: "starting" });
    void retryTradingRuntime().then(
      () => setState({ kind: "ready" }),
      (reason: unknown) => setState(failedRuntimeState(reason)),
    );
  };

  if (state.kind === "ready") return children;

  const localBrowser =
    getTradingRuntimeMode() === "local-browser" || (state.kind === "failed" && state.browserAccess);
  const canRetry = state.kind === "failed" && state.retryAvailable;

  return (
    <main className="desktop-runtime-gate">
      <section>
        <img src="/fyxtez-f-mark-alpha.png" alt="" />
        <small>TERMINAL</small>
        <h1>
          {state.kind === "starting"
            ? localBrowser
              ? "Connecting this browser"
              : "Getting Terminal ready"
            : localBrowser
              ? canRetry
                ? "Browser access needs attention"
                : "Open this page from Terminal again"
              : "Terminal could not start"}
        </h1>
        {state.kind === "starting" ? (
          <>
            <p>
              {localBrowser
                ? "Confirming the secure connection to Terminal on this computer."
                : "Loading everything you need to use the terminal."}
            </p>
            <LoadingIndicator
              variant="panel"
              label="Preparing your workspace"
              detail="Loading your saved setup and the latest market information. The first start may take a little longer."
            />
          </>
        ) : (
          <>
            <p>{state.message}</p>
            {localBrowser && (
              <p className="desktop-runtime-gate-guidance">
                {canRetry
                  ? "Make sure the installed Terminal app is still open, then check again. Your Binance keys remain protected on this computer."
                  : "Return to the installed Terminal app and choose Open in browser. For your security, this page cannot reconnect by itself. Your Binance keys remain protected on this computer."}
              </p>
            )}
          </>
        )}
        {state.kind === "failed" && canRetry && (
          <button type="button" onClick={retry}>
            {localBrowser ? "CHECK AGAIN" : "TRY AGAIN"}
          </button>
        )}
      </section>
    </main>
  );
}
