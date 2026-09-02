# Fyxtez Terminal frontend

React 18 + TypeScript + Vite client for the Fyxtez trading terminal.

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
| `VITE_NTFY_URL` | Full ntfy publish URL for browser-owned alerts |

All `VITE_*` values are embedded in the browser bundle. The API token is only an
interim single-user/private-network mechanism and must be replaced before a
public deployment.

## Commands

```bash
npm run dev      # development server
npm run build    # TypeScript check and production bundle
npm run preview  # serve an existing production bundle
```

The current production build issue and other release gates must be resolved
before publishing a production build.

See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for module and data-flow details.
