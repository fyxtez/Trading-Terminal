mod backend_supervisor;

use backend_supervisor::{BackendSupervisor, DesktopRuntimeInfo};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use zeroize::Zeroizing;

const SERVICE: &str = "com.fyxtez.terminal";
const BINANCE_NETWORK: &str = "binance-network";

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialStatus {
    binance_configured: bool,
    binance_network: Option<String>,
    ntfy_configured: bool,
    telegram_configured: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialInput {
    binance_api_key: Option<String>,
    binance_api_secret: Option<String>,
    binance_network: Option<String>,
    confirm_mainnet: Option<bool>,
    ntfy_url: Option<String>,
    telegram_bot_token: Option<String>,
    telegram_chat_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotificationInput {
    title: String,
    body: String,
    click_url: String,
}

fn entry(name: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, name).map_err(|error| format!("credential store unavailable: {error}"))
}

fn has_secret(name: &str) -> bool {
    read_secret(name).is_ok_and(|value| value.is_some())
}

fn read_secret(name: &str) -> Result<Option<Zeroizing<String>>, String> {
    match entry(name)?.get_password() {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(Zeroizing::new(value))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("failed to read {name}: {error}")),
    }
}

fn store(name: &str, value: &str) -> Result<(), String> {
    entry(name)?
        .set_password(value)
        .map_err(|error| format!("failed to store {name}: {error}"))
}

fn validate_http_url(name: &str, value: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(value).map_err(|_| format!("{name} must be a valid URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(format!("{name} must use http or https and include a host"));
    }
    Ok(())
}

fn remove(name: &str) {
    if let Ok(value) = entry(name) {
        let _ = value.delete_credential();
    }
}

#[tauri::command]
fn credential_status() -> CredentialStatus {
    let binance_network = read_secret(BINANCE_NETWORK)
        .ok()
        .flatten()
        .map(|value| value.to_string())
        .filter(|value| matches!(value.as_str(), "mainnet" | "testnet"));
    CredentialStatus {
        binance_configured: binance_network.is_some()
            && has_secret("binance-api-key")
            && has_secret("binance-api-secret"),
        binance_network,
        ntfy_configured: has_secret("ntfy-url"),
        telegram_configured: has_secret("telegram-bot-token") && has_secret("telegram-chat-id"),
    }
}

#[tauri::command]
async fn save_credentials(
    input: CredentialInput,
    supervisor: State<'_, BackendSupervisor>,
) -> Result<CredentialStatus, String> {
    if let Some(value) = input
        .ntfy_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        validate_http_url("ntfy URL", value)?;
    }

    match (input.binance_api_key, input.binance_api_secret) {
        (Some(api_key), Some(api_secret)) => {
            let network = input
                .binance_network
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Choose Binance Mainnet or Testnet".to_string())?;
            if !matches!(network, "mainnet" | "testnet") {
                return Err("Binance network must be mainnet or testnet".into());
            }
            if network == "mainnet" && input.confirm_mainnet != Some(true) {
                return Err("Confirm that Binance Mainnet uses real funds".into());
            }
            let api_key = Zeroizing::new(api_key.trim().to_owned());
            let api_secret = Zeroizing::new(api_secret.trim().to_owned());
            if api_key.is_empty() || api_secret.is_empty() {
                return Err("Enter both the Binance API key and secret".into());
            }
            store("binance-api-key", &api_key)?;
            store("binance-api-secret", &api_secret)?;
            store(BINANCE_NETWORK, network)?;
        }
        (None, None) => {}
        _ => return Err("Enter both the Binance API key and secret".into()),
    }
    if let Some(value) = input.ntfy_url.as_deref() {
        store_optional("ntfy-url", Some(value))?;
    }
    if let Some(value) = input.telegram_bot_token.as_deref() {
        store_optional("telegram-bot-token", Some(value))?;
    }
    if let Some(value) = input.telegram_chat_id.as_deref() {
        store_optional("telegram-chat-id", Some(value))?;
    }
    supervisor.restart().await?;
    Ok(credential_status())
}

fn store_optional(name: &str, value: Option<&str>) -> Result<(), String> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => store(name, value),
        None => {
            remove(name);
            Ok(())
        }
    }
}

#[tauri::command]
async fn clear_credentials(
    supervisor: State<'_, BackendSupervisor>,
) -> Result<CredentialStatus, String> {
    for name in [
        "binance-api-key",
        "binance-api-secret",
        BINANCE_NETWORK,
        "ntfy-url",
        "telegram-bot-token",
        "telegram-chat-id",
    ] {
        remove(name);
    }
    supervisor.restart().await?;
    Ok(credential_status())
}

#[tauri::command]
async fn desktop_runtime(
    supervisor: State<'_, BackendSupervisor>,
) -> Result<DesktopRuntimeInfo, String> {
    supervisor.runtime_info().await
}

#[tauri::command]
async fn restart_backend(
    supervisor: State<'_, BackendSupervisor>,
) -> Result<DesktopRuntimeInfo, String> {
    supervisor.restart().await
}

#[tauri::command]
async fn send_notification(input: NotificationInput) -> Result<(), String> {
    if input.title.trim().is_empty()
        || input.title.len() > 160
        || input.body.trim().is_empty()
        || input.body.len() > 8_000
        || !matches!(
            input.click_url.split_once("://").map(|(scheme, _)| scheme),
            Some("http" | "https")
        )
    {
        return Err("invalid notification content".into());
    }

    let ntfy_url = read_secret("ntfy-url")?;
    let telegram = match (
        read_secret("telegram-bot-token")?,
        read_secret("telegram-chat-id")?,
    ) {
        (Some(token), Some(chat_id)) => Some((token, chat_id)),
        (None, None) => None,
        _ => return Err("Telegram token and chat ID must both be configured".into()),
    };

    if ntfy_url.is_none() && telegram.is_none() {
        return Err("No notification connection is configured".into());
    }

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|_| "Could not initialize notification delivery".to_string())?;

    let mut failures = Vec::new();

    if let Some((bot_token, chat_id)) = telegram {
        let response = client
            .post(format!(
                "https://api.telegram.org/bot{}/sendMessage",
                bot_token.as_str()
            ))
            .json(&serde_json::json!({
                "chat_id": chat_id.as_str(),
                "text": input.body.as_str(),
            }))
            .send()
            .await
            .map_err(|_| "Telegram request failed".to_string());

        match response {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => failures.push(format!(
                "Telegram rejected the notification ({})",
                response.status()
            )),
            Err(error) => failures.push(error),
        }
    }

    if let Some(url) = ntfy_url {
        let response = client
            .post(url.as_str())
            .header("Title", input.title)
            .header("Click", input.click_url)
            .body(input.body)
            .send()
            .await
            .map_err(|_| "ntfy request failed".to_string());

        match response {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => failures.push(format!(
                "ntfy rejected the notification ({})",
                response.status()
            )),
            Err(error) => failures.push(error),
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let supervisor = BackendSupervisor::start(app.handle()).map_err(|error| {
                std::io::Error::other(format!("backend startup failed: {error}"))
            })?;
            app.manage(supervisor);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_runtime,
            restart_backend,
            credential_status,
            save_credentials,
            clear_credentials,
            send_notification
        ])
        .build(tauri::generate_context!())
        .expect("error while building Fyxtez Terminal desktop");

    app.run(|app, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            app.state::<BackendSupervisor>().shutdown();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::validate_http_url;

    #[test]
    fn accepts_https_notification_url() {
        assert!(validate_http_url("ntfy URL", "https://ntfy.sh/private-topic").is_ok());
    }

    #[test]
    fn rejects_non_http_notification_url() {
        assert!(validate_http_url("ntfy URL", "file:///tmp/topic").is_err());
    }

    #[test]
    fn rejects_notification_url_without_host() {
        assert!(validate_http_url("ntfy URL", "https://").is_err());
    }
}
