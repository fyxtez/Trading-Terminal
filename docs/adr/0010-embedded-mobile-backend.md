# ADR 0010: Embed the backend library in the mobile application

## Status

Accepted

## Context

The desktop package runs Axum as a supervised sidecar. Android applications do
not have the same process and executable packaging model, while the terminal
still needs the existing validation, persistence, alert, account, and exchange
logic. Moving a second copy of that logic under `src-tauri` would create two
implementations of financially sensitive behavior.

## Decision

Keep `backend/` as the single backend crate and expose its application lifecycle
from `backend/src/lib.rs`. The desktop executable in `backend/src/main.rs`
remains a thin wrapper and continues to be packaged as the Tauri sidecar.

On Android, the Tauri crate links the backend crate as a target-specific Rust
dependency. Tauri starts Axum in its own Tokio runtime on a random loopback port,
creates a 256-bit per-launch capability, waits for `/health`, and gives only the
runtime URL and capability to the WebView. The embedded supervisor permits at
most three automatic restarts and also supports a user-requested retry.

Android secrets use the native Android keyring store backed by Android Keystore.
Backend JSON, SQLite, and icon data use Tauri's private application-data
directory. No backend source tree, Cargo installation, `.env`, fixed port, or
separate executable is required on the device.

## Consequences

- Desktop and mobile share the same API routes and trading invariants.
- Platform-specific lifecycle and credential adapters stay in `src-tauri`.
- The Android backend lives only as long as the application process. Android may
  suspend or terminate that process in the background, so continuous alert and
  user-stream monitoring is not promised until a foreground-service design is
  implemented and independently reviewed.
- The initial Android target is arm64 debug/development distribution. It is not
  yet a signed Play Store release target.

## Follow-up

- Exercise chart, Settings, keyring, Testnet, notification, sleep/resume, and
  process-recreation flows on a physical Android device.
- Decide whether continuous background monitoring is a product requirement. If
  it is, add an explicit foreground service and visible persistent notification.
- Add Android signing, release CI, upgrade/uninstall, and clean-device acceptance
  tests before declaring Android a supported release target.

## Implementation status update (2026-09-04)

The protected release workflow now builds and verifies a signed arm64 APK/AAB,
and the signed APK has been installed successfully on a physical device. Play
Store publication and clean-device acceptance remain out of scope. Continuous
monitoring is now confirmed as a product requirement; ADR 0012 defines the
foreground-service implementation that remains pending.
