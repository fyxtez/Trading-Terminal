# Fyxtez Terminal frontend

React 18 + TypeScript + Vite client for the Fyxtez trading terminal.

Development requires Node.js 20.19+ or 22.12+.

## Browser development

```bash
cp .env.example .env
npm install
npm run dev
```

The local backend normally runs at `http://127.0.0.1:8657`. Set
`VITE_TRADING_API_TOKEN` to the backend's `SERVICE_API_TOKEN`.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `VITE_TRADING_API_URL` | REST/WebSocket backend base URL |
| `VITE_TRADING_LOCAL_API_URL` | Optional local URL retained for explicit local configuration |
| `VITE_TRADING_API_TOKEN` | Shared token used by the current API client |
| `VITE_PUBLIC_TERMINAL_URL` | Public base URL used in alert links |

All `VITE_*` values are embedded in the browser bundle. The API token is only an
interim single-user/private-network mechanism and must be replaced before a
public deployment.

## Commands

```bash
npm run dev      # development server
npm run build    # TypeScript check and production bundle
npm run preview  # serve an existing production bundle
npm run test:run       # run the frontend test suite once
npm run desktop:dev    # managed Axum sidecar + Vite in a Tauri window
npm run desktop:build  # create Linux .deb and AppImage bundles
```

The native source is in `src-tauri/`. Desktop commands do not use frontend or
backend `.env` files: Tauri selects an ephemeral loopback port and per-launch
API capability, starts and supervises the bundled Axum sidecar, and supplies
runtime connection data over IPC. `DesktopSetupGate` stores secrets through
Rust commands in the OS credential manager; browser development continues
directly to the terminal. Review
[`../docs/adr`](../docs/adr/README.md) before changing IPC permissions, CSP or
secret handling. Browser mode is intentionally chart-only and does not send
native ntfy/Telegram notifications.

`src-tauri/app-icon.svg` is the editable application-icon source. Regenerate
platform assets after changing it with `npx tauri icon src-tauri/app-icon.svg`.

The first-run wizard contains separate Binance, ntfy and Telegram steps. All can
be skipped and managed later under Settings → Third-Party Connections. A Binance
connection requires an explicit Mainnet or Testnet selection; Mainnet also
requires confirmation that real funds are involved. Skipping Binance starts
chart-only mode and suppresses private account/order requests.
Notification destinations are read by native Rust from the OS credential store;
they are never compiled into Vite or returned to React.

The drawing canvas implementation lives under
[`src/hooks/useDrawingCanvas`](src/hooks/useDrawingCanvas/README.md). Its public
hook remains available from `src/hooks/useDrawingCanvas.ts`, while rendering,
geometry, pending-order controls, and armed pointer interactions are maintained
as separate modules.

Other high-traffic modules follow the same boundary: market-data preferences
live in `src/hooks/marketDataPersistence.ts`, transient chart editors live next
to `ChartPanel`, and Settings summary cards are separate from settings state and
search orchestration.

Linux x86_64 bundle creation is enabled. Distribution remains gated on signing
and the clean-machine acceptance procedure in
[`../docs/RELEASING.md`](../docs/RELEASING.md).

See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for module and data-flow details.
