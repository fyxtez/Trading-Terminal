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
credentials and returns only boolean status plus the non-secret network name to
React. Axum reads the same entries directly. After a save, Tauri restarts the
managed sidecar so network endpoints and credentials change as one runtime
generation.

Axum starts without Binance credentials and retains public chart-data support.
Signed account/order methods and the private user stream fail closed until a
complete network/key/secret set exists. A restart refreshes reference data and
account snapshots, and reconnects the private stream.

Persistent alert delivery reads ntfy and Telegram configuration from the
keyring. Local frontend alerts pass only rendered notification content to a
native Tauri command; native Rust performs delivery. Exchange and notification
secrets are not accepted from environment variables.

ADR 0004 completes the sidecar lifecycle and per-launch service-capability part
of this decision. ADR 0006 defines explicit Binance network selection.

## Consequences

- Binance, ntfy and Telegram credentials never enter Vite, browser storage,
  backend environment variables, argv or application logs.
- Both native Rust processes require access to the user's OS credential manager.
- Plain browser development is chart-only and cannot deliver native
  notifications.
- Updating credentials restarts the backend, rebuilds exchange state, and
  reconnects the private stream.
- Desktop restart control remains behind Tauri IPC and the Axum bearer
  boundary.

## Follow-up

Verify credential-manager behavior on every supported operating system during
clean-machine release acceptance.
