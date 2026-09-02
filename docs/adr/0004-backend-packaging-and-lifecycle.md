# ADR 0004: Package and supervise the backend as a sidecar

- Status: Proposed
- Date: 2026-09-02

## Context

The frontend currently requires Axum on port 8657. During development, `frontend/scripts/desktop-dev-server.sh` starts that service before Vite. An installed desktop application cannot require Cargo, source code or a manually maintained `.env` file.

## Proposed decision

Build `binance-futures-axum` for every desktop target and include it as a Tauri
sidecar. Tauri owns its lifecycle: acquire a single-instance lock, select a
loopback port and one-time service token, start the backend without secrets in
argv, wait for authenticated readiness, provide the endpoint to the WebView,
and terminate the child on app exit. As accepted in ADR 0005, both Rust
processes read exchange and notification secrets from the same OS credential
store; Tauri does not hand those secrets to Axum.

The production server binds only to loopback. Its service token is generated per launch and is never a `VITE_*` build variable.

## Consequences

- Release creation must build a sidecar for each target triple.
- Crash handling and restart limits become native-shell responsibilities.
- Port discovery replaces the fixed production port.

## Follow-up

Choose a protected mechanism (for example an inherited pipe or local bootstrap
socket) for the per-launch endpoint and service capability. Threat-model local
process inspection and origin confusion before implementation. This ADR must
become Accepted before `bundle.active` is enabled.
