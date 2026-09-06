import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeBrowserLaunchTicket,
  getLocalBrowserSession,
  getTradingRuntimeMode,
  initializeLocalBrowserRuntime,
  isDedicatedBrowserOrigin,
  LOCAL_BROWSER_SESSION_PROOF_KEY,
  TRADING_API_TOKEN,
} from "./constants";
import { tradingApiFetch } from "../trading/api/http";

const session = {
  mode: "local-browser",
  authenticated: true,
  binanceConfigured: true,
  binanceNetwork: "testnet",
  expiresInMs: 3_600_000,
};
const sessionProof = "a".repeat(64);

describe("local browser runtime", () => {
  afterEach(() => {
    window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}`);
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("accepts only the exact native browser origin", () => {
    expect(isDedicatedBrowserOrigin("http://127.0.0.1:8658")).toBe(true);
    expect(isDedicatedBrowserOrigin("http://localhost:8658")).toBe(false);
    expect(isDedicatedBrowserOrigin("http://127.0.0.1:5173")).toBe(false);
    expect(isDedicatedBrowserOrigin("https://127.0.0.1:8658")).toBe(false);
  });

  it("removes the one-use launch ticket from browser history before it is redeemed", () => {
    const ticket = "b".repeat(64);
    window.history.replaceState({}, "", `/#browser-ticket=${ticket}`);
    const replaceState = vi.spyOn(window.history, "replaceState");

    expect(consumeBrowserLaunchTicket()).toBe(ticket);
    expect(replaceState).toHaveBeenCalledWith(expect.anything(), "", "/");
    expect(window.location.hash).toBe("");
  });

  it("keeps the dual-auth proof only in sessionStorage and sends it after redeem", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...session, sessionProof }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(session), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const ticket = "b".repeat(64);
    await initializeLocalBrowserRuntime("http://127.0.0.1:8658", ticket);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8658/api/browser-session/redeem",
      expect.objectContaining({
        credentials: "include",
        redirect: "error",
        body: JSON.stringify({ ticket }),
      }),
    );
    const redeemRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(redeemRequest.headers).has("x-fyxtez-browser-proof")).toBe(false);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8658/api/browser-session",
      expect.objectContaining({
        credentials: "include",
        redirect: "error",
        headers: { "x-fyxtez-browser-proof": sessionProof },
      }),
    );
    expect(getTradingRuntimeMode()).toBe("local-browser");
    expect(getLocalBrowserSession()).toMatchObject({
      binanceConfigured: true,
      binanceNetwork: "testnet",
    });
    expect(TRADING_API_TOKEN).toBe("");
    expect(window.sessionStorage.getItem(LOCAL_BROWSER_SESSION_PROOF_KEY)).toBe(sessionProof);
    expect(window.localStorage.getItem(LOCAL_BROWSER_SESSION_PROOF_KEY)).toBeNull();

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await tradingApiFetch("http://127.0.0.1:8658/api/account");
    expect(window.sessionStorage.getItem(LOCAL_BROWSER_SESSION_PROOF_KEY)).toBeNull();
    expect(window.localStorage.getItem(LOCAL_BROWSER_SESSION_PROOF_KEY)).toBeNull();
    expect(getLocalBrowserSession()).toBeNull();
  });

  it("fails closed without a new ticket when the tab proof is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(initializeLocalBrowserRuntime("http://127.0.0.1:8658", null)).rejects.toThrow(
      "expired or was turned off",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
