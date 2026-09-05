use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

pub const EXPORT_STAGE_NAME: &str = "fyxtez-backup-export.fyxtez-backup";
pub const IMPORT_STAGE_NAME: &str = "fyxtez-backup-import.fyxtez-backup";
const MANIFEST_PATH: &str = "manifest.json";
const FRONTEND_PATH: &str = "frontend/local-storage.json";
const FORMAT_VERSION: u32 = 1;
const MAX_ARCHIVE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FRONTEND_BYTES: usize = 16 * 1024 * 1024;
const MAX_FRONTEND_KEYS: usize = 2_048;
const MAX_FRONTEND_VALUE_BYTES: usize = 2 * 1024 * 1024;

const BACKEND_FILES: [&str; 10] = [
    "alerts.sqlite3",
    "alerts.sqlite3-wal",
    "alerts.sqlite3-shm",
    "operations.sqlite3",
    "operations.sqlite3-wal",
    "operations.sqlite3-shm",
    "symbols.json",
    "symbols.json.tmp",
    "sizing.json",
    "sizing.json.tmp",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInput {
    pub frontend_storage: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupExportInfo {
    pub stage_file: &'static str,
    pub suggested_file_name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub frontend_key_count: usize,
    pub backend_file_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInspection {
    pub app_version: String,
    pub created_at_unix_ms: u64,
    pub size_bytes: u64,
    pub sha256: String,
    pub frontend_key_count: usize,
    pub backend_files: Vec<String>,
    pub frontend_storage: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub safety_backup_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format_version: u32,
    app_version: String,
    created_at_unix_ms: u64,
    entries: Vec<ManifestEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestEntry {
    path: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug)]
pub struct ValidatedBackup {
    manifest: Manifest,
    frontend_storage: BTreeMap<String, String>,
    backend_files: BTreeMap<String, Vec<u8>>,
    archive_size: u64,
    archive_sha256: String,
}

impl ValidatedBackup {
    pub fn inspection(&self) -> BackupInspection {
        BackupInspection {
            app_version: self.manifest.app_version.clone(),
            created_at_unix_ms: self.manifest.created_at_unix_ms,
            size_bytes: self.archive_size,
            sha256: self.archive_sha256.clone(),
            frontend_key_count: self.frontend_storage.len(),
            backend_files: self.backend_files.keys().cloned().collect(),
            frontend_storage: self.frontend_storage.clone(),
        }
    }

    pub fn backend_files(&self) -> &BTreeMap<String, Vec<u8>> {
        &self.backend_files
    }
}

pub fn export_stage_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join(EXPORT_STAGE_NAME)
}

pub fn import_stage_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join(IMPORT_STAGE_NAME)
}

pub fn create_export(
    data_dir: &Path,
    cache_dir: &Path,
    app_version: &str,
    frontend_storage: &BTreeMap<String, String>,
) -> Result<BackupExportInfo, String> {
    fs::create_dir_all(cache_dir).map_err(|_| "Could not prepare backup staging".to_string())?;
    let stage_path = export_stage_path(cache_dir);
    remove_file_if_present(&stage_path)?;
    let created_at = now_unix_ms()?;
    create_archive(
        data_dir,
        &stage_path,
        app_version,
        created_at,
        frontend_storage,
    )?;
    let bytes = read_bounded_file(&stage_path, MAX_ARCHIVE_BYTES, "backup archive")?;
    let backend_file_count = collect_backend_files(data_dir)?.len();
    Ok(BackupExportInfo {
        stage_file: EXPORT_STAGE_NAME,
        suggested_file_name: format!("fyxtez-backup-{created_at}.fyxtez-backup"),
        size_bytes: bytes.len() as u64,
        sha256: sha256_hex(&bytes),
        frontend_key_count: frontend_storage.len(),
        backend_file_count,
    })
}

pub fn inspect_import(cache_dir: &Path) -> Result<ValidatedBackup, String> {
    validate_archive(&import_stage_path(cache_dir))
}

pub fn create_safety_backup(
    data_dir: &Path,
    app_version: &str,
    frontend_storage: &BTreeMap<String, String>,
) -> Result<(PathBuf, String), String> {
    let created_at = now_unix_ms()?;
    let backups_dir = data_dir.join("backups");
    fs::create_dir_all(&backups_dir)
        .map_err(|_| "Could not create the safety-backup directory".to_string())?;
    let name = format!("fyxtez-safety-{created_at}.fyxtez-backup");
    let path = backups_dir.join(&name);
    create_archive(data_dir, &path, app_version, created_at, frontend_storage)?;
    Ok((path, name))
}

pub fn collect_backend_files(data_dir: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut files = BTreeMap::new();
    let mut total = 0_u64;
    for name in BACKEND_FILES {
        let path = data_dir.join(name);
        if !path.exists() {
            continue;
        }
        let bytes = read_bounded_file(&path, MAX_ENTRY_BYTES, "application data")?;
        total = total
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| "Application data is too large to back up".to_string())?;
        if total > MAX_ARCHIVE_BYTES {
            return Err("Application data is too large to back up".into());
        }
        files.insert(name.to_string(), bytes);
    }
    Ok(files)
}

pub fn install_backend_files(
    data_dir: &Path,
    incoming: &BTreeMap<String, Vec<u8>>,
) -> Result<(), String> {
    validate_backend_map(incoming)?;
    fs::create_dir_all(data_dir)
        .map_err(|_| "Could not prepare application data for restore".to_string())?;
    let nonce = random_hex()?;
    let transaction_dir = data_dir.join(format!(".fyxtez-restore-{nonce}"));
    let incoming_dir = transaction_dir.join("incoming");
    let previous_dir = transaction_dir.join("previous");
    fs::create_dir_all(&incoming_dir)
        .and_then(|_| fs::create_dir_all(&previous_dir))
        .map_err(|_| "Could not prepare an atomic restore transaction".to_string())?;

    let mut preserved = Vec::new();
    let mut activated = Vec::new();
    let operation = (|| {
        for (name, bytes) in incoming {
            let path = incoming_dir.join(name);
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|_| "Could not stage restored application data".to_string())?;
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| "Could not safely stage restored application data".to_string())?;
        }

        for name in BACKEND_FILES {
            let current = data_dir.join(name);
            if current.exists() {
                fs::rename(&current, previous_dir.join(name))
                    .map_err(|_| "Could not preserve current application data".to_string())?;
                preserved.push(name);
            }
        }

        for name in incoming.keys() {
            fs::rename(incoming_dir.join(name), data_dir.join(name))
                .map_err(|_| "Could not activate restored application data".to_string())?;
            activated.push(name.as_str());
        }
        Ok(())
    })();

    if let Err(error) = operation {
        for name in activated {
            let installed = data_dir.join(name);
            if installed.exists() {
                let _ = fs::remove_file(installed);
            }
        }
        for name in preserved {
            let previous = previous_dir.join(name);
            if previous.exists() {
                let _ = fs::rename(previous, data_dir.join(name));
            }
        }
        let _ = fs::remove_dir_all(&transaction_dir);
        return Err(error);
    }

    let _ = fs::remove_dir_all(&transaction_dir);
    Ok(())
}

pub fn cleanup_stages(cache_dir: &Path) -> Result<(), String> {
    remove_file_if_present(&export_stage_path(cache_dir))?;
    remove_file_if_present(&import_stage_path(cache_dir))
}

fn create_archive(
    data_dir: &Path,
    archive_path: &Path,
    app_version: &str,
    created_at_unix_ms: u64,
    frontend_storage: &BTreeMap<String, String>,
) -> Result<(), String> {
    validate_frontend_storage(frontend_storage)?;
    let frontend_bytes = serde_json::to_vec(frontend_storage)
        .map_err(|_| "Could not serialize local settings".to_string())?;
    if frontend_bytes.len() > MAX_FRONTEND_BYTES {
        return Err("Local settings are too large to back up".into());
    }
    let backend_files = collect_backend_files(data_dir)?;
    let mut content = BTreeMap::from([(FRONTEND_PATH.to_string(), frontend_bytes)]);
    for (name, bytes) in backend_files {
        content.insert(format!("data/{name}"), bytes);
    }
    let entries = content
        .iter()
        .map(|(path, bytes)| ManifestEntry {
            path: path.clone(),
            size_bytes: bytes.len() as u64,
            sha256: sha256_hex(bytes),
        })
        .collect();
    let manifest = Manifest {
        format_version: FORMAT_VERSION,
        app_version: app_version.to_string(),
        created_at_unix_ms,
        entries,
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|_| "Could not serialize backup manifest".to_string())?;

    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(archive_path)
        .map_err(|_| "Could not create backup archive".to_string())?;
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o600);
    for (path, bytes) in content {
        writer
            .start_file(path, options)
            .and_then(|_| writer.write_all(&bytes).map_err(Into::into))
            .map_err(|_| "Could not write backup archive".to_string())?;
    }
    writer
        .start_file(MANIFEST_PATH, options)
        .and_then(|_| writer.write_all(&manifest_bytes).map_err(Into::into))
        .map_err(|_| "Could not write backup manifest".to_string())?;
    writer
        .finish()
        .and_then(|file| file.sync_all().map(|_| file).map_err(Into::into))
        .map_err(|_| "Could not finalize backup archive".to_string())?;
    Ok(())
}

fn validate_archive(path: &Path) -> Result<ValidatedBackup, String> {
    let archive_bytes = read_bounded_file(path, MAX_ARCHIVE_BYTES, "backup archive")?;
    let archive_sha256 = sha256_hex(&archive_bytes);
    let cursor = std::io::Cursor::new(&archive_bytes);
    let mut archive =
        ZipArchive::new(cursor).map_err(|_| "Backup is not a valid ZIP archive".to_string())?;
    if archive.is_empty() || archive.len() > BACKEND_FILES.len() + 2 {
        return Err("Backup contains an invalid number of entries".into());
    }

    let allowed: BTreeSet<String> = std::iter::once(MANIFEST_PATH.to_string())
        .chain(std::iter::once(FRONTEND_PATH.to_string()))
        .chain(BACKEND_FILES.into_iter().map(|name| format!("data/{name}")))
        .collect();
    let mut files = BTreeMap::<String, Vec<u8>>::new();
    let mut total_uncompressed = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| "Could not read backup entry".to_string())?;
        let name = entry.name().to_string();
        if entry.is_dir() || !allowed.contains(&name) || files.contains_key(&name) {
            return Err("Backup contains an unsupported or duplicate entry".into());
        }
        if entry.size() > MAX_ENTRY_BYTES {
            return Err("Backup contains an oversized entry".into());
        }
        total_uncompressed = total_uncompressed
            .checked_add(entry.size())
            .ok_or_else(|| "Backup expands beyond the safe size limit".to_string())?;
        if total_uncompressed > MAX_ARCHIVE_BYTES {
            return Err("Backup expands beyond the safe size limit".into());
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut bytes)
            .map_err(|_| "Could not read backup entry".to_string())?;
        files.insert(name, bytes);
    }

    let manifest_bytes = files
        .remove(MANIFEST_PATH)
        .ok_or_else(|| "Backup manifest is missing".to_string())?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| "Backup manifest is invalid".to_string())?;
    if manifest.format_version != FORMAT_VERSION {
        return Err(format!(
            "Backup format {} is not supported by this app",
            manifest.format_version
        ));
    }
    if manifest.app_version.trim().is_empty() || manifest.app_version.len() > 64 {
        return Err("Backup app version is invalid".into());
    }

    let manifest_paths: BTreeSet<_> = manifest.entries.iter().map(|entry| &entry.path).collect();
    if manifest_paths.len() != manifest.entries.len()
        || manifest.entries.len() != files.len()
        || !manifest.entries.iter().all(|expected| {
            files.get(&expected.path).is_some_and(|bytes| {
                bytes.len() as u64 == expected.size_bytes && sha256_hex(bytes) == expected.sha256
            })
        })
    {
        return Err("Backup integrity verification failed".into());
    }

    let frontend_bytes = files
        .remove(FRONTEND_PATH)
        .ok_or_else(|| "Backup local settings are missing".to_string())?;
    if frontend_bytes.len() > MAX_FRONTEND_BYTES {
        return Err("Backup local settings are too large".into());
    }
    let frontend_storage: BTreeMap<String, String> = serde_json::from_slice(&frontend_bytes)
        .map_err(|_| "Backup local settings are invalid".to_string())?;
    validate_frontend_storage(&frontend_storage)?;

    let mut backend_files = BTreeMap::new();
    for (path, bytes) in files {
        let name = path
            .strip_prefix("data/")
            .ok_or_else(|| "Backup contains an unsupported entry".to_string())?;
        backend_files.insert(name.to_string(), bytes);
    }
    validate_backend_map(&backend_files)?;

    Ok(ValidatedBackup {
        manifest,
        frontend_storage,
        backend_files,
        archive_size: archive_bytes.len() as u64,
        archive_sha256,
    })
}

fn validate_frontend_storage(storage: &BTreeMap<String, String>) -> Result<(), String> {
    if storage.len() > MAX_FRONTEND_KEYS {
        return Err("Too many local settings to back up".into());
    }
    for (key, value) in storage {
        if !is_portable_frontend_key(key)
            || key.len() > 512
            || value.len() > MAX_FRONTEND_VALUE_BYTES
        {
            return Err("Local settings contain an unsupported entry".into());
        }
    }
    Ok(())
}

fn is_portable_frontend_key(key: &str) -> bool {
    if key.starts_with("fyxtez:symbol-icon-metadata:")
        || key.starts_with("price-alerts-")
        || key.starts_with("fyxtez:price-alerts-")
    {
        return false;
    }
    key.starts_with("fyxtez:")
        || key.starts_with("fyxtez.")
        || key.starts_with("drawings-")
        || key.starts_with("drawing-sets-")
        || key.starts_with("active-drawing-set-")
        || key.starts_with("trade-markers-v2-")
}

fn validate_backend_map(files: &BTreeMap<String, Vec<u8>>) -> Result<(), String> {
    let allowed: BTreeSet<&str> = BACKEND_FILES.into_iter().collect();
    if files.keys().any(|name| !allowed.contains(name.as_str())) {
        return Err("Backup contains unsupported application data".into());
    }
    Ok(())
}

fn read_bounded_file(path: &Path, max_bytes: u64, label: &str) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path).map_err(|_| format!("Could not read {label}"))?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return Err(format!("{label} exceeds the safe size limit"));
    }
    let file = File::open(path).map_err(|_| format!("Could not read {label}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| format!("Could not read {label}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("{label} exceeds the safe size limit"));
    }
    Ok(bytes)
}

fn remove_file_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not clear an old backup staging file".into()),
    }
}

fn now_unix_ms() -> Result<u64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is invalid".to_string())?
        .as_millis();
    u64::try_from(millis).map_err(|_| "System clock is outside the supported range".to_string())
}

fn random_hex() -> Result<String, String> {
    let mut bytes = [0_u8; 8];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Could not create a restore transaction identifier".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "fyxtez-backup-test-{label}-{}",
            random_hex().expect("random")
        ));
        fs::create_dir_all(&path).expect("temp dir");
        path
    }

    #[test]
    fn archive_round_trip_preserves_allowed_data_and_excludes_secrets_and_cache() {
        let root = temp_dir("round-trip");
        let data = root.join("data");
        let cache = root.join("cache");
        fs::create_dir_all(data.join("icons")).expect("data dirs");
        fs::write(data.join("operations.sqlite3"), b"journal").expect("journal");
        fs::write(data.join("symbols.json"), b"{\"symbols\":[]}").expect("symbols");
        fs::write(data.join("icons/replaceable.png"), b"cache").expect("cache");
        fs::write(data.join("binance-api-secret"), b"must-not-leak").expect("secret decoy");
        let frontend = BTreeMap::from([
            ("fyxtez:drawings:BTCUSDT".into(), "[]".into()),
            ("fyxtez.settings.marginSectionVisible".into(), "true".into()),
            ("drawings-BTCUSDT".into(), "[]".into()),
        ]);

        create_export(&data, &cache, "0.1.0", &frontend).expect("export");
        fs::copy(export_stage_path(&cache), import_stage_path(&cache)).expect("stage import");
        let backup = inspect_import(&cache).expect("inspect");

        assert_eq!(backup.frontend_storage, frontend);
        assert_eq!(backup.backend_files["operations.sqlite3"], b"journal");
        assert!(!backup.backend_files.contains_key("replaceable.png"));
        let raw = fs::read(import_stage_path(&cache)).expect("archive bytes");
        assert!(
            !raw.windows(b"must-not-leak".len())
                .any(|window| window == b"must-not-leak")
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn rejects_unknown_local_storage() {
        let invalid = BTreeMap::from([("binance-api-secret".into(), "secret".into())]);
        assert!(validate_frontend_storage(&invalid).is_err());
    }

    #[test]
    fn rejects_a_manifest_that_does_not_match_archive_content() {
        let root = temp_dir("tamper");
        let cache = root.join("cache");
        fs::create_dir_all(&cache).expect("cache");
        let file = File::create(import_stage_path(&cache)).expect("archive");
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        writer.start_file(FRONTEND_PATH, options).expect("entry");
        writer.write_all(b"{}").expect("frontend");
        let manifest = Manifest {
            format_version: FORMAT_VERSION,
            app_version: "0.1.0".into(),
            created_at_unix_ms: 1,
            entries: vec![ManifestEntry {
                path: FRONTEND_PATH.into(),
                size_bytes: 2,
                sha256: "0".repeat(64),
            }],
        };
        writer.start_file(MANIFEST_PATH, options).expect("manifest");
        writer
            .write_all(&serde_json::to_vec(&manifest).expect("json"))
            .expect("manifest bytes");
        writer.finish().expect("finish");

        assert!(
            inspect_import(&cache)
                .expect_err("tampering must fail")
                .contains("integrity")
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn backend_install_replaces_the_exact_allowed_file_set() {
        let root = temp_dir("install");
        fs::write(root.join("operations.sqlite3"), b"old").expect("old");
        fs::write(root.join("alerts.sqlite3"), b"remove-me").expect("old alerts");
        let incoming = BTreeMap::from([
            ("operations.sqlite3".into(), b"new".to_vec()),
            ("symbols.json".into(), b"{}".to_vec()),
        ]);
        install_backend_files(&root, &incoming).expect("install");
        assert_eq!(fs::read(root.join("operations.sqlite3")).unwrap(), b"new");
        assert_eq!(fs::read(root.join("symbols.json")).unwrap(), b"{}");
        assert!(!root.join("alerts.sqlite3").exists());
        fs::remove_dir_all(root).expect("cleanup");
    }
}
