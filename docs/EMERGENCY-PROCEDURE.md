# Emergency trading procedure

Use this runbook when the terminal reports uncertain order state, repeated or
duplicate requests, stale account data, reconciliation drift, an unresponsive
sidecar, unexpected positions/orders, or possible API-key exposure. Binance is
the authoritative source of truth. A notification failure by itself is not
proof that a trade failed.

[ADR 0008](adr/0008-authoritative-exchange-reconciliation.md) defines the normal
automatic reconciliation contract. Use this procedure when that process cannot
establish a safe, unambiguous final state.

## 1. Stabilize the situation

1. Stop clicking trading controls. Do not retry an order whose result is
   uncertain until its Binance order/trade history has been checked.
2. Record the current UTC time, application version, selected Binance network,
   affected symbols, and the last action attempted.
3. Open the official Binance Futures web or mobile interface independently of
   Fyxtez Terminal. Do not rely on a stale terminal balance, chart marker, toast,
   or WebSocket status.
4. If the terminal appears to be submitting repeated actions, quit it. This
   stops the managed backend and prevents new requests from this installation,
   but it does **not** cancel orders already resting on Binance or close open
   positions.

The backend does not yet have the planned server-side
`disable-new-entries` risk switch. Until that exists, quitting the application
is the immediate local entry stop; all exchange cleanup must be verified on
Binance.

## 2. Cancel exposure-creating orders

From Binance, inspect **all USD-M Futures symbols**, not only the chart that was
open in Fyxtez:

1. Cancel open entry orders.
2. Inspect and cancel conditional/algo orders that are no longer wanted,
   including stop-market and take-profit orders.
3. Refresh Binance and verify that the open-order count is zero, or that every
   remaining order is deliberately being retained.

Use Fyxtez **Close Everything FULL** only when the backend and exchange are
healthy and its account snapshot can be independently verified. The action
requires the armed confirmation click and may partially succeed; always review
its per-symbol result and confirm the final state on Binance.

## 3. Reconcile and close positions

1. Treat Binance positions and trade history as authoritative. Compare every
   non-zero USD-M Futures position with what Fyxtez displayed.
2. If a position must be closed, use Binance's close-position/reduce-only flow.
   Confirm the symbol, side, quantity, order type, and network before submitting.
   Never use an ordinary order that could reverse the position when a
   reduce-only close is available.
3. Refresh until every intended position has `positionAmt = 0` and no closing
   order remains pending. Check recent fills and realized PNL for partial fills
   or an accidental reversal.
4. Re-check both regular open orders and conditional/algo orders after positions
   are flat.

If the API key may be compromised, revoke it immediately and perform the steps
above through the authenticated Binance interface. Do not wait for the local
application to recover.

## 4. Revoke credentials and preserve evidence

After the account is safe—or immediately when compromise is suspected:

1. Revoke the dedicated Binance API key. If dormant legacy ntfy/Telegram
   credentials still exist in the OS credential store, remove or rotate them
   if they may have been exposed.
2. Preserve screenshots of Binance positions, open orders, order/trade history,
   and the terminal Diagnostics section. Redact API keys, private notification
   URLs, account identifiers, and financial information before sharing.
3. Preserve the exact application version and downloaded artifact checksum.
4. Preserve available Tauri/sidecar console or system-journal output. The local
   operation journal contains redacted request correlation and results, not
   full exchange payloads, so copy relevant runtime output before closing an
   attached development terminal.
5. Make a private copy of the platform application-data directory before
   reinstalling. On Linux this is normally
   `$XDG_DATA_HOME/com.fyxtez.terminal` or
   `~/.local/share/com.fyxtez.terminal`. It contains runtime data such as the
   symbol registry, sizing settings, alerts database, operation journal, and
   icon cache; secrets remain in the OS credential manager.

Never attach the OS keyring database, secret values, full private URLs, or an
unredacted environment dump to an issue.

## 5. Roll back and recover

1. Do not restart trading on the suspect version. The release owner should
   withdraw the affected GitHub release without deleting its tag or audit trail.
2. Verify the checksum/signature of the last known-good artifact and reinstall
   that version. Preserve application data and keyring entries until the
   incident has been investigated.
3. Start chart-only first. Confirm backend health, exchange connectivity,
   user-stream freshness, and zero reconciliation drift in Diagnostics.
4. Create a new restricted Binance key: Futures trading only, no withdrawals,
   and an IP restriction where practical. Never reuse the revoked key.
5. Validate the repaired version on Testnet. Return to Mainnet only after the
   root cause is understood, relevant tests pass, and Binance again shows the
   expected orders and positions.

Record the incident timeline, affected versions, Binance order IDs, observed
diagnostic counters, corrective change, and verification evidence. Secrets must
remain redacted from the incident record.
