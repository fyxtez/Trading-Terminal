# Fyxtez Terminal backend

Rust, Tokio, and Axum service responsible for exchange access, trading safety,
account state, persistent alerts, symbol metadata, and frontend REST/WebSocket
APIs.

This remains the local execution authority. Tauri packages it as a sidecar,
starts it on an ephemeral loopback port, health-checks it, restarts it at most
three times after crashes, and stops it with the application. See
[`ADR 0004`](../docs/adr/0004-backend-packaging-and-lifecycle.md).

## Setup

```bash
cp .env.example .env
# Set a random SERVICE_API_TOKEN. Use the same value in frontend/.env.
cargo run
```

This standalone development mode defaults to Binance testnet and
`127.0.0.1:8657`. It refuses mainnet unless `BINANCE_TESTNET=false` and
`ALLOW_MAINNET=true` are both explicitly set.
Binance, ntfy and Telegram credentials are read from the operating-system
credential manager populated by Settings → Desktop connections. Without a
Binance connection, the service starts in chart-only mode.

## Validation

```bash
cargo fmt --check
cargo check --locked
cargo test --locked
```

The runtime bootstrap has unit coverage. Financially sensitive order-domain
coverage is still incomplete and remains a release gate.

## Runtime data

The default `data/` directory contains sizing JSON, a symbol registry, an icon
cache, and the SQLite alert database. These files are intentionally excluded
from Git. Back them up before production use.

## API security

Most routes require the bearer token from `SERVICE_API_TOKEN`. `/health` is
public. The WebSocket upgrade uses a short-lived, one-use ticket issued through
an authenticated POST; icon bytes use the normal bearer-protected fetch path.
Bind standalone development to localhost.

Desktop mode ignores project server/token/data-path settings. It reads a bounded
one-line bootstrap payload from stdin, binds only to `127.0.0.1`, and keeps data
under Tauri's platform application-data directory. Exchange and notification
credentials still come directly from the OS credential manager.

See [`.env.example`](.env.example) for all configuration variables and
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) for service internals.
