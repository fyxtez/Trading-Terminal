# Fyxtez Terminal

Fyxtez Terminal is a personal derivatives-trading terminal with a React charting
interface and a Rust execution service. It combines live market data, chart
tools, position management, price alerts, and Binance USD-M Futures execution in
one browser UI.

> **Safety notice:** this application can submit real orders. New installations
> default to Binance testnet. Keep `BINANCE_TESTNET=true` and
> `ALLOW_MAINNET=false` until all security and deployment checks are complete.

## Features

- Multi-symbol, multi-tab candlestick charts built with Lightweight Charts
- Binance and MEXC market-data sources
- Market, limit, stop-market, take-profit, reduce, chase, and close-position flows
- Isolated-margin enforcement, leverage controls, and configurable sizing
- Live account, position, order, PNL, and trading-event updates
- Drawing tools, drawing sets, trade markers, sessions, hotkeys, and chart alerts
- Persistent SQLite-backed price alerts with optional ntfy notifications
- Dynamic symbol registry and locally cached symbol icons

## Repository layout

```text
.
├── frontend/       React 18 + TypeScript + Vite browser application
├── backend/        Rust + Axum API, WebSocket service, and exchange client
├── ARCHITECTURE.md System design and data-flow documentation
└── README.md       Project setup and operating guide
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for component boundaries, request flows,
persistence, and security assumptions.

## Prerequisites

- Node.js 20 or newer and npm
- A recent stable Rust toolchain with Cargo
- Binance Futures testnet API credentials
- Network access to the configured exchange and notification APIs

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

Edit `backend/.env` and provide at least:

- `BINANCE_API_KEY_TEST`
- `BINANCE_API_SECRET_TEST`
- `SERVICE_API_TOKEN` (use a long random value, not the placeholder)

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

Open the URL printed by Vite, normally `http://localhost:5173`.

## Validation

Run these checks before merging or deploying changes:

```bash
cd backend
cargo fmt --check
cargo check --locked

cd ../frontend
npm ci
npm run build
```

At the time this documentation was added, the Rust check passes with minor
dead-code warnings, while the frontend production build is blocked by the
top-level `await` described in the pre-deployment checklist. Automated tests and
CI are also still pending.

## Configuration

All secrets belong in ignored `.env` files or a deployment secret manager.
Use [backend/.env.example](backend/.env.example) and
[frontend/.env.example](frontend/.env.example) as the canonical variable lists.
Never commit live exchange keys, service tokens, or private notification topics.

Important runtime data defaults to `backend/data/`:

- `sizing.json` — sizing configuration
- `symbols.json` — dynamic symbol registry
- `alerts.sqlite3` — persistent alert database
- `icons/` — downloaded icon cache

Paths can be overridden through backend environment variables.

## Deployment status

There is currently no supported one-command production deployment and no CI
pipeline. Before exposing the terminal outside a trusted local/private network,
complete the required security and deployment checks.
In particular, the current Vite token model is not safe authentication for a
public browser application because Vite embeds it in the generated JavaScript.

## Additional documentation

- [Frontend guide](frontend/README.md)
- [Backend guide](backend/README.md)
- [Architecture](ARCHITECTURE.md)
