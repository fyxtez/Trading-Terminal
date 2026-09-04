# ADR 0012: Keep continuous monitoring explicit and platform-native

- Status: Accepted; implementation pending
- Date: 2026-09-04

## Context

Price alerts, user-stream reconciliation, and notification delivery currently
run inside the application-owned backend. Desktop shutdown stops its sidecar,
and Android may suspend or terminate the embedded process after the activity is
backgrounded. Therefore neither platform can promise monitoring after the
application runtime has stopped.

Silent attempts to evade either operating system's lifecycle would be fragile
and would hide battery/network use from the user.

## Decision

Continuous monitoring is a product requirement, implemented separately for
each platform while keeping the shared Rust backend logic unchanged:

- **Linux desktop:** closing the window will hide it to a system tray instead
  of exiting. The tray must visibly show running/degraded state and offer
  **Open** and explicit **Quit** actions. Explicit Quit stops the sidecar.
  Start-on-login remains opt-in.
- **Android:** monitoring will run through a real foreground service with a
  persistent Android notification. The notification must explain that alerts
  and exchange monitoring are active and provide a stop action. The service
  owns the embedded backend lifecycle independently of the activity UI.
- **Both platforms:** after sleep, network loss, process recreation, or service
  restart, Binance REST reconciliation remains authoritative before trading or
  declaring the stream healthy.

Until both implementations pass lifecycle tests, the UI and release notes must
state that alerts are guaranteed only while the application process is active.

## Consequences

- Desktop close and explicit Quit become intentionally different operations.
- Android shows the operating-system-required persistent notification and may
  consume additional battery/network resources while monitoring.
- The two lifecycle adapters require platform-specific code, but alert,
  exchange, and reconciliation behavior stays in the shared backend crate.
- This does not attempt to keep a trading UI alive invisibly; only the backend
  monitoring runtime remains active.

## Follow-up

1. Implement and test Linux tray close/open/quit plus opt-in start-on-login.
2. Implement the Android foreground service and notification channel.
3. Test desktop logout/shutdown and Android swipe-away, Doze, reboot, network
   transition, notification permission, and explicit stop behavior.
4. Add Diagnostics fields that distinguish foreground UI state from background
   monitoring state.
