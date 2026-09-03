# ADR 0008: Reconcile trading state from Binance

- Status: Accepted
- Date: 2026-09-03

## Context

A successful HTTP response is not the only way an exchange action can complete.
Binance may accept an order even when the response is lost to a timeout, process
exit, or local network failure. User-data WebSocket events may also be delayed,
duplicated, reordered, or missed during a disconnect. Finally, workflows such as
replace-order and close-everything contain several independent Binance requests;
they cannot be made transactional by a local mutex.

The frontend and backend therefore cannot infer exchange state from a request
result, a WebSocket connection indicator, or an optimistic UI update alone.

## Decision

### Authority order

Trading state has the following authority, from highest to lowest:

1. Current Binance REST account, position-risk, open-order, order and trade
   history responses.
2. Binance user-data WebSocket events, used for low-latency updates and as a
   signal to fetch new snapshots.
3. Replaceable backend account and position-risk caches.
4. Frontend query state, chart annotations, pending controls and optimistic UI.

A lower layer must never overwrite a newer authoritative snapshot merely
because it received an older event later. UI state is a projection, not a
ledger. Binance remains authoritative even when the local result is surprising
or undesirable.

### Request outcomes and timeouts

Before Binance acknowledges a mutation, the UI treats it as pending. A normal
success may be reflected immediately for responsiveness, but the resulting
orders, balance and positions are still reconciled from Binance.

A timeout, connection loss, sidecar exit, malformed response, or HTTP 5xx after
a state-changing request produces an **unknown outcome**, not a failed trade.
For an unknown outcome:

1. Do not automatically repeat the mutation.
2. Fetch fresh account, position-risk and open-order snapshots.
3. Query the specific order by exchange order ID or client order ID when one is
   available, and inspect recent trade history when the snapshots are
   insufficient.
4. Replace local projections with the returned Binance state.
5. If the outcome still cannot be proven, keep it visibly uncertain/degraded
   and require the operator to verify it in Binance before retrying.

Durable client intent IDs and server-side response replay now protect financial
mutations as defined in [ADR 0009](0009-durable-financial-intents.md).
An intent left in progress by a crash still has an unknown exchange outcome: it
fails closed and requires authoritative reconciliation rather than blind replay.

### Process crash and restart

The desktop supervisor may restart a crashed sidecar only within its bounded
restart policy. It does not replay in-memory trading commands. Resting orders,
fills and positions survive on Binance regardless of the local process.

On every configured backend start, authoritative account and position-risk
snapshots must load before the API becomes ready. When the user-data stream
connects or reconnects, the backend requests another account and position-risk
refresh and tells the frontend to reload account/order projections. Ephemeral
pending UI state from the previous process is not evidence that an operation did
or did not execute.

If those authoritative prerequisites cannot be established, the application
must remain loading, degraded, or unavailable for private trading. It must not
restore a guessed pre-crash state from frontend storage.

### WebSocket gaps

The private user-data stream is an acceleration channel, not the source of
record. After disconnect it reconnects with bounded delay. Every connection or
reconnection requests fresh snapshots. If the backend-to-frontend broadcast
receiver reports lag, it sends `SNAPSHOT_REQUIRED`; React then reloads the
affected account and order resources.

Order and position hooks also poll every four seconds as a self-healing backstop,
and position-risk has a slower backend safety refresh. A REST snapshot replaces
the corresponding derived cache even when it disagrees with WebSocket-derived
or optimistic state. A green WebSocket indicator alone never proves that local
state is current.

### Partially successful multi-step actions

`TradeLock` prevents two local account-mutating workflows from interleaving. It
does not provide a Binance transaction or roll back already accepted exchange
requests.

Each multi-step workflow must therefore:

- preserve and return the outcome of each attempted exchange step;
- stop making unsafe dependent requests after a prerequisite fails;
- treat any rollback/compensation request as best effort and verify its result;
- request fresh account, position-risk and order snapshots after success,
  failure, or uncertainty; and
- drive subsequent controls from the reconciled exchange state, not from the
  intended final state.

In particular:

- If an old order is canceled but its replacement fails, the old order remains
  canceled unless a compensating order is independently accepted and verified.
- If an entry fills but a protective order fails, the position exists without
  the intended protection and must be surfaced for immediate operator action.
- Close-everything takes a fresh starting snapshot, but each cancellation and
  reduce-only close can succeed or fail independently. Its per-item result is
  not proof of the final account state; all positions and both regular and algo
  orders must be fetched again.

The emergency procedure applies whenever automatic reconciliation cannot
establish a safe, unambiguous final state.

### Diagnostics and logging

Diagnostics expose exchange connectivity, user-stream freshness,
reconciliation success/failure and detected drift. Logs may include redacted
request context and non-secret exchange/client order IDs needed to correlate an
uncertain action, but must never include API secrets, service capabilities, or
private notification URLs.

## Consequences

- The application favors duplicate-exposure prevention over transparent retry.
- Temporary disagreement may be visible while a fresh snapshot is loading.
- WebSocket events improve latency without becoming a second source of truth.
- A locally serialized workflow may still need manual recovery after partial
  exchange success.
- An error shown by the terminal does not by itself mean that no trade occurred.

## Follow-up

- Add automated Testnet drills for lost responses, process exits, stream gaps,
  partial fills and partial multi-step success.
- Add an operator workflow for resolving durable intents whose outcome remains
  uncertain after a crash.
