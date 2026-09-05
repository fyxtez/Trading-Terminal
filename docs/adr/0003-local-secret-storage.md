# ADR 0003: Store secrets in the operating-system credential store

- Status: Partially superseded by ADR 0005 and ADR 0013
- Date: 2026-09-02

## Context

Binance API secrets, Telegram bot tokens and private ntfy topics must not be compiled into Vite, stored in localStorage, committed in `.env`, written to SQLite as plaintext or returned from Rust to the WebView. A desktop installation has access to the user's native credential manager.

## Decision

Tauri Rust commands store credentials under service `com.fyxtez.terminal` using the cross-platform `keyring` crate. Binance uses one coherent set of `binance-api-key`, `binance-api-secret` and `binance-network`; retained dormant notification entries use `ntfy-url`, `telegram-bot-token` and `telegram-chat-id`.

The WebView can request boolean configuration status, save replacement values, or clear credentials. It cannot read secret values. Sensitive Rust strings used during saving are zeroized on drop. Binance onboarding requires a dedicated API key with withdrawals disabled.

The ntfy step accepts a short public-service topic and expands it to
`https://ntfy.sh/<topic>` in native Rust before storage. Complete HTTP(S)
publish URLs remain supported for existing and self-hosted configurations.

Onboarding has independent Binance, ntfy and Telegram steps. Every step is
optional and can be reopened from Settings. Completion of the wizard is a
non-secret local preference; it is deliberately separate from credential
status. Without Binance credentials the desktop runs in chart-only mode: public
market data, charting and drawings remain available, while account requests,
order polling, execution controls and the private trading stream fail closed.

## Consequences

- Secrets remain local and protected by the platform credential manager.
- A missing or locked keychain is a visible setup error, not an `.env` fallback.
- Axum reads the same OS credential-store entries directly; this replaces the
  original temporary `.env` compatibility described by this ADR.
- Binance key, secret and network replacement/clear operations snapshot every
  target first and restore the previous set if an individual keyring mutation
  fails. Incomplete or invalid sets block trading instead of being interpreted
  as chart-only mode.
- A transient read failure clears the WebView's boolean trading permission and
  opens a styled recovery panel. `RETRY CREDENTIAL STORE` re-reads status only;
  it never returns secret values or requires replacing intact credentials.

## Follow-up

Credential access is completed by ADR 0005. Sidecar packaging, lifecycle and a
per-launch service capability are completed by ADR 0004. Explicit Binance
network selection is recorded in ADR 0006.

## Implementation status update (2026-09-04)

ADR 0013 makes price alerts, ntfy, and Telegram dormant. Legacy notification
credentials may remain in the OS store, but current UI and runtime paths do not
read or use them. Binance remains the only exposed connection.

Fault-injection tests cover locked/unavailable reads, incomplete and invalid
Binance sets, successful unlock recovery, failed replacement/clear rollback and
secret-free errors. Platform-specific manual keychain drills remain release
acceptance work whenever another operating system is added.
