import { afterEach, beforeEach, expect, it, vi } from "vitest";

const storageKey = "fyxtez:opcore-embedded-session";
const secrets = { sessionSecret: "a".repeat(64), sessionProof: "b".repeat(64) };
const postMessage = vi.fn();

function frame(parentOrigin = "http://127.0.0.1:37373", topLevel = false) {
  const parent = {};
  vi.stubGlobal("window", {
    self: topLevel ? parent : {},
    top: parent,
    location: {
      origin: "https://terminal.fyxtez.com",
      search: `?embed=opcore&instance=fixture&parentOrigin=${encodeURIComponent(parentOrigin)}`,
    },
    parent: { postMessage },
  });
}
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  postMessage.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("restores only the embedded session and revokes it without clearing normal browser authorization", async () => {
  frame();
  const normalKey = "fyxtez:local-browser-session-proof";
  localStorage.setItem(normalKey, "c".repeat(64));
  const module = await import("./embeddedTerminal");
  expect(module.getEmbeddedCredentials()).toBeNull();
  module.storeEmbeddedCredentials(secrets);
  vi.resetModules();
  const restored = await import("./embeddedTerminal");
  expect(restored.getEmbeddedCredentials()).toEqual(secrets);
  expect(restored.embeddedSessionHeaders()).toEqual({
    "x-fyxtez-embedded-session": secrets.sessionSecret,
  });
  restored.clearEmbeddedCredentials();
  expect(localStorage.getItem(storageKey)).toBeNull();
  expect(localStorage.getItem(normalKey)).toBe("c".repeat(64));
});

it("works in memory when third-party storage is blocked and sends no credentials to the parent", async () => {
  frame("tauri://localhost");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const module = await import("./embeddedTerminal");
  module.storeEmbeddedCredentials(secrets);
  expect(module.getEmbeddedCredentials()).toEqual(secrets);
  module.notifyEmbeddedParent("connect", "d".repeat(64));
  module.notifyEmbeddedParent("ready");
  expect(postMessage.mock.calls).toEqual([
    [
      { type: "fyxtez:embed", instance: "fixture", status: "connect", requestId: "d".repeat(64) },
      "*",
    ],
    [{ type: "fyxtez:embed", instance: "fixture", status: "ready" }, "*"],
  ]);
  module.clearEmbeddedCredentials();
  expect(module.getEmbeddedCredentials()).toBeNull();
});

it.each(["https://evil.example", "http://127.0.0.1:37373.evil.example", "http://127.0.0.1:37374"])(
  "refuses an untrusted frame parent %s",
  async (origin) => {
    frame(origin);
    localStorage.setItem(storageKey, JSON.stringify(secrets));
    const module = await import("./embeddedTerminal");
    expect(module.isEmbeddedTerminal()).toBe(false);
    expect(module.getEmbeddedCredentials()).toBeNull();
    expect(() => module.storeEmbeddedCredentials(secrets)).toThrow();
  },
);

it("never activates embedded credentials for a top-level Terminal tab", async () => {
  frame("http://127.0.0.1:37373", true);
  localStorage.setItem(storageKey, JSON.stringify(secrets));
  const module = await import("./embeddedTerminal");
  expect(module.isEmbeddedTerminal()).toBe(false);
  expect(module.getEmbeddedCredentials()).toBeNull();
});
