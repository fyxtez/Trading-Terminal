# Private server browser verification — 2026-09-15

## Change and deployment

The installed app's Open in Browser command now uses the selected private
server's browser access routes. Previously the remote status was unsupported,
the launch failed and the tray error handler showed the native window. The
server now serves the packaged UI and issues one-use browser launch tickets.
Launch errors show a dialog instead of bringing up the main window silently.

- Release: `/opt/fyxtez-terminal/releases/20260915-browser`.
- Previous release and systemd unit retained for rollback.
- Backend SHA256: `9143eed74ca2f2927e8cba010bf0974fa08f41ae25ee2dfa0f38d0881d5718fa`.
- Linux package: `Fyxtez Terminal_1.0.36_amd64.deb` (same derived version, updated build).
- Package SHA256: `b4b9d4f23ad8f9231d29889ecd2c7d71c865d88d5192df0a86580eeca5686dd8`.
- Installed executable matched the executable extracted from the package.
- Source version metadata restored to the repository's 1.0.0 baseline.

## Automated checks

- Frontend: 215 tests in 58 files passed; TypeScript, CSS/comment guards and
  Prettier passed; production frontend and Linux deb builds passed.
- Backend: 87 tests passed; native shell: 39 tests passed. Rust formatting and
  Clippy with warnings denied passed for both crates.
- Added coverage for HTTPS launch origin validation, remote cookies, browser
  proof restoration/revocation, account/network handshake, private-server price
  routing and native/browser settings behavior. Local browser tests still pass.
- `git diff --check` and source version consistency check passed.

## Deployed checks

All 26 HTTPS/WSS checks passed using application session operations and read-only
exchange requests:

- Public HTML/CSP available; unauthenticated account access rejected.
- Owner token can manage hosted browser access and cannot reload local credentials.
- One-use ticket, at most 60 seconds, redeems only on the configured origin.
- Cookie has Secure, HttpOnly, SameSite=Strict, host-only and `/api` attributes.
- Cookie alone, ticket replay and foreign-origin mutation are rejected.
- Browser session, server handshake, account, open orders and candles return 200.
- Browser cannot administer browser access or desktop credentials.
- Browser-authenticated WSS upgrades with 101 and a verified accept header.
- Turning off browser access invalidates the test session.

After installing and restarting the Linux app, the actual Open in Browser tray
menu entry was activated through its DBus menu. The default Brave browser
redeemed a new session. Nginx recorded its normal Chrome-family browser user
agent receiving 200 for the production JS bundle, browser/server session,
account, open orders, candles, exchange information and WebSocket ticket.
The server reported browser access enabled with one active browser session.
The native app log was empty and no local backend process was running.

No Mainnet order was submitted as part of verification. Android packaging and
device behavior were not exercised by this fix.
