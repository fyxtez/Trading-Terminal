import {
  TRADING_API_BASE_URL,
  TRADING_API_TOKEN,
  getLocalBrowserSessionProof,
  getTradingRuntimeMode,
  invalidateLocalBrowserSession,
  isDedicatedBrowserOrigin,
  type TradingRuntimeMode,
} from "../../config/constants";

export const LOCAL_BROWSER_SESSION_ENDED_EVENT = "fyxtez:local-browser-session-ended";

/**
 * Sends requests to the selected Fyxtez service without ever inventing an
 * empty bearer header. Native builds authenticate with their private in-memory
 * service token. The local browser combines its HttpOnly cookie with a proof
 * held only for this browser-tab session. Public mode stays chart-only.
 */
export async function tradingApiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const runtimeMode: TradingRuntimeMode = getTradingRuntimeMode();
  const headers = new Headers(init.headers);
  if (TRADING_API_TOKEN && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${TRADING_API_TOKEN}`);
  }

  if (runtimeMode === "local-browser") {
    let requestOrigin: string;
    try {
      const requestUrl =
        input instanceof Request
          ? new URL(input.url)
          : new URL(input.toString(), `${TRADING_API_BASE_URL}/`);
      requestOrigin = requestUrl.origin;
    } catch {
      throw new Error("Terminal blocked an invalid browser request.");
    }

    const selectedOrigin = new URL(TRADING_API_BASE_URL).origin;
    if (!isDedicatedBrowserOrigin(selectedOrigin) || requestOrigin !== selectedOrigin) {
      // Never attach the page-session capability to Binance, a hosted UI, or
      // any other origin if a caller accidentally hands this wrapper an
      // external URL.
      throw new Error("Terminal blocked a browser request outside this computer.");
    }

    const proof = getLocalBrowserSessionProof();
    if (!proof) {
      invalidateLocalBrowserSession();
      window.dispatchEvent(new Event(LOCAL_BROWSER_SESSION_ENDED_EVENT));
      throw new Error("This browser connection has expired or was turned off.");
    }
    // Always replace a caller-provided value. Only the persistent origin-scoped proof
    // selected by the trusted bootstrap is allowed to authenticate this tab.
    headers.set("x-fyxtez-browser-proof", proof);
  }

  const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  let signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
  // Polling readers must eventually settle so shared requests release all
  // waiting consumers. Keep the deadline through response-body consumption.
  // Mutation deadlines/retries are owned by the durable-intent flow.
  if (method === "GET" || method === "HEAD") {
    const deadline = AbortSignal.timeout(15_000);
    signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  }

  const response = await fetch(input, {
    ...init,
    signal,
    headers,
    credentials: runtimeMode === "local-browser" ? "include" : init.credentials,
    redirect: runtimeMode === "local-browser" ? "error" : init.redirect,
  });

  if (runtimeMode === "local-browser" && response.status === 401) {
    invalidateLocalBrowserSession();
    window.dispatchEvent(new Event(LOCAL_BROWSER_SESSION_ENDED_EVENT));
  }
  return response;
}

export function tradingApiHeaders(initial: Record<string, string> = {}): Record<string, string> {
  return {
    ...initial,
    ...(TRADING_API_TOKEN ? { Authorization: `Bearer ${TRADING_API_TOKEN}` } : {}),
  };
}
