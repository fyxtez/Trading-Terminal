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
- An intent left in progress across a backend restart is never aged out or
  replayed. While one exists, every new entry, ADD, non-reduce order amendment
  and limit-to-market chase fails closed even when the client supplies a fresh
  UUID. Cancel, Stop Loss, Reduce, Close Position and Close Everything remain
  available so the gate cannot trap exposure.
- Settings > Diagnostics lists only redacted intents inherited from the previous
  process. Resolution requires the operator to inspect Binance Positions, Open
  Orders and Order History and type `I VERIFIED BINANCE`. The backend then
  refreshes account, position-risk and all regular open-order snapshots under
  `TradeLock`; it never repeats the mutation.
- A resolved intent becomes a stored HTTP 409 tombstone rather than being
  deleted, and the frontend discards its retry token. Reuse therefore cannot
  execute the old action, while the next deliberate action gets a new UUID.
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
- Recovery cannot clear an intent created by the current process, so an active
  request cannot be mistaken for an orphaned crash record.
- Entry workflows add exchange round trips and can block trading during
  provider degradation.
- The local journal is safety metadata and must be backed up with other app
  data, but it is not an exchange ledger.

## Ongoing verification

- Keep lost-response, restart, global entry-gate, resolution tombstone,
  partial-fill and replacement scenarios in automated regression coverage and
  the hard-gated Binance Futures Testnet drill.
