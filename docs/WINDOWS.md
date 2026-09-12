# Windows desktop preview

Windows uses the same frontend, Rust trading engine, native credential store,
local data, and optional browser companion as Linux. Binance credentials stay
on the user's machine. Windows does not change Binance IP restrictions.

## Build

Use Windows x64 with Visual Studio C++ Build Tools (Desktop development with
C++ and Windows SDK), Node.js 22.12 or newer, and the Rust MSVC toolchain pinned
by `rust-toolchain.toml`.

```powershell
npm ci --prefix frontend
node frontend/scripts/version.mjs prepare
npm --prefix frontend run desktop:build
```

The NSIS installer is written to
`frontend/src-tauri/target/release/bundle/nsis/`. It installs for the current
user and installs WebView2 if needed. Preview installers are not code-signed.
For development use `npm --prefix frontend run desktop:dev`; `run.sh` remains
the Linux launcher.

## Automated validation

The **Windows build and smoke** GitHub Actions workflow runs on Windows Server
2022. It runs frontend, backend, and shell tests, including an actual Windows
credential-store round trip using synthetic values. It builds and silently
installs the NSIS package, then launches the installed executable and checks:

- WebView2 rendering and native IPC;
- the packaged backend and capability-protected local API;
- repeated chart-document writes and persistence across backend restart;
- bundled browser UI and protected browser account API;
- explicit Quit terminating the shell and backend.

The workflow uploads the installer, SHA256 hashes, a screenshot, and smoke-test
results. No Binance keys or real orders are used. Runner checks do not replace
manual testing of chart gestures, tray interaction, Windows 10/11 machines, or
live exchange execution. Public market data may be unavailable in the runner's
region, so the smoke test does not depend on Binance connectivity.
