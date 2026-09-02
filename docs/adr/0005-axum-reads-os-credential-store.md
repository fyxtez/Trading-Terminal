# ADR 0005: Let Axum read the operating-system credential store

- Status: Accepted
- Date: 2026-09-02

## Context

ADR 0003 placed Binance, ntfy and Telegram secrets in the operating-system
credential manager through Tauri. Axum still read equivalent values from
`backend/.env`, so the secure onboarding configuration did not control the
actual exchange and notification clients. Passing secrets through the WebView,
HTTP, argv or a plaintext file would recreate the exposure the desktop move is
intended to remove.

## Decision

Tauri and Axum use the same keyring service, `com.fyxtez.terminal`. Tauri writes
credentials and returns only boolean status to React. Axum reads the same entries
directly. After a save, Tauri sends Axum a reload signal that contains no secret
values.

Axum starts without Binance credentials and retains public chart-data support.
Signed account/order methods and the private user stream fail closed until a
complete key/secret pair exists. A credential reload refreshes reference data
and account snapshots, and causes the private stream to reconnect.

Persistent alert delivery reads ntfy and Telegram configuration from the
keyring. Local frontend alerts pass only rendered notification content to a
native Tauri command; native Rust performs delivery. Exchange and notification
secrets are not accepted from environment variables.

This decision supersedes only the credential-handoff part of ADR 0004. Its
sidecar lifecycle and per-launch service-capability proposal remain open.

## Consequences

- Binance, ntfy and Telegram credentials never enter Vite, browser storage,
  backend environment variables, argv or application logs.
- Both native Rust processes require access to the user's OS credential manager.
- Plain browser development is chart-only and cannot deliver native
  notifications.
- Updating credentials while the backend is running requires a credential
  reload and private-stream reconnection.
- The current secret-free reload signal is loopback-only but unauthenticated;
  sidecar bootstrap must replace it with the per-launch capability.

## Follow-up

Package and supervise Axum as a Tauri sidecar. Replace the static development
service token and fixed port with per-launch values before enabling release
bundles.
