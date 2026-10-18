import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  embeddedTerminalContext,
  notifyEmbeddedParent,
  storeEmbeddedCredentials,
} from "../../config/embeddedTerminal";
import { tradingApiFetch } from "../../trading/api/http";

export function EmbeddedConnection({ onConnected }: { onConnected: () => void }) {
  const connected = useRef(onConnected);
  connected.current = onConnected;
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setError("");
    setWaiting(false);
    notifyEmbeddedParent("loading");
    async function post(path: string, body: unknown) {
      const response = await fetch(`/api/browser-session/embed/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        body: JSON.stringify(body),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "Connection expired. Please try again."
            : "Could not connect. Make sure browser access is enabled in Terminal, then retry.",
        );
      return response.json();
    }
    function failed(reason: unknown) {
      if (abort.signal.aborted) return;
      setWaiting(false);
      setError(reason instanceof Error ? reason.message : "Could not connect Terminal.");
      notifyEmbeddedParent("unavailable");
    }
    void post("request", { parentOrigin: embeddedTerminalContext!.parentOrigin })
      .then((pair) => {
        if (abort.signal.aborted) return;
        if (
          !/^[a-f0-9]{64}$/.test(pair.requestId) ||
          !/^[a-f0-9]{64}$/.test(pair.pollSecret) ||
          !Number.isFinite(pair.expiresInMs)
        )
          throw new Error("Invalid connection response.");
        const expires = Date.now() + Math.min(pair.expiresInMs, 180_000);
        setWaiting(true);
        notifyEmbeddedParent("connect", pair.requestId);
        const poll = async () => {
          if (abort.signal.aborted) return;
          if (Date.now() >= expires) {
            failed(new Error("Connection expired. Please try again."));
            return;
          }
          try {
            const result = await post("poll", {
              requestId: pair.requestId,
              pollSecret: pair.pollSecret,
            });
            if (abort.signal.aborted) return;
            if (result.status === "connected") {
              storeEmbeddedCredentials(result);
              connected.current();
            } else if (result.status === "pending") {
              timer = setTimeout(() => void poll(), 1500);
            } else {
              failed(new Error("Connection was declined. You can try again."));
            }
          } catch (reason) {
            failed(reason);
          }
        };
        void poll();
      })
      .catch(failed);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [attempt]);

  return (
    <main className="desktop-runtime-gate">
      <section>
        <h1>Connect Terminal</h1>
        {waiting ? (
          <p>
            Choose Connect Terminal above, approve the connection in your authorized Terminal
            browser, then return here.
          </p>
        ) : (
          !error && <p>Preparing your connection…</p>
        )}
        {error && (
          <>
            <p role="alert">{error}</p>
            <button onClick={() => setAttempt((value) => value + 1)}>Try again</button>
          </>
        )}
      </section>
    </main>
  );
}

export function TerminalConnectionGate({ children }: { children: ReactNode }) {
  const [requestId] = useState(() => {
    if (window.self !== window.top) return null;
    const id = new URLSearchParams(window.location.hash.slice(1)).get("opcore-connect");
    return id && /^[a-f0-9]{64}$/.test(id) ? id : null;
  });
  const [origin, setOrigin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!requestId) return;
    const abort = new AbortController();
    void tradingApiFetch(`/api/browser-session/embed/review?requestId=${requestId}`, {
      signal: abort.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            "This connection expired or was already reviewed. Return to OpCore and retry.",
          );
        const result = await response.json();
        if (!abort.signal.aborted) setOrigin(result.parentOrigin);
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(String(reason.message));
      });
    return () => abort.abort();
  }, [requestId]);
  if (!requestId) return <>{children}</>;
  async function decide(approve: boolean) {
    setBusy(true);
    setError("");
    try {
      const response = await tradingApiFetch("/api/browser-session/embed/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, approve }),
      });
      if (!response.ok)
        throw new Error("This connection could not be approved. Return to OpCore and retry.");
      setDone(true);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not connect.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="desktop-runtime-gate">
      <section>
        <h1>{done ? "Connection reviewed" : "Connect OpCore to Terminal?"}</h1>
        {done ? (
          <p>You can close this tab and return to OpCore.</p>
        ) : (
          <>
            <p>
              This allows Terminal inside OpCore to use your Terminal account, including trading.
              Connect only if you just requested this in OpCore.
            </p>
            {origin && <p>App: {origin}</p>}
            {error && <p role="alert">{error}</p>}
            <button disabled={!origin || busy || !!error} onClick={() => void decide(true)}>
              Connect OpCore
            </button>
            <button disabled={!origin || busy} onClick={() => void decide(false)}>
              Cancel
            </button>
          </>
        )}
      </section>
    </main>
  );
}
