# Architecture Decision Records

This directory records architectural decisions that are expensive or unsafe to rediscover from code alone. ADRs are append-only: supersede an accepted decision with a new ADR instead of silently rewriting its rationale.

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](0001-existing-frontend-backend-boundary.md) | Accepted | Preserve the React/Axum boundary during desktop migration |
| [0002](0002-tauri-desktop-shell.md) | Accepted | Use Tauri 2 as the desktop shell |
| [0003](0003-local-secret-storage.md) | Partially superseded by 0005 | Keep exchange and notification secrets in the OS credential store |
| [0004](0004-backend-packaging-and-lifecycle.md) | Accepted | Bundle and supervise the Axum backend as a desktop sidecar |
| [0005](0005-axum-reads-os-credential-store.md) | Accepted | Let Axum read Binance and notification secrets from the OS credential store |
| [0006](0006-explicit-binance-network-selection.md) | Accepted | Require explicit Testnet/Mainnet selection for every Binance connection |

New ADRs use the next four-digit number and contain Context, Decision, Consequences, and Follow-up sections.
