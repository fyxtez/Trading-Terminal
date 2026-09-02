# Fyxtez Terminal architecture

## Overview

Fyxtez Terminal is split into a browser client and a single Rust service. The
browser owns presentation and interactive chart state. The backend is the trust
boundary for exchange credentials, order validation, account state, persistent
alerts, and exchange communication.

The desktop migration adds a Tauri 2 native process around the existing SPA.
During migration, the React/Axum contract remains intact:

```text
Tauri native process
  ├── OS credential-store commands (secrets never returned to WebView)
  ├── WebView: existing React/Vite terminal
  └── Local Axum service
      └── reads the same OS credential-store service directly
```

Production bundling is deliberately disabled until Tauri supervises the Axum
sidecar and replaces the development service token with a per-launch
capability. Decisions and constraints are recorded in
[`docs/adr`](docs/adr/README.md).

### Desktop connection modes

- **Chart only:** no Binance secret is configured; public market data and local
  chart tools work, but account state and execution are disabled in both UI and
  frontend API guards.
- **Trading connected:** Binance key and secret exist in the OS credential
  manager. Native status exposes only booleans to React; Axum reads the same
  keychain entries without a JavaScript or `.env` credential handoff.
- **Optional notifications:** ntfy and Telegram are configured independently
  and never gate chart or trading access.

```text
Browser (React/Vite)
  ├── public Binance/MEXC candles
  └── REST + authenticated WebSocket
      v
Rust API (Axum/Tokio)
  ├── Binance USD-M REST and user-data streams
  ├── proxied MEXC history and Binance reference data
  ├── SQLite alert store
  ├── JSON symbol and sizing stores
  └── ntfy and external icon providers
```

## Frontend

The frontend lives in `frontend/src` and uses React 18, TypeScript, Vite, and
Lightweight Charts.

### Main areas

- `components/` contains UI surfaces and chart overlays.
- `hooks/` coordinates chart lifecycle, market streams, positions, orders,
  drawings, alerts, tabs, and hotkeys.
- `trading/api/` is the REST client layer.
- `trading/` contains trading-domain types and calculations.
- `utils/` contains chart geometry, persistence helpers, time/session logic, and
  marker/drawing utilities.
- `config/` contains API selection, supported intervals, colors, and the runtime
  symbol registry view.

`App.tsx` is currently the composition root. It wires the chart, panels, trading
state, settings, and overlays together. Several frontend modules are larger than
the desired long-term boundary; their planned decomposition is tracked in the
before-live checklist.

### Frontend state

State is intentionally split between:

- React state and refs for the current session
- backend snapshots/streams for authoritative account and order state
- `localStorage` for UI preferences, tabs, drawings, drawing sets, and markers

Local browser state must never be treated as authoritative for exchange
positions or order completion.

## Backend

The backend is a Tokio application exposed through Axum.

### Main areas

- `main.rs` loads configuration, initializes stores and exchange reference data,
  starts background workers, and handles graceful shutdown.
- `api.rs` defines REST/WebSocket routes, authentication, validation, and trading
  workflows.
- `binance.rs` signs and sends Binance REST requests and caches exchange metadata.
- `binance_stream/` maintains the Binance user-data stream.
- `account_state.rs` and `position_risk_state.rs` maintain shared snapshots.
- `trading_events.rs` broadcasts account/trade changes to connected clients.
- `alerts.rs` stores and evaluates persistent price alerts.
- `symbol_registry.rs` owns registered symbols and their market-data source.
- `sizing_store.rs` persists sizing policy.
- `icons.rs` resolves and caches symbol imagery.

### Concurrency model

Shared read-mostly state uses Tokio synchronization primitives. A global
`trade_lock` serializes sensitive multi-step trading workflows so concurrent UI
actions cannot interleave their exchange-side state transitions. Background
tasks refresh exchange reference data, account state, position risk, alerts, and
user-stream events. They are aborted during graceful shutdown.

## Request and event flows

### Market data

1. The frontend loads the authoritative symbol registry from the backend.
2. The selected symbol determines Binance or MEXC as the data source.
3. The frontend fetches public Binance candles directly; MEXC history may use
   the local backend proxy. Live candles are polled from the selected venue.
4. Chart hooks translate market data into Lightweight Charts series and overlays.

### Order execution

1. The user creates an intent in the frontend.
2. The frontend sends an authenticated REST request.
3. The backend resolves the registered execution symbol and validates the input.
4. Exposure-increasing flows enforce isolated margin and acquire `trade_lock`.
5. The backend applies exchange filters/sizing and signs the Binance request.
6. Binance user-data events update backend snapshots and are broadcast to the UI.
7. The frontend reconciles optimistic UI state with authoritative events.

Close and reduction paths use `reduceOnly` where appropriate. These invariants
are financially critical and need automated coverage before live deployment.

### Persistent alerts

1. The frontend creates an authenticated alert through the API.
2. The backend stores it in SQLite.
3. The alert worker observes market/trading events and evaluates triggers.
4. Triggered alerts may be delivered through ntfy and Telegram and linked back
   to the terminal. Destinations are loaded from the OS credential store.

Local, non-persistent alerts depend on frontend lifetime. In Tauri they delegate
delivery to native Rust; plain browser development does not have notification
credential access.

## Persistence

| Data | Default location | Owner |
| --- | --- | --- |
| Sizing policy | `backend/data/sizing.json` | Backend |
| Symbol registry | `backend/data/symbols.json` | Backend |
| Persistent alerts | `backend/data/alerts.sqlite3` | Backend |
| Icon cache | `backend/data/icons/` | Backend |
| UI settings/drawings/tabs | Browser `localStorage` | Frontend |
| Binance/ntfy/Telegram secrets | OS credential manager | Native Rust |

Runtime data and secrets are ignored by Git. Production deployment must include
backup and restore procedures for backend-owned data.

## Authentication and trust boundaries

Most API routes require `Authorization: Bearer <SERVICE_API_TOKEN>`. WebSocket
and image requests use a query token because browser WebSocket and `<img>` APIs
cannot attach the same custom header in the current implementation. `/health`
is unauthenticated.

This is suitable only for a trusted single-user/private-network setup. A
`VITE_*` value is compiled into the public browser bundle and is therefore not a
secret. Frontend guards make the supported browser UI chart-only, but they are
not a backend authentication boundary: a caller holding the shared token can
still invoke Axum directly. The credential-reload endpoint currently accepts a
secret-free loopback signal without bearer authentication. Before any public or
multi-user deployment, replace this model with server-side sessions, replace the
development-only local CORS allowlist, avoid capability values in URLs, and add
rate limiting and audit logging.

## Safety properties already present

- Testnet is the default.
- Mainnet requires two explicit environment switches.
- Exchange and notification credentials never enter the browser, `.env`, argv
  or backend logs.
- Service tokens must be at least 16 characters.
- Exposure-increasing symbol setup enforces isolated margin.
- Multi-step trade workflows are serialized.
- The server responds to SIGINT/SIGTERM and stops background tasks.

These controls reduce risk but do not replace tests, authentication, monitoring,
or deployment hardening.

See [`SECURITY.md`](SECURITY.md) for key permissions, supported exposure and the
pre-release security checklist.
