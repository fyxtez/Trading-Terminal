use std::path::Path;

use axum::{Json, extract::State};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    api::AppState,
    error::{AppError, AppResult},
};

pub(crate) fn backend_id(data_file: &Path) -> AppResult<String> {
    let path = data_file.with_file_name("backend-id");
    if path.exists() {
        let value = std::fs::read_to_string(&path)?;
        uuid::Uuid::parse_str(value.trim())
            .map_err(|_| AppError::Config("Invalid backend identity".into()))?;
        return Ok(value.trim().to_owned());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let id = uuid::Uuid::new_v4().to_string();
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(id.as_bytes())?;
    file.sync_all()?;
    Ok(id)
}

pub(crate) async fn session(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "apiVersion": 1,
        "backendId": state.backend_id,
        "accountScope": state.binance.account_scope(),
        "mode": if state.remote_host { "remote" } else { "local" },
        "binanceConfigured": state.binance.is_configured(),
        "binanceNetwork": if !state.binance.is_configured() { None } else if state.binance.is_testnet() { Some("testnet") } else { Some("mainnet") },
        "capabilities": ["market-data", "durable-intents"]
    }))
}

pub(crate) fn opaque_scope(key: Option<&str>) -> String {
    hex::encode(Sha256::digest(
        format!("fyxtez-account-scope:{}", key.unwrap_or("unconfigured")).as_bytes(),
    ))
}
