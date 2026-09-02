# Fyxtez Terminal frontend

React 18 + TypeScript + Vite client for the Fyxtez trading terminal.

Development requires Node.js 20.19+ or 22.12+.

## Setup

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
npm run desktop:dev    # backend + Vite in a Tauri development window
npm run desktop:build  # compile the shell; release bundle is not enabled yet
```

The native source is in `src-tauri/`. `DesktopSetupGate` runs only inside Tauri
and stores secrets through Rust commands in the OS credential manager; browser
development continues directly to the terminal. Review
[`../docs/adr`](../docs/adr/README.md) before changing IPC permissions, CSP or
secret handling. Browser mode is intentionally chart-only and does not send
native ntfy/Telegram notifications.

The first-run wizard contains separate Binance, ntfy and Telegram steps. All can
be skipped and managed later under Settings → Desktop connections. Skipping
Binance starts chart-only mode and suppresses private account/order requests.
Notification destinations are read by native Rust from the OS credential store;
they are never compiled into Vite or returned to React.

The production bundle remains intentionally disabled until the Axum sidecar,
per-launch endpoint/token and release signing flow are implemented.

See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for module and data-flow details.
