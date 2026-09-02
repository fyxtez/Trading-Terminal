import { useEffect, useState, type ReactNode } from "react";
import {
  initializeTradingApiBaseUrl,
  restartDesktopBackend,
} from "../../config/constants";
import "./DesktopRuntimeGate.css";

type RuntimeState =
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "failed"; message: string };

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export default function DesktopRuntimeGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RuntimeState>({ kind: "starting" });

  useEffect(() => {
    let current = true;
    void initializeTradingApiBaseUrl().then(
      () => current && setState({ kind: "ready" }),
      (reason: unknown) =>
        current && setState({ kind: "failed", message: errorMessage(reason) }),
    );
    return () => {
      current = false;
    };
  }, []);

  const retry = () => {
    setState({ kind: "starting" });
    void restartDesktopBackend().then(
      () => setState({ kind: "ready" }),
      (reason: unknown) =>
        setState({ kind: "failed", message: errorMessage(reason) }),
    );
  };

  if (state.kind === "ready") return children;

  return (
    <main className="desktop-runtime-gate">
      <section>
        <img src="/fyxtez-f-mark-alpha.png" alt="" />
        <small>FYXTEZ TERMINAL</small>
        <h1>{state.kind === "starting" ? "Starting local engine" : "Local engine unavailable"}</h1>
        <p>
          {state.kind === "starting"
            ? "Preparing the private backend bundled with this desktop app…"
            : state.message}
        </p>
        {state.kind === "failed" && (
          <button type="button" onClick={retry}>RETRY BACKEND</button>
        )}
      </section>
    </main>
  );
}
