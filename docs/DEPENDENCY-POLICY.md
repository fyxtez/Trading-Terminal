# Dependency policy

Dependency lockfiles are committed for the frontend, backend, and Tauri shell.
CI installs from those lockfiles, runs `npm audit --audit-level=high`, and runs
`cargo audit` against both Cargo lockfiles on every change. Known vulnerability
advisories fail the job. Yanked or unmaintained transitive crates are reviewed
and recorded rather than silently ignored.

## Reviewed warnings (2026-09-02)

- Backend: `chacha20 0.10.1` is yanked and arrives through
  `reqwest -> quinn -> quinn-proto -> rand`. RustSec reports no vulnerability
  advisory for it. Keep `reqwest`/`quinn` current and remove this acceptance as
  soon as their resolved graph no longer selects the yanked version.
- Linux Tauri: GTK3 binding crates (`gtk`, `gdk`, `atk` and related sys/macros
  crates) are reported unmaintained; they are transitive dependencies of
  Tauri/Wry's Linux WebKit runtime. `glib 0.18.5` also carries
  `RUSTSEC-2024-0429`, and `urlpattern` currently brings several unmaintained
  `unic-*` crates. The application does not directly use the affected GLib
  iterator, but that does not eliminate transitive risk. Keep Tauri/Wry patched
  and re-run the audit before every artifact is published.

`npm audit` currently reports no vulnerabilities.

## Update cadence

- Dependabot checks npm, both Rust workspaces, and GitHub Actions quarterly
  (January, April, July, and October). Non-major version updates are grouped by
  workspace; major updates remain separate so breaking changes are visible.
- Dependabot pull requests are never merged automatically. Review their release
  notes and require the complete CI pipeline before merging.
- Apply security updates immediately rather than waiting for the quarterly
  version-update window, then repeat frontend tests, Rust tests, Clippy,
  dependency audits, bundle builds, and the relevant smoke tests.
- Do not merge automated lockfile changes without reviewing release notes and
  trading/runtime behavior.
- Add a time-bounded entry here for every accepted advisory or warning. Remove
  entries when the dependency graph is fixed.
