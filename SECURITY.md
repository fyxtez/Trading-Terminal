# Security model

Fyxtez Terminal is currently a self-hosted, single-user development application
that can submit real Binance USD-M Futures orders. It is not ready to expose as
a public web service or distribute as an installable production desktop build.

## Secrets

Binance API keys, the Binance API secret, private ntfy URLs, Telegram bot tokens
and Telegram chat IDs are stored through the Tauri setup UI in the operating
system credential manager under service `com.fyxtez.terminal`. They must not be
placed in `.env`, Vite variables, localStorage, SQLite, command-line arguments or
logs. React receives configuration booleans only; it cannot retrieve secrets.

`SERVICE_API_TOKEN` and `VITE_TRADING_API_TOKEN` are a temporary local
development capability. They must contain the same random value. Because Vite
embeds its value in JavaScript, this is not suitable authentication for an
untrusted or public client.

## Binance key policy

- Create a dedicated key for this application.
- Enable only the Futures permissions the terminal needs.
- Never enable withdrawals.
- Apply a Binance IP restriction when practical.
- Start on testnet. Mainnet additionally requires `BINANCE_TESTNET=false` and
  `ALLOW_MAINNET=true` in the ignored backend environment file.
- Revoke the key immediately if the computer, credential store or repository
  secrets are suspected to be compromised.

## Network boundary

Keep Axum bound to `127.0.0.1`. The supported browser UI is chart-only, but its
frontend checks do not prevent a holder of the shared development token from
calling the local backend directly. CORS accepts only the current localhost and
Tauri WebView origins, but WebSocket and icon requests still carry the
development capability in the query string, and the secret-free credential
reload signal is unauthenticated. These are explicit release blockers, not
public-service controls.

Release bundling remains disabled until Tauri supervises Axum as a sidecar,
selects a loopback port, creates a per-launch capability, distributes it without
compiling it into Vite and terminates the backend on exit.

## Before committing

Run `git status --short --ignored` and verify that `.env`, SQLite/WAL files,
`backend/data/icons`, `backend/data/symbols.json`, `node_modules`, `dist` and
Rust `target` directories are ignored. Commit `.env.example` templates only.

Run the validation commands documented in the root README. Test notification
delivery separately for each configured provider because notification failure
must never be treated as proof that a trading action failed.
