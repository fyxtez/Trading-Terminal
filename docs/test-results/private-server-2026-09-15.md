# Private backend deployment verification — 2026-09-15

## Deployment

- Linux app package: `fyxtez-terminal` 1.0.36, amd64.
- Package SHA256: `f4c6462295aa2c7a38d328b266c09c4607d1502e62a298849eb876562274b4fe`.
- Server: `46.101.107.226`, Ubuntu 24.04, x86_64.
- HTTPS/WSS: `terminal.fyxtez.com`; backend bound to `127.0.0.1:8657`.
- Service: `fyxtez-terminal.service`, unprivileged `fyxtez-terminal` user,
  enabled at boot and restarted on failure.
- Backend SHA256: `ab53f3b66a8471d23501a172d311b9dd885721c24d0482b8e259d0a872da9320`.

## Verified

- Frontend: all 210 tests in 57 files passed, lint, formatting and production
  build passed. After extending workspace scoping to the remaining storage keys,
  lint/format and the seven relevant connection/intent/drawing tests passed again.
- Backend: 85 tests passed; native shell: 38 tests passed. Rust formatting and
  Clippy with warnings denied passed for both crates.
- Native production package built successfully. The installed executable hash
  matches the executable extracted from that package; source version metadata
  was restored to the repository baseline after packaging.
- A signed read-only Binance permission check from the server returned reading
  and Futures access enabled, withdrawals disabled and IP restriction enabled.
  Keys were provisioned only after explicit approval and this check.
- The journal, symbols, sizing and shared drawing files were migrated with
  separate explicit approval. Local originals were retained. SQLite integrity
  was `ok`, the previously empty server journal had no financial intents, and
  the migrated backend reported zero unresolved intents.
- HTTPS session, account, open orders and candles returned HTTP 200.
  Unauthenticated session/account requests returned 401. A remote principal
  was denied the desktop credentials-control route with 401.
- A ticket-authenticated trading WebSocket returned 101 with a valid TLS
  certificate and verified WebSocket accept header.
- The installed app was restarted. Its WebView requests for account, open orders,
  candles, exchange information, diagnostics and chart documents returned 200
  on the remote server. No local `fyxtez-backend` process remained.

Verification used read-only exchange requests and application session requests.
No Mainnet order was submitted as a test. Android packaging/device behavior and
the remaining architecture work are listed in [deployment scope](../../deploy/README.md).
