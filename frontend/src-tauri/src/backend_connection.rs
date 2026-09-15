//! The native shell selects a host; it does not own a remote service's lifecycle.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, Manager, Runtime};

#[cfg(desktop)]
use crate::backend_supervisor::BackendSupervisor as LocalSupervisor;
#[cfg(mobile)]
use crate::mobile_backend::BackendSupervisor as LocalSupervisor;
use crate::{
    CredentialStatus,
    credential_store::{CredentialStore, PlatformCredentialStore},
};

const PROFILE_FILE: &str = "backend-connection.json";

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum ConnectionProfile {
    #[default]
    Local,
    Remote {
        url: String,
        #[serde(rename = "backendId")]
        backend_id: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionInput {
    mode: String,
    url: Option<String>,
    token: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeInfo {
    pub api_base_url: String,
    pub api_token: String,
    pub generation: u64,
    pub remote: bool,
    pub scope: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerSession {
    api_version: u32,
    backend_id: String,
    account_scope: String,
    mode: String,
    binance_configured: bool,
    binance_network: Option<String>,
}

enum ActiveConnection {
    Local(LocalSupervisor),
    Remote { url: String, backend_id: String },
}

pub struct BackendSupervisor {
    active: Result<ActiveConnection, String>,
}

fn normalize_url(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value.trim()).map_err(|_| "Enter a valid HTTPS server URL")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(
            "Server URL must be an HTTPS origin without credentials, a path or query".into(),
        );
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

pub(crate) fn token_name(url: &str) -> String {
    format!("remote-backend-{:x}", Sha256::digest(url.as_bytes()))
}

fn read_profile(path: &Path) -> Result<ConnectionProfile, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
            "Saved server connection is invalid. Open Connection settings to replace it.".into()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ConnectionProfile::Local),
        Err(_) => Err("Cannot read saved server connection".into()),
    }
}

fn profile_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(PROFILE_FILE))
        .map_err(|_| "Cannot locate connection settings".into())
}

async fn handshake(
    url: &str,
    token: &str,
    expected_id: Option<&str>,
) -> Result<ServerSession, String> {
    if !(32..=256).contains(&token.len())
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(
            "Enter the server access token (32–256 letters, digits, dashes or underscores)".into(),
        );
    }
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Cannot initialize server connection")?
        .get(format!("{url}/api/session"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Cannot reach the selected server. Check your connection and retry.")?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(
            "Server access was denied. Replace the server access token in Connection settings."
                .into(),
        );
    }
    if !response.status().is_success() {
        return Err(format!(
            "Selected server is unavailable (HTTP {})",
            response.status().as_u16()
        ));
    }
    let session: ServerSession = response
        .json()
        .await
        .map_err(|_| "Server returned an incompatible session")?;
    validate_session(&session, expected_id)?;
    Ok(session)
}

fn validate_session(session: &ServerSession, expected_id: Option<&str>) -> Result<(), String> {
    if session.api_version != 1
        || session.mode != "remote"
        || session.backend_id.is_empty()
        || session.account_scope.is_empty()
        || (session.binance_configured
            && !matches!(
                session.binance_network.as_deref(),
                Some("mainnet" | "testnet")
            ))
        || (!session.binance_configured && session.binance_network.is_some())
    {
        return Err("This server is incompatible with the installed application".into());
    }
    if expected_id.is_some_and(|id| id != session.backend_id) {
        return Err(
            "The server identity changed. Reconnect explicitly in Connection settings.".into(),
        );
    }
    Ok(())
}

impl BackendSupervisor {
    pub fn start<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let active = (|| match read_profile(&profile_path(app)?)? {
            ConnectionProfile::Local => LocalSupervisor::start(app).map(ActiveConnection::Local),
            ConnectionProfile::Remote { url, backend_id } => Ok(ActiveConnection::Remote {
                url: normalize_url(&url)?,
                backend_id,
            }),
        })();
        // A bad remote connection still opens the recovery UI; it never starts
        // a local backend as an implicit fallback.
        Ok(Self { active })
    }

    pub fn is_remote(&self) -> bool {
        !matches!(&self.active, Ok(ActiveConnection::Local(_)))
    }

    pub fn ensure_local(&self) -> Result<(), String> {
        if self.is_remote() {
            Err("This action manages local data. Select Local in Connection settings first.".into())
        } else {
            Ok(())
        }
    }

    async fn remote_session(
        &self,
    ) -> Result<(String, zeroize::Zeroizing<String>, ServerSession), String> {
        let Ok(ActiveConnection::Remote { url, backend_id }) = &self.active else {
            return Err("No remote connection selected".into());
        };
        let token = PlatformCredentialStore
            .read(&token_name(url))?
            .ok_or("Server access token is missing. Open Connection settings.")?;
        let session = handshake(url, &token, Some(backend_id)).await?;
        Ok((url.clone(), token, session))
    }

    pub async fn credential_status(&self) -> Result<CredentialStatus, String> {
        match &self.active {
            Err(error) => Err(error.clone()),
            Ok(ActiveConnection::Local(_)) => {
                crate::credential_status_from(&PlatformCredentialStore)
            }
            Ok(ActiveConnection::Remote { .. }) => {
                let (_, _, session) = self.remote_session().await?;
                Ok(CredentialStatus {
                    binance_configured: session.binance_configured,
                    binance_network: session.binance_network,
                    ntfy_configured: false,
                    telegram_configured: false,
                })
            }
        }
    }

    pub async fn runtime_info(&self) -> Result<DesktopRuntimeInfo, String> {
        match &self.active {
            Err(error) => Err(error.clone()),
            Ok(ActiveConnection::Local(local)) => {
                let info = local.runtime_info().await?;
                Ok(DesktopRuntimeInfo {
                    api_base_url: info.api_base_url,
                    api_token: info.api_token,
                    generation: info.generation,
                    remote: false,
                    scope: "local".into(),
                })
            }
            Ok(ActiveConnection::Remote { .. }) => {
                let (url, token, session) = self.remote_session().await?;
                Ok(DesktopRuntimeInfo {
                    api_base_url: url,
                    api_token: token.to_string(),
                    generation: 1,
                    remote: true,
                    scope: format!(
                        "remote:{}:{}:{}",
                        session.backend_id,
                        session.account_scope,
                        session.binance_network.as_deref().unwrap_or("unconfigured")
                    ),
                })
            }
        }
    }

    pub async fn restart(&self) -> Result<DesktopRuntimeInfo, String> {
        if let Ok(ActiveConnection::Local(local)) = &self.active {
            local.restart().await?;
        }
        self.runtime_info().await
    }

    pub fn request_restart(&self) -> Result<(), String> {
        self.ensure_local()?;
        if let Ok(ActiveConnection::Local(local)) = &self.active {
            local.request_restart()?;
        }
        Ok(())
    }

    pub async fn pause(&self) -> Result<(), String> {
        self.ensure_local()?;
        if let Ok(ActiveConnection::Local(local)) = &self.active {
            local.pause().await?;
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        if let Ok(ActiveConnection::Local(local)) = &self.active {
            local.shutdown();
        }
    }

    #[cfg(desktop)]
    pub fn set_browser_access_enabled(&self, enabled: bool) {
        if let Ok(ActiveConnection::Local(local)) = &self.active {
            local.set_browser_access_enabled(enabled);
        }
    }
}

#[tauri::command]
pub(crate) fn backend_connection_settings(app: AppHandle) -> Result<ConnectionProfile, String> {
    read_profile(&profile_path(&app)?)
}

#[tauri::command]
pub(crate) async fn save_backend_connection(
    app: AppHandle,
    input: ConnectionInput,
) -> Result<(), String> {
    let profile = match input.mode.as_str() {
        "local" => ConnectionProfile::Local,
        "remote" => {
            let url = normalize_url(input.url.as_deref().unwrap_or(""))?;
            let name = token_name(&url);
            let token = zeroize::Zeroizing::new(input.token.unwrap_or_default().trim().to_owned());
            let token = if token.is_empty() {
                PlatformCredentialStore
                    .read(&name)?
                    .ok_or("Enter a server access token")?
            } else {
                token
            };
            let session = handshake(&url, &token, None).await?;
            PlatformCredentialStore.write(&name, &token)?;
            ConnectionProfile::Remote {
                url,
                backend_id: session.backend_id,
            }
        }
        _ => return Err("Choose Local or Private server".into()),
    };
    let path = profile_path(&app)?;
    std::fs::create_dir_all(path.parent().ok_or("Missing connection directory")?)
        .map_err(|_| "Cannot create connection directory")?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec_pretty(&profile).map_err(|_| "Cannot encode connection settings")?,
    )
    .map_err(|_| "Cannot save connection settings")?;
    std::fs::rename(temp, path).map_err(|_| "Cannot install connection settings")?;
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_https_origins_can_receive_the_server_token() {
        for value in [
            "http://example.com",
            "https://user:pass@example.com",
            "https://example.com/path",
            "https://example.com?token=x",
            "https://example.com#x",
        ] {
            assert!(normalize_url(value).is_err());
        }
        assert_eq!(
            normalize_url("https://terminal.fyxtez.com/").unwrap(),
            "https://terminal.fyxtez.com"
        );
    }
    #[test]
    fn a_replaced_server_or_incompatible_version_is_rejected() {
        let mut session = ServerSession {
            api_version: 1,
            backend_id: "server-one".into(),
            account_scope: "account".into(),
            mode: "remote".into(),
            binance_configured: true,
            binance_network: Some("mainnet".into()),
        };
        assert!(validate_session(&session, Some("server-one")).is_ok());
        assert!(validate_session(&session, Some("server-two")).is_err());
        session.api_version = 2;
        assert!(validate_session(&session, None).is_err());
    }
}
