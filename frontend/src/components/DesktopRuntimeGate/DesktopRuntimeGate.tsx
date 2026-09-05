import { useEffect, useState, type ReactNode } from "react";
import { initializeTradingApiBaseUrl, restartDesktopBackend } from "../../config/constants";
import LoadingIndicator from "../LoadingIndicator/LoadingIndicator";
import { userFacingError } from "../../utils/userFacingError";
import "./DesktopRuntimeGate.css";

type RuntimeState = { kind: "starting" } | { kind: "ready" } | { kind: "failed"; message: string };

function errorMessage(reason: unknown): string {
  return userFacingError(reason, "Fyxtez could not start. Please try again.");
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
        <h1>{state.kind === "starting" ? "Getting Terminal ready" : "Fyxtez could not start"}</h1>
        {state.kind === "starting" ? (
          <>
            <p>Loading everything you need to use the terminal.</p>
            <LoadingIndicator
              variant="panel"
              label="Preparing your workspace"
              detail="Loading your saved setup and the latest market information. The first start may take a little longer."
            />
          </>
        ) : (
          <p>{state.message}</p>
        )}
        {state.kind === "failed" && (
          <button type="button" onClick={retry}>
            TRY AGAIN
          </button>
        )}
      </section>
    </main>
  );
}
