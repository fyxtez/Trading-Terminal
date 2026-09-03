import { Component, type ErrorInfo, type ReactNode } from "react";
import "./AppErrorBoundary.css";

type State = { error: Error | null };

export default class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[frontend] uncaught render error", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="app-error-boundary" role="alert">
        <div>
          <span>FRONTEND RECOVERY</span>
          <h1>The terminal could not render safely.</h1>
          <p>
            Trading controls are unavailable until the interface is reloaded. The local backend and
            any already-completed exchange action are not rolled back by this display error.
          </p>
          <code>{this.state.error.message || "Unknown frontend error"}</code>
          <button type="button" onClick={() => window.location.reload()}>
            RELOAD TERMINAL
          </button>
        </div>
      </main>
    );
  }
}
