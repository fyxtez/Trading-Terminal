use std::time::Duration;

use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

use crate::backend_supervisor::{BROWSER_ACCESS_PORT, BackendSupervisor};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const MIN_TICKET_LENGTH: usize = 32;
const MAX_TICKET_LENGTH: usize = 256;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAccessStatus {
    pub supported: bool,
    pub available: bool,
    pub enabled: bool,
    pub browser_url: Option<String>,
    pub active_sessions: u32,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserLaunch {
    url: String,
    #[allow(dead_code)]
    expires_in_ms: u64,
}

#[derive(Debug, Deserialize)]
struct BrowserAccessError {
    error: String,
}

pub async fn status(supervisor: &BackendSupervisor) -> Result<BrowserAccessStatus, String> {
    let status: BrowserAccessStatus =
        request(supervisor, Method::GET, "/api/browser-access/status").await?;
    supervisor.set_browser_access_enabled(status.available && status.enabled);
    Ok(status)
}

pub async fn enable(supervisor: &BackendSupervisor) -> Result<BrowserAccessStatus, String> {
    let status: BrowserAccessStatus =
        request(supervisor, Method::POST, "/api/browser-access/enable").await?;
    supervisor.set_browser_access_enabled(status.available && status.enabled);
    Ok(status)
}

pub async fn disable(supervisor: &BackendSupervisor) -> Result<BrowserAccessStatus, String> {
    // Clear the local mirror immediately; the backend acknowledges disable only
    // after persisting revocation of the browser sessions.
    supervisor.set_browser_access_enabled(false);
    let status = request(supervisor, Method::POST, "/api/browser-access/disable").await?;
    Ok(status)
}

pub async fn open_in_default_browser(
    app: &AppHandle,
    supervisor: &BackendSupervisor,
) -> Result<BrowserAccessStatus, String> {
    let current = status(supervisor).await?;
    let was_enabled = current.available && current.enabled;
    let status = if was_enabled {
        current
    } else {
        enable(supervisor).await?
    };
    if !status.available || !status.enabled {
        return Err(status
            .unavailable_reason
            .clone()
            .unwrap_or_else(|| "Browser access is not available on this computer".to_string()));
    }

    let open_result = async {
        let launch: BrowserLaunch =
            request(supervisor, Method::POST, "/api/browser-access/launch").await?;
        let url = validate_launch_url(&launch.url)?;

        #[allow(deprecated)]
        app.shell()
            .open(url.to_string(), None)
            .map_err(|_| "Could not open the default browser".to_string())?;
        Ok::<(), String>(())
    }
    .await;

    if let Err(error) = open_result {
        if !was_enabled && disable(supervisor).await.is_err() {
            return Err(format!(
                "{error}. Browser access could not be turned back off; retry Disable in Terminal Settings"
            ));
        }
        return Err(error);
    }

    Ok(status)
}

async fn request<T: DeserializeOwned>(
    supervisor: &BackendSupervisor,
    method: Method,
    path: &str,
) -> Result<T, String> {
    let runtime = supervisor.runtime_info().await?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not prepare browser access".to_string())?;

    let response = client
        .request(method, format!("{}{}", runtime.api_base_url, path))
        .bearer_auth(&runtime.api_token)
        .send()
        .await
        .map_err(|_| "Fyxtez did not respond to the browser access request".to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response
            .json::<BrowserAccessError>()
            .await
            .ok()
            .and_then(|body| safe_browser_access_error(&body.error));
        return Err(browser_access_http_error(status, detail.as_deref()));
    }

    response
        .json()
        .await
        .map_err(|_| "Fyxtez returned an invalid browser access response".to_string())
}

fn safe_browser_access_error(value: &str) -> Option<String> {
    const CONFLICT_PREFIX: &str = "Duplicate or conflicting request: ";

    let value = value.trim();
    let value = value.strip_prefix(CONFLICT_PREFIX).unwrap_or(value);
    let safe_prefix = value.starts_with("Browser access ") || value.starts_with("Browser files ");
    if safe_prefix && value.len() <= 240 && value.is_ascii() && !value.chars().any(char::is_control)
    {
        Some(value.to_string())
    } else {
        None
    }
}

fn browser_access_http_error(status: StatusCode, detail: Option<&str>) -> String {
    match status {
        StatusCode::CONFLICT => detail
            .unwrap_or("Browser access is currently unavailable")
            .to_string(),
        StatusCode::NOT_FOUND | StatusCode::NOT_IMPLEMENTED => {
            "This build does not support browser access".into()
        }
        _ => format!("Browser access request failed ({status})"),
    }
}

fn validate_launch_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value)
        .map_err(|_| "Fyxtez returned an invalid browser launch address".to_string())?;
    let expected_port = BROWSER_ACCESS_PORT;
    let valid_origin = url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(expected_port)
        && url.username().is_empty()
        && url.password().is_none();
    let valid_location = url.path() == "/" && url.query().is_none();
    let ticket = url
        .fragment()
        .and_then(|fragment| fragment.strip_prefix("browser-ticket="));
    let valid_ticket = ticket.is_some_and(|ticket| {
        (MIN_TICKET_LENGTH..=MAX_TICKET_LENGTH).contains(&ticket.len())
            && ticket
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    });
    let canonical = ticket.is_some_and(|ticket| {
        value == format!("http://127.0.0.1:{expected_port}/#browser-ticket={ticket}")
    });

    if valid_origin && valid_location && valid_ticket && canonical {
        Ok(url)
    } else {
        Err("Fyxtez returned an unsafe browser launch address".into())
    }
}

#[cfg(test)]
mod tests {
    use reqwest::StatusCode;

    use super::{browser_access_http_error, safe_browser_access_error, validate_launch_url};

    const TICKET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn accepts_only_the_fixed_loopback_launch_origin() {
        let url = validate_launch_url(&format!("http://127.0.0.1:8658/#browser-ticket={TICKET}"))
            .expect("valid local launch URL");
        assert_eq!(url.host_str(), Some("127.0.0.1"));

        for unsafe_url in [
            format!("https://127.0.0.1:8658/#browser-ticket={TICKET}"),
            format!("http://localhost:8658/#browser-ticket={TICKET}"),
            format!("http://@127.0.0.1:8658/#browser-ticket={TICKET}"),
            format!("http://127.0.0.1:8659/#browser-ticket={TICKET}"),
            format!("http://127.0.0.1:8658/other#browser-ticket={TICKET}"),
            format!("http://127.0.0.1:8658/?next=evil#browser-ticket={TICKET}"),
            "http://127.0.0.1:8658/#browser-ticket=short".to_string(),
        ] {
            assert!(
                validate_launch_url(&unsafe_url).is_err(),
                "accepted unsafe URL: {unsafe_url}"
            );
        }
    }

    #[test]
    fn reports_only_safe_browser_access_conflict_details() {
        let collision = safe_browser_access_error(
            "Duplicate or conflicting request: Browser access port 8658 is already in use",
        );
        assert_eq!(
            browser_access_http_error(StatusCode::CONFLICT, collision.as_deref()),
            "Browser access port 8658 is already in use"
        );

        let missing_files = safe_browser_access_error(
            "Duplicate or conflicting request: Browser files are unavailable; reinstall the app",
        );
        assert_eq!(
            browser_access_http_error(StatusCode::CONFLICT, missing_files.as_deref()),
            "Browser files are unavailable; reinstall the app"
        );

        assert!(safe_browser_access_error("secret=/tmp/private-token").is_none());
        assert_eq!(
            browser_access_http_error(StatusCode::CONFLICT, None),
            "Browser access is currently unavailable"
        );
    }

    #[test]
    fn rejects_fragment_injection() {
        for fragment in [
            format!("browser-ticket={TICKET}&next=evil"),
            format!("browser-ticket={TICKET}/evil"),
            format!("other={TICKET}"),
        ] {
            assert!(validate_launch_url(&format!("http://127.0.0.1:8658/#{fragment}")).is_err());
        }
    }
}
