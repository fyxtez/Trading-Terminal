# ADR 0004: Package and supervise the backend as a sidecar

- Status: Accepted
- Date: 2026-09-02

## Context

Standalone browser development uses Axum on a configured port, historically
8657. An installed desktop application cannot require Cargo, source code, a
fixed port, or a manually maintained `.env` file.

## Decision

Build `fyxtez-backend` for every desktop target and include it as a Tauri
sidecar. Tauri owns its lifecycle: enforce a single application instance,
select an ephemeral loopback port, generate a 256-bit per-launch capability,
start the backend, wait for readiness, provide the endpoint to the WebView over
IPC, and terminate the child on app exit. As accepted in ADR 0005, both Rust
processes read exchange and notification secrets from the same OS credential
store; Tauri does not hand those secrets to Axum.

The sidecar also monitors the bootstrap stdin pipe. If the Tauri parent crashes
or is force-terminated before its normal exit callback runs, the operating
system closes that pipe and `fyxtez-backend` terminates itself instead of
leaving a credential-bearing loopback API orphaned.

The bootstrap is bounded JSON written to the child's stdin. It contains only the
port, capability and Tauri application-data directory. It is not passed through
`VITE_*`, argv, a URL, or a file. The production server always binds to
`127.0.0.1`. WebSockets use short-lived, one-use tickets so the bearer
capability does not appear in a URL.

Unexpected sidecar termination triggers at most three automatic restarts with
backoff. After that, the application exposes a failed state and requires an
explicit retry. A second app launch focuses the existing window.

## Consequences

- Release creation must build a sidecar for each target triple.
- Crash handling, restart limits, and process shutdown are native-shell
  responsibilities.
- Port discovery replaces the fixed production port.
- Desktop data moves from repository-relative paths to the platform
  application-data directory.

## Follow-up

Complete signed Linux release ownership and a clean-machine install test. Treat
any future capability transport, multi-window support, or remote API exposure as
a new security decision.

## Implementation status update (2026-09-04)

Signed release ownership and protected Linux/Android CI are complete. The
downloaded Debian package installs and survives remove/reinstall without
changing application data on the development machine; acceptance on a separate
clean Linux system remains pending.
