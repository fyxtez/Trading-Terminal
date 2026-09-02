# Fyxtez Terminal architecture

## Overview

Fyxtez Terminal is split into a browser client and a single Rust service. The
browser owns presentation and interactive chart state. The backend is the trust
boundary for exchange credentials, order validation, account state, persistent
alerts, and exchange communication.

```text
Browser (React/Vite)
  ├── REST + authenticated WebSocket
  v
Rust API (Axum/Tokio)
  ├── Binance USD-M REST and user-data streams
  ├── Binance/MEXC public market-data APIs
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
3. Historical candles are fetched and live updates are streamed/polled.
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
4. Triggered alerts may be delivered through ntfy and linked back to the terminal.

Browser-owned, non-persistent alerts are a separate path and depend on browser
lifetime.

## Persistence

| Data | Default location | Owner |
| --- | --- | --- |
| Sizing policy | `backend/data/sizing.json` | Backend |
| Symbol registry | `backend/data/symbols.json` | Backend |
| Persistent alerts | `backend/data/alerts.sqlite3` | Backend |
| Icon cache | `backend/data/icons/` | Backend |
| UI settings/drawings/tabs | Browser `localStorage` | Frontend |

Runtime data and secrets are ignored by Git. Production deployment must include
backup and restore procedures for backend-owned data.

## Authentication and trust boundaries

Most API routes require `Authorization: Bearer <SERVICE_API_TOKEN>`. WebSocket
and image requests use a query token because browser WebSocket and `<img>` APIs
cannot attach the same custom header in the current implementation. `/health`
is unauthenticated.

This is suitable only for a trusted single-user/private-network setup. A
`VITE_*` value is compiled into the public browser bundle and is therefore not a
secret. Before public deployment, replace the shared frontend token with a
server-side authentication/session design, restrict CORS, avoid secrets in URLs,
and add rate limiting and audit logging before exposing the service publicly.

## Safety properties already present

- Testnet is the default.
- Mainnet requires two explicit environment switches.
- Backend exchange credentials never need to enter the browser.
- Service tokens must be at least 16 characters.
- Exposure-increasing symbol setup enforces isolated margin.
- Multi-step trade workflows are serialized.
- The server responds to SIGINT/SIGTERM and stops background tasks.

These controls reduce risk but do not replace tests, authentication, monitoring,
or deployment hardening.
