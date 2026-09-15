# Private server deployment

The native app can select Local or Private server in Settings → Exchange
Connections → Backend connection. Saving verifies the server session, stores its
access token in the OS credential store and restarts the app. The startup failure
screen also exposes connection settings. Remote mode does not launch the desktop
sidecar or Android embedded service, and reconnect never selects Local implicitly.

## Current host

- SSH: `root@46.101.107.226`
- HTTPS/WSS: `terminal.fyxtez.com`
- Service: `fyxtez-terminal.service`, running as `fyxtez-terminal`
- Listener: `127.0.0.1:8657`, behind the existing Nginx HTTPS virtual host
- Binary: `/opt/fyxtez-terminal/current/fyxtez-backend`
- Browser UI: `/opt/fyxtez-terminal/current/browser-ui`
- Persistent state: `/var/lib/fyxtez-terminal`
- Root-owned credentials: `/etc/fyxtez-terminal`, directory mode `0700`, files `0600`

The server's observed Binance egress address is `46.101.107.226`. Keep that public
address assigned to this host and include it in the Binance API key's IP allowlist.
Local trading requires its own permitted outbound IP.

## Installation and updates

1. Run the repository's Rust and frontend validation checks. Build the backend
   using `cargo build --locked --release --manifest-path backend/Cargo.toml` on an
   architecture and libc version compatible with the host (currently x86_64,
   Ubuntu 24.04).
2. Build the frontend with `node frontend/scripts/native-build.mjs frontend`;
   this clears development API credentials from the build environment. Upload
   the executable and `frontend/dist/` (as `browser-ui/`) into a new directory
   below `/opt/fyxtez-terminal/releases`. Keep the previous release for rollback.
3. Create the unprivileged `fyxtez-terminal` system user and install the service
   file in `/etc/systemd/system`. It uses systemd credentials so the backend can
   start without an interactive desktop keyring. The service explicitly permits
   Mainnet; the network in the private Binance credentials file selects the venue.
   systemd's credential mount can use mode `0440` inside its private directory;
   `ExecStartPre` makes a `0600` copy in `/run/fyxtez-terminal` for the backend's
   stricter file-permission check. This volatile directory is excluded from data
   backups and removed with the service runtime.
4. Provision `binance.json` privately with the string fields `binance-api-key`,
   `binance-api-secret` and `binance-network` (`mainnet` or `testnet`). An empty
   object starts an unconfigured service. Verify read/Futures permissions and
   disabled withdrawals before provisioning Mainnet credentials. Generate a
   random 64-character hexadecimal `service-token`. Never include either secret
   file in a repository, bundle, URL, command-line argument or diagnostic output.
5. Stop the old local trading runtime during the initial move. Use SQLite's
   backup API to copy `operations.sqlite3`, and copy `symbols.json`, `sizing.json`
   and shared `chart-documents.json` when present. Do not copy browser sessions
   or the local native service token. Preserve the local files for Local mode.
6. Point `current` at the new release, reload systemd and enable/start the service.
   Preserve the existing Nginx certificate configuration. Proxy `/`, including
   `/api/` and `/health`, to the loopback listener; allow WebSocket upgrades and a suitable
   streaming timeout. Avoid logging WebSocket ticket query values.
7. Check unauthenticated rejection, authenticated `/api/session`, `/api/account`,
   `/api/market-data/binance/klines` and the ticket-based trading WebSocket over
   HTTPS. Read-only verification does not require placing a Mainnet order.
8. Install the updated native app, select the server and verify it has no local
   backend process. A new host needs its HTTPS/WSS origin added to Tauri's CSP
   before packaging; the current build permits `terminal.fyxtez.com`. Hosted
   browser mode also requires the matching frontend trusted origin and server
   browser CSP entry. Arbitrary public sites do not gain browser trading access.

Nginx must forward the Upgrade and Connection headers for the WebSocket route.
See [Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html).

## Recovery and current scope

Stop the service before an offline data-directory backup, or use SQLite's backup
API for the journal. Include `backend-id` and the journal together in private
backups. Restore ownership and permissions, restart and resolve any uncertain
intents against exchange state before resuming trading. Roll back the executable
by restoring the previous `current` symlink; do not discard the journal.

The first deployment uses one owner token. Rotate `/etc/fyxtez-terminal/service-token`
and restart the service to revoke access, then update authorized clients. Per-device
pairing/revocation is follow-up work. Server credentials are administered through
SSH; remote clients cannot call local credential or desktop lifecycle routes.
The owner token can administer the private server's browser sessions.

## Open in Browser

In Private server mode, the installed app's tray menu and Settings → Browser
access open `https://terminal.fyxtez.com`. A one-use, 60-second ticket is passed
in the URL fragment and removed from history before redemption. The server
issues a host-only `Secure`, `HttpOnly`, `SameSite=Strict` cookie scoped to `/api`
and a separate proof stored in browser local storage. Both are required for API
access; mutations also require the exact configured Origin. Neither the owner
token nor Binance credentials are sent to browser JavaScript.

The browser connects directly to the remote service and keeps working after
the desktop app closes. Reopening the browser restores the session for up to
30 days. Turning off Browser access in the installed app revokes all browser
sessions, including existing WebSocket access. Browser clients cannot administer
sessions or credentials. Session hashes persist in
`/var/lib/fyxtez-terminal/server-browser-sessions.json`; include this private file
in a server backup only if retaining browser authorizations is intended.

`SERVER_BROWSER_ORIGIN` and `SERVER_BROWSER_UI_DIR` must be configured together.
The browser origin must use HTTPS and match Nginx's forwarded Host. Local mode
continues using the separate `http://127.0.0.1:8658` companion. Browser launch
failures display an error in the installed app.

Remote Binance candles and exchange metadata share a backend cache. Signed and
public requests made by the Binance client share rate-limit backoff. Passive
account and order reads still use the existing frontend deduplication; full
server-side snapshot deduplication across devices remains follow-up work.
Other programs on the same server can also consume its Binance IP allowance.

Remote workspaces and pending financial intent IDs are scoped to server identity,
account and network. A client restart retains uncertain remote intent IDs; it
does not automatically resubmit trades. Ordinary UI preferences stay on the
device. Local backup controls operate only in Local mode. Android uses the same
connection adapter, but a packaged Android/device smoke test is required before
claiming that platform verified.
