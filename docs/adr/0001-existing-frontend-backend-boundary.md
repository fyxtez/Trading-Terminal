# ADR 0001: Preserve the existing frontend/backend boundary

- Status: Accepted
- Date: 2026-09-02

## Context

The frontend is a React 18/Vite SPA. It owns chart rendering, drawing tools, local display preferences, symbol tabs, trade-ticket interaction and presentation of positions/orders. The Rust/Axum service owns Binance request signing, order execution, account state, persistent SQLite alerts, symbol registry data, sizing configuration and the trading-event WebSocket.

Moving every backend module into Tauri commands in one change would mix a packaging migration with a protocol rewrite and make trading regressions hard to isolate.

## Decision

Keep the HTTP/WebSocket contract during the first desktop milestones. Tauri hosts the existing built SPA and provides desktop-only commands. Axum remains the sole owner of exchange execution until individual contracts are deliberately migrated.

## Consequences

- Browser development remains available.
- Existing frontend API modules continue to work.
- Desktop development temporarily runs a localhost backend.
- The release bundle is incomplete until the backend is packaged and supervised by Tauri.

## Follow-up

Inventory each REST/WebSocket route before deciding whether it remains local HTTP or becomes IPC. Execution behavior must not exist in both paths.
