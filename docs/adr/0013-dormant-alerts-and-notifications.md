# ADR 0013: Keep alerts and external notifications dormant

- Status: Accepted; supersedes ADR 0012
- Date: 2026-09-04

## Context

Reliable mobile background alert monitoring requires a foreground service or a
separately hosted always-on worker. Both choices add battery, network,
operational, and product complexity that is not justified for the current
terminal release. ntfy and Telegram existed only as delivery mechanisms for
that alert subsystem.

## Decision

Price alerts, ntfy, and Telegram are dormant product features:

- React does not show alert creation, alert lines, alert settings, notification
  connections, or notification-delivery diagnostics.
- The frontend alert hook remains mounted behind a disabled feature gate and
  performs no storage synchronization, API calls, price monitoring, or
  notification delivery.
- Axum does not register `/api/alerts` routes, open the persisted alert
  database, start the alert market websocket, or send provider messages.
- Tauri does not register the native notification-delivery command. The legacy
  validation, credential, alert, and provider implementation stays in source
  for a future explicit product decision.
- Existing local alert data and previously stored notification credentials are
  left untouched. They are not read or used by the dormant runtime.

Trading account streams, reconciliation, operational warnings, and trade-result
toasts are not price alerts and remain active.

## Consequences

- Desktop and Android do not consume background network or battery for price
  alert monitoring.
- No alert is promised while the application is open, backgrounded, or closed.
- Linux tray and Android foreground-service work from ADR 0012 is no longer
  planned for the current release.
- Re-enabling alerts requires an explicit review of lifecycle, delivery,
  security, UI, and retained-data compatibility; changing a single UI element
  is not sufficient.

## Follow-up

1. Keep release documentation and tests explicit that the feature is dormant.
2. Do not delete retained alert data or notification credentials automatically.
3. If alerts return, adopt an always-on architecture deliberately and supersede
   this ADR with a new reviewed decision.
