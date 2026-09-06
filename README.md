# Fyxtez Terminal

Fyxtez Terminal is a personal derivatives-trading terminal with a React charting
interface and a Rust execution service. It combines live market data, chart
tools, position management, and Binance USD-M Futures execution in
a self-hosted Tauri 2 native application. Linux desktop is the supported release
target and can optionally open the same local trading engine in a normal desktop
browser. An Android arm64 development build embeds the same Rust backend for
physical-device UI testing. Standalone browser development remains available
for chart/UI work and suppresses account requests and execution controls.

> **Safety notice:** this application can submit real orders. A new desktop
> installation has no Binance network or credentials selected and starts in
> chart-only mode. Connecting Mainnet requires an explicit real-funds
> confirmation. Testnet and Mainnet credentials are not interchangeable.

## Features

- Multi-symbol, multi-tab candlestick charts built with Lightweight Charts
- Binance and MEXC market-data sources
- Preseeded Binance Gold (`XAUUSDT`) and Silver (`XAGUSDT`) TradFi charts
- Market, limit, stop-market, take-profit, reduce, chase, and close-position flows
- Isolated-margin enforcement, leverage controls, and configurable sizing
- Live account, position, order, PNL, and trading-event updates
- Drawing tools, drawing sets, trade markers, sessions, and hotkeys
- Explicit market-data degradation/retry UI and redacted runtime diagnostics
- Opt-in Linux browser access with revocable local sessions and tray lifecycle
- Dynamic local symbol registry without an arbitrary account-wide limit, plus
  best-effort locally cached symbol icons

## Repository layout

```text
.
├── frontend/       React 18 + TypeScript + Vite browser application
│   └── src-tauri/  Tauri 2 desktop/mobile native shell
├── backend/        Shared Rust/Axum library plus the desktop sidecar binary
├── docs/adr/        Architecture decision records
├── ARCHITECTURE.md System design and data-flow documentation
└── README.md       Project setup and operating guide
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for component boundaries, request flows,
persistence, and security assumptions.

Operational references:

- [Local data and backup](docs/LOCAL-DATA-BACKUP.md)
- [Outbound connections](docs/OUTBOUND-CONNECTIONS.md)
- [Emergency procedure](docs/EMERGENCY-PROCEDURE.md)
- [Linux releases](docs/RELEASING.md)

### Desktop development

```bash
./run.sh
```

The launcher installs missing frontend dependencies automatically, using
`npm ci --include=dev` when a lockfile exists and `npm install --include=dev`
otherwise. Desktop, browser and Android modes share this check. The first
installation requires network access; npm failures stop startup with an error.

Tauri compiles and starts Axum as its managed sidecar, chooses a random private
loopback port and per-launch capability, waits for readiness, starts Vite, and
opens the desktop window. Desktop mode does not read project `.env` files.
Configure Binance from the first-run wizard or Settings. The Linux Settings
panel can also enable **Browser access**, which opens the packaged UI at the
fixed local origin `http://127.0.0.1:8658`; the installed process must remain
running. Price alerts, ntfy, and Telegram
are intentionally dormant in the current product; see
[ADR 0013](docs/adr/0013-dormant-alerts-and-notifications.md) and the
[architecture decision records](docs/adr/README.md).

Development builds open in a resizable 1280×800 window and allow mobile-width
testing down to 320×480. Release builds remain fullscreen.

### Android device development

Install the Android SDK/NDK, Java, ADB, and the Rust Android target, then enable
USB debugging and authorize this computer on an arm64 Android device. From the
repository root, one command builds, replaces, and launches the debug app:

```bash
./run.sh android
```

The APK is written to
`frontend/src-tauri/gen/android/app/build/outputs/apk/universal/debug/`.
Android links `backend/` as a Rust library inside the Tauri process; it does not
package a second backend source tree or require Cargo, `.env`, or a manually
started service on the phone. Secrets use Android's native credential store and
runtime data stays in the app's private data directory.

This is currently a signed direct-distribution preview. The protected release
workflow produces and verifies an arm64 APK/AAB using the provisioned upload
identity, but Android is not yet a supported Play Store release.
Price alerts and their ntfy/Telegram delivery are dormant on Android and Linux.
No foreground alert service or alert-specific background connection is started.
Trading state still reconciles after the application resumes or reconnects.

### Linux release bundle

```bash
cd frontend
npm ci
npm run test:run
npm run desktop:build
```

This creates Linux x86_64 `.deb` and AppImage packages under
`frontend/src-tauri/target/release/bundle/`. The `.deb` is the primary first
release format; AppImage is the portable fallback. See
[docs/RELEASING.md](docs/RELEASING.md) before publishing an artifact.

In an installed Linux build, **Settings → Browser access → ENABLE & OPEN** opens an
authenticated terminal in the user's normal browser. On Linux desktops with a
working status tray, closing the native window leaves Fyxtez available there;
**Disable** revokes every browser session, and tray **Quit** stops the local
service. Without a tray, closing the window remains a real exit so Fyxtez cannot
be left invisibly running. This listener is loopback only and is not a remotely
hosted or LAN-accessible terminal. Choosing **OPEN IN BROWSER** again opens
another authorized tab without disconnecting tabs already in use.

## Prerequisites

- Node.js 20.19 or newer (or 22.12 or newer) and npm
- A recent stable Rust toolchain with Cargo
- Network access to the configured exchange and notification APIs
- Tauri platform prerequisites for desktop development

The versions currently used during development can be checked with:

```bash
node --version
npm --version
rustc --version
cargo --version
```

## Standalone browser development

### 1. Configure the backend

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env` and provide a `SERVICE_API_TOKEN` (use a long random
value, not the placeholder). Do not put Binance credentials in this file.

`BINANCE_TESTNET` and `ALLOW_MAINNET` select the standalone browser-development
backend network. They do not configure the desktop build. Desktop users select
Testnet or Mainnet in the native connection flow.

Start it with:

```bash
cargo run
```

By default it listens on `127.0.0.1:8657`. Startup loads local state and begins
accepting requests without waiting for external providers. Exchange metadata,
account state and cached artwork refresh in the background; actions that could
increase exposure remain blocked until their required Binance data is ready.

### 2. Configure the frontend

In another terminal:

```bash
cd frontend
cp .env.example .env
```

Set `VITE_TRADING_API_TOKEN` to the same value as the backend
`SERVICE_API_TOKEN`, then run:

```bash
npm install
npm run dev
```

Open the URL printed by Vite, normally `http://localhost:5173`. This development
browser UI is chart-only by design. `./run.sh browser` starts the complete
standalone browser-development stack. It is distinct from the authenticated
**Browser access** session opened by an installed Linux app; use `./run.sh` and
enable that setting for account access and execution in a normal browser.

## Validation

Run these checks before merging or deploying changes:

```bash
cd backend
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked

cd ../frontend
npm ci
npm run check

cd src-tauri
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

`npm run check` runs TypeScript and CSS lint guards, verifies Prettier formatting,
runs the frontend tests, and creates a production build. Use `npm run format` to
apply the repository's TS/TSX/CSS style. GitHub Actions repeats these checks plus
backend/Tauri formatting, Clippy and tests on every push and pull request. A green
build is necessary but not sufficient validation for real-money trading flows.

Product versions are automatic. The repository starts at `1.0.0`; each new
first-parent commit on `master` advances the patch number, CI prepares that
version for every build, and a successful push receives the matching Git tag.
The normal developer flow remains only `git add`, `git commit`, and `git push`.
See [the release guide](docs/RELEASING.md).

## Configuration

Binance keys and the selected Binance network belong only in the platform
credential manager and are configured through the Tauri UI. Native Axum never
falls back to `.env`. Tauri creates its private API endpoint and capability in
memory for each launch. Desktop sends the bootstrap payload to the sidecar over
stdin; Android passes it directly to the embedded backend. Neither path uses
Vite, argv, a URL, or a file. Linux Browser access exchanges a short-lived
one-use URL-fragment ticket for a revocable session split between an `HttpOnly`
cookie and a tab-scoped proof. The browser receives neither the native sidecar
capability nor the Binance credentials; those credentials remain only in the
operating-system credential manager on that computer.

Before a newly entered Mainnet Binance pair is stored, the native layer checks
Binance's signed API-key permission response. Reading and Futures access are
required, and any key with withdrawals enabled is rejected with a request to
create a new restricted key. Testnet keys cannot authorize real withdrawals,
but they are still authenticated against the signed Futures account endpoint
and must report that trading is allowed.
Key, secret and network updates are rollback-safe: an unavailable, incomplete
or corrupt credential store blocks trading and opens a retryable native setup
error without revealing or automatically deleting stored values.
Settings also provides an explicit, confirmed Binance disconnect. It blocks
account actions immediately, removes only the Binance key/secret/network set,
restarts into chart-only mode and restores the previous set if backend restart
fails.

Installed desktop runtime data uses the platform application-data directory.
Standalone backend development defaults to `backend/data/`:

- `sizing.json` — sizing configuration
- `symbols.json` — dynamic symbol registry
- `alerts.sqlite3` — retained legacy alert data; dormant code does not open it
- `operations.sqlite3` — durable financial intents and redacted audit metadata;
  restart-surviving uncertain operations block only new exposure until the
  explicitly confirmed Settings > Diagnostics reconciliation tombstones them
- `icons/` — downloaded icon cache

Paths can be overridden through backend environment variables. Native Linux and
Android builds expose versioned export/restore under **Settings > Local data
backup**, with a documented closed-app fallback. Credentials remain in the OS
credential manager and are never included in either backup method. See
[local data and backup](docs/LOCAL-DATA-BACKUP.md).

## Deployment status

The supported deployment shape is a local, single-user Linux desktop install,
including its optional same-computer browser companion. Do not expose Axum as a
public service or forward its loopback ports. CI produces verified, signed/attested
Linux `.deb`/AppImage and Android arm64 APK/AAB artifacts. Android remains a
direct-distribution preview, and the first public release remains gated on the
clean-machine acceptance procedure in [docs/RELEASING.md](docs/RELEASING.md).
Windows and macOS are not yet verified release targets, and v1 intentionally
has no automatic updater.

## Additional documentation

- [Frontend guide](frontend/README.md)
- [Backend guide](backend/README.md)
- [Architecture](ARCHITECTURE.md)
- [Security model and operating guidance](SECURITY.md)
- [Dependency policy and reviewed audit warnings](docs/DEPENDENCY-POLICY.md)
- [Linux release procedure](docs/RELEASING.md)
- [Android signed release procedure](docs/ANDROID-RELEASING.md)
- [Continuous background monitoring decision](docs/adr/0012-continuous-background-monitoring.md)
- [Desktop release and live-trading checklist](docs/RELEASE-CHECKLIST.md)
- [Binance Testnet failure drill](docs/TESTNET-FAILURE-DRILL.md)
- [Emergency trading procedure](docs/EMERGENCY-PROCEDURE.md)
- [Authoritative exchange reconciliation](docs/adr/0008-authoritative-exchange-reconciliation.md)
