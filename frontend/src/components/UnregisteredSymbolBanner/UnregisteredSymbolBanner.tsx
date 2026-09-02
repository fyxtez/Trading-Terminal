import { useState } from "react";
import { getSymbolInfo } from "../../config/symbols";
import { addSymbol } from "../../trading/api/symbols";
import "./UnregisteredSymbolBanner.css";

type UnregisteredSymbolBannerProps = {
  symbol: string;
  /** Re-syncs the frontend's symbol registry - see useSymbol()'s syncRegistry. */
  onRegistered: () => Promise<void>;
};

/**
 * Shown when the active chart symbol isn't registered on whichever backend
 * the app is currently connected to (see getSymbolConfig()'s placeholder
 * fallback in config/constants.ts, and isSymbolUnconfirmed()).
 *
 * This app automatically picks between a local dev backend and an
 * always-on remote one (see initializeTradingApiBaseUrl()) - each keeps its
 * own independently-persisted symbol registry file. A symbol added while
 * one backend was active simply isn't known to the other. Rather than
 * silently showing an inaccurate placeholder chart (or, before that,
 * crashing the app), this offers a one-click fix: register the symbol on
 * whichever backend is active right now.
 */
export default function UnregisteredSymbolBanner({ symbol, onRegistered }: UnregisteredSymbolBannerProps) {
  const [status, setStatus] = useState<"idle" | "pending" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const info = getSymbolInfo(symbol);

  const handleRegister = async () => {
    if (status === "pending") return;
    setStatus("pending");
    setError(null);
    try {
      await addSymbol(info.label);
      await onRegistered();
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not register symbol");
    }
  };

  return (
    <div className="unregistered-symbol-banner" role="status">
      <span className="unregistered-symbol-banner-text">
        <strong>{info.label}</strong> isn't registered on the currently connected backend
        {error ? ` — ${error}` : " — price/precision shown may be inaccurate."}
      </span>
      <button
        className="unregistered-symbol-banner-action"
        onClick={() => void handleRegister()}
        disabled={status === "pending"}
      >
        {status === "pending" ? "Registering…" : status === "error" ? "Retry" : "Register here"}
      </button>
    </div>
  );
}
