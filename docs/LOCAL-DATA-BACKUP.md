# Local data, backup and restore

Fyxtez Terminal is local-first. There is no cloud copy of chart drawings,
settings, alerts, symbols or the financial intent journal.

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

Binance, ntfy and Telegram credentials are intentionally **not** in this
directory. They remain in the operating-system credential manager and must be
reconnected separately after a machine migration. Never put an exported
keyring or plaintext API credentials in a backup archive.

## Consistent Linux backup

1. Close Fyxtez Terminal and confirm that both the desktop process and its
   managed backend have stopped. This is required so SQLite WAL and WebKit
   local-storage files form a consistent snapshot.
2. Copy the entire `com.fyxtez.terminal` directory, not selected SQLite files.
   Preserve permissions and timestamps.
3. Encrypt the backup at rest, record its SHA-256 checksum, and keep at least
   one previous known-good generation.
4. Optionally run `sqlite3 alerts.sqlite3 'PRAGMA integrity_check;'` and the
   same command for `operations.sqlite3` inside the copied directory. Both must
   report `ok`.

The icon and WebKit caches are replaceable, but copying the complete directory
is the supported procedure because WebKit owns the exact on-disk localStorage
layout.

## Restore or migrate

1. Install the same or a newer compatible application version, launch it once,
   then close it.
2. Preserve the newly created app-data directory as a rollback copy.
3. Restore the complete backed-up directory to the path above with the original
   user ownership. Do not merge individual WebKit database files.
4. Launch the application in chart-only mode first. Verify symbols, drawings,
   settings and alerts.
5. Reconnect notification providers and Binance through Settings. Confirm the
   selected Testnet/Mainnet environment explicitly; credentials are not part of
   the restored data.
6. Compare account, positions and open orders with Binance before submitting a
   mutation. The exchange wins over restored UI or journal state.

An old `in_progress` financial intent is intentionally not auto-replayed after
restore. Reconcile on Binance and create a new operator action only after its
outcome is known.

## Upgrade, rollback and uninstall

Package upgrades and application rollback must preserve the app-data directory
and credential-manager entries. Before either operation, take a closed-app
backup. On 2026-09-04 the downloaded Debian 0.1.0 package was removed with
`dpkg --remove` and reinstalled on the development machine. The package was
restored successfully and all 1,213 files under `com.fyxtez.terminal` had
identical before/after SHA-256 hashes. The package has no maintainer scripts and
does not manage the separate OS credential-store entries.

This result documents Debian remove/reinstall behavior on the development
machine; it does not replace the still-pending clean-machine upgrade and restore
acceptance. Other operating systems/package managers may behave differently,
so never assume uninstall removed local data or credentials.

Backup/restore is documented but remains a release acceptance test until a
restore has been exercised on a clean supported machine.
