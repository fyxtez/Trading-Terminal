# Security model

Fyxtez Terminal is a self-hosted, single-user desktop application that can
submit real Binance USD-M Futures orders. Its Axum API is a local implementation
detail, not a public or multi-user service.

## Secrets

Binance API keys and the Binance API secret are stored through the Tauri setup
UI in the operating system credential manager under service
`com.fyxtez.terminal`. They must not be
placed in `.env`, Vite variables, localStorage, SQLite, command-line arguments or
logs. Secret text necessarily exists transiently in the WebView while the user
types it and while the save IPC call is in progress; clear fields immediately
afterward. Once stored, React receives only configuration booleans plus the
non-secret Binance network and cannot retrieve a saved secret.

Legacy ntfy and Telegram validation/storage code remains in the repository, and
older installations may still have those credentials in the platform manager.
ADR 0013 makes those integrations dormant: the UI does not expose them, the
native delivery command is not registered, and the backend does not read or use
them. Existing entries are deliberately not deleted automatically.

Installed desktop builds generate a 256-bit capability and choose an ephemeral
loopback port for every application launch. Tauri sends both to Axum over child
stdin and gives the runtime connection to the WebView over IPC. They are never
compiled into Vite, added to argv, written to a file, or placed in a logged URL.
The browser-development `SERVICE_API_TOKEN`/`VITE_TRADING_API_TOKEN` pair remains
a separate, local-only mechanism. The desktop pre-build explicitly clears
`VITE_TRADING_*` values so an ignored developer `.env` cannot contaminate a
release bundle.

Opt-in Linux Browser access does not reuse that native capability. Tauri asks
Axum for a short-lived one-use launch ticket and opens it only in a loopback URL
fragment. URL fragments are never transmitted in HTTP requests; the browser
removes it before its first API request and exchanges it for a split session:
an opaque, revocable `HttpOnly`,
`SameSite=Strict` cookie plus an independent proof kept only in that tab's
`sessionStorage`. Reopening from Fyxtez in the same browser profile keeps the
shared cookie and adds a new proof without invalidating earlier authorized tabs;
a different browser profile receives an independent cookie. Every authenticated
browser request requires a matching pair, so a different localhost port cannot
use a cookie it happens to receive. Browser JavaScript and storage never receive
the native sidecar capability or saved Binance credentials.
Session status exposes only whether Binance is configured and the non-secret
Live/Practice network selection. Credential entry, replacement and removal stay
inside the native UI.

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

Installed desktop and embedded mobile Axum listeners bind only to loopback.
Standalone development must also keep `SERVER_HOST` on `127.0.0.1`. The private
native listener uses the per-launch bearer capability. The optional companion listener uses the fixed local origin
`http://127.0.0.1:8658` and remains unusable for trading until Browser access is
explicitly enabled and a launch ticket is redeemed. Browser sessions may use
normal trading routes but cannot administer Browser access or trigger native
credential reload. Disable, backend restart and application exit revoke all
browser capabilities. WebSocket access uses a separate short-lived, one-use
ticket obtained through an authenticated POST.

CORS accepts only known development and Tauri WebView origins. Companion requests
always enforce the exact loopback Host and matching tab proof; mutations and
WebSockets also require the exact Origin, while safe GETs reject any mismatched
Origin when one is supplied. The served UI sets a restrictive content security
policy and framing/referrer protections. `/health` reveals only service/network status and is intentionally
unauthenticated; the packaged static UI is also public but contains no authority
by itself. Do not
port-forward either listener or expose it through a reverse proxy.

Native input, Axum body and request-duration limits are explicit. Outbound
credentials-bearing HTTP clients reject redirects, provider calls have bounded
timeouts, and diagnostics remove URL paths/query/userinfo that may contain
tokens or signatures. The reviewed destination matrix is in
[docs/OUTBOUND-CONNECTIONS.md](docs/OUTBOUND-CONNECTIONS.md).

Financial mutations require a durable intent UUID. Axum persists request
fingerprints and replayable results in the local operation journal; conflicting
or uncertain reuse fails closed. Before new exposure, the backend refreshes
authoritative exchange prerequisites and enforces the registered execution
symbol, isolated margin and Binance exchange filters.

New Mainnet Binance credentials are verified before storage through Binance's
signed API-key-permission endpoint. The native layer requires reading and
Futures access and rejects any key with withdrawals enabled. See
[ADR 0011](docs/adr/0011-mainnet-api-key-permission-gate.md).

Tauri owns the sidecar lifecycle and limits automatic crash recovery to three
attempts. A second desktop launch focuses the existing window instead of
starting a competing backend/keyring owner. These controls protect the desktop
boundary; they do not make the backend safe to expose on a LAN or the Internet.
While Browser access is enabled and a system tray is available, closing the
Linux window hides it instead of terminating the process. The tray provides an
explicit Quit action; disabling Browser access restores the ordinary close
behavior and revokes existing browser sessions. If tray creation fails, close
remains a real exit so the process cannot become invisible. This background
lifecycle does not enable dormant alerts.

## Release boundary

Linux and Android release artifacts are built, signature-checked, checksummed,
and attested by the protected release workflow. They must stay draft/prerelease
until the documented clean-machine installation check succeeds. There is no
updater in v1. The Android upload identity and CI signing credentials live
outside Git and build outputs. See [docs/RELEASING.md](docs/RELEASING.md).

## Before committing

Run `git status --short --ignored` and verify that `.env`, SQLite/WAL files,
`backend/data/icons`, `backend/data/symbols.json`, `backend/data/sizing.json`,
`node_modules`, `dist` and Rust `target` directories are ignored. Commit
`.env.example` templates only.

Use the native allowlisted export under **Settings > Local data backup**, or the
documented complete closed-app fallback, according to
[docs/LOCAL-DATA-BACKUP.md](docs/LOCAL-DATA-BACKUP.md). The portable archive is
integrity checked but not encrypted. Do not include exported credential-manager
data or plaintext secrets.

Run the validation commands documented in the root README. Price alerts and
external notification providers are not part of current release acceptance.

For unexpected orders, uncertain request results, stale account state, or a
suspected credential compromise, follow the
[emergency trading procedure](docs/EMERGENCY-PROCEDURE.md). Binance is the
authoritative state during recovery.
