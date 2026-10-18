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

### Verify browser asset delivery

On the current Ubuntu host, Nginx workers run as `www-data`. Its proxy temporary
directory must be writable by that user. Install the persistent ownership rule
from the repository root on the server:

```sh
install -m 0644 deploy/nginx-proxy-tmpfiles.conf /etc/tmpfiles.d/fyxtez-nginx-proxy.conf
systemd-tmpfiles --create /etc/tmpfiles.d/fyxtez-nginx-proxy.conf
runuser -u www-data -- test -w /var/lib/nginx/proxy
nginx -t
```

This applies immediately and at boot; no backend or Nginx restart is needed.
For another host, verify the configured Nginx worker user and proxy temporary
path before installing the rule. The rule only changes the proxy directory,
preserving the restricted `0700` mode.

After every deployment, run this check from a machine with public network access:

```sh
python3 deploy/check-browser-assets.py https://terminal.fyxtez.com
```

It downloads `/`, `/BTC`, and their JavaScript/CSS entry assets, checking response
types and complete bodies. A `200 OK` or successful HEAD request alone is not
sufficient: on 2026-10-09, Nginx returned `200` but truncated the main JavaScript
because `/var/lib/nginx/proxy` belonged to `nobody`. The error log reported
`Permission denied` while reading upstream; browsers reported
`ERR_CONTENT_LENGTH_MISMATCH`. Also open the site in a browser to verify rendering;
this download check does not exercise JavaScript execution or authenticated trading.

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

## Always-on price alerts

Alerts are enabled permanently. The service uses
`ALERTS_DB_PATH=/var/lib/fyxtez-terminal/alerts.sqlite3`; include this database in
SQLite backups. It contains active alerts, triggered records, and the durable
per-channel delivery queue. No clients need to stay open. In Local mode, closing
the local backend still stops monitoring. Monitoring currently supports Binance
Futures symbols; a crossing and retrace during server/exchange downtime is not replayed.

Provision `/etc/fyxtez-terminal/notifications.json` (0600, root owned) with string
keys `ntfy-url`, `telegram-bot-token`, and `telegram-chat-id`. Use an HTTPS ntfy
topic subscribed to on the receiving devices. Add a systemd drop-in:

```ini
[Service]
LoadCredential=notifications.json:/etc/fyxtez-terminal/notifications.json
ExecStartPre=/usr/bin/install -m 0600 %d/notifications.json /run/fyxtez-terminal/notifications.json
Environment=NOTIFICATION_CREDENTIALS_FILE=/run/fyxtez-terminal/notifications.json
```

Reload systemd and restart after provisioning. `PUBLIC_TERMINAL_URL` points to
`https://terminal.fyxtez.com`. Settings → Alerts shows server delivery status;
`GET /api/alerts/status` returns only configured flags and queue count.
Unconfigured/failed channels retain pending messages. Successful channels are not
repeated; crash recovery provides at-least-once delivery. Test alerts should be
clearly labelled and never require placing an exchange order.


### OpCore main-panel embedding (source change, 2026-10-18)

Deploy the updated Terminal backend and frontend together before delivering the
OpCore client that selects Terminal below Wallets. This source change has not been
deployed. No order or live account is needed for its offline checks.

Only `/BTC?embed=opcore` may be framed. Its CSP allows the exact installed OpCore
origins: `tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`,
and `http://127.0.0.1:37373`. Normal documents and API responses retain DENY and
`frame-ancestors 'none'`. Do not add a blanket proxy framing override. Debug
builds additionally allow Vite ports 1420 and 31420; release builds do not.

First use creates a three-minute pending connection. The owner chooses Connect
Terminal in OpCore, then explicitly approves in an already authorized top-level
Terminal browser tab. If that browser has not been authorized, use the installed
Terminal app's existing Open in Browser flow first, then retry from OpCore.
Approval enables Terminal account access, including trading, within the frame.
It cannot be approved by another embedded session.

The frame polls with a private one-use secret and receives a separate embedded
session plus proof. Those values remain in Terminal storage/memory; OpCore sees
only status and a public request ID. Embedded requests use those headers with
credentials omitted, so blocked third-party cookies do not prevent access.
Blocked storage still permits the current visit; reopening then requires pairing
again. Normal Strict/HttpOnly cookie authorization is unchanged. Disabling browser
access revokes both kinds of sessions and their WebSocket authority. Pending
connections are bounded and expire; they do not survive a backend restart.

Verification: Rust browser/auth and frame-header tests, frontend auth/API and
embedded-storage tests, and the cross-project OpCore Playwright case with both
real built frontend bundles and mock API responses. From the OpCore repository,
after building both frontends, set `OPCORE_TERMINAL_DIST` to this project's
`frontend/dist` and select `Terminal (opens|ignores|real bundle)` in
`e2e/terminal.spec.ts`. These checks do not establish native WebKit/Android or
production-login behavior; verify those during delivery without placing an order.
