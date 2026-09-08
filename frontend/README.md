# Fyxtez Terminal frontend

React 18 + TypeScript + Vite client for the Fyxtez trading terminal.

User-facing application text uses **Terminal**, and the toolbar and settings
panel both use **Settings**. Existing internal identifiers, storage keys and
backup extensions retain their names for compatibility.

Development requires Node.js 20.19+ or 22.12+.

Adding a symbol checks Binance Futures, then MEXC Futures. The menu shows a
loading indicator until registration and the registry refresh finish. Spot-only
pairs cannot currently be added, even if they exist on an exchange's spot market.

For desktop development, run `./run.sh` from the repository root. It installs
missing frontend dependencies before launching the app.

## Standalone browser development

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

All `VITE_*` values are embedded in the browser bundle. This token-based workflow
is local development only and remains chart-only. It is not the installed
Linux app's authenticated Browser access mode.

## Commands

```bash
npm run dev      # development server
npm run build    # TypeScript check and production bundle
npm run preview  # serve an existing production bundle
npm run test:run       # run the frontend test suite once
npm run desktop:dev    # managed Axum sidecar + Vite in a Tauri window
npm run desktop:build  # create Linux .deb and AppImage bundles
npm run android:dev    # run against an authorized Android device
npm run android:build:device # build an arm64 Android debug APK
```

The native source is in `src-tauri/`. Desktop commands do not use frontend or
backend `.env` files: Tauri selects an ephemeral loopback port and per-launch
API capability, starts and supervises the bundled Axum sidecar, and supplies
runtime connection data over IPC. `DesktopSetupGate` stores secrets through
Rust commands in the OS credential manager. On Linux, Browser access serves a
second copy of the packaged frontend at `127.0.0.1:8658`; a one-use launch
ticket becomes a split browser session: an `HttpOnly` cookie and a second proof
kept only in that tab's `sessionStorage`. Opening from Terminal again adds another
tab proof without disconnecting earlier tabs in that browser profile. The native
capability and Binance keys remain outside browser JavaScript and storage. The
two frontends share authoritative backend/trading state but keep separate
origin-scoped drawings, tabs and UI preferences. Review
[`../docs/adr`](../docs/adr/README.md) before changing IPC permissions, CSP or
secret handling. Standalone Vite browser mode is intentionally chart-only and
does not send native ntfy/Telegram notifications.

On Android, the same `backend/` crate is linked into the Tauri process and
served on a per-launch loopback port. The Android app therefore needs neither a
separate sidecar nor developer tooling on the device. From the repository root,
`./run.sh android` builds, installs, and launches the arm64 debug APK on one
authorized ADB device. Android remains a development target; continuous
background execution is not yet guaranteed.

`src-tauri/app-icon.svg` is the editable application-icon source. Regenerate
platform assets after changing it with `npx tauri icon src-tauri/app-icon.svg`.

The first-run wizard offers one optional Binance connection, which can be
managed later under Settings → Exchange Connections. A Binance connection
requires an explicit Live or Practice selection; Live also requires confirmation
that real funds are involved. Skipping Binance starts chart-only mode and
suppresses private account/order requests. The dormant ntfy/Telegram code is not
exposed by the product UI.

The drawing canvas implementation lives under
[`src/hooks/useDrawingCanvas`](src/hooks/useDrawingCanvas/README.md). Its public
hook remains available from `src/hooks/useDrawingCanvas.ts`, while rendering,
geometry, pending-order controls, and armed pointer interactions are maintained
as separate modules.

Other high-traffic modules follow the same boundary: market-data preferences
live in `src/hooks/marketDataPersistence.ts`, transient chart editors live next
to `ChartPanel`, and Settings summary cards are separate from settings state and
search orchestration.

Coordinate-mapping callbacks retain their identity across React renders and
read current chart data through refs, avoiding overlay subscription restarts.
Pen hit testing converts each point once per scan, and the canvas updates pane
inset CSS only when it changes. Session calculations reuse timezone formatters
while resolving offsets for each date, including daylight-saving changes.

Linux x86_64 bundle creation is enabled. Distribution remains gated on signing
and the clean-machine acceptance procedure in
[`../docs/RELEASING.md`](../docs/RELEASING.md).

See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for module and data-flow details.
