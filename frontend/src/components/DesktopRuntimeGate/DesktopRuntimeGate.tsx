import terminalMark from "../../assets/fyxtez-f-mark-alpha.png?inline";
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
import BackendConnectionSection from "../SettingsPanel/BackendConnectionSection";

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
    reason instanceof LocalBrowserSessionError ||
    runtimeMode === "local-browser" ||
    runtimeMode === "remote-browser";

  return {
    kind: "failed",
    message: errorMessage(reason, browserAccess),
    browserAccess,
    // A browser tab can retry a temporary connection failure only while it
    // still holds its half of the active session. Once that proof is gone, a
    // fresh one-use launch ticket must come from the installed app.
    retryAvailable:
      !browserAccess ||
      ((runtimeMode === "local-browser" || runtimeMode === "remote-browser") &&
        getLocalBrowserSessionProof() !== null),
  };
}

export default function DesktopRuntimeGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RuntimeState>({ kind: "starting" });
  const [sessionWarning, setSessionWarning] = useState<string | null>(null);
  const [showStartupMessage, setShowStartupMessage] = useState(false);

  useEffect(() => {
    if (state.kind !== "starting") return;
    const timer = window.setTimeout(() => setShowStartupMessage(true), 300);
    return () => window.clearTimeout(timer);
  }, [state.kind]);

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
    if (
      state.kind !== "ready" ||
      !["local-browser", "remote-browser"].includes(getTradingRuntimeMode())
    )
      return;

    let current = true;
    let checking = false;
    let nextCheckAt = Date.now() + 30_000;
    const checkSession = async () => {
      if (checking || document.visibilityState === "hidden") return;
      checking = true;
      try {
        await validateLocalBrowserSession();
        if (current) setSessionWarning(null);
        nextCheckAt = Date.now() + 30_000;
      } catch (reason) {
        if (current) {
          const failure = failedRuntimeState(reason);
          if (failure.kind === "failed" && failure.retryAvailable) {
            // Keep charts mounted during temporary outages so recovery does not
            // repeatedly reload candle history and amplify the request load.
            setSessionWarning("Checking server connection… Reconnecting automatically.");
            nextCheckAt = Date.now() + 5_000;
          } else {
            setState(failure);
          }
        }
      } finally {
        checking = false;
      }
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

    const interval = window.setInterval(() => {
      if (Date.now() >= nextCheckAt) void checkSession();
    }, 5_000);
    const handleOnline = () => void checkSession();
    window.addEventListener("online", handleOnline);
    window.addEventListener(LOCAL_BROWSER_SESSION_ENDED_EVENT, handleSessionEnded);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      current = false;
      window.clearInterval(interval);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener(LOCAL_BROWSER_SESSION_ENDED_EVENT, handleSessionEnded);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [state.kind]);

  useEffect(() => {
    if (state.kind !== "failed" || !state.browserAccess || !state.retryAvailable) return;
    let current = true;
    let checking = false;
    const reconnect = async () => {
      if (checking || document.visibilityState === "hidden") return;
      checking = true;
      try {
        await retryTradingRuntime();
        if (current) setState({ kind: "ready" });
      } catch (reason) {
        if (current) setState(failedRuntimeState(reason));
      } finally {
        checking = false;
      }
    };
    const timer = window.setInterval(() => void reconnect(), 5_000);
    const resume = () => void reconnect();
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      current = false;
      window.clearInterval(timer);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [state]);

  const retry = () => {
    setShowStartupMessage(false);
    setState({ kind: "starting" });
    void retryTradingRuntime().then(
      () => setState({ kind: "ready" }),
      (reason: unknown) => setState(failedRuntimeState(reason)),
    );
  };

  if (state.kind === "ready")
    return (
      <>
        {children}
        {sessionWarning && (
          <div className="browser-session-reconnecting" role="status">
            {sessionWarning}
          </div>
        )}
      </>
    );
  if (state.kind === "starting" && !showStartupMessage) {
    return <main className="desktop-runtime-gate" aria-busy="true" aria-label="Loading Terminal" />;
  }

  const localBrowser =
    ["local-browser", "remote-browser"].includes(getTradingRuntimeMode()) ||
    (state.kind === "failed" && state.browserAccess);
  const canRetry = state.kind === "failed" && state.retryAvailable;
  const remoteBrowser = getTradingRuntimeMode() === "remote-browser";

  return (
    <main className="desktop-runtime-gate">
      <section>
        <img src={terminalMark} alt="" />
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
                ? remoteBrowser
                  ? "Connecting securely to your private Terminal server."
                  : "Confirming the secure connection to Terminal on this computer."
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
                {remoteBrowser
                  ? canRetry
                    ? "Check your internet connection, then try again. Your trading backend continues running on the server."
                    : "In the installed Terminal app, choose Open in Browser to authorize this browser. Binance keys stay on your server."
                  : canRetry
                    ? "Make sure the installed Terminal app is still open, then check again. Your Binance keys remain protected on this computer."
                    : "Return to the installed Terminal app and choose Open in Browser. For your security, this page cannot reconnect by itself. Your Binance keys remain protected on this computer."}
              </p>
            )}
          </>
        )}
        {state.kind === "failed" && canRetry && (
          <button type="button" onClick={retry}>
            {localBrowser ? "CHECK AGAIN" : "TRY AGAIN"}
          </button>
        )}
        {state.kind === "failed" && <BackendConnectionSection />}
      </section>
    </main>
  );
}
