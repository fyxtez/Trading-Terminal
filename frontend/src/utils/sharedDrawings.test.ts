import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Drawing } from "../types/drawing";
const exchange = vi.hoisted(() => ({
  items: {} as Record<string, unknown>,
  revision: 0,
  fail: false,
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("../trading/api/http", () => ({
  tradingApiHeaders: () => ({}),
  tradingApiFetch: async (_url: string, options: RequestInit) => {
    if (exchange.fail) throw new Error("offline");
    if (options.method === "PUT") {
      const patch = JSON.parse(options.body as string);
      for (const d of patch.upserts)
        if (!patch.seed || !(d.id in exchange.items)) exchange.items[d.id] = d;
      for (const id of patch.deleted) exchange.items[id] = null;
      exchange.revision++;
    }
    return new Response(JSON.stringify({ items: exchange.items, revision: exchange.revision }), {
      headers: { "content-type": "application/json" },
    });
  },
}));
const line = (id: string, price = 100): Drawing => ({
  id,
  type: "horizontal",
  price,
  color: "white",
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  localStorage.clear();
  exchange.items = {};
  exchange.revision = 0;
  exchange.fail = false;
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
it("replicates edits and deletions between independent desktop and browser clients", async () => {
  const desktop = await import("./sharedDrawings");
  const seenDesktop = vi.fn();
  const stopDesktop = desktop.connectSharedDrawings("BTCUSDT", [line("a")], seenDesktop);
  await vi.advanceTimersByTimeAsync(0);
  vi.resetModules();
  const browser = await import("./sharedDrawings");
  const seenBrowser = vi.fn();
  const stopBrowser = browser.connectSharedDrawings("BTCUSDT", [line("b")], seenBrowser);
  await vi.advanceTimersByTimeAsync(2100);
  expect(seenDesktop.mock.lastCall?.[0].map((d: Drawing) => d.id).sort()).toEqual(["a", "b"]);
  browser.publishSharedDrawings("BTCUSDT", [line("a"), line("b")], [line("a", 120), line("b")]);
  await vi.advanceTimersByTimeAsync(2500);
  expect(seenDesktop.mock.lastCall?.[0].find((d: Drawing) => d.id === "a").price).toBe(120);
  desktop.publishSharedDrawings("BTCUSDT", [line("a", 120), line("b")], [line("b")]);
  await vi.advanceTimersByTimeAsync(2500);
  expect(seenBrowser.mock.lastCall?.[0].map((d: Drawing) => d.id)).toEqual(["b"]);
  stopBrowser();
  stopDesktop();
});
it("retains edits made while offline and excludes exchange order lines", async () => {
  const client = await import("./sharedDrawings");
  exchange.fail = true;
  const stop = client.connectSharedDrawings("BTCUSDT", [], vi.fn());
  client.publishSharedDrawings("BTCUSDT", [], [line("a")]);
  await vi.advanceTimersByTimeAsync(1200);
  expect(localStorage.getItem("fyxtez:drawing-sync-pending:BTCUSDT")).toContain('"a"');
  exchange.fail = false;
  await vi.advanceTimersByTimeAsync(1200);
  expect(exchange.items.a).toEqual(line("a"));
  expect(client.drawingPatch([], [{ ...line("order"), orderSide: "BUY" } as Drawing])).toEqual({
    upserts: [],
    deleted: [],
  });
  stop();
});
