# Dependency policy

Dependency lockfiles are committed for the frontend, backend, and Tauri shell.
CI installs from those lockfiles, scans the npm lockfile with OSV, and runs
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

## Security refresh (2026-10-21)

The frontend resolves `source-map-js 1.2.2`, `vite 8.2.4`, and `vitest 4.1.12`.
Both Rust lockfiles resolve `quinn-proto 0.11.18`, `rustls 0.23.46`,
`rustls-webpki 0.103.16`, and `webpki-roots 1.0.10`; the Tauri shell uses
`zip 9.0.0`. OSV reports no frontend issues, and both Cargo audits pass without
vulnerability errors. No advisory suppressions were added.

The remaining Cargo warnings are accepted pending review by 2026-11-21 or the
next release, whichever comes first:

- The backend still resolves the previously reviewed yanked `chacha20 0.10.1`.
- Both lockfiles include unmaintained `zvariant 5.15.0`,
  `zvariant_derive 5.15.0`, and `zbus_names 4.3.4` through the Linux
  `keyring -> zbus-secret-service-keyring-store -> zbus` dependency graph
  (`RUSTSEC-2026-0370`, `RUSTSEC-2026-0372`, `RUSTSEC-2026-0371`). Track the
  keyring upstream migration before replacing these transitive crates.
- Tauri still reports the reviewed `glib 0.18.5` unsoundness warning and
  unmaintained `unic-*` crates. It also reports unmaintained
  `proc-macro-error 1.0.4` (`RUSTSEC-2024-0370`) through the GTK/GLib macros.
  Recheck these dependencies with the next Tauri/Wry update.

## Update cadence

- Dependabot checks npm, both Rust workspaces, and GitHub Actions quarterly
  (January, April, July, and October). Minor and patch version updates are
  grouped by workspace. Dependabot does not open routine major-version PRs;
  breaking upgrades are selected and reviewed manually.
- Dependabot pull requests are never merged automatically. Review their release
  notes and require the complete CI pipeline before merging.
- Apply security updates immediately rather than waiting for the quarterly
  version-update window. Security updates are not restricted by the routine
  minor/patch version policy. Then repeat frontend tests, Rust tests, Clippy,
  dependency audits, bundle builds, and the relevant smoke tests.
- Do not merge automated lockfile changes without reviewing release notes and
  trading/runtime behavior.
- Add a time-bounded entry here for every accepted advisory or warning. Remove
  entries when the dependency graph is fixed.
