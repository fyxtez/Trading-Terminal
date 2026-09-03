# Desktop release and live-trading checklist

Last reviewed: 2026-09-03

The supported product boundary is a self-hosted, single-user Tauri application.
Browser mode is for chart-only development. A successful desktop package does
not by itself make Mainnet trading release-ready.

## Desktop release

- [x] Tauri starts, health-checks, supervises and stops the packaged Axum sidecar.
- [x] Native code generates a per-launch loopback port and capability.
- [x] Single-instance and bounded sidecar restart behavior are defined.
- [x] Linux CI produces `.deb` and AppImage bundles containing the sidecar.
- [x] A downloaded `.deb` installs and launches on the development Linux machine.
- [x] CI checks frontend, backend, Tauri, dependencies and committed secrets.
- [ ] Repeat installation acceptance on a clean Linux machine or VM.
- [ ] Provision a release signing identity and verify a signed artifact or checksum manifest.
- [ ] Verify Windows and macOS only when those targets are introduced.

The complete install procedure and signing policy are in [RELEASING.md](RELEASING.md).

## Trading safety

- [x] Every financial mutation has a durable intent ID and replay/conflict policy.
- [x] Exposure-increasing requests fail closed without fresh price, filters,
  account and position-risk prerequisites.
- [x] Sensitive workflows are serialized by `TradeLock`.
- [x] Close Everything requires explicit confirmation and reports partial failures.
- [x] Binance state is authoritative after timeouts, stream gaps and process restarts.
- [x] Auto Market opens the entry and protective stop in one backend workflow;
  ambiguous stop responses are reconciled and unprotected entries are compensated.
- [x] Auto Market mock-exchange tests cover stop success, explicit stop rejection,
  lost stop response recovered by `clientAlgoId`, and failed rollback escalation.
- [ ] Complete the remaining mock-exchange scenarios for reversal ordering,
  cancel/replace failures and authoritative refresh after partial workflows.
- [ ] Exercise REST timeout, time drift, dropped user stream, sidecar restart and
  unresolved-intent recovery against Binance Futures Testnet.
- [ ] Configure a dedicated restricted Mainnet key: Futures only, no withdrawals,
  IP restriction where practical, and a smallest-acceptable-notional first trade.

The owner has manually exercised Testnet market/limit orders, TP/SL movement,
partial fill, cancellation, reversal and Close Everything. Failure-injection
drills above remain separate acceptance work.

Custom application-level monetary risk limits are intentionally out of scope.
The backend still enforces exchange filters, isolated margin, fresh prerequisites,
durable intents, reduction semantics and workflow compensation. This decision is
recorded in [ADR 0009](adr/0009-durable-financial-intents.md).

## Security, data and notifications

- [x] Binance, ntfy and Telegram secrets live in the OS credential manager.
- [x] Frontend code can read connection status but cannot retrieve stored secrets.
- [x] Native inputs, outbound redirects, request sizes and timeouts have bounded policies.
- [x] Outbound providers and secret-redaction behavior are documented.
- [x] Local backup and restore steps are documented.
- [x] Redacted durable intent/audit metadata is stored in `operations.sqlite3`.
- [x] Provider delivery failures are visible without changing a completed alert/trade result.
- [ ] Test ntfy and Telegram independently, together, misconfigured and offline.
- [ ] Exercise backup and restore on a clean supported system.
- [ ] Test locked, unavailable and corrupt credential-store behavior on each supported OS.
- [ ] Audit repository history and old archives, then rotate any credential whose
  confidentiality is uncertain.

See [OUTBOUND-CONNECTIONS.md](OUTBOUND-CONNECTIONS.md),
[LOCAL-DATA-BACKUP.md](LOCAL-DATA-BACKUP.md) and
[EMERGENCY-PROCEDURE.md](EMERGENCY-PROCEDURE.md).

## Release acceptance

- [x] A clean checkout passes frontend, backend and Tauri checks in CI.
- [x] Chart-only mode works without private credentials.
- [x] Binance network selection explicitly distinguishes `LIVE` Mainnet from `DEMO` Testnet.
- [ ] A clean supported machine passes the complete install/upgrade/uninstall procedure.
- [ ] Testnet failure-injection and soak tests finish without unresolved drift.
- [ ] Backup/restore and release-signature verification are exercised.

Mainnet can only be selected after an explicit real-funds confirmation, but that
selection is not a claim that every release-acceptance item above has passed.
