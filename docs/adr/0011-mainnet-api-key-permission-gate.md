# ADR 0011: Reject unsafe Binance Mainnet API-key permissions

- Status: Accepted
- Date: 2026-09-04

## Context

The terminal needs Binance Futures read/trade access, but never needs permission
to withdraw funds. A warning in onboarding is insufficient: a user can paste a
more privileged key by mistake, and merely storing that key increases the
impact of a local credential compromise.

Testnet keys cannot withdraw real funds. Mainnet keys expose their current
permissions through Binance's signed
[`GET /sapi/v1/account/apiRestrictions`](https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/account#get-api-key-permission)
endpoint.

## Decision

Before storing a newly supplied Mainnet key and secret, the native Tauri layer:

1. obtains Binance server time;
2. signs and calls the API-key-permission endpoint with the candidate secret;
3. requires account reading and Futures access; and
4. requires `enableWithdrawals=false`.

The validation request uses a redirect-disabled native HTTP client and never
passes the secret to the WebView, backend URL, logs, or local files. Failure to
reach Binance, authenticate, or parse the permission response fails closed:
nothing from the candidate Binance pair is written to the credential store.
The UI asks for a new restricted Futures key when withdrawals are enabled.

## Consequences

- Withdrawal-enabled Mainnet credentials cannot be newly connected.
- Invalid, wrong-network, IP-blocked, or insufficiently privileged keys fail at
  setup time instead of leaving a misleading connected state.
- Mainnet credential setup requires temporary access to both
  `api.binance.com` and Binance Futures.
- IP allowlisting remains an operator responsibility because requiring it in
  code would make the app unusable on legitimate dynamic-IP connections.
- Existing keys stored by a pre-gate build are checked the next time they are
  replaced; release acceptance must replace or re-save them before Mainnet use.

## Follow-up

- Exercise the rejection message with a deliberately withdrawal-enabled test
  key that holds no funds, then revoke that key immediately.
- Keep the permission response schema and endpoint under dependency/API review.
