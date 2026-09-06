import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tradingApiFetch } from "./http";

const runtime = vi.hoisted(() => ({ mode: "local-browser" }));
const browserAuth = vi.hoisted(() => ({
  proof: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" as string | null,
  invalidate: vi.fn(),
}));

vi.mock("../../config/constants", () => ({
  TRADING_API_BASE_URL: "http://127.0.0.1:8658",
  TRADING_API_TOKEN: "",
  getTradingRuntimeMode: () => runtime.mode,
  getLocalBrowserSessionProof: () => browserAuth.proof,
  invalidateLocalBrowserSession: browserAuth.invalidate,
  isDedicatedBrowserOrigin: (origin: string) => origin === "http://127.0.0.1:8658",
}));

describe("tradingApiFetch", () => {
  beforeEach(() => {
    browserAuth.proof = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    browserAuth.invalidate.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the HttpOnly browser cookie without creating an empty bearer header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await tradingApiFetch("http://127.0.0.1:8658/api/account", { method: "GET" });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.credentials).toBe("include");
    expect(request.redirect).toBe("error");
    const headers = new Headers(request.headers);
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.get("x-fyxtez-browser-proof")).toBe(browserAuth.proof);
  });

  it("fails before fetch instead of sending the proof to an external origin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(tradingApiFetch("https://example.com/api/account")).rejects.toThrow(
      "outside this computer",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the page proof when the backend rejects the browser session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    await tradingApiFetch("http://127.0.0.1:8658/api/account");

    expect(browserAuth.invalidate).toHaveBeenCalledOnce();
  });
});
