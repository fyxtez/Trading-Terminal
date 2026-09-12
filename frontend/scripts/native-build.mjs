import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontend = fileURLToPath(new URL("../", import.meta.url));
const project = dirname(frontend.replace(/[\\/]$/, ""));
const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { cwd: frontend, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
};
function buildFrontend() {
  const env = { ...process.env };
  for (const name of [
    "VITE_TRADING_API_TOKEN",
    "VITE_TRADING_API_URL",
    "VITE_TRADING_LOCAL_API_URL",
    "VITE_PUBLIC_TERMINAL_URL",
    "VITE_NTFY_URL",
  ])
    env[name] = "";
  // Invoke Node tools directly: npm.cmd needs a shell on Windows. No shell
  // interpolation is needed for paths, arguments, or development capabilities.
  run(process.execPath, ["scripts/check-css-balance.mjs"], env);
  run(process.execPath, ["node_modules/typescript/bin/tsc", "-b"], env);
  run(process.execPath, ["node_modules/vite/bin/vite.js", "build"], env);
  if (/(src|href)="\//.test(readFileSync(join(frontend, "dist/index.html"), "utf8")))
    throw new Error("Native index contains an absolute asset URL");
}
function sidecar(mode) {
  if (!["debug", "release"].includes(mode)) throw new Error("Expected debug or release");
  const hostResult = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (hostResult.status !== 0) throw new Error("Could not determine Rust host");
  const host = /^host: (.+)$/m.exec(hostResult.stdout)?.[1]?.trim();
  if (!host) throw new Error("Missing Rust host triple");
  const target = process.env.TAURI_ENV_TARGET_TRIPLE || host;
  const suffix = target.includes("windows") ? ".exe" : "";
  const backend = join(project, "backend");
  const args = ["build", "--locked", "--manifest-path", join(backend, "Cargo.toml")];
  if (mode === "release") args.push("--release");
  if (target !== host) args.push("--target", target);
  run("cargo", args);
  const cargoTarget = process.env.CARGO_TARGET_DIR
    ? resolve(frontend, process.env.CARGO_TARGET_DIR)
    : join(backend, "target");
  const binary = join(
    cargoTarget,
    ...(target !== host ? [target] : []),
    mode,
    `fyxtez-backend${suffix}`,
  );
  const binaries = join(frontend, "src-tauri/binaries");
  mkdirSync(binaries, { recursive: true });
  const destination = join(binaries, `fyxtez-backend-${target}${suffix}`);
  copyFileSync(binary, destination);
  if (process.platform !== "win32") chmodSync(destination, 0o755);
  for (const profile of [
    join(frontend, "src-tauri/target", mode),
    join(frontend, "src-tauri/target", target, mode),
  ]) {
    const legacy = join(profile, `binance-futures-axum${suffix}`);
    if (existsSync(legacy)) rmSync(legacy);
  }
  console.log(`[fyxtez] Sidecar ready: ${destination}`);
}
try {
  const [command = "desktop", mode = "debug"] = process.argv.slice(2);
  if (command === "frontend") buildFrontend();
  else if (command === "sidecar") sidecar(mode);
  else if (command === "desktop") {
    buildFrontend();
    sidecar("release");
  } else if (command === "dev") {
    buildFrontend();
    sidecar("debug");
    run(process.execPath, ["node_modules/vite/bin/vite.js"]);
  } else throw new Error(`Unknown native build command: ${command}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
