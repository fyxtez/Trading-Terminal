import { spawnSync } from "node:child_process";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const projectRoot = new URL("../../", import.meta.url);
const projectRootPath = fileURLToPath(projectRoot);
const releasePolicyPath = ".release-version.json";

const files = {
  releasePolicy: new URL(releasePolicyPath, projectRoot),
  tauriConfig: new URL("frontend/src-tauri/tauri.conf.json", projectRoot),
  frontendPackage: new URL("frontend/package.json", projectRoot),
  frontendLock: new URL("frontend/package-lock.json", projectRoot),
  tauriManifest: new URL("frontend/src-tauri/Cargo.toml", projectRoot),
  tauriLock: new URL("frontend/src-tauri/Cargo.lock", projectRoot),
  backendManifest: new URL("backend/Cargo.toml", projectRoot),
  backendLock: new URL("backend/Cargo.lock", projectRoot),
};

const command = process.argv[2];
const argument = process.argv[3];

try {
  if (command === "check" && process.argv.length === 3) {
    await checkSourceVersions();
  } else if (command === "derive" && process.argv.length === 3) {
    console.log(await deriveVersion());
  } else if (command === "prepare") {
    const hasTag = argument === "--tag" && process.argv.length === 5;
    if (process.argv.length !== 3 && !hasTag) usage();
    await prepareVersion(hasTag ? process.argv[4] : undefined);
  } else {
    usage();
  }
} catch (error) {
  console.error(`Version error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function checkSourceVersions() {
  const policy = await loadReleasePolicy();
  verifyVersions(await loadState(), policy.baseVersion);
  console.log(`Source version metadata is consistent at ${policy.baseVersion}`);
}

async function prepareVersion(tag) {
  const policy = await loadReleasePolicy();
  const sourceState = await loadState();
  verifyVersions(sourceState, policy.baseVersion);

  const version = await deriveVersion(policy);
  await setVersion(version, sourceState);
  verifyVersions(await loadState(), version, tag);
  console.log(tag === undefined ? `Prepared build version ${version}` : `Prepared ${tag}`);
}

async function deriveVersion(policy) {
  policy ??= await loadReleasePolicy();
  const [, major, minor, basePatch] = parseVersion(policy.baseVersion);
  const baselineCommit = git(["log", "--diff-filter=A", "--format=%H", "--", releasePolicyPath])
    .split("\n")
    .filter(Boolean)
    .at(-1);
  if (!baselineCommit) return policy.baseVersion;

  git(["merge-base", "--is-ancestor", baselineCommit, "HEAD"]);
  const commitsSinceBaseline = Number(
    git(["rev-list", "--first-parent", "--count", `${baselineCommit}..HEAD`]),
  );
  if (!Number.isSafeInteger(commitsSinceBaseline) || commitsSinceBaseline < 0) {
    throw new Error("Could not derive a safe patch number from Git history");
  }

  const derived = `${major}.${minor}.${basePatch + commitsSinceBaseline}`;
  parseVersion(derived);
  return derived;
}

function verifyVersions(state, expected, tag) {
  parseVersion(expected);
  const observed = [
    ["frontend/src-tauri/tauri.conf.json", state.tauriConfig.version],
    ["frontend/package.json", state.frontendPackage.version],
    ["frontend/package-lock.json", state.frontendLock.version],
    ["frontend/package-lock.json root package", state.frontendLock.packages?.[""]?.version],
    ["frontend/src-tauri/Cargo.toml", packageVersion(state.tauriManifest)],
    [
      "frontend/src-tauri/Cargo.lock (fyxtez-terminal-desktop)",
      lockPackageVersion(state.tauriLock, "fyxtez-terminal-desktop"),
    ],
    [
      "frontend/src-tauri/Cargo.lock (fyxtez-backend)",
      lockPackageVersion(state.tauriLock, "fyxtez-backend"),
    ],
    ["backend/Cargo.toml", packageVersion(state.backendManifest)],
    ["backend/Cargo.lock", lockPackageVersion(state.backendLock, "fyxtez-backend")],
  ];
  const mismatches = observed.filter(([, version]) => version !== expected);
  if (mismatches.length > 0) {
    const details = mismatches
      .map(([label, version]) => `  ${label}: ${version ?? "missing"}`)
      .join("\n");
    throw new Error(`Version metadata must equal ${expected}:\n${details}`);
  }

  if (tag !== undefined && tag !== `v${expected}`) {
    throw new Error(`Release tag ${tag} does not match build version v${expected}`);
  }
}

async function setVersion(version, state) {
  parseVersion(version);
  state.tauriConfigSource = replaceJsonVersion(state.tauriConfigSource, version);
  state.frontendPackage.version = version;
  state.frontendLock.version = version;
  if (!state.frontendLock.packages?.[""]) {
    throw new Error("frontend/package-lock.json has no root package metadata");
  }
  state.frontendLock.packages[""].version = version;
  state.tauriManifest = replacePackageVersion(state.tauriManifest, version);
  state.tauriLock = replaceLockPackageVersion(
    replaceLockPackageVersion(state.tauriLock, "fyxtez-terminal-desktop", version),
    "fyxtez-backend",
    version,
  );
  state.backendManifest = replacePackageVersion(state.backendManifest, version);
  state.backendLock = replaceLockPackageVersion(state.backendLock, "fyxtez-backend", version);

  const rendered = new Map([
    [files.tauriConfig, state.tauriConfigSource],
    [files.frontendPackage, json(state.frontendPackage)],
    [files.frontendLock, json(state.frontendLock)],
    [files.tauriManifest, state.tauriManifest],
    [files.tauriLock, state.tauriLock],
    [files.backendManifest, state.backendManifest],
    [files.backendLock, state.backendLock],
  ]);
  await replaceFiles(rendered, state.originals);
}

async function loadReleasePolicy() {
  const policy = JSON.parse(await readFile(files.releasePolicy, "utf8"));
  parseVersion(policy.baseVersion);
  return policy;
}

async function loadState() {
  const versionFiles = Object.values(files).filter((file) => file !== files.releasePolicy);
  const originals = new Map(
    await Promise.all(versionFiles.map(async (file) => [file, await readFile(file, "utf8")])),
  );
  return {
    originals,
    tauriConfig: JSON.parse(originals.get(files.tauriConfig)),
    tauriConfigSource: originals.get(files.tauriConfig),
    frontendPackage: JSON.parse(originals.get(files.frontendPackage)),
    frontendLock: JSON.parse(originals.get(files.frontendLock)),
    tauriManifest: originals.get(files.tauriManifest),
    tauriLock: originals.get(files.tauriLock),
    backendManifest: originals.get(files.backendManifest),
    backendLock: originals.get(files.backendLock),
  };
}

async function replaceFiles(rendered, originals) {
  const staged = [];
  try {
    for (const [file, contents] of rendered) {
      const path = fileURLToPath(file);
      const temporary = `${path}.version-${process.pid}.tmp`;
      await writeFile(temporary, contents, { flag: "wx" });
      staged.push([file, temporary]);
    }
    for (const [file, temporary] of staged) await rename(temporary, file);
  } catch (error) {
    await Promise.allSettled(staged.map(([, temporary]) => unlink(temporary)));
    await Promise.allSettled(
      [...originals].map(([file, contents]) => writeFile(file, contents, "utf8")),
    );
    throw error;
  }
}

function replaceJsonVersion(source, version) {
  const pattern = /^(\s*"version"\s*:\s*")[^"]+("\s*,?\s*)$/gm;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error("Tauri configuration must contain exactly one version field");
  }
  const updated = source.replace(pattern, `$1${version}$2`);
  const parsed = JSON.parse(updated);
  if (parsed.version !== version) throw new Error("Failed to update Tauri app version");
  return updated;
}

function packageVersion(source) {
  const { start, end } = packageBounds(source);
  return source.slice(start, end).match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
}

function replacePackageVersion(source, version) {
  const { start, end } = packageBounds(source);
  const section = source.slice(start, end);
  const matches = [...section.matchAll(/^version\s*=\s*"[^"]+"\s*$/gm)];
  if (matches.length !== 1) throw new Error("Cargo [package] must contain exactly one version");
  const updated = section.replace(/^version\s*=\s*"[^"]+"\s*$/m, `version = "${version}"`);
  return source.slice(0, start) + updated + source.slice(end);
}

function packageBounds(source) {
  const header = /^\[package\]\s*$/m.exec(source);
  if (!header || header.index === undefined) {
    throw new Error("Cargo manifest has no [package] section");
  }
  const start = header.index + header[0].length;
  const nextSection = source.slice(start).search(/^\[/m);
  return { start, end: nextSection < 0 ? source.length : start + nextSection };
}

function lockPackageVersion(source, packageName) {
  const pattern = new RegExp(
    `^\\[\\[package\\]\\]\\nname = "${escapeRegExp(packageName)}"\\nversion = "([^"]+)"$`,
    "gm",
  );
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return undefined;
  return matches[0][1];
}

function replaceLockPackageVersion(source, packageName, version) {
  const pattern = new RegExp(
    `(^\\[\\[package\\]\\]\\nname = "${escapeRegExp(packageName)}"\\nversion = ")[^"]+("$)`,
    "gm",
  );
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Cargo.lock must contain exactly one ${packageName} package`);
  }
  return source.replace(pattern, `$1${version}$2`);
}

function parseVersion(version) {
  const match = typeof version === "string" ? RELEASE_VERSION.exec(version) : null;
  if (!match) {
    throw new Error(
      `Invalid release version: ${version ?? "missing"}. Use a stable SemVer such as 1.0.0.`,
    );
  }

  const parts = match.map(Number);
  const [, major, minor, patch] = parts;
  const androidVersionCode = major * 1_000_000 + minor * 1_000 + patch;
  if (!Number.isSafeInteger(androidVersionCode) || androidVersionCode < 1) {
    throw new Error(`Release version ${version} cannot be represented by Android versionCode.`);
  }
  if (androidVersionCode > 2_100_000_000) {
    throw new Error(`Release version ${version} exceeds Android's versionCode limit.`);
  }
  return parts;
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: projectRootPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function usage() {
  console.error("Usage: node scripts/version.mjs check | derive | prepare [--tag vX.Y.Z]");
  process.exit(2);
}
