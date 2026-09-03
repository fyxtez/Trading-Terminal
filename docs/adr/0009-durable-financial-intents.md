# ADR 0009: Require durable financial intents

- Status: Accepted
- Date: 2026-09-03

## Context

A UI double click, lost HTTP response, frontend retry or backend restart can
otherwise submit the same financial mutation more than once. The exchange
remains the source of truth, but duplicate prevention must also exist at the
local API boundary.

## Decision

Every account-mutating order, position, leverage and sizing request carries a
UUID in `x-fyxtez-intent-id`. Before dispatch, Axum records the intent and a
SHA-256 fingerprint of its method, route and body in `operations.sqlite3`.

- A completed identical request replays the recorded HTTP result.
- Reusing an ID for different content is rejected.
- An in-progress intent after a crash or uncertain result is rejected until the
  operator reconciles Binance state and creates a new explicit intent.
- The frontend coalesces concurrent identical actions and keeps the same intent
  across transport retries.
- The journal stores no request body, credentials, signatures or notification
  destinations. A second table records bounded audit metadata: time, intent,
  method, route, outcome and status.

Exposure-increasing workflows execute under `TradeLock`, require a registered
Binance execution symbol and fail closed unless fresh exchange filters, price,
account and position-risk data are available. Isolated margin and Binance's
exchange filters are enforced before submission. The application does not add
custom per-order, total-exposure or daily-loss monetary limits.

## Consequences

- An automatic retry cannot silently create duplicate exposure.
- An ambiguous crash favors a visible conflict and manual reconciliation over
  guessing whether the exchange accepted the operation.
- Entry workflows add exchange round trips and can block trading during
  provider degradation.
- The local journal is safety metadata and must be backed up with other app
  data, but it is not an exchange ledger.

## Follow-up

- Exercise lost-response, crash, partial-fill and replacement scenarios against
  Binance Futures Testnet.
- Add a deliberate operator flow for resolving old uncertain intents after
  authoritative reconciliation.
