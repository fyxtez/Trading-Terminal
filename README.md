# Fyxtez Terminal

Fyxtez Terminal is a personal derivatives-trading terminal with a React charting
interface and a Rust execution service. It combines live market data, chart
tools, position management, price alerts, and Binance USD-M Futures execution in
a self-hosted Tauri 2 desktop application. Browser development remains available
for chart/UI work; the browser UI suppresses account requests and execution
controls.

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
- Drawing tools, drawing sets, trade markers, sessions, hotkeys, and chart alerts
- Persistent SQLite-backed price alerts with optional ntfy/Telegram notifications
- Dynamic symbol registry and locally cached symbol icons

## Repository layout

```text
.
├── frontend/       React 18 + TypeScript + Vite browser application
│   └── src-tauri/  Tauri 2 native desktop shell
├── backend/        Rust + Axum API, WebSocket service, and exchange client
├── docs/adr/        Architecture decision records
├── ARCHITECTURE.md System design and data-flow documentation
└── README.md       Project setup and operating guide
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for component boundaries, request flows,
persistence, and security assumptions.

### Desktop development

```bash
cd frontend
npm install
cd ..
./run.sh
```

Tauri compiles and starts Axum as its managed sidecar, chooses a random loopback
port and per-launch capability, waits for readiness, starts Vite, and opens the
desktop window. Desktop mode does not read project `.env` files. Configure
Binance, ntfy, and Telegram from the first-run wizard or Settings. See the
[architecture decision records](docs/adr/README.md).

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

## Browser development

### 1. Configure the backend

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env` and provide a `SERVICE_API_TOKEN` (use a long random
value, not the placeholder). Do not put Binance, ntfy or Telegram credentials
in this file.

`BINANCE_TESTNET` and `ALLOW_MAINNET` select the standalone browser-development
backend network. They do not configure the desktop build. Desktop users select
Testnet or Mainnet in the native connection flow.

Start it with:

```bash
cargo run
```

By default it listens on `127.0.0.1:8657`. A successful startup initializes
exchange metadata and account state before accepting requests.

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

Open the URL printed by Vite, normally `http://localhost:5173`. This browser UI
is chart-only by design. `./run.sh browser` starts the complete standalone
browser-development stack. Use `./run.sh` for account access, execution, and
native notifications.

## Validation

Run these checks before merging or deploying changes:

```bash
cd backend
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked

cd ../frontend
npm ci
npm run test:run
npm run build

cd src-tauri
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

GitHub Actions repeats the frontend build plus backend/Tauri formatting, Clippy
and test checks on every push and pull request. The project still has very
limited automated domain coverage, so a green build is necessary but not
sufficient validation for trading flows.

## Configuration

Binance keys, the selected Binance network, private ntfy URLs and Telegram
credentials belong only in the operating-system credential manager and are
configured through the Tauri UI. Desktop Axum never falls back to `.env`. Tauri
creates its API endpoint and capability in memory for each launch and passes
the bootstrap payload to the sidecar over stdin, never through Vite, argv, a
URL, or a file.

Installed desktop runtime data uses the platform application-data directory.
Standalone backend development defaults to `backend/data/`:

- `sizing.json` — sizing configuration
- `symbols.json` — dynamic symbol registry
- `alerts.sqlite3` — persistent alert database
- `icons/` — downloaded icon cache

Paths can be overridden through backend environment variables.

## Deployment status

The supported deployment shape is a local, single-user desktop install. Do not
expose Axum as a public service. Linux bundles are enabled, but the first public
artifact remains gated on the clean-machine acceptance test and release-signing
process in [docs/RELEASING.md](docs/RELEASING.md). Windows and macOS are not yet
verified release targets, and v1 intentionally has no automatic updater.

## Additional documentation

- [Frontend guide](frontend/README.md)
- [Backend guide](backend/README.md)
- [Architecture](ARCHITECTURE.md)
- [Security model and operating guidance](SECURITY.md)
- [Dependency policy and reviewed audit warnings](docs/DEPENDENCY-POLICY.md)
- [Linux release procedure](docs/RELEASING.md)
