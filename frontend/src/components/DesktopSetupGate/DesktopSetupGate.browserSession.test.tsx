import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  getLocalBrowserSession,
  initializeLocalBrowserRuntime,
  initializeRemoteBrowserRuntime,
  invalidateLocalBrowserSession,
  validateLocalBrowserSession,
} from "../../config/constants";
import { canUseTradingAccount } from "../../desktop/credentials";
import { SnapshotCache } from "../../trading/api/snapshotCache";
import DesktopSetupGate from "./DesktopSetupGate";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

async function openBrowser(mode: "local-browser" | "remote-browser") {
  const session = {
    mode,
    authenticated: true,
    binanceConfigured: true,
    binanceNetwork: "mainnet" as "mainnet" | "testnet",
    expiresInMs: 60_000,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/api/session")) {
        return Response.json({
          apiVersion: 1,
          mode: "remote",
          backendId: "server",
          accountScope: "account",
          binanceConfigured: true,
          binanceNetwork: session.binanceNetwork,
        });
      }
      return Response.json(
        url.endsWith("/redeem") ? { ...session, sessionProof: "a".repeat(64) } : session,
      );
    }),
  );
  if (mode === "remote-browser") {
    await initializeRemoteBrowserRuntime("https://terminal.fyxtez.com", "b".repeat(64));
  } else {
    await initializeLocalBrowserRuntime("http://127.0.0.1:8658", "b".repeat(64));
  }
  render(
    <DesktopSetupGate>
      <div>Workspace</div>
    </DesktopSetupGate>,
  );
  return session;
}

function pendingSnapshot() {
  const cache = new SnapshotCache<string[]>(3500);
  let resolve!: (value: string[]) => void;
  const pending = new Promise<string[]>((done) => {
    resolve = done;
  });
  const request = cache.get(() => pending);
  return { cache, request, resolve };
}

it.each(["local-browser", "remote-browser"] as const)(
  "keeps an in-flight account read valid across a routine %s session check",
  async (mode) => {
    const session = await openBrowser(mode);
    const { cache, request, resolve } = pendingSnapshot();
    const result = expect(request).resolves.toEqual(["current-position"]);
    session.expiresInMs -= 30_000;
    await act(async () => {
      await validateLocalBrowserSession();
    });
    resolve(["current-position"]);
    await result;
    expect(cache.peek()).toEqual(["current-position"]);
    expect(getLocalBrowserSession()?.expiresInMs).toBe(30_000);
  },
);

it("still rejects in-flight account data when browser access is revoked", async () => {
  await openBrowser("remote-browser");
  const { request, resolve } = pendingSnapshot();
  const result = expect(request).rejects.toThrow("connection changed");
  act(() => invalidateLocalBrowserSession());
  resolve(["revoked-account"]);
  await result;
  expect(canUseTradingAccount()).toBe(false);
});

it("still invalidates a local browser read when its Binance network changes", async () => {
  const session = await openBrowser("local-browser");
  const { request, resolve } = pendingSnapshot();
  const result = expect(request).rejects.toThrow("connection changed");
  session.binanceNetwork = "testnet";
  await act(async () => {
    await validateLocalBrowserSession();
  });
  resolve(["previous-network"]);
  await result;
});
