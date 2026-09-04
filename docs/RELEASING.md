# Linux desktop releases

The first supported release target is Linux x86_64. Ubuntu/Debian users should
install the `.deb`; AppImage is a portable fallback. GitHub releases are created
as drafts so no artifact is published before the clean-machine check.

The first release intentionally has no automatic updater. Installing is still a
single user action: open the downloaded `.deb` in the system software installer
and choose Install. AppImage users make the file executable and open it.

## Build locally

Install the Linux prerequisites listed in the official Tauri documentation,
then run:

```bash
cd frontend
npm ci
npm run test:run
npm run desktop:build
```

The Tauri pre-build command compiles the Axum backend in release mode and places
the target-suffixed binary in the ignored `src-tauri/binaries/` directory. Tauri
then embeds it as an external binary and creates `.deb` and AppImage bundles.

The build inputs are the exact Git commit, both Cargo lockfiles, the npm
lockfile, Rust 1.96.0 from `rust-toolchain.toml`, Node 22.12.0 in CI, and the
Ubuntu 22.04 runner. Keep generated sidecars and bundles out of Git. Builds are
not claimed to be bit-for-bit reproducible across runner-image updates, so every
release must record artifact SHA-256 hashes.

## Create a draft GitHub release

1. Make the version in `frontend/src-tauri/tauri.conf.json` match the intended
   tag.
2. Push a tag such as `v0.1.0`, or manually run **Linux desktop release** from
   GitHub Actions.
3. Download the draft assets and perform the clean-machine test below.
4. Verify the attached SHA-256 manifests and GitHub build attestations.
5. Publish the draft only after all acceptance checks pass.

No automatic updater is included in the first release.

## Ownership, signing, and rollback

The repository owner is the release owner. Only that account, or a separately
approved GitHub Environment with required review, may publish the draft created
by CI. Tag and package versions must match and release tags are immutable after
publication; corrections use a new patch version.

Linux uses GitHub's keyless Sigstore-backed build attestation as its signing
identity. The release workflow attests the `.deb`, AppImage and their SHA-256
manifest using the workflow's short-lived OIDC identity; there is no Linux
private key to store or leak. Verify a freshly downloaded asset with:

```bash
gh attestation verify ./Fyxtez.Terminal_0.1.0_amd64.deb \
  --repo fyxtez/Trading-Terminal
sha256sum --check SHA256SUMS-linux-x86_64.txt
```

Attestation proves the artifact came from this repository's release workflow;
it does not prove that the source is defect-free. Drafts remain gated on the
clean-machine acceptance test.

Android uses a long-lived upload keystore because Android requires every APK and
AAB to carry an application signature. The keystore is generated and backed up
outside this repository, while CI receives it only through protected `releases`
environment secrets. See [ANDROID-RELEASING.md](ANDROID-RELEASING.md) for the
one-time setup, fingerprint verification and recovery rules.

CI stages and verifies every Linux and Android artifact before creating or
updating a draft. The final publish job runs only after both platform jobs
succeed. Failed protected-environment jobs remain visible in GitHub's deployment
audit history, but they do not create or modify a GitHub Release. After a
successful publish, CI retains the newest `releases` deployment record and
removes superseded records; Actions run history and release assets are not
affected.

Rollback is manual in v1: withdraw the affected GitHub release, leave the tag
for auditability, publish the last known-good signed artifact and checksums, and
issue a higher patch version with the fix. Application data and OS credential
entries must not be deleted during an upgrade or rollback. Revoke Binance keys
immediately if an incident could have exposed credentials.

## Clean-machine acceptance

Use a supported Ubuntu/Debian machine or VM that does not have Cargo, Node.js or
the repository installed.

- Install the `.deb` by double-clicking it in the system software installer.
- Confirm the application menu and taskbar use the Fyxtez icon.
- Confirm first launch starts without `.env` files or developer tools.
- Skip every connection and verify chart-only mode works.
- Add testnet credentials and verify balance, positions and stream connectivity.
- Restart the app and verify credentials remain available without being shown.
- Edit the connection, select Mainnet, and verify explicit real-funds
  confirmation is required. Do not submit a real order during installation
  acceptance.
- Confirm Settings and onboarding do not expose price alerts, ntfy, or Telegram.
- Launch the app a second time and verify the existing window receives focus.
- Terminate the sidecar during a session and verify bounded recovery/degraded
  behavior plus the explicit **Retry backend** action after retries are
  exhausted.
- Upgrade over the installed version and verify application data remains.
- Uninstall and document whether local application data is retained by the OS.

The Debian remove/reinstall portion was exercised on the development machine on
2026-09-04: package 0.1.0 was removed and reinstalled, and all 1,213 files in the
application-data directory retained identical SHA-256 hashes. A different
version and clean machine are still required for full upgrade acceptance.

Every release build also runs a package-level smoke test in a clean Ubuntu
22.04 Docker container before attestation. To repeat it locally against a
downloaded or locally built package:

```bash
frontend/scripts/smoke-test-deb-docker.sh ./Fyxtez.Terminal_0.1.0_amd64.deb
```

The container begins without Node.js, npm, Cargo, Rust or the repository. It
installs package dependencies through APT, verifies both executables and their
dynamic libraries, checks the desktop entry and icons, then exercises reinstall,
purge and installation while confirming that a user-data marker survives. This
is deliberately narrower than the clean-machine acceptance above: a headless
container cannot validate WebKit rendering, the desktop keyring, taskbar/menu
integration, single-instance focus or a real graphical first launch.

Keep screenshots/logs of the test with secrets redacted. A CI build alone does
not satisfy this acceptance gate because hosted runners do not reproduce a real
desktop keyring and taskbar session.
