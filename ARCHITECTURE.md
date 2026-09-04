# Fyxtez Terminal architecture

## Overview

Fyxtez Terminal is split into a browser client and a single Rust service. The
browser owns presentation and interactive chart state. The backend is the trust
boundary for exchange credentials, order validation, account state, and
exchange communication.

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

Linux x86_64 `.deb` and AppImage bundling is enabled and CI attaches SHA-256
manifests plus keyless build attestations. Android release artifacts carry the
long-lived upload certificate. Public distribution still requires
clean-machine acceptance. Decisions and constraints are recorded in
[`docs/adr`](docs/adr/README.md).

Android preserves the same React/Axum boundary but links the backend crate into
the Tauri process instead of packaging a second executable:

```text
Android Tauri process
  ├── Android-native credential store
  ├── bounded embedded-backend supervisor
  ├── WebView: existing React/Vite terminal
  └── shared backend library on 127.0.0.1:<ephemeral-port>
      └── private app-data JSON, SQLite, and icon storage
```

### Desktop connection modes

- **Chart only:** no Binance secret is configured; public market data and local
  chart tools work, but account state and execution are disabled in both UI and
  frontend API guards.
- **Trading connected:** a Binance network, key and secret exist in the OS
  credential manager. Native status exposes only booleans plus the non-secret
  network name to React; Axum reads the same keychain entries without a
  JavaScript or `.env` credential handoff. No network is selected by default,
  and Mainnet needs an explicit real-funds confirmation. New Mainnet
  credentials are stored only after Binance confirms reading/Futures access
  and `enableWithdrawals=false`.
- **Dormant integrations:** price alerts, ntfy, and Telegram remain in source
  but expose no UI, routes, background worker, or provider delivery.

```text
Browser (React/Vite)
  ├── public Binance/MEXC candles
  └── REST + authenticated WebSocket
      v
Rust API (Axum/Tokio)
  ├── Binance USD-M REST and user-data streams
  ├── proxied MEXC history and Binance reference data
  ├── JSON symbol and sizing stores
  └── external icon providers
```

## Frontend

The frontend lives in `frontend/src` and uses React 18, TypeScript, Vite, and
Lightweight Charts.

### Main areas

- `components/` contains UI surfaces and chart overlays.
- `hooks/` coordinates chart lifecycle, market streams, positions, orders,
  drawings, tabs, and hotkeys. Dormant alert hooks remain feature-gated. The
  drawing overlay is decomposed under `hooks/useDrawingCanvas/` into rendering,
  canvas primitives, geometry,
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
- `components/SettingsPanel/settingsSearch.ts` owns the pure settings
  section/field search model independently of the drawer rendering.
- `hooks/useOperationalDiagnostics.ts` combines protected backend diagnostics
  with frontend sidecar and market-feed state. Settings renders the snapshot.
- `components/AppErrorBoundary/` is the fail-closed recovery surface for
  uncaught React render/lifecycle failures.
- `components/PositionBracketOverlay/positionBracketModel.ts` owns persisted
  bracket anchors/zone extents and pure bracket calculations.
- `components/PositionBracketOverlay/positionBracketPresentation.ts` derives
  TP/SL zone visibility, R labels, preview geometry, and label-collision state.
- `components/App/useAppPreferences.ts` owns chart-only preference defaults and
  local persistence; `appPanelLayout.ts` and `orderPresentation.ts` isolate
  panel sizing and order-display rules from the composition root.
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

The backend is a reusable Tokio application exposed through Axum.

### Main areas

- `lib.rs` loads configuration, initializes stores and exchange reference data,
  starts background workers, and handles graceful shutdown. `main.rs` is a thin
  standalone/desktop-sidecar entry point.
- `runtime_config.rs` separates standalone `.env` development from the bounded
  stdin bootstrap used by the desktop sidecar.
- `api.rs` composes routes and the remaining multi-step trading workflows.
  Account read models, regular-order CRUD, WebSocket/runtime middleware, and
  symbol/icon/market-data handlers live in focused `api/` route modules
  while preserving the same public URLs.
- `binance.rs` signs and sends Binance REST requests and caches exchange metadata.
- `binance_stream/` maintains the Binance user-data stream.
- `account_state.rs` and `position_risk_state.rs` maintain shared snapshots.
- `trading_events.rs` broadcasts account/trade changes to connected clients.
- `diagnostics.rs` maintains redacted, process-lifetime health timestamps and
  counters exposed through the authenticated diagnostics endpoint.
- `operation_safety.rs` persists financial request intents, replayable results
  and redacted audit correlation in SQLite.
- `alerts.rs` retains the dormant persistent-alert implementation. Its routes,
  database, worker, and provider delivery are disabled by ADR 0013.
- `symbol_registry.rs` owns registered symbols and their market-data source.
  The single-user local registry has no arbitrary symbol-count ceiling; icon
  resolution is best-effort and cannot reject an otherwise valid symbol.
- `sizing_store.rs` persists sizing policy.
- `icons.rs` resolves and caches symbol imagery.

### Concurrency model

Shared read-mostly state uses Tokio synchronization primitives. A global
process-local `TradeLock` serializes Binance account mutations. A handler keeps
its guard across the authoritative reads and writes of its workflow, so another
request cannot place, cancel, modify, close, or chase an order in the
middle of that transition. In particular, `close-everything` holds the guard
from its fresh account/open-order snapshot through every cancellation and
reduce-only close. The lock is not distributed; desktop single-instance
enforcement and Android's single application process provide the one-process
ownership assumption. A
contention test verifies that a second workflow cannot enter before the first
guard is released.

Background tasks refresh exchange reference data, account state, position risk,
and user-stream events. They do not submit account mutations through the
HTTP trading workflows and are aborted during graceful shutdown.

Price-alert monitoring is not a background task. ADR 0013 supersedes the earlier
Linux tray/Android foreground-service alert plan.

## Request and event flows

### Market data

1. The frontend loads the authoritative symbol registry from the backend.
2. The selected symbol determines Binance or MEXC as the data source.
3. The frontend fetches public Binance candles directly; MEXC history may use
   the local backend proxy. Live candles are polled from the selected venue.
4. Chart hooks translate market data into Lightweight Charts series and overlays.

### Order execution

1. The user creates an intent in the frontend.
2. The frontend sends an authenticated REST request with a durable UUID. It
   coalesces concurrent identical actions and retains the UUID across a retry.
3. Axum atomically starts or replays the matching intent from
   `operations.sqlite3`; conflicting or uncertain reuse fails closed.
4. The backend resolves the registered execution symbol and validates the input.
5. Account-mutating flows acquire `TradeLock`. Exposure-increasing flows refresh
   Binance prerequisites and require isolated margin.
6. The backend applies exchange filters/sizing and signs the Binance request.
7. Binance user-data events provide low-latency updates and trigger REST snapshot
   refreshes in the backend and frontend.
8. Fresh Binance REST state replaces backend caches and frontend optimistic
   projections after success, failure, reconnect, stream lag, or uncertainty.

Close and reduction paths use `reduceOnly` where appropriate. These invariants
are financially critical and need automated coverage before live deployment.
Timeouts and interrupted mutations have an unknown outcome and are never treated
as proof that Binance rejected the action. Multi-step workflows are locally
serialized but are not exchange transactions; their recovery and authority
rules are defined in
[ADR 0008](docs/adr/0008-authoritative-exchange-reconciliation.md).

### Dormant alerts

The alert UI, frontend monitoring, `/api/alerts` routes, SQLite alert store,
market websocket worker, and ntfy/Telegram delivery are inactive. Their source
is retained but no runtime path invokes it. Existing alert data and notification
credentials are preserved without being read. See ADR 0013.

### Failure and diagnostics flow

`/health` answers only whether the local backend API is alive. The authenticated
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
| Legacy alert data (dormant) | `backend/data/alerts.sqlite3` | Preserved, not opened |
| Financial intents and redacted audit metadata | `backend/data/operations.sqlite3` | Backend |
| Icon cache | `backend/data/icons/` | Backend |
| UI settings/drawings/tabs | Browser `localStorage` | Frontend |
| Binance secrets | OS credential manager | Native Rust |
| Legacy ntfy/Telegram secrets (dormant) | OS credential manager | Preserved, not read |

The table shows standalone development defaults. In installed native builds,
backend-owned JSON, SQLite, and icon data live under the operating system's
application-data directory resolved by Tauri. Runtime data and secrets are
ignored by Git.

The supported closed-app backup and restore procedure is documented in
[`docs/LOCAL-DATA-BACKUP.md`](docs/LOCAL-DATA-BACKUP.md). Outbound provider,
timeout, redirect and failure boundaries are listed in
[`docs/OUTBOUND-CONNECTIONS.md`](docs/OUTBOUND-CONNECTIONS.md).

## Authentication and trust boundaries

Native startup generates a 256-bit per-launch bearer capability and an
ephemeral loopback port. Desktop writes a one-line JSON bootstrap to the
sidecar's stdin; Android passes the same values directly to the linked backend
library. Neither value appears in `VITE_*`, argv, a file, nor application URLs.
Tauri gives the runtime information to the WebView through an IPC command.
The desktop frontend build also shadows local `VITE_TRADING_*` variables with
empty values, preventing an ignored developer `.env` from leaking its browser
development capability into release assets.

Frontend quality gates are exposed through `npm run lint`, `npm run format:check`,
`npm run test:ci`, and the aggregate `npm run check`. Prettier owns TS/TSX/CSS
layout; TypeScript, the CSS syntax guard, and the comment-invariant guard reject
invalid code, unbalanced CSS, and historical `FIX`/`FEATURE` labels in source.

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
- The desktop backend sidecar is packaged, health-checked, supervised, and
  stopped by Tauri; Android health-checks and supervises the embedded backend.
- Automatic local-backend recovery is bounded to three attempts before a visible
  retry is required.
- Exposure-increasing symbol setup enforces isolated margin.
- Multi-step trade workflows are serialized.
- Financial mutations require persistent intent IDs; identical completed
  requests replay their recorded result, while uncertain outcomes fail closed.
- New exposure requires fresh exchange prerequisites, a registered Binance
  execution symbol, isolated margin and valid exchange filters.
- Native credential and notification inputs, Axum request bodies and request
  duration are explicitly bounded.
- The server responds to SIGINT/SIGTERM and stops background tasks.

These controls reduce risk but do not replace tests, authentication, monitoring,
or deployment hardening.

See [`SECURITY.md`](SECURITY.md) for key permissions, supported exposure and the
pre-release security checklist.
