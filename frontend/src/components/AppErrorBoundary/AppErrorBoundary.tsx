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
          <span>TERMINAL RECOVERY</span>
          <h1>Something went wrong on this screen.</h1>
          <p>
            Trading is paused until the screen reloads. Any action Binance already completed stays
            completed.
          </p>
          <button type="button" onClick={() => window.location.reload()}>
            RELOAD TERMINAL
          </button>
        </div>
      </main>
    );
  }
}
