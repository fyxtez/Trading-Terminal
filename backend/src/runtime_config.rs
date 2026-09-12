use std::{
    io::{BufRead, BufReader, Read},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};

use serde::Deserialize;

use crate::error::{AppError, AppResult};

const MIN_SERVICE_TOKEN_LENGTH: usize = 32;
const MAX_BOOTSTRAP_BYTES: u64 = 16 * 1024;
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub const DESKTOP_BROWSER_PORT: u16 = 8658;

#[derive(Debug)]
pub struct BrowserRuntimeConfig {
    pub address: SocketAddr,
    pub ui_dir: PathBuf,
}

#[derive(Debug)]
pub struct RuntimeConfig {
    pub address: SocketAddr,
    pub service_token: String,
    pub symbol_registry_path: PathBuf,
    pub icon_cache_dir: PathBuf,
    pub sizing_config_path: PathBuf,
    pub alerts_db_path: PathBuf,
    pub operation_journal_path: PathBuf,
    pub use_secure_network: bool,
    pub parent_process_guard: bool,
    pub browser: Option<BrowserRuntimeConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SidecarBootstrap {
    port: u16,
    service_token: String,
    data_dir: PathBuf,
    #[serde(default)]
    browser_port: Option<u16>,
    #[serde(default)]
    browser_ui_dir: Option<PathBuf>,
}

impl RuntimeConfig {
    pub fn load() -> AppResult<Self> {
        if std::env::var_os("FYXTEZ_DESKTOP_SIDECAR").is_some() {
            Self::from_sidecar_stdin()
        } else {
            dotenvy::dotenv().ok();
            Self::from_environment()
        }
    }

    fn from_sidecar_stdin() -> AppResult<Self> {
        let mut payload = String::new();
        BufReader::new(std::io::stdin())
            .take(MAX_BOOTSTRAP_BYTES + 1)
            .read_line(&mut payload)?;

        if payload.is_empty() || payload.len() as u64 > MAX_BOOTSTRAP_BYTES {
            return Err(AppError::Config(
                "desktop bootstrap payload is missing or too large".into(),
            ));
        }

        let bootstrap: SidecarBootstrap = serde_json::from_str(payload.trim_end())
            .map_err(|error| AppError::Config(format!("invalid desktop bootstrap: {error}")))?;
        validate_token(&bootstrap.service_token)?;
        if bootstrap.port == 0 {
            return Err(AppError::Config(
                "desktop bootstrap port must not be zero".into(),
            ));
        }

        std::fs::create_dir_all(&bootstrap.data_dir)?;
        let data_dir = bootstrap.data_dir;
        let browser = browser_config(bootstrap.browser_port, bootstrap.browser_ui_dir)?;

        Ok(Self {
            address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), bootstrap.port),
            service_token: bootstrap.service_token,
            symbol_registry_path: data_dir.join("symbols.json"),
            icon_cache_dir: data_dir.join("icons"),
            sizing_config_path: data_dir.join("sizing.json"),
            alerts_db_path: data_dir.join("alerts.sqlite3"),
            operation_journal_path: data_dir.join("operations.sqlite3"),
            use_secure_network: true,
            parent_process_guard: true,
            browser,
        })
    }

    fn from_environment() -> AppResult<Self> {
        let service_token = std::env::var("SERVICE_API_TOKEN")
            .map_err(|_| AppError::Config("SERVICE_API_TOKEN must be set".into()))?;
        validate_token(&service_token)?;

        let host = std::env::var("SERVER_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let port = std::env::var("SERVER_PORT")
            .unwrap_or_else(|_| "8657".into())
            .parse::<u16>()
            .map_err(|_| AppError::Config("SERVER_PORT must be a valid u16".into()))?;
        let address = format!("{host}:{port}")
            .parse::<SocketAddr>()
            .map_err(|_| {
                AppError::Config("SERVER_HOST/SERVER_PORT form an invalid address".into())
            })?;

        Ok(Self {
            address,
            service_token,
            symbol_registry_path: env_path("SYMBOL_REGISTRY_PATH", "data/symbols.json"),
            icon_cache_dir: env_path("ICON_CACHE_DIR", "data/icons"),
            sizing_config_path: env_path("SIZING_CONFIG_PATH", "data/sizing.json"),
            alerts_db_path: env_path("ALERTS_DB_PATH", "data/alerts.sqlite3"),
            operation_journal_path: env_path("OPERATION_JOURNAL_PATH", "data/operations.sqlite3"),
            use_secure_network: false,
            parent_process_guard: false,
            browser: None,
        })
    }

    pub fn embedded(
        address: SocketAddr,
        service_token: String,
        data_dir: PathBuf,
    ) -> AppResult<Self> {
        validate_token(&service_token)?;
        if !address.ip().is_loopback() || address.port() == 0 {
            return Err(AppError::Config(
                "embedded backend must use a non-zero loopback address".into(),
            ));
        }
        std::fs::create_dir_all(&data_dir)?;

        Ok(Self {
            address,
            service_token,
            symbol_registry_path: data_dir.join("symbols.json"),
            icon_cache_dir: data_dir.join("icons"),
            sizing_config_path: data_dir.join("sizing.json"),
            alerts_db_path: data_dir.join("alerts.sqlite3"),
            operation_journal_path: data_dir.join("operations.sqlite3"),
            use_secure_network: true,
            parent_process_guard: false,
            browser: None,
        })
    }
}

fn browser_config(
    browser_port: Option<u16>,
    browser_ui_dir: Option<PathBuf>,
) -> AppResult<Option<BrowserRuntimeConfig>> {
    match (browser_port, browser_ui_dir) {
        (None, None) => Ok(None),
        (Some(port), Some(ui_dir)) => {
            #[cfg(not(any(target_os = "linux", target_os = "windows")))]
            {
                let _ = (port, ui_dir);
                return Ok(None);
            }

            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                if port != DESKTOP_BROWSER_PORT {
                    return Err(AppError::Config(format!(
                        "desktop browser port must be {DESKTOP_BROWSER_PORT}"
                    )));
                }
                if ui_dir.as_os_str().is_empty() {
                    return Err(AppError::Config(
                        "desktop browser UI directory must not be empty".into(),
                    ));
                }
                Ok(Some(BrowserRuntimeConfig {
                    address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
                    ui_dir,
                }))
            }
        }
        _ => Err(AppError::Config(
            "desktop browser port and UI directory must be supplied together".into(),
        )),
    }
}

/// Keep the desktop backend bound to the lifetime of the Tauri process.
///
/// The shell keeps the sidecar's stdin pipe open after writing the bootstrap
/// line. Every operating system closes that pipe if the parent exits, even
/// when it is killed before Tauri can run its normal shutdown callback.
pub fn spawn_parent_lifetime_guard() -> AppResult<()> {
    std::thread::Builder::new()
        .name("fyxtez-parent-guard".into())
        .spawn(|| {
            let mut stdin = std::io::stdin().lock();
            let mut buffer = [0_u8; 64];

            loop {
                match stdin.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(_) => break,
                }
            }

            // The parent is already unavailable, so immediate termination is
            // safer than leaving a credential-bearing loopback API orphaned.
            std::process::exit(0);
        })?;
    Ok(())
}

fn env_path(name: &str, default: &str) -> PathBuf {
    std::env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(default))
}

fn validate_token(token: &str) -> AppResult<()> {
    if token.len() < MIN_SERVICE_TOKEN_LENGTH || token.starts_with("replace-with-") {
        return Err(AppError::Config(format!(
            "service token must be a non-placeholder random value containing at least {MIN_SERVICE_TOKEN_LENGTH} characters"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{net::SocketAddr, path::PathBuf};

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    use super::DESKTOP_BROWSER_PORT;
    use super::{RuntimeConfig, browser_config, validate_token};

    #[test]
    fn rejects_short_service_tokens() {
        assert!(validate_token("too-short").is_err());
    }

    #[test]
    fn accepts_random_length_service_tokens() {
        assert!(validate_token(&"a".repeat(64)).is_ok());
    }

    #[test]
    fn embedded_runtime_requires_loopback() {
        let token = "a".repeat(64);
        assert!(
            RuntimeConfig::embedded(
                "127.0.0.1:43123".parse::<SocketAddr>().unwrap(),
                token.clone(),
                PathBuf::from("data"),
            )
            .is_ok()
        );
        assert!(
            RuntimeConfig::embedded(
                "0.0.0.0:43123".parse::<SocketAddr>().unwrap(),
                token,
                PathBuf::from("data"),
            )
            .is_err()
        );
    }

    #[test]
    fn browser_bootstrap_fields_are_all_or_nothing() {
        assert!(browser_config(None, None).unwrap().is_none());
        assert!(
            browser_config(Some(8658), None)
                .unwrap_err()
                .to_string()
                .contains("supplied together")
        );
        assert!(
            browser_config(None, Some(PathBuf::from("ui")))
                .unwrap_err()
                .to_string()
                .contains("supplied together")
        );
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn desktop_browser_bootstrap_uses_the_stable_loopback_origin() {
        let browser = browser_config(
            Some(DESKTOP_BROWSER_PORT),
            Some(PathBuf::from("browser-ui")),
        )
        .unwrap()
        .unwrap();
        assert_eq!(browser.address.to_string(), "127.0.0.1:8658");
        assert_eq!(browser.ui_dir, PathBuf::from("browser-ui"));
        assert!(browser_config(Some(9000), Some(PathBuf::from("ui"))).is_err());
    }
}
