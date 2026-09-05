import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { BaseDirectory, readFile, writeFile } from "@tauri-apps/plugin-fs";

const EXPORT_STAGE_NAME = "fyxtez-backup-export.fyxtez-backup";
const IMPORT_STAGE_NAME = "fyxtez-backup-import.fyxtez-backup";
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

export type BackupInspection = {
  appVersion: string;
  createdAtUnixMs: number;
  sizeBytes: number;
  sha256: string;
  frontendKeyCount: number;
  backendFiles: string[];
  frontendStorage: Record<string, string>;
};

type BackupExportInfo = {
  stageFile: string;
  suggestedFileName: string;
  sizeBytes: number;
  sha256: string;
  frontendKeyCount: number;
  backendFileCount: number;
};

export type RestoreResult = {
  safetyBackupName: string;
};

export function collectFyxtezLocalStorage(): Record<string, string> {
  const storage: Record<string, string> = {};
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key || !isPortableFyxtezKey(key)) continue;
    const value = window.localStorage.getItem(key);
    if (value !== null) storage[key] = value;
  }
  return storage;
}

export function replaceFyxtezLocalStorage(next: Record<string, string>): void {
  const unsupportedKey = Object.keys(next).find((key) => !isPortableFyxtezKey(key));
  if (unsupportedKey) throw new Error("Backup contains an unsupported local setting");

  const existingKeys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key && isPortableFyxtezKey(key)) existingKeys.push(key);
  }
  existingKeys.forEach((key) => window.localStorage.removeItem(key));
  Object.entries(next).forEach(([key, value]) => window.localStorage.setItem(key, value));
}

export async function exportLocalBackup(): Promise<BackupExportInfo | null> {
  const exportInfo = await invoke<BackupExportInfo>("export_local_backup", {
    input: { frontendStorage: collectFyxtezLocalStorage() },
  });
  try {
    const destination = await save({
      title: "Export Fyxtez backup",
      defaultPath: exportInfo.suggestedFileName,
      filters: [{ name: "Fyxtez backup", extensions: ["fyxtez-backup"] }],
    });
    if (!destination) return null;
    const bytes = await readFile(EXPORT_STAGE_NAME, { baseDir: BaseDirectory.AppCache });
    await writeFile(destination, bytes);
    return exportInfo;
  } finally {
    await invoke("cleanup_local_backup_stages").catch(() => undefined);
  }
}

export async function chooseLocalBackup(): Promise<BackupInspection | null> {
  const source = await open({
    title: "Choose a Fyxtez backup",
    multiple: false,
    directory: false,
    filters: [{ name: "Fyxtez backup", extensions: ["fyxtez-backup"] }],
  });
  if (!source || Array.isArray(source)) return null;
  const bytes = await readFile(source);
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Backup exceeds the 128 MiB limit");
  await writeFile(IMPORT_STAGE_NAME, bytes, { baseDir: BaseDirectory.AppCache });
  try {
    return await invoke<BackupInspection>("inspect_local_backup");
  } catch (error) {
    await invoke("cleanup_local_backup_stages").catch(() => undefined);
    throw error;
  }
}

export async function restoreLocalBackup(inspection: BackupInspection): Promise<RestoreResult> {
  const previousStorage = collectFyxtezLocalStorage();
  try {
    replaceFyxtezLocalStorage(inspection.frontendStorage);
    return await invoke<RestoreResult>("restore_local_backup", {
      input: { frontendStorage: previousStorage },
    });
  } catch (error) {
    try {
      replaceFyxtezLocalStorage(previousStorage);
    } catch {
      throw new Error(
        `Restore failed and local settings rollback also failed: ${errorMessage(error)}`,
      );
    }
    throw error;
  }
}

export async function cancelLocalBackupRestore(): Promise<void> {
  await invoke("cleanup_local_backup_stages");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPortableFyxtezKey(key: string): boolean {
  if (key.startsWith("fyxtez:symbol-icon-metadata:")) return false;
  if (key.startsWith("price-alerts-") || key.startsWith("fyxtez:price-alerts-")) return false;
  return (
    key.startsWith("fyxtez:") ||
    key.startsWith("fyxtez.") ||
    key.startsWith("drawings-") ||
    key.startsWith("drawing-sets-") ||
    key.startsWith("active-drawing-set-") ||
    key.startsWith("trade-markers-v2-")
  );
}
