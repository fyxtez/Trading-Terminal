import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(`${process.env.RUNNER_TEMP}/fyxtez-smoke/package.json`);
const { chromium } = require("playwright-core");
const out = `${process.env.RUNNER_TEMP}/fyxtez-smoke-results`;
await mkdir(out, { recursive: true });
const child = spawn(process.argv[2], [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" },
  stdio: "ignore",
});
let browser;
const checks = [];
async function until(fn, timeout = 90000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out: ${last?.message || "condition not met"}`);
}
try {
  browser = await until(async () =>
    chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 2000 }),
  );
  const page = await until(() =>
    browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => !p.url().startsWith("devtools:")),
  );
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const invoke = (command) =>
    page.evaluate((command) => window.__TAURI_INTERNALS__.invoke(command), command);
  const runtime = await until(() => invoke("desktop_runtime"));
  assert(runtime.apiBaseUrl.startsWith("http://127.0.0.1:"));
  assert(runtime.apiToken.length >= 32);
  checks.push(
    "Installed shell and real packaged sidecar started; native IPC returned loopback runtime",
  );
  const api = async (path, options = {}) =>
    fetch(runtime.apiBaseUrl + path, {
      ...options,
      headers: {
        Authorization: `Bearer ${runtime.apiToken}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  assert.equal((await fetch(runtime.apiBaseUrl + "/health")).status, 200);
  assert.equal((await fetch(runtime.apiBaseUrl + "/api/chart-drawings/BTCUSDT")).status, 401);
  const patch = {
    upserts: [{ id: "windows-smoke-line", type: "horizontal", price: 100, color: "#ffffff" }],
    deleted: [],
  };
  assert.equal(
    (await api("/api/chart-drawings/BTCUSDT", { method: "PUT", body: JSON.stringify(patch) }))
      .status,
    200,
  );
  const before = await (await api("/api/chart-drawings/BTCUSDT")).json();
  assert.equal(before.items["windows-smoke-line"].price, 100);
  patch.upserts[0].price = 101;
  assert.equal(
    (await api("/api/chart-drawings/BTCUSDT", { method: "PUT", body: JSON.stringify(patch) }))
      .status,
    200,
  );
  checks.push(
    "Protected API rejects missing capability; Windows storage supports repeated atomic updates",
  );
  const status = await invoke("enable_browser_access");
  assert(status.supported && status.available && status.enabled);
  assert.equal((await fetch("http://127.0.0.1:8658/")).status, 200);
  assert.equal((await fetch("http://127.0.0.1:8658/api/account")).status, 401);
  await invoke("disable_browser_access");
  checks.push("Packaged browser UI served; browser account API remains protected");
  // Public market data can be blocked by the runner's region. A real WebView
  // render, IPC and local API are tested; no Binance credentials or orders.
  await until(async () => (await page.locator("body").innerText()).trim().length > 30);
  await page.screenshot({ path: `${out}/window.png` });
  assert(!(await page.getByText("Something went wrong on this screen", { exact: false }).count()));
  assert.deepEqual(pageErrors, []);
  checks.push("WebView2 rendered frontend without an error boundary or uncaught page error");
  await invoke("restart_backend");
  const restarted = await until(async () => {
    const next = await invoke("desktop_runtime");
    return next.generation > runtime.generation ? next : null;
  });
  assert.equal(restarted.apiBaseUrl, runtime.apiBaseUrl);
  const persisted = await (
    await fetch(restarted.apiBaseUrl + "/api/chart-drawings/BTCUSDT", {
      headers: { Authorization: `Bearer ${restarted.apiToken}` },
    })
  ).json();
  assert.equal(persisted.items["windows-smoke-line"].price, 101);
  checks.push("Managed backend restart succeeds and retains chart documents");
  await invoke("exit_app").catch(() => {});
  await until(() => child.exitCode !== null, 20000);
  await until(async () => {
    try {
      await fetch(runtime.apiBaseUrl + "/health");
      return false;
    } catch {
      return true;
    }
  }, 20000);
  checks.push("Explicit Quit stops shell and sidecar (no orphan listener)");
  await writeFile(`${out}/checks.json`, JSON.stringify({ checks }, null, 2));
  console.log(checks.join("\n"));
} catch (e) {
  await writeFile(`${out}/checks.json`, JSON.stringify({ checks, error: e.message }, null, 2));
  throw e;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child.exitCode === null) child.kill();
}
