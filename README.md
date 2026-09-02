# Fyxtez Terminal

Fyxtez Terminal is a personal derivatives-trading terminal with a React charting
interface and a Rust execution service. It combines live market data, chart
tools, position management, price alerts, and Binance USD-M Futures execution in
one browser UI. The project is now migrating to a self-hosted Tauri 2 desktop
application. Browser development remains available for chart/UI work; the
official browser UI suppresses account requests and execution controls.

> **Safety notice:** this application can submit real orders. New installations
> default to Binance testnet. Keep `BINANCE_TESTNET=true` and
> `ALLOW_MAINNET=false` until all security and deployment checks are complete.

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
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
# Put the same random service token in both files, then:
cd frontend && npm install && cd ..
./run.sh
```

This starts the local Axum service, waits for readiness, starts Vite and opens
the Tauri window. Release bundling remains disabled until the backend is a
supervised sidecar. See the
[architecture decision records](docs/adr/README.md).

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

## Local setup

### 1. Configure the backend

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env` and provide a `SERVICE_API_TOKEN` (use a long random
value, not the placeholder). Do not put Binance, ntfy or Telegram credentials
in this file.

Keep testnet enabled for development. The backend deliberately refuses to use
mainnet unless both `BINANCE_TESTNET=false` and `ALLOW_MAINNET=true` are set.

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

Open the URL printed by Vite, normally `http://localhost:5173`. This browser
UI is chart-only by design. Use `./run.sh` and Settings → Desktop connections
to configure trading or notifications. `./run.sh browser` starts the browser
development stack explicitly.

## Validation

Run these checks before merging or deploying changes:

```bash
cd backend
cargo fmt --check
cargo check --locked

cd ../frontend
npm ci
npm run build

cd src-tauri
cargo fmt --check
cargo check --locked
```

GitHub Actions repeats the frontend build plus backend/Tauri formatting, Clippy
and test checks on every push and pull request. The project still has very
limited automated domain coverage, so a green build is necessary but not
sufficient validation for trading flows.

## Configuration

Binance keys, private ntfy URLs and Telegram credentials belong only in the
operating-system credential manager and are configured through the Tauri UI.
The local service token remains in ignored development `.env` files until the
sidecar lifecycle replaces it with a per-launch token. Never commit either.

Important runtime data defaults to `backend/data/`:

- `sizing.json` — sizing configuration
- `symbols.json` — dynamic symbol registry
- `alerts.sqlite3` — persistent alert database
- `icons/` — downloaded icon cache

Paths can be overridden through backend environment variables.

## Deployment status

There is currently no supported one-command production deployment. Before
exposing the terminal outside a trusted local/private network, complete the
required security and deployment checks.
In particular, the current Vite token model is not safe authentication for a
public browser application because Vite embeds it in the generated JavaScript.
The current desktop workflow also assumes the local backend is at
`127.0.0.1:8657`; dynamic sidecar ports are part of the proposed release design.

## Additional documentation

- [Frontend guide](frontend/README.md)
- [Backend guide](backend/README.md)
- [Architecture](ARCHITECTURE.md)
- [Security model and operating guidance](SECURITY.md)
