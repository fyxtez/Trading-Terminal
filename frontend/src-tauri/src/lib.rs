use keyring::Entry;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const SERVICE: &str = "com.fyxtez.terminal";

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialStatus {
    binance_configured: bool,
    ntfy_configured: bool,
    telegram_configured: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialInput {
    binance_api_key: Option<String>,
    binance_api_secret: Option<String>,
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
    entry(name)
        .and_then(|value| value.get_password().map_err(|error| error.to_string()))
        .is_ok()
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
    CredentialStatus {
        binance_configured: has_secret("binance-api-key") && has_secret("binance-api-secret"),
        ntfy_configured: has_secret("ntfy-url"),
        telegram_configured: has_secret("telegram-bot-token") && has_secret("telegram-chat-id"),
    }
}

async fn notify_backend_credentials_changed() -> Result<(), String> {
    let response = reqwest::Client::new()
        .post("http://127.0.0.1:8657/api/desktop/credentials/reload")
        .send()
        .await
        .map_err(|error| format!("credentials were saved, but backend reload failed: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(format!(
            "credentials were saved, but backend rejected them ({status}): {detail}"
        ));
    }

    Ok(())
}

#[tauri::command]
async fn save_credentials(input: CredentialInput) -> Result<CredentialStatus, String> {
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
            let api_key = Zeroizing::new(api_key.trim().to_owned());
            let api_secret = Zeroizing::new(api_secret.trim().to_owned());
            if api_key.is_empty() || api_secret.is_empty() {
                return Err("Enter both the Binance API key and secret".into());
            }
            store("binance-api-key", &api_key)?;
            store("binance-api-secret", &api_secret)?;
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
    notify_backend_credentials_changed().await?;
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
async fn clear_credentials() -> Result<CredentialStatus, String> {
    for name in [
        "binance-api-key",
        "binance-api-secret",
        "ntfy-url",
        "telegram-bot-token",
        "telegram-chat-id",
    ] {
        remove(name);
    }
    notify_backend_credentials_changed().await?;
    Ok(credential_status())
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

    let client = reqwest::Client::new();

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
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            credential_status,
            save_credentials,
            clear_credentials,
            send_notification
        ])
        .run(tauri::generate_context!())
        .expect("error while running Fyxtez Terminal desktop");
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
