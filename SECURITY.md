# Security model

Fyxtez Terminal is a self-hosted, single-user desktop application that can
submit real Binance USD-M Futures orders. Its Axum API is a local implementation
detail, not a public or multi-user service.

## Secrets

Binance API keys, the Binance API secret, private ntfy URLs, Telegram bot tokens
and Telegram chat IDs are stored through the Tauri setup UI in the operating
system credential manager under service `com.fyxtez.terminal`. They must not be
placed in `.env`, Vite variables, localStorage, SQLite, command-line arguments or
logs. Secret text necessarily exists transiently in the WebView while the user
types it and while the save IPC call is in progress; clear fields immediately
afterward. Once stored, React receives only configuration booleans plus the
non-secret Binance network and cannot retrieve a saved secret.

Installed desktop builds generate a 256-bit capability and choose an ephemeral
loopback port for every application launch. Tauri sends both to Axum over child
stdin and gives the runtime connection to the WebView over IPC. They are never
compiled into Vite, added to argv, written to a file, or placed in a logged URL.
The browser-development `SERVICE_API_TOKEN`/`VITE_TRADING_API_TOKEN` pair remains
a separate, local-only mechanism. The desktop pre-build explicitly clears
`VITE_TRADING_*` values so an ignored developer `.env` cannot contaminate a
release bundle.

## Binance key policy

- Create a dedicated key for this application.
- Enable only the Futures permissions the terminal needs.
- Never enable withdrawals.
- Apply a Binance IP restriction when practical.
- Start on Testnet. Desktop onboarding has no preselected network and requires a
  separate confirmation before storing a Mainnet selection.
- Treat Testnet and Mainnet keys as separate credentials and verify the selected
  network before saving.
- Revoke the key immediately if the computer, credential store or repository
  secrets are suspected to be compromised.

## Network boundary

Axum binds to `127.0.0.1`. Almost every route requires the per-launch bearer
capability. WebSocket access uses a 30-second, one-use ticket obtained through an
authenticated POST; protected icon data is fetched with the bearer header.
CORS accepts only the development and Tauri WebView origins. The local health
route reveals only service/network status and is intentionally unauthenticated.

Tauri owns the sidecar lifecycle and limits automatic crash recovery to three
attempts. A second desktop launch focuses the existing window instead of
starting a competing backend/keyring owner. These controls protect the desktop
boundary; they do not make the backend safe to expose on a LAN or the Internet.

## Release boundary

Linux bundles are buildable but must stay draft/prerelease until the documented
clean-machine installation check succeeds and release signing is configured.
There is no updater in v1. Signing keys and CI signing credentials must live in
the release owner's hardware/secret store, never in Git, build caches, logs, or
unsigned artifacts. See [docs/RELEASING.md](docs/RELEASING.md).

## Before committing

Run `git status --short --ignored` and verify that `.env`, SQLite/WAL files,
`backend/data/icons`, `backend/data/symbols.json`, `node_modules`, `dist` and
Rust `target` directories are ignored. Commit `.env.example` templates only.

Run the validation commands documented in the root README. Test notification
delivery separately for each configured provider because notification failure
must never be treated as proof that a trading action failed.

For unexpected orders, uncertain request results, stale account state, or a
suspected credential compromise, follow the
[emergency trading procedure](docs/EMERGENCY-PROCEDURE.md). Binance is the
authoritative state during recovery.
