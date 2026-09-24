# ADR 0016: Persistent server price alerts

- Status: Accepted; supersedes ADR 0013
- Date: 2026-09-24

## Context

The owner now runs an always-on private backend shared by Linux and Android and
has requested price alerts with both ntfy and Telegram delivery.

## Decision

- Alerts are always stored and monitored on the connected backend. There is no
  browser monitoring mode or persistence switch. Closing all remote clients does
  not stop the private server. Local mode still requires its backend to run.
- The chart and account-wide list use authenticated backend routes. WebSocket
  change events, reconnect, visibility/online events and a 15-second fallback
  refresh synchronize devices. Mutation failures are visible; server confirmation
  precedes line changes. Undo/redo also writes to the backend.
- Old browser-owned alerts are not silently uploaded or rearmed. Local storage
  only contributes lock/dim preferences for IDs confirmed by the server.
- Binance Futures aggTrade prices evaluate the saved crossing direction. A level
  already reached at reconnect fires on the first received tick. A crossing and
  retrace entirely during a server/exchange outage cannot be reconstructed.
  Only Binance-registered symbols can create alerts; MEXC monitoring is unsupported.
- Trigger consumption checks the exact saved alert version, protecting concurrent
  edits. SQLite commits the triggered record and delivery queue atomically.
  Triggered records remain in the database but disappear from active lists.
- One delivery worker retries ntfy and Telegram independently with bounded
  exponential backoff (5 to 320 seconds), including after a process restart.
  Completed channels are not retried. Delivery is at-least-once: a crash after
  provider acceptance but before database acknowledgement can duplicate a message.
  Unconfigured channels remain queued until configured. Invalid or incomplete
  credentials are isolated per channel; Telegram delivery requires its explicit
  success acknowledgement, not just an HTTP 2xx response.
- Headless notification secrets come from an owner-only JSON file configured by
  `NOTIFICATION_CREDENTIALS_FILE`, mounted through systemd credentials. Desktop
  local mode can use retained OS keyring entries. Remote device keyrings and
  native notification commands are not involved in delivery.
- Authenticated `/api/alerts/status` reports configured channels and pending
  deliveries without returning secrets. Settings displays that status.

## Validation

Regression tests cover persistence/restart, atomic single consumption, races
against edits/deletion, invalid prices, cross-device refresh, mutation failures,
late create/trigger responses, symbol switches, and server-backed undo/redo.
Local HTTP provider tests cover independent retries across restart, invalid
credentials, refused Telegram acknowledgements, and exact small-price rendering.
Release checks include backend/Tauri tests and Clippy, frontend checks/builds,
remote alert CRUD and restart, and real ntfy delivery. Notification chart links
return HTTP 200 and preserve custom symbols while the registry loads. Real Telegram delivery
remains dependent on valid owner-supplied credentials.

## Consequences

Private-server alerts do not consume phone background execution. Server or exchange
outages still interrupt price observation. The alert database must be backed up
with SQLite-aware tooling, including queued notifications. Notification recipients
must subscribe to the configured ntfy topic or start the configured Telegram bot.

## Follow-up

Owner-approved ntfy provisioning and delivery of a retained test message are
verified on the private server. The retained Linux Telegram entries failed token
and numeric chat-ID validation; valid replacement credentials are required before
Telegram delivery can be verified. Pending Telegram delivery remains durable.
Install the updated Android APK and verify the chart interactions on the physical
device; automated tests and an APK build do not replace that check.
