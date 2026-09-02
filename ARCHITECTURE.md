# Fyxtez Terminal architecture

## Overview

Fyxtez Terminal is split into a browser client and a single Rust service. The
browser owns presentation and interactive chart state. The backend is the trust
boundary for exchange credentials, order validation, account state, persistent
alerts, and exchange communication.

The desktop runtime adds a Tauri 2 native process around the existing SPA while
preserving the React/Axum contract:

```text
Tauri native process
  ├── OS credential-store commands (secrets never returned to WebView)
  ├── single-instance guard and bounded sidecar supervisor
  ├── WebView: existing React/Vite terminal
  └── bundled Axum sidecar on 127.0.0.1:<ephemeral-port>
      ├── receives port/capability/app-data path once over stdin
      └── reads the same OS credential-store service directly
```

Linux x86_64 `.deb` and AppImage bundling is enabled. Distribution still
requires artifact signing and clean-machine acceptance. Decisions and
constraints are recorded in [`docs/adr`](docs/adr/README.md).

### Desktop connection modes

- **Chart only:** no Binance secret is configured; public market data and local
  chart tools work, but account state and execution are disabled in both UI and
  frontend API guards.
- **Trading connected:** a Binance network, key and secret exist in the OS
  credential manager. Native status exposes only booleans plus the non-secret
  network name to React; Axum reads the same keychain entries without a
  JavaScript or `.env` credential handoff. No network is selected by default,
  and Mainnet needs an explicit real-funds confirmation.
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
  drawings, alerts, tabs, and hotkeys. The drawing overlay is decomposed under
  `hooks/useDrawingCanvas/` into rendering, canvas primitives, geometry,
  pending-order layout/hit-testing, and armed pointer interactions.
- `components/PositionsPanel/` separates panel orchestration from position and
  open-order row rendering; row-specific styles follow the same boundary.
- `components/ChartPanel/ChartTransientEditors.tsx` contains the short-lived
  chart editors and temporary price line, leaving chart orchestration in the
  panel itself.
- `hooks/marketDataPersistence.ts` owns validation and storage of per-symbol
  intervals and chart viewports; `useMarketData` remains responsible for data
  loading, polling, and backfill.
- `components/SettingsPanel/SettingsSummaryCards.tsx` owns the desktop
  connection summary and balance presentation.
- `hooks/useOperationalDiagnostics.ts` combines protected backend diagnostics
  with frontend sidecar and market-feed state. Settings renders the snapshot;
  transient notification failures also produce a dismissible global warning.
- `components/AppErrorBoundary/` is the fail-closed recovery surface for
  uncaught React render/lifecycle failures.
- `components/PositionBracketOverlay/positionBracketModel.ts` owns persisted
  bracket anchors/zone extents and pure bracket calculations.
- `trading/api/` is the REST client layer.
- `trading/` contains trading-domain types and calculations.
- `utils/` contains chart geometry, persistence helpers, time/session logic, and
  marker/drawing utilities.
- `config/` contains API selection, supported intervals, colors, and the runtime
  symbol registry view.

`App.tsx` is currently the composition root. It wires the chart, panels, trading
state, settings, and overlays together. Large interaction modules should expose
a small orchestration API and keep rendering, geometry, and exchange mutations
in separate modules.

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
- `runtime_config.rs` separates standalone `.env` development from the bounded
  stdin bootstrap used by the desktop sidecar.
- `api.rs` composes REST/WebSocket routes, authentication, validation, and
  trading workflows. Alert handlers and symbol/icon/market-data handlers live in
  focused `api/` route modules while preserving the same public URLs.
- `binance.rs` signs and sends Binance REST requests and caches exchange metadata.
- `binance_stream/` maintains the Binance user-data stream.
- `account_state.rs` and `position_risk_state.rs` maintain shared snapshots.
- `trading_events.rs` broadcasts account/trade changes to connected clients.
- `diagnostics.rs` maintains redacted, process-lifetime health timestamps and
  counters exposed through the authenticated diagnostics endpoint.
- `alerts.rs` stores and evaluates persistent price alerts.
- `symbol_registry.rs` owns registered symbols and their market-data source.
- `sizing_store.rs` persists sizing policy.
- `icons.rs` resolves and caches symbol imagery.

### Concurrency model

Shared read-mostly state uses Tokio synchronization primitives. A global
process-local `TradeLock` serializes Binance account mutations. A handler keeps
its guard across the authoritative reads and writes of its workflow, so another
request cannot place, cancel, modify, close, chase, or reverse an order in the
middle of that transition. In particular, `close-everything` holds the guard
from its fresh account/open-order snapshot through every cancellation and
reduce-only close. The lock is not distributed; the desktop single-instance
policy and managed sidecar provide the one-process ownership assumption. A
contention test verifies that a second workflow cannot enter before the first
guard is released.

Background tasks refresh exchange reference data, account state, position risk,
alerts, and user-stream events. They do not submit account mutations through the
HTTP trading workflows and are aborted during graceful shutdown.

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
4. Account-mutating flows acquire `TradeLock`; exposure-increasing flows also
   enforce isolated margin.
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

Notification delivery is best-effort and cannot change the authoritative result
of a triggered alert or completed exchange action. Delivery failures are shown
as frontend warnings and retained as process-lifetime diagnostic counters.

### Failure and diagnostics flow

`/health` answers only whether the sidecar API is alive. The authenticated
`/api/diagnostics` snapshot separately reports exchange connectivity,
user-stream freshness, reconciliation drift and rejected/duplicate mutation
requests. React adds its own sidecar and public market-feed states. Failed
initial candle loads and failed live polling are explicit degraded states with
a manual retry; uncaught render failures enter the global fail-closed boundary.

## Persistence

| Data | Default location | Owner |
| --- | --- | --- |
| Sizing policy | `backend/data/sizing.json` | Backend |
| Symbol registry | `backend/data/symbols.json` | Backend |
| Persistent alerts | `backend/data/alerts.sqlite3` | Backend |
| Icon cache | `backend/data/icons/` | Backend |
| UI settings/drawings/tabs | Browser `localStorage` | Frontend |
| Binance/ntfy/Telegram secrets | OS credential manager | Native Rust |

The table shows standalone development defaults. In installed desktop builds,
backend-owned JSON, SQLite, and icon data live under the operating system's
application-data directory resolved by Tauri. Runtime data and secrets are
ignored by Git.

## Authentication and trust boundaries

Desktop startup generates a 256-bit per-launch bearer capability and an
ephemeral loopback port. A one-line JSON bootstrap is written to the sidecar's
stdin; neither value appears in `VITE_*`, argv, a file, nor application URLs.
Tauri gives the runtime information to the WebView through an IPC command.
The desktop frontend build also shadows local `VITE_TRADING_*` variables with
empty values, preventing an ignored developer `.env` from leaking its browser
development capability into release assets.

Most API routes require `Authorization: Bearer <capability>`. WebSocket clients
exchange that bearer value for a 30-second, one-use ticket; protected icon bytes
are bearer-fetched and displayed through temporary blob URLs. `/health` is the
only public route. CORS is restricted to known Vite/Tauri origins and CSP allows
loopback connections on arbitrary ports because the desktop port is ephemeral.

Standalone browser development retains the configured shared token. Because a
`VITE_*` value is compiled into JavaScript, that workflow is local-only and the
browser UI deliberately remains chart-only. Neither mode is a public or
multi-user authentication design.

## Safety properties already present

- A desktop install begins with no Binance network or credentials.
- Mainnet requires explicit network selection and real-funds confirmation.
- Exchange and notification credentials exist in the WebView only while the
  user enters them; they are not returned after saving and never enter `.env`,
  argv, URLs, localStorage, SQLite, or backend logs.
- Desktop capabilities contain 256 random bits and service tokens must contain
  at least 32 characters.
- The backend sidecar is packaged, health-checked, supervised, and stopped by
  Tauri; only one desktop application instance owns it.
- Automatic sidecar recovery is bounded to three attempts before a visible
  retry is required.
- Exposure-increasing symbol setup enforces isolated margin.
- Multi-step trade workflows are serialized.
- The server responds to SIGINT/SIGTERM and stops background tasks.

These controls reduce risk but do not replace tests, authentication, monitoring,
or deployment hardening.

See [`SECURITY.md`](SECURITY.md) for key permissions, supported exposure and the
pre-release security checklist.
