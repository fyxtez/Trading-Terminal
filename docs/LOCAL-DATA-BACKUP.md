# Local data, backup and restore

Fyxtez Terminal is local-first. There is no cloud copy of chart drawings,
settings, symbols, the financial intent journal, or retained legacy alert data.
Native Linux and Android builds provide a portable backup in **Settings > Local
data backup**.

## What is stored

The installed Linux application currently keeps its application data under:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/com.fyxtez.terminal/
```

That directory contains backend data (`alerts.sqlite3`, `operations.sqlite3`,
`symbols.json`, `sizing.json`, and the replaceable `icons/` cache) plus WebKit
storage. The `localstorage/` data includes drawings, drawing sets, tabs, chart
viewports and UI preferences. Standalone backend development instead defaults
to `backend/data/`; browser-development storage belongs to that browser profile
and is not the installed desktop profile.

Binance credentials are intentionally **not** in this directory. They remain in
the operating-system credential manager and must be reconnected separately
after a machine migration. Dormant legacy ntfy/Telegram entries may also remain
in that manager but are not used. Never put an exported keyring or plaintext
credentials in a backup archive.

## Built-in export

1. Open **Settings > Local data backup** and select **EXPORT BACKUP**.
2. Choose the destination. Android uses the system document picker, so the file
   may be saved to local storage or a document provider selected by the user.
3. Keep the resulting `.fyxtez-backup` file private. It is integrity checked but
   is not encrypted.

The native layer serializes backup operations, pauses the supervised backend,
copies the SQLite database together with any WAL/SHM sidecars, writes a
versioned manifest and SHA-256 hash for every entry, finalizes the ZIP archive,
then restarts the backend. UI state is exported through an explicit allowlist
of Fyxtez settings, drawings, drawing sets and chart state instead of copying
WebKit's browser-profile database.

The archive has fixed entry and total-size limits. Import rejects unknown,
duplicate, oversized or hash-mismatched entries, path traversal and unsupported
format versions. It deliberately excludes:

- Binance and dormant notification credentials in the OS credential manager;
- Android/Linux release signing keys;
- logs, browser/WebKit caches and the replaceable icon cache;
- dormant browser price-alert entries.

## Restore or migrate

1. Install the same or a newer compatible application version and open
   **Settings > Local data backup > RESTORE BACKUP**.
2. Choose the `.fyxtez-backup` file. Review its creation time, source app
   version, size, contents and shortened SHA-256, then type `RESTORE`.
3. Fyxtez creates a safety archive of the current state under the app-data
   `backups/` directory before changing anything. Backend files are replaced as
   one rollback-aware transaction. A failed restored-backend start reinstates
   the previous backend files, and a failed native restore reinstates the
   frontend localStorage snapshot.
4. Select **CLOSE APP**, reopen the application in chart-only mode and verify
   symbols, drawings, settings and retained application data. Legacy alerts
   remain intentionally invisible while ADR 0013 is active.
5. Reconnect Binance through Settings. Confirm the selected Testnet/Mainnet
   environment explicitly; credentials are not part of the restored data.
6. Compare account, positions and open orders with Binance before submitting a
   mutation. The exchange wins over restored UI or journal state.

An old `in_progress` financial intent is intentionally not auto-replayed or
expired after restore. It appears under Settings > Diagnostics and blocks only
new exposure. Reconcile Positions, Open Orders and Order History on Binance,
then use the typed-confirmation recovery control. A successful recovery refreshes
authoritative snapshots and tombstones the old UUID; it never submits the old
request. Create a new operator action only after its outcome is known.

## Manual closed-app fallback

For disaster recovery when the built-in UI cannot open, close Fyxtez Terminal
and confirm its managed backend has stopped. Copy the complete
`com.fyxtez.terminal` app-data directory with permissions and timestamps intact.
Restore it only while the application is closed; never merge individual WebKit
or SQLite files into a running profile. Encrypt this full directory snapshot at
rest. Optionally run `sqlite3 alerts.sqlite3 'PRAGMA integrity_check;'` and the
same command for `operations.sqlite3`; both must report `ok`.

## Upgrade, rollback and uninstall

Package upgrades and application rollback must preserve the app-data directory
and credential-manager entries. Before either operation, use the built-in
export or take a closed-app fallback snapshot. On 2026-09-04 the downloaded
Debian 0.1.0 package was removed with `dpkg --remove` and reinstalled on the
development machine. The package was restored successfully and all 1,213 files
under `com.fyxtez.terminal` had identical before/after SHA-256 hashes. The
package has no maintainer scripts and does not manage the separate OS
credential-store entries.

This result documents Debian remove/reinstall behavior on the development
machine; it does not replace the still-pending clean-machine upgrade and restore
acceptance. Other operating systems/package managers may behave differently,
so never assume uninstall removed local data or credentials.

The archive implementation has automated round-trip, allowlist and exact-file-set
tests. Backup/restore remains a release acceptance test until the built-in flow
has also been exercised on a clean supported machine.
