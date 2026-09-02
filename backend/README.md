# Fyxtez Terminal backend

Rust, Tokio, and Axum service responsible for exchange access, trading safety,
account state, persistent alerts, symbol metadata, and frontend REST/WebSocket
APIs.

## Setup

```bash
cp .env.example .env
# Fill in Binance Futures testnet credentials and a random SERVICE_API_TOKEN.
cargo run
```

The service defaults to Binance testnet and `127.0.0.1:8657`. It refuses mainnet
unless `BINANCE_TESTNET=false` and `ALLOW_MAINNET=true` are both explicitly set.

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

See [`.env.example`](.env.example) for all configuration variables and
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) for service internals.
