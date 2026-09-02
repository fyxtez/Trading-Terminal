# Fyxtez Terminal backend

Rust, Tokio, and Axum service responsible for exchange access, trading safety,
account state, persistent alerts, symbol metadata, and frontend REST/WebSocket
APIs.

During the Tauri migration this remains the local execution authority. Desktop
development starts it automatically; release sidecar packaging and lifecycle
supervision are proposed in
[`ADR 0004`](../docs/adr/0004-backend-packaging-and-lifecycle.md).

## Setup

```bash
cp .env.example .env
# Set a random SERVICE_API_TOKEN. Use the same value in frontend/.env.
cargo run
```

The service defaults to Binance testnet and `127.0.0.1:8657`. It refuses mainnet
unless `BINANCE_TESTNET=false` and `ALLOW_MAINNET=true` are both explicitly set.
Binance, ntfy and Telegram credentials are read from the operating-system
credential manager populated by Settings → Desktop connections. Without a
Binance connection, the service starts in chart-only mode.

## Validation

```bash
cargo fmt --check
cargo check --locked
cargo test --locked
```

Automated domain tests are not yet implemented and remain a release blocker.

## Runtime data

The default `data/` directory contains sizing JSON, a symbol registry, an icon
cache, and the SQLite alert database. These files are intentionally excluded
from Git. Back them up before production use.

## API security

Most routes require the bearer token from `SERVICE_API_TOKEN`. `/health` is
public; WebSocket and icon-image routes perform their own query-token checks.
Bind to localhost or a trusted private network until the authentication and CORS
items in the release checklist are complete.

The desktop development bridge currently expects `127.0.0.1:8657`. Other ports
are supported only by the standalone browser/backend workflow until the Tauri
sidecar selects and distributes a per-launch endpoint.

See [`.env.example`](.env.example) for all configuration variables and
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) for service internals.
