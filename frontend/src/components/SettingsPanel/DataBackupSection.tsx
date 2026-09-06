import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import {
  cancelLocalBackupRestore,
  chooseLocalBackup,
  exportLocalBackup,
  restoreLocalBackup,
  type BackupInspection,
} from "../../desktop/localBackup";
import { userFacingError } from "../../utils/userFacingError";

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
      setError(userFacingError(reason, "Terminal could not create the backup."));
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
      setError(userFacingError(reason, "Terminal could not open this backup."));
    } finally {
      setBusy(null);
    }
  };

  const cancelRestore = async () => {
    setCandidate(null);
    setConfirmation("");
    setError(null);
    await cancelLocalBackupRestore().catch((reason) =>
      setError(userFacingError(reason, "Terminal could not cancel the restore.")),
    );
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
        `Restore completed. Safety copy kept as ${result.safetyBackupName}. Close and reopen Terminal to load every restored setting.`,
      );
    } catch (reason) {
      setError(userFacingError(reason, "Terminal could not restore this backup."));
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
      setError(userFacingError(reason, "Terminal could not close. Please close it normally."));
      setBusy(null);
    }
  };

  return (
    <section className="settings-section data-backup-section">
      <div className="settings-section-heading settings-section-heading-with-action">
        <div>
          <h3>Backup and restore</h3>
          {isExpanded && <p>Save your drawings, layouts and settings, or restore them later.</p>}
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
              Binance keys, signing keys and activity logs are never included. The backup file is
              readable by anyone who has it, so keep it private.
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
                <strong>Backup ready to restore</strong>
                <span>Created {formatDate(candidate.createdAtUnixMs)}</span>
                <span>
                  App {candidate.appVersion} · {formatBytes(candidate.sizeBytes)} ·{" "}
                  {candidate.frontendKeyCount} settings · {candidate.backendFiles.length} saved data
                  files
                </span>
              </div>
              <label>
                <span>Type RESTORE to replace your saved drawings and settings</span>
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
