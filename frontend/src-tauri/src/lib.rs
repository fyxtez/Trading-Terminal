#[cfg(desktop)]
mod backend_supervisor;
mod binance_credentials;
#[cfg(mobile)]
mod mobile_backend;

#[cfg(desktop)]
use backend_supervisor::{BackendSupervisor, DesktopRuntimeInfo};
#[cfg(not(target_os = "android"))]
use keyring::{Entry, Error as KeyringError};
#[cfg(target_os = "android")]
use keyring_core::{Entry, Error as KeyringError};
#[cfg(mobile)]
use mobile_backend::{BackendSupervisor, DesktopRuntimeInfo};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use zeroize::Zeroizing;

use binance_credentials::validate_binance_credentials;

const SERVICE: &str = "com.fyxtez.terminal";
const BINANCE_NETWORK: &str = "binance-network";
const NTFY_PUBLIC_BASE_URL: &str = "https://ntfy.sh";
const MAX_URL_LENGTH: usize = 2_048;
const MAX_CREDENTIAL_LENGTH: usize = 256;
const EXTERNAL_NOTIFICATION_CONNECTIONS_ENABLED: bool = false;

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

#[allow(dead_code)]
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
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!("failed to read {name}: {error}")),
    }
}

fn store(name: &str, value: &str) -> Result<(), String> {
    entry(name)?
        .set_password(value)
        .map_err(|error| format!("failed to store {name}: {error}"))
}

fn validate_http_url(name: &str, value: &str) -> Result<(), String> {
    if value.len() > MAX_URL_LENGTH {
        return Err(format!("{name} is too long"));
    }
    let parsed = reqwest::Url::parse(value).map_err(|_| format!("{name} must be a valid URL"))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(format!("{name} must use http or https and include a host"));
    }
    Ok(())
}

fn validate_secret(name: &str, value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.len() < 16
        || value.len() > MAX_CREDENTIAL_LENGTH
        || value.chars().any(char::is_whitespace)
    {
        return Err(format!(
            "{name} must contain 16 to {MAX_CREDENTIAL_LENGTH} non-whitespace characters"
        ));
    }
    Ok(value.to_owned())
}

fn validate_telegram_token(value: &str) -> Result<String, String> {
    let value = validate_secret("Telegram bot token", value)?;
    let (bot_id, secret) = value
        .split_once(':')
        .ok_or_else(|| "Telegram bot token has an invalid format".to_string())?;
    if bot_id.is_empty()
        || !bot_id.bytes().all(|byte| byte.is_ascii_digit())
        || secret.is_empty()
        || !secret
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Telegram bot token has an invalid format".into());
    }
    Ok(value)
}

fn validate_telegram_chat_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    let digits = value.strip_prefix('-').unwrap_or(value);
    if value.is_empty()
        || value.len() > 32
        || digits.is_empty()
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("Telegram chat ID must be a numeric ID".into());
    }
    Ok(value.to_owned())
}

fn normalize_ntfy_destination(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.contains("://") {
        validate_http_url("ntfy URL", value)?;
        return Ok(value.to_owned());
    }

    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(
            "ntfy topic must contain only letters, numbers, dashes or underscores and be at most 64 characters"
                .into(),
        );
    }

    Ok(format!("{NTFY_PUBLIC_BASE_URL}/{value}"))
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
        ntfy_configured: false,
        telegram_configured: false,
    }
}

#[tauri::command]
async fn save_credentials(
    input: CredentialInput,
    supervisor: State<'_, BackendSupervisor>,
) -> Result<CredentialStatus, String> {
    if !EXTERNAL_NOTIFICATION_CONNECTIONS_ENABLED
        && (input.ntfy_url.is_some()
            || input.telegram_bot_token.is_some()
            || input.telegram_chat_id.is_some())
    {
        return Err("External notification connections are not available".into());
    }

    let normalized_ntfy_url = input
        .ntfy_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(normalize_ntfy_destination)
        .transpose()?;
    let normalized_telegram_token = input
        .telegram_bot_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(validate_telegram_token)
        .transpose()?;
    let normalized_telegram_chat_id = input
        .telegram_chat_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(validate_telegram_chat_id)
        .transpose()?;
    if normalized_telegram_token.is_some() != normalized_telegram_chat_id.is_some() {
        return Err("Telegram token and chat ID must both be provided".into());
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
            let api_key = Zeroizing::new(validate_secret("Binance API key", &api_key)?);
            let api_secret = Zeroizing::new(validate_secret("Binance API secret", &api_secret)?);
            validate_binance_credentials(&api_key, &api_secret, network).await?;
            store("binance-api-key", &api_key)?;
            store("binance-api-secret", &api_secret)?;
            store(BINANCE_NETWORK, network)?;
        }
        (None, None) => {}
        _ => return Err("Enter both the Binance API key and secret".into()),
    }
    if input.ntfy_url.is_some() {
        store_optional("ntfy-url", normalized_ntfy_url.as_deref())?;
    }
    if input.telegram_bot_token.is_some() {
        store_optional("telegram-bot-token", normalized_telegram_token.as_deref())?;
    }
    if input.telegram_chat_id.is_some() {
        store_optional("telegram-chat-id", normalized_telegram_chat_id.as_deref())?;
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
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
#[allow(dead_code)]
async fn send_notification(input: NotificationInput) -> Result<(), String> {
    if input.title.trim().is_empty()
        || input.title.chars().count() > 160
        || input.body.trim().is_empty()
        || input.body.chars().count() > 8_000
    {
        return Err("invalid notification content".into());
    }
    validate_http_url("notification click URL", input.click_url.trim())?;

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
        .redirect(reqwest::redirect::Policy::none())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init());

    let app = builder
        .setup(|app| {
            #[cfg(all(debug_assertions, desktop))]
            if let Some(window) = app.get_webview_window("main") {
                window.set_fullscreen(false)?;
                window.set_size(tauri::LogicalSize::new(1280.0, 800.0))?;
                window.center()?;
            }

            #[cfg(target_os = "android")]
            keyring_core::set_default_store(
                android_native_keyring_store::Store::new_with_configuration(
                    &std::collections::HashMap::new(),
                )
                .map_err(|error| {
                    std::io::Error::other(format!("Android credential store failed: {error}"))
                })?,
            );

            #[cfg(mobile)]
            fyxtez_backend::init_tracing();

            let supervisor = BackendSupervisor::start(app.handle()).map_err(|error| {
                std::io::Error::other(format!("backend startup failed: {error}"))
            })?;
            app.manage(supervisor);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_runtime,
            restart_backend,
            exit_app,
            credential_status,
            save_credentials,
            clear_credentials
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
    use super::{
        normalize_ntfy_destination, validate_http_url, validate_secret, validate_telegram_chat_id,
        validate_telegram_token,
    };

    #[test]
    fn expands_an_ntfy_topic_to_the_public_publish_url() {
        assert_eq!(
            normalize_ntfy_destination(" private_topic-42 ").as_deref(),
            Ok("https://ntfy.sh/private_topic-42")
        );
    }

    #[test]
    fn preserves_a_complete_ntfy_publish_url() {
        assert_eq!(
            normalize_ntfy_destination("https://notify.example.test/private-topic").as_deref(),
            Ok("https://notify.example.test/private-topic")
        );
    }

    #[test]
    fn rejects_an_invalid_short_ntfy_topic() {
        assert!(normalize_ntfy_destination("not a private topic").is_err());
        assert!(normalize_ntfy_destination(&"a".repeat(65)).is_err());
    }

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

    #[test]
    fn rejects_urls_with_embedded_credentials_or_excessive_length() {
        assert!(validate_http_url("ntfy URL", "https://user:secret@example.test/topic").is_err());
        assert!(
            validate_http_url(
                "ntfy URL",
                &format!("https://example.test/{}", "a".repeat(2_100))
            )
            .is_err()
        );
    }

    #[test]
    fn validates_binance_secret_shape_without_exposing_its_value() {
        assert!(validate_secret("Binance API key", "a-valid-secret-value").is_ok());
        assert!(validate_secret("Binance API key", "short").is_err());
        assert!(validate_secret("Binance API key", "contains whitespace").is_err());
    }

    #[test]
    fn validates_telegram_connection_as_a_pair_of_strict_values() {
        assert!(validate_telegram_token("123456789:abc_DEF-1234567890").is_ok());
        assert!(validate_telegram_token("not-a-bot-token").is_err());
        assert!(validate_telegram_chat_id("-1001234567890").is_ok());
        assert!(validate_telegram_chat_id("@public-channel").is_err());
    }
}
