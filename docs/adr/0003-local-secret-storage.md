# ADR 0003: Store secrets in the operating-system credential store

- Status: Accepted; credential handoff superseded by ADR 0005
- Date: 2026-09-02

## Context

Binance API secrets, Telegram bot tokens and private ntfy topic URLs must not be compiled into Vite, stored in localStorage, committed in `.env`, written to SQLite as plaintext or returned from Rust to the WebView. A desktop installation has access to the user's native credential manager.

## Decision

Tauri Rust commands store credentials under service `com.fyxtez.terminal` using the cross-platform `keyring` crate. Keys are `binance-api-key`, `binance-api-secret`, `ntfy-url`, `telegram-bot-token` and `telegram-chat-id`.

The WebView can request boolean configuration status, save replacement values, or clear credentials. It cannot read secret values. Sensitive Rust strings used during saving are zeroized on drop. Binance onboarding requires a dedicated API key with withdrawals disabled.

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

## Follow-up

Credential access is completed by ADR 0005. Sidecar packaging, lifecycle and a
per-launch service capability are completed by ADR 0004. Explicit Binance
network selection is recorded in ADR 0006.
