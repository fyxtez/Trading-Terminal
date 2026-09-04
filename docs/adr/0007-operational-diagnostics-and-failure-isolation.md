# ADR 0007: Isolate secondary failures and expose operational diagnostics

- Status: Accepted
- Date: 2026-09-03

## Context

The desktop process, local API, public market feed, Binance REST API, Binance
user-data stream, reconciliation workers and optional notification providers
can fail independently. A green backend health check does not prove that the
exchange or private stream is healthy. Notification delivery is secondary to
the alert or trade action that caused it and must not rewrite an already-known
successful result as a failed trade.

## Decision

Keep `/health` as the narrow sidecar liveness probe and expose a separate,
authenticated `/api/diagnostics` snapshot. It contains only statuses,
timestamps and bounded counters for exchange connectivity, user-stream
freshness, cache reconciliation drift, rejected/duplicate mutation requests
and notification failures. It never contains credentials, request bodies,
private notification URLs or exchange signatures.

React combines that snapshot with its own sidecar/backend and live market-data
states in Settings → Diagnostics. Market history/load failure and live-poll
failure produce an explicit degraded chart state with a retry action. An
application-level React error boundary fails closed by replacing trading UI
with a reload-only recovery screen.

Notification delivery remains best-effort. Native or backend delivery failures
produce a visible warning and a diagnostic counter, while the triggering alert
or already-completed exchange action keeps its authoritative result.

## Consequences

- Operators can distinguish backend, exchange, stream and market-feed failures.
- Diagnostic counters reset when the backend process restarts; they are not an
  audit log.
- A reconciliation difference is reported as repaired drift, not silently
  ignored.
- Duplicate counts include conflicts detected by the durable financial-intent
  journal described in ADR 0009.
- React error boundaries do not catch errors in asynchronous callbacks; those
  paths must continue to expose their own explicit error state.

## Follow-up

Exercise diagnostics and durable audit correlation during the Testnet
lost-response and sidecar-crash drills without placing secrets or full payloads
in logs.

## Implementation status update (2026-09-04)

ADR 0013 makes external notification delivery dormant. Its retained diagnostic
counter remains part of the backend schema for compatibility, but the Settings
UI does not show a notification-delivery row and no alert provider can update
the counter in the current runtime.
