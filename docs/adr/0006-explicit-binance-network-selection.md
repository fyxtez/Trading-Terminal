# ADR 0006: Require explicit Binance network selection

- Status: Accepted
- Date: 2026-09-02

## Context

A Binance API key alone does not tell the application whether it belongs to the
USD-M Futures Testnet or Mainnet. Guessing the network, silently defaulting to
Mainnet, or reusing a prior `.env` switch can show misleading connection state
and can direct an intended test action toward real funds.

## Decision

The desktop connection form requires the user to select either `testnet` or
`mainnet`; neither is preselected on a clean install. Selecting Mainnet also
requires a separate acknowledgement that the connection uses real funds.

Tauri stores the non-secret network value beside the key and secret in the OS
credential manager. A Binance connection is considered complete only when all
three values exist. Existing key/secret entries without a network remain
inactive. Saving a connection restarts the Axum sidecar so its REST and
WebSocket endpoints are derived from one immutable network choice.

Standalone browser/backend development retains its guarded `.env` switches,
but those variables are ignored by the desktop sidecar.

## Consequences

- Clean installs and legacy partial credentials fail closed into chart-only
  mode.
- Mainnet cannot be enabled by an implicit default.
- Switching networks requires entering the matching key and secret again.
- The UI may display the selected network, but never secret material.

## Follow-up

Add end-to-end release acceptance for Testnet connection, Mainnet confirmation,
network switching, and partial/locked credential-store failures.

## Implementation status update (2026-09-04)

Network selection and explicit Mainnet confirmation are implemented. ADR 0011
adds a native pre-storage permission gate that rejects Mainnet keys with
withdrawals enabled or without reading/Futures access. Locked/corrupt
credential-store acceptance remains pending.
