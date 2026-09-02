# ADR 0002: Use Tauri 2 as the desktop shell

- Status: Accepted
- Date: 2026-09-02

## Context

Fyxtez Terminal is changing from a remotely hosted multi-user concept into a self-hosted, single-user desktop application. The existing Vite SPA matches Tauri's static frontend model and the trading service is written in Rust.

## Decision

Use Tauri 2. Desktop source lives in `frontend/src-tauri`, while Vite produces
`frontend/dist`. Desktop development uses `npm run desktop:dev` or the
repository-level `./run.sh`; browser development uses `npm run dev` when its
backend is already running or `./run.sh browser` for the complete stack.

The initial window is desktop-first (1600x1000, minimum 1100x700). Capabilities start with `core:default`, bundling is disabled until the backend sidecar and credential handoff are complete, and CSP explicitly lists the local backend and current market-data origins.

## Consequences

- One UI codebase serves browser development and desktop builds.
- Desktop-only behavior must use Tauri runtime detection.
- Adding a plugin requires an explicit capability review.
- Mobile is out of scope for the initial migration.

## Follow-up

Enable bundle targets only after signed artifacts, backend inclusion, CSP tests and platform prerequisites are documented and verified.
