# Secret and release-artifact audit — 2026-09-05

## Result

No Binance API credential, Android signing key, private key, or known local
application secret was found in the reachable Git history, retained project
archives, shell history, running-process arguments, or the signed draft-release
payload. The draft release is not ready to publish yet because its Linux
checksum manifest refers to pre-upload filenames that GitHub renamed.

Two local development values do require cleanup. The current loopback service
token and the retired ntfy URL exist in the installed desktop WebKit cache. The
retired ntfy URL also exists in one unreachable object in this local `.git`
database. Neither value is reachable from a branch, tag, reflog or GitHub
release, but both should be treated as disclosed to anyone who can read this
machine's local development data.

No secret value is copied into this report.

## Scope and method

The audit covered commit `5c7895188a74ffdc60352d1a86c48c8568e6bc00`
on 2026-09-05 and included:

- 382 currently tracked files;
- all 30 commits reachable from local refs and all 32 commits reachable when
  reflogs are included;
- 256 unreachable local Git blobs recovered for a separate content scan;
- ignored project `.env` files, generated frontend output, local Linux and
  Android build artifacts, and the project ZIP archive;
- the retained `fyxtez-terminal-OLD/fyxtez-terminal.zip` archive (179 entries);
- the private GitHub `v0.1.0` draft release: two Linux binaries, APK, AAB and two
  checksum manifests; 2,095 extracted files (approximately 377 MB) were scanned;
- the separately downloaded `.deb` package;
- installed Linux application data under
  `$HOME/.local/share/com.fyxtez.terminal` (1,265 files, approximately 50 MB);
- 774 running-process command lines, the user's shell history, and a bounded
  scan of relevant user-journal entries since 2026-09-01.

The generic scan used Gitleaks 8.30.0 from the project's official release, with
its published SHA-256 checksum verified before execution. Version 8.30.1 was
deliberately not used because its upstream issue tracker records a regression
in the bundled default rules. Exact fingerprints of the configured local
service token, matching frontend token and retired ntfy URL were also searched
without printing their values.

The OS credential manager, GitHub Actions environment-secret values and the
Android platform keystore were intentionally not extracted. Those stores are
the security boundary for Binance and signing credentials; the audit instead
checked application code, logs, caches and artifacts for accidental copies.

## Findings

### A1 — Local WebKit cache retains development values (medium)

The installed desktop WebKit cache contains 47 duplicate/cache representations
of the loopback development service token and 47 representations of the retired
ntfy URL. The matching cache files are mode `0600`, and neither value appears in
the signed release artifacts, reachable Git history, project archives, process
arguments, shell history or sampled journal output.

The same service token is compiled into the current local `frontend/dist`
development output. This is expected for browser development, where the
frontend must present the local token, but that output and the cache are not a
suitable place for a long-lived credential.

Required before closing the audit item:

1. stop the development backend and desktop application;
2. replace the shared values in `backend/.env` and `frontend/.env` with a newly
   generated development-only token;
3. remove the retired ntfy URL from local configuration and never reuse that
   topic;
4. clear the generated frontend output and Fyxtez WebKit cache, then rebuild;
5. repeat the exact-fingerprint scan and record zero matches outside the two
   active local `.env` files.

### A2 — Retired ntfy URL in an unreachable local Git blob (medium)

One of the 256 unreachable blobs contains the retired ntfy URL. It could not be
mapped to either of the two unreachable commits and is absent from all refs and
reflogs, so it is not part of the current repository history sent to GitHub.
Anyone who receives this local `.git` object database could nevertheless
recover it. The topic must remain retired. Local object pruning is optional
after the value has been retired; rotation, not history rewriting, is the
security boundary.

### A3 — Linux checksum manifest cannot be checked after download (medium,
release blocker)

The Linux SHA-256 values in the draft are correct, but the manifest names are:

```text
Fyxtez Terminal_0.1.0_amd64.AppImage
Fyxtez Terminal_0.1.0_amd64.deb
```

GitHub exposes the assets with dots instead of the space:

```text
Fyxtez.Terminal_0.1.0_amd64.AppImage
Fyxtez.Terminal_0.1.0_amd64.deb
```

Consequently, a normal `sha256sum --check SHA256SUMS-linux-x86_64.txt` fails
with missing-file errors after download. The Android manifest verifies
successfully. Stage Linux assets under their final GitHub-safe names before
generating and verifying the manifest, rebuild the draft, and check both
manifests from a fresh download before publishing.

The separately downloaded Linux package has a different SHA-256 hash from the
current private draft asset. It scanned clean, but it must not be presented as
the current release candidate.

### A4 — Local sensitive files have broad permissions (low)

The ignored `backend/.env` and `frontend/.env` files are mode `0644`, while
`backend/.env.deploy` and the retained project ZIP are mode `0664`. On a
multi-user system these modes unnecessarily expose local configuration to
other accounts. Set secret-bearing local files and private archives to `0600`.
The WebKit cache files that contain the exact development values are already
`0600`.

### A5 — Android build relies on a clean environment (low, hardening)

The desktop release command explicitly empties all `VITE_*` service values
before building. Android currently calls `npm run build` directly and therefore
relies on GitHub Actions not having developer `.env` values. The audited signed
APK and AAB are clean, as is the locally inspected Android package, so this is
not a confirmed release leak. Add an Android-safe build command that explicitly
empties the same variables to make local and CI release behavior deterministic.

### A6 — Generic cache heuristics (informational)

Gitleaks reported nine repeated instances of one eight-character value in
generated WebKit cache JavaScript, under `password` and `wsToken` labels. The
value does not match any configured project credential and does not exist in
the repository source or installed npm dependency tree. This appears to be
short-lived generated/runtime data, but the whole cache should still be
discarded as part of A1 rather than allowlisted.

## Clean checks

- Gitleaks: no finding in current/reachable Git history, refs plus reflogs,
  unreachable Git blobs, either project archive, or extracted draft-release
  assets.
- Exact configured-value scan: zero matches in reachable history, retained
  project archives, draft-release APK/AAB/AppImage/`.deb`, downloaded `.deb`,
  running process arguments, shell history and sampled journal output.
- Draft artifacts: no `.env`, keystore, private-key, client-secret, SQLite or
  log filename was packaged.
- Android checksum verification succeeded; the Linux hashes match the assets
  when compared by value, with only the filename mismatch described in A3.
- The two local SQLite databases inspected during the audit contained zero
  application rows.

## Remediation result — 2026-09-05

- A new 64-character development-only service token was generated and written
  consistently to the two ignored local `.env` files without exposing it in
  command output. The retired ntfy setting was removed.
- The generated frontend output and only the Fyxtez `WebKitCache` directory
  were removed while application settings, drawings, databases and the OS
  credential manager were preserved.
- The affected local `.env` files, deployment configuration and private project
  ZIP were restricted to mode `0600`.
- Desktop and Android now use one native frontend build command that explicitly
  empties development `VITE_*` values. All 56 frontend tests passed, the native
  frontend build passed, and a complete arm64 debug APK build passed.
- The rebuilt native `dist`, extracted debug APK and remaining application-data
  directory contain zero copies of the new token. Gitleaks also reports zero
  findings in those outputs and the changed tracked files.
- Linux staging now renames the `.deb` and AppImage to their final GitHub-safe
  names before computing checksums. A local staging simulation verified both
  files successfully with `sha256sum --check`.
- The old ntfy topic is permanently retired. Its unreachable local Git blob is
  retained as non-reachable recovery data; it is not a usable credential and
  does not require rewriting remote history.

## Closure criteria

The repository-history and local-remediation audit item is closed. The current
GitHub draft still has the old Linux manifest and must not be published. Run the
updated signed-release workflow, freshly download all six replacement assets,
and verify both manifests before closing the separate release-blocker item.

## Tool provenance

- [Gitleaks v8.30.0 release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.0)
- [Upstream v8.30.1 default-rules regression report](https://github.com/gitleaks/gitleaks/issues/2170)
