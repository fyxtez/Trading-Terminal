use std::{
    io::{BufRead, BufReader, Read},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};

use serde::Deserialize;

use crate::error::{AppError, AppResult};

const MIN_SERVICE_TOKEN_LENGTH: usize = 32;
const MAX_BOOTSTRAP_BYTES: u64 = 16 * 1024;

#[derive(Debug)]
pub struct RuntimeConfig {
    pub address: SocketAddr,
    pub service_token: String,
    pub symbol_registry_path: PathBuf,
    pub icon_cache_dir: PathBuf,
    pub sizing_config_path: PathBuf,
    pub alerts_db_path: PathBuf,
    pub desktop_sidecar: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SidecarBootstrap {
    port: u16,
    service_token: String,
    data_dir: PathBuf,
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

        Ok(Self {
            address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), bootstrap.port),
            service_token: bootstrap.service_token,
            symbol_registry_path: data_dir.join("symbols.json"),
            icon_cache_dir: data_dir.join("icons"),
            sizing_config_path: data_dir.join("sizing.json"),
            alerts_db_path: data_dir.join("alerts.sqlite3"),
            desktop_sidecar: true,
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
            desktop_sidecar: false,
        })
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
    use super::validate_token;

    #[test]
    fn rejects_short_service_tokens() {
        assert!(validate_token("too-short").is_err());
    }

    #[test]
    fn accepts_random_length_service_tokens() {
        assert!(validate_token(&"a".repeat(64)).is_ok());
    }
}
