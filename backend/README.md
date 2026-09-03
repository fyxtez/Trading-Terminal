# Fyxtez Terminal backend

Rust, Tokio, and Axum service responsible for exchange access, trading safety,
account state, persistent alerts, symbol metadata, and frontend REST/WebSocket
APIs.

This remains the local execution authority. The application lifecycle lives in
`src/lib.rs`; `src/main.rs` is the thin standalone/desktop-sidecar executable.
Desktop Tauri packages and supervises that executable. Android links the same
crate as a library and starts it inside the Tauri process, avoiding a duplicate
mobile backend implementation. See
[`ADR 0004`](../docs/adr/0004-backend-packaging-and-lifecycle.md) and
[`ADR 0010`](../docs/adr/0010-embedded-mobile-backend.md).

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

Native mode ignores project server/token/data-path settings and binds only to
`127.0.0.1`. Desktop reads a bounded one-line bootstrap payload from stdin;
Android receives equivalent configuration in process. Both keep data under
Tauri's platform application-data directory and read exchange/notification
credentials directly from the platform credential manager.

See [`.env.example`](.env.example) for all configuration variables and
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) for service internals.
