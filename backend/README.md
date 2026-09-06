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

Most routes require either the native/standalone bearer token or, on the optional
Linux companion listener, both parts of a valid browser session. `/health` is
public. The WebSocket upgrade uses a short-lived, one-use ticket issued through
an authenticated POST; icon bytes use the normal authenticated fetch path. Bind
standalone development to localhost.

Native mode ignores project server/token/data-path settings and binds only to
`127.0.0.1`. Desktop reads a bounded one-line bootstrap payload from stdin;
Android receives equivalent configuration in process. Both keep data under
Tauri's platform application-data directory and read exchange/notification
credentials directly from the platform credential manager.

The Linux sidecar may also receive an optional packaged-UI path and fixed
loopback Browser access port. Native-only control routes can enable it and issue
a short-lived launch ticket. The local browser redeems that ticket for a split,
revocable session: an `HttpOnly`, `SameSite=Strict` cookie plus an independent
tab-scoped request proof. Both are required on normal account/trading routes;
another launch in the same browser profile reuses its valid cookie and adds a
new proof without invalidating existing tabs. The session cannot reload
credentials or administer Browser access. Neither the sidecar bearer nor
exchange secrets is returned to the browser. Standalone and Android runtimes do
not enable this listener.

See [`.env.example`](.env.example) for all configuration variables and
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) for service internals.
