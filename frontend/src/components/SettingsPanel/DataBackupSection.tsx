import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import {
  cancelLocalBackupRestore,
  chooseLocalBackup,
  errorMessage,
  exportLocalBackup,
  restoreLocalBackup,
  type BackupInspection,
} from "../../desktop/localBackup";

type Props = {
  forceExpanded: boolean;
};

type BusyAction = "export" | "choose" | "restore" | "restart" | null;

export default function DataBackupSection({ forceExpanded }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [candidate, setCandidate] = useState<BackupInspection | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const isExpanded = forceExpanded || expanded;

  const runExport = async () => {
    setBusy("export");
    setError(null);
    setMessage(null);
    try {
      const result = await exportLocalBackup();
      setMessage(
        result
          ? `Backup exported and verified (${formatBytes(result.sizeBytes)}).`
          : "Backup export cancelled.",
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  };

  const chooseBackup = async () => {
    setBusy("choose");
    setError(null);
    setMessage(null);
    setCandidate(null);
    setConfirmation("");
    try {
      const result = await chooseLocalBackup();
      if (result) setCandidate(result);
      else setMessage("Restore cancelled.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  };

  const cancelRestore = async () => {
    setCandidate(null);
    setConfirmation("");
    setError(null);
    await cancelLocalBackupRestore().catch((reason) => setError(errorMessage(reason)));
  };

  const confirmRestore = async () => {
    if (!candidate || confirmation !== "RESTORE") return;
    setBusy("restore");
    setError(null);
    setMessage(null);
    try {
      const result = await restoreLocalBackup(candidate);
      setCandidate(null);
      setConfirmation("");
      setRestartRequired(true);
      setMessage(
        `Restore completed. Safety copy kept as ${result.safetyBackupName}. Close and reopen Fyxtez to load every restored setting.`,
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  };

  const restartApp = async () => {
    setBusy("restart");
    setError(null);
    try {
      await invoke("exit_app");
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(null);
    }
  };

  return (
    <section className="settings-section data-backup-section">
      <div className="settings-section-heading settings-section-heading-with-action">
        <div>
          <h3>Local data backup</h3>
          {isExpanded && <p>Move drawings, layouts and local app data between installations.</p>}
        </div>
        <button
          type="button"
          className="settings-section-visibility-button"
          aria-expanded={isExpanded}
          onClick={() => setExpanded((visible) => !visible)}
        >
          {forceExpanded ? "MATCH" : expanded ? "HIDE" : "SHOW"}
        </button>
      </div>

      {isExpanded && (
        <div className="data-backup-content">
          <div className="data-backup-notice">
            <strong>Keys stay on this device</strong>
            <span>
              Binance credentials, signing keys, logs and replaceable caches are never included. The
              backup itself is not encrypted, so store it privately.
            </span>
          </div>

          <div className="data-backup-actions">
            <button type="button" disabled={busy !== null} onClick={() => void runExport()}>
              {busy === "export" ? "EXPORTING…" : "EXPORT BACKUP"}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => void chooseBackup()}>
              {busy === "choose" ? "CHECKING…" : "RESTORE BACKUP"}
            </button>
          </div>

          {candidate && (
            <div className="data-backup-confirmation">
              <div className="data-backup-summary">
                <strong>Verified backup</strong>
                <span>Created {formatDate(candidate.createdAtUnixMs)}</span>
                <span>
                  App {candidate.appVersion} · {formatBytes(candidate.sizeBytes)} ·{" "}
                  {candidate.frontendKeyCount} local settings · {candidate.backendFiles.length}{" "}
                  backend files
                </span>
                <code title={candidate.sha256}>SHA-256 {candidate.sha256.slice(0, 16)}…</code>
              </div>
              <label>
                <span>Type RESTORE to replace local data</span>
                <input
                  type="text"
                  value={confirmation}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy !== null}
                  onChange={(event) => setConfirmation(event.target.value.toUpperCase())}
                />
              </label>
              <div className="data-backup-confirmation-actions">
                <button type="button" disabled={busy !== null} onClick={() => void cancelRestore()}>
                  CANCEL
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy !== null || confirmation !== "RESTORE"}
                  onClick={() => void confirmRestore()}
                >
                  {busy === "restore" ? "RESTORING…" : "RESTORE DATA"}
                </button>
              </div>
            </div>
          )}

          {message && <div className="data-backup-message">{message}</div>}
          {error && <div className="settings-error data-backup-error">{error}</div>}
          {restartRequired && (
            <button
              type="button"
              className="data-backup-restart"
              disabled={busy !== null}
              onClick={() => void restartApp()}
            >
              {busy === "restart" ? "CLOSING…" : "CLOSE APP"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "at an unknown time" : date.toLocaleString();
}
