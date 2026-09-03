import { useEffect, useState, type ReactNode } from "react";
import { initializeTradingApiBaseUrl, restartDesktopBackend } from "../../config/constants";
import LoadingIndicator from "../LoadingIndicator/LoadingIndicator";
import "./DesktopRuntimeGate.css";

type RuntimeState = { kind: "starting" } | { kind: "ready" } | { kind: "failed"; message: string };

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export default function DesktopRuntimeGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RuntimeState>({ kind: "starting" });

  useEffect(() => {
    let current = true;
    void initializeTradingApiBaseUrl().then(
      () => current && setState({ kind: "ready" }),
      (reason: unknown) => current && setState({ kind: "failed", message: errorMessage(reason) }),
    );
    return () => {
      current = false;
    };
  }, []);

  const retry = () => {
    setState({ kind: "starting" });
    void restartDesktopBackend().then(
      () => setState({ kind: "ready" }),
      (reason: unknown) => setState({ kind: "failed", message: errorMessage(reason) }),
    );
  };

  if (state.kind === "ready") return children;

  return (
    <main className="desktop-runtime-gate">
      <section>
        <img src="/fyxtez-f-mark-alpha.png" alt="" />
        <small>FYXTEZ TERMINAL</small>
        <h1>
          {state.kind === "starting" ? "Starting local backend" : "Local backend unavailable"}
        </h1>
        {state.kind === "starting" ? (
          <>
            <p>Preparing the private services bundled with this desktop app.</p>
            <LoadingIndicator
              variant="panel"
              label="Loading backend data"
              detail="Preparing local storage, market definitions and connection state. First launch can take a few seconds."
            />
          </>
        ) : (
          <p>{state.message}</p>
        )}
        {state.kind === "failed" && (
          <button type="button" onClick={retry}>
            RETRY BACKEND
          </button>
        )}
      </section>
    </main>
  );
}
