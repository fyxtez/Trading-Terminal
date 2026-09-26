import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const origin = "https://terminal.fyxtez.com";
const proof = "a".repeat(64);
const ticket = "b".repeat(64);
const session = {
  mode: "remote-browser",
  authenticated: true,
  binanceConfigured: true,
  binanceNetwork: "mainnet",
  expiresInMs: null,
};
const metadata = {
  apiVersion: 1,
  mode: "remote",
  backendId: "server-id",
  accountScope: "account-id",
  binanceConfigured: true,
  binanceNetwork: "mainnet",
};

function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("private server browser", () => {
  it("redeems a one-use ticket, routes prices through the server and restores without a native token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ...session, sessionProof: proof }))
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response(metadata));
    vi.stubGlobal("fetch", fetchMock);
    const config = await import("./constants");
    await config.initializeRemoteBrowserRuntime(origin, ticket);
    expect(config.getTradingRuntimeMode()).toBe("remote-browser");
    expect(config.isRemoteBackend()).toBe(true);
    expect(config.getBackendScope()).toBe("remote:server-id:account-id:mainnet");
    expect(config.TRADING_API_TOKEN).toBe("");
    expect(config.getLocalBrowserSession()).toMatchObject(session);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      credentials: "include",
      redirect: "error",
      body: JSON.stringify({ ticket }),
    });

    fetchMock.mockResolvedValueOnce(response([[1, "123"]]));
    const { fetchBinanceKlineData } = await import("../trading/api/binanceMarketData");
    await fetchBinanceKlineData(
      new URLSearchParams({ symbol: "BTCUSDT", interval: "1m", limit: "1" }),
    );
    const [url, request] = fetchMock.mock.calls[3];
    expect(url).toBe(`${origin}/api/market-data/binance/klines?symbol=BTCUSDT&interval=1m&limit=1`);
    expect(request.credentials).toBe("include");
    expect(new Headers(request.headers).get("x-fyxtez-browser-proof")).toBe(proof);
    for (const [, request] of fetchMock.mock.calls) {
      expect(new Headers(request.headers).has("Authorization")).toBe(false);
    }

    vi.resetModules();
    fetchMock.mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response(metadata));
    const restarted = await import("./constants");
    await restarted.initializeRemoteBrowserRuntime(origin, null);
    expect(restarted.getLocalBrowserSession()).toMatchObject(session);
    expect(restarted.getBackendScope()).toBe("remote:server-id:account-id:mainnet");

    const { tradingApiFetch } = await import("../trading/api/http");
    const previousCalls = fetchMock.mock.calls.length;
    await expect(tradingApiFetch("https://example.com/api/account")).rejects.toThrow(
      "outside the selected connection",
    );
    expect(fetchMock).toHaveBeenCalledTimes(previousCalls);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await tradingApiFetch(`${origin}/api/account`);
    expect(restarted.getLocalBrowserSession()).toBeNull();
    expect(localStorage.getItem(restarted.LOCAL_BROWSER_SESSION_PROOF_KEY)).toBeNull();
  });

  it("rejects other browser origins and a missing launch proof before making requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const config = await import("./constants");
    for (const other of ["http://terminal.fyxtez.com", "https://example.com", `${origin}:8443`]) {
      await expect(config.initializeRemoteBrowserRuntime(other, ticket)).rejects.toThrow(
        "configured private server",
      );
    }
    await expect(config.initializeRemoteBrowserRuntime(origin, null)).rejects.toThrow(
      "expired or was turned off",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an incompatible account handshake and clears the saved proof", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response({ ...session, sessionProof: proof }))
        .mockResolvedValueOnce(response(session))
        .mockResolvedValueOnce(response({ ...metadata, binanceNetwork: "testnet" })),
    );
    const config = await import("./constants");
    await expect(config.initializeRemoteBrowserRuntime(origin, ticket)).rejects.toThrow(
      "incompatible session",
    );
    expect(config.getLocalBrowserSession()).toBeNull();
    expect(localStorage.getItem(config.LOCAL_BROWSER_SESSION_PROOF_KEY)).toBeNull();
  });
});

it.each(["session-502", "metadata-503", "metadata-network", "unreadable-session"])(
  "retains a valid login across %s and recovers without a launch ticket",
  async (failure) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ...session, sessionProof: proof }))
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response(metadata));
    vi.stubGlobal("fetch", fetchMock);
    const config = await import("./constants");
    await config.initializeRemoteBrowserRuntime(origin, ticket);
    if (failure === "session-502")
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 502 }));
    if (failure === "metadata-503")
      fetchMock
        .mockResolvedValueOnce(response(session))
        .mockResolvedValueOnce(new Response(null, { status: 503 }));
    if (failure === "metadata-network")
      fetchMock
        .mockResolvedValueOnce(response(session))
        .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    if (failure === "unreadable-session")
      fetchMock.mockResolvedValueOnce(new Response("truncated", { status: 200 }));
    await expect(config.validateLocalBrowserSession()).rejects.toThrow();
    expect(config.getLocalBrowserSessionProof()).toBe(proof);
    fetchMock.mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response(metadata));
    await config.initializeRemoteBrowserRuntime(origin, null);
    expect(config.getLocalBrowserSession()).toMatchObject(session);
  },
);

it.each([401, 403])("removes authorization when session validation returns %s", async (status) => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(response({ ...session, sessionProof: proof }))
    .mockResolvedValueOnce(response(session))
    .mockResolvedValueOnce(response(metadata));
  vi.stubGlobal("fetch", fetchMock);
  const config = await import("./constants");
  await config.initializeRemoteBrowserRuntime(origin, ticket);
  fetchMock.mockResolvedValueOnce(new Response(null, { status }));
  await expect(config.validateLocalBrowserSession()).rejects.toThrow("expired");
  expect(config.getLocalBrowserSessionProof()).toBeNull();
});

it("does not destroy an existing session when a replacement launch link fails", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(response({ ...session, sessionProof: proof }))
    .mockResolvedValueOnce(response(session))
    .mockResolvedValueOnce(response(metadata));
  vi.stubGlobal("fetch", fetchMock);
  const config = await import("./constants");
  await config.initializeRemoteBrowserRuntime(origin, ticket);
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(config.initializeRemoteBrowserRuntime(origin, ticket)).rejects.toThrow();
  expect(config.getLocalBrowserSessionProof()).toBe(proof);
});
