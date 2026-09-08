use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderValue, Method, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{sync::Mutex, time::Instant};

use crate::error::{AppError, AppResult};

use super::api::AppState;

pub(crate) const BROWSER_SESSION_COOKIE: &str = "fyxtez_browser_session";
pub(crate) const BROWSER_PROOF_HEADER: &str = "x-fyxtez-browser-proof";
const LAUNCH_TICKET_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BrowserSessionAuth {
    pub session_id: u64,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RequestAuth {
    Native,
    Browser(BrowserSessionAuth),
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct WebsocketTicket {
    pub expires_at: Instant,
    pub auth: RequestAuth,
}

#[derive(Clone)]
pub(crate) struct BrowserAccessState {
    origin: Option<String>,
    host: Option<String>,
    inner: Arc<Mutex<BrowserAccessInner>>,
}

struct BrowserAccessInner {
    available: bool,
    enabled: bool,
    generation: u64,
    next_session_id: u64,
    unavailable_reason: Option<String>,
    launch_tickets: HashMap<String, Instant>,
    sessions: HashMap<String, BrowserSessionRecord>,
}

#[derive(Debug, Clone)]
struct BrowserSessionRecord {
    auth: BrowserSessionAuth,
    proof_hashes: HashSet<[u8; 32]>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserAccessStatus {
    supported: bool,
    available: bool,
    enabled: bool,
    browser_url: Option<String>,
    active_sessions: usize,
    unavailable_reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserLaunchResponse {
    url: String,
    expires_in_ms: u64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RedeemBrowserTicketRequest {
    ticket: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserSessionResponse {
    mode: &'static str,
    authenticated: bool,
    binance_configured: bool,
    binance_network: Option<&'static str>,
    expires_in_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RedeemedBrowserSessionResponse {
    #[serde(flatten)]
    session: BrowserSessionResponse,
    session_proof: String,
}

impl BrowserAccessState {
    pub(crate) fn disabled() -> Self {
        Self {
            origin: None,
            host: None,
            inner: Arc::new(Mutex::new(BrowserAccessInner {
                available: false,
                enabled: false,
                generation: 0,
                next_session_id: 1,
                unavailable_reason: None,
                launch_tickets: HashMap::new(),
                sessions: HashMap::new(),
            })),
        }
    }

    pub(crate) fn configured(address: std::net::SocketAddr) -> Self {
        let host = address.to_string();
        Self {
            origin: Some(format!("http://{host}")),
            host: Some(host),
            inner: Arc::new(Mutex::new(BrowserAccessInner {
                available: false,
                enabled: false,
                generation: 0,
                next_session_id: 1,
                unavailable_reason: Some("Browser access is starting".into()),
                launch_tickets: HashMap::new(),
                sessions: HashMap::new(),
            })),
        }
    }

    pub(crate) async fn mark_available(&self) {
        let mut inner = self.inner.lock().await;
        inner.available = true;
        inner.unavailable_reason = None;
    }

    pub(crate) async fn mark_unavailable(&self, reason: impl Into<String>) {
        let mut inner = self.inner.lock().await;
        inner.available = false;
        inner.enabled = false;
        inner.generation = inner.generation.wrapping_add(1);
        inner.unavailable_reason = Some(reason.into());
        inner.launch_tickets.clear();
        inner.sessions.clear();
    }

    pub(crate) async fn status(&self) -> BrowserAccessStatus {
        let now = Instant::now();
        let mut inner = self.inner.lock().await;
        remove_expired(&mut inner, now);
        BrowserAccessStatus {
            supported: self.origin.is_some(),
            available: inner.available,
            enabled: inner.enabled,
            browser_url: self.origin.clone(),
            // A browser cookie is shared by tabs, while each redeemed launch
            // ticket creates a separate tab proof. Report those independent
            // tab authorization capabilities rather than only counting cookie
            // jars. They remain counted until revocation;
            // this is not a live count of currently open tabs.
            active_sessions: inner
                .sessions
                .values()
                .map(|record| record.proof_hashes.len())
                .sum(),
            unavailable_reason: inner.unavailable_reason.clone(),
        }
    }

    pub(crate) async fn enable(&self) -> AppResult<BrowserAccessStatus> {
        {
            let mut inner = self.inner.lock().await;
            if !inner.available {
                return Err(AppError::Conflict(
                    inner
                        .unavailable_reason
                        .clone()
                        .unwrap_or_else(|| "Browser access is unavailable".into()),
                ));
            }
            inner.enabled = true;
        }
        Ok(self.status().await)
    }

    pub(crate) async fn disable(&self) -> BrowserAccessStatus {
        {
            let mut inner = self.inner.lock().await;
            inner.enabled = false;
            inner.generation = inner.generation.wrapping_add(1);
            inner.launch_tickets.clear();
            inner.sessions.clear();
        }
        self.status().await
    }

    pub(crate) async fn issue_launch_ticket(&self) -> AppResult<BrowserLaunchResponse> {
        let origin = self
            .origin
            .as_deref()
            .ok_or_else(|| AppError::Conflict("Browser access is not supported".into()))?;
        let now = Instant::now();
        let ticket = random_secret()?;
        let mut inner = self.inner.lock().await;
        remove_expired(&mut inner, now);
        if !inner.available || !inner.enabled {
            return Err(AppError::Conflict(
                "Enable browser access before opening the terminal".into(),
            ));
        }
        inner
            .launch_tickets
            .insert(ticket.clone(), now + LAUNCH_TICKET_TTL);
        Ok(BrowserLaunchResponse {
            // A fragment is intentionally used so the launch secret never
            // reaches access logs or the HTTP request target.
            url: format!("{origin}/#browser-ticket={ticket}"),
            expires_in_ms: duration_millis(LAUNCH_TICKET_TTL),
        })
    }

    pub(crate) async fn redeem(
        &self,
        ticket: &str,
        existing_session: Option<&str>,
    ) -> AppResult<(String, String, BrowserSessionAuth)> {
        let now = Instant::now();
        let mut inner = self.inner.lock().await;
        remove_expired(&mut inner, now);
        if !inner.available || !inner.enabled {
            return Err(AppError::Unauthorized);
        }

        // Removal happens before the expiry check, making every launch ticket
        // one-use even when the caller races with its deadline.
        let expires_at = inner.launch_tickets.remove(ticket);
        if expires_at.is_none_or(|expires_at| expires_at <= now) {
            return Err(AppError::Unauthorized);
        }

        let session_proof = random_secret()?;
        let proof_hash = secret_hash(&session_proof);

        // Cookies are shared by tabs, but sessionStorage (and therefore the
        // proof) is tab-scoped. Reuse an active cookie session and add a proof
        // for the newly opened tab so older tabs do not lose authorization
        // when the shared cookie is overwritten. A missing, malformed or stale
        // cookie starts an independent browser session.
        if let Some((session, record)) = existing_session
            .filter(|session| valid_secret(session))
            .and_then(|session| {
                inner
                    .sessions
                    .get_mut(session)
                    .map(|record| (session.to_owned(), record))
            })
        {
            record.proof_hashes.insert(proof_hash);
            return Ok((session, session_proof, record.auth));
        }

        let session = random_secret()?;
        let auth = BrowserSessionAuth {
            session_id: inner.next_session_id,
            generation: inner.generation,
        };
        inner.next_session_id = inner.next_session_id.wrapping_add(1);
        inner.sessions.insert(
            session.clone(),
            BrowserSessionRecord {
                auth,
                proof_hashes: HashSet::from([proof_hash]),
            },
        );
        Ok((session, session_proof, auth))
    }

    pub(crate) async fn authenticate_cookie(
        &self,
        headers: &HeaderMap,
        method: &Method,
    ) -> AppResult<BrowserSessionAuth> {
        self.validate_browser_headers(headers, is_mutation(method))?;
        let session =
            cookie_value(headers, BROWSER_SESSION_COOKIE).ok_or(AppError::Unauthorized)?;
        if !valid_secret(session) {
            return Err(AppError::Unauthorized);
        }
        let session_proof = headers
            .get(BROWSER_PROOF_HEADER)
            .and_then(|value| value.to_str().ok())
            .filter(|value| valid_secret(value))
            .ok_or(AppError::Unauthorized)?;
        let now = Instant::now();
        let mut inner = self.inner.lock().await;
        remove_expired(&mut inner, now);
        if !inner.available || !inner.enabled {
            return Err(AppError::Unauthorized);
        }
        let record = inner.sessions.get(session).ok_or(AppError::Unauthorized)?;
        if !record.proof_hashes.contains(&secret_hash(session_proof)) {
            return Err(AppError::Unauthorized);
        }
        let auth = record.auth;
        if auth.generation != inner.generation {
            return Err(AppError::Unauthorized);
        }
        Ok(auth)
    }

    pub(crate) async fn session_auth_is_active(&self, auth: BrowserSessionAuth) -> bool {
        let inner = self.inner.lock().await;
        inner.available
            && inner.enabled
            && inner.generation == auth.generation
            && inner.sessions.values().any(|stored| stored.auth == auth)
    }

    pub(crate) fn validate_browser_headers(
        &self,
        headers: &HeaderMap,
        require_origin: bool,
    ) -> AppResult<()> {
        let expected_host = self.host.as_deref().ok_or(AppError::Unauthorized)?;
        let supplied_host = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok());
        if supplied_host != Some(expected_host) {
            return Err(AppError::Unauthorized);
        }

        let expected_origin = self.origin.as_deref().ok_or(AppError::Unauthorized)?;
        let supplied_origin = headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok());
        // Same-origin GET requests commonly omit Origin. If an Origin is
        // present, however, it must always be exact so an allow-listed dev
        // origin cannot read a browser session. Mutations and WebSockets must
        // provide it.
        if (require_origin || supplied_origin.is_some()) && supplied_origin != Some(expected_origin)
        {
            return Err(AppError::Unauthorized);
        }
        Ok(())
    }
}

pub(crate) async fn browser_access_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    require_master_token(&state, &headers)?;
    Ok(no_store_json(state.browser_access.status().await))
}

pub(crate) async fn enable_browser_access(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    require_master_token(&state, &headers)?;
    Ok(no_store_json(state.browser_access.enable().await?))
}

pub(crate) async fn disable_browser_access(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    require_master_token(&state, &headers)?;
    Ok(no_store_json(state.browser_access.disable().await))
}

pub(crate) async fn launch_browser_access(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    require_master_token(&state, &headers)?;
    Ok(no_store_json(
        state.browser_access.issue_launch_ticket().await?,
    ))
}

pub(crate) async fn redeem_browser_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<RedeemBrowserTicketRequest>,
) -> AppResult<Response> {
    state
        .browser_access
        .validate_browser_headers(&headers, true)?;
    if !valid_secret(&request.ticket) {
        return Err(AppError::Unauthorized);
    }
    let existing_session = cookie_value(&headers, BROWSER_SESSION_COOKIE);
    let (session, session_proof, _) = state
        .browser_access
        .redeem(&request.ticket, existing_session)
        .await?;
    let body = RedeemedBrowserSessionResponse {
        session: session_response(&state),
        session_proof,
    };
    let mut response = no_store_json(body);
    // Clear the broader cookie created by pre-hardening builds. Cookie paths
    // are part of a cookie's identity, so replacing it with Path=/api alone
    // would leave the old root-scoped capability behind.
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_static(
            "fyxtez_browser_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        ),
    );
    response
        .headers_mut()
        .append(header::SET_COOKIE, browser_session_cookie(&session)?);
    Ok(response)
}

pub(crate) async fn browser_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    state
        .browser_access
        .authenticate_cookie(&headers, &Method::GET)
        .await?;
    Ok(no_store_json(session_response(&state)))
}

fn no_store_json<T: Serialize>(value: T) -> Response {
    let mut response = Json(value).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    );
    response
        .headers_mut()
        .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response
}

fn session_response(state: &AppState) -> BrowserSessionResponse {
    let configured = state.binance.is_configured();
    BrowserSessionResponse {
        mode: "local-browser",
        authenticated: true,
        binance_configured: configured,
        binance_network: if !configured {
            None
        } else if state.binance.is_testnet() {
            Some("testnet")
        } else {
            Some("mainnet")
        },
        expires_in_ms: None,
    }
}

pub(crate) fn require_master_token(state: &AppState, headers: &HeaderMap) -> AppResult<()> {
    let supplied = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let expected = format!("Bearer {}", state.service_token);
    if supplied != Some(expected.as_str()) {
        return Err(AppError::Unauthorized);
    }
    Ok(())
}

fn remove_expired(inner: &mut BrowserAccessInner, now: Instant) {
    inner
        .launch_tickets
        .retain(|_, expires_at| *expires_at > now);
    let generation = inner.generation;
    inner
        .sessions
        .retain(|_, record| record.auth.generation == generation);
}

fn random_secret() -> AppResult<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| AppError::Config("cannot generate a browser session secret".into()))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn valid_secret(secret: &str) -> bool {
    secret.len() == 64 && secret.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn secret_hash(secret: &str) -> [u8; 32] {
    Sha256::digest(secret.as_bytes()).into()
}

fn browser_session_cookie(session: &str) -> AppResult<HeaderValue> {
    HeaderValue::from_str(&format!(
        "{BROWSER_SESSION_COOKIE}={session}; HttpOnly; SameSite=Strict; Path=/api"
    ))
    .map_err(|_| AppError::Config("cannot create browser session cookie".into()))
}

fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|cookies| cookies.split(';'))
        .filter_map(|cookie| cookie.trim().split_once('='))
        .find_map(|(cookie_name, value)| (cookie_name == name).then_some(value))
}

fn is_mutation(method: &Method) -> bool {
    matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    )
}

fn duration_millis(duration: Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue, Method, header};

    use super::{
        BROWSER_PROOF_HEADER, BROWSER_SESSION_COOKIE, BrowserAccessState, BrowserSessionResponse,
        RedeemedBrowserSessionResponse, browser_session_cookie, cookie_value,
    };

    fn browser_headers(origin: bool) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:8658"));
        if origin {
            headers.insert(
                header::ORIGIN,
                HeaderValue::from_static("http://127.0.0.1:8658"),
            );
        }
        headers
    }

    fn add_session_auth(headers: &mut HeaderMap, session: &str, proof: &str) {
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{BROWSER_SESSION_COOKIE}={session}")).unwrap(),
        );
        headers.insert(BROWSER_PROOF_HEADER, HeaderValue::from_str(proof).unwrap());
    }

    #[test]
    fn redeem_is_the_only_session_payload_that_contains_the_proof() {
        let session = BrowserSessionResponse {
            mode: "local-browser",
            authenticated: true,
            binance_configured: false,
            binance_network: None,
            expires_in_ms: None,
        };
        let ordinary = serde_json::to_value(&session).unwrap();
        assert!(ordinary.get("sessionProof").is_none());

        let redeemed = serde_json::to_value(RedeemedBrowserSessionResponse {
            session,
            session_proof: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .into(),
        })
        .unwrap();
        assert_eq!(
            redeemed
                .get("sessionProof")
                .and_then(|value| value.as_str()),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
    }

    #[test]
    fn browser_cookie_is_scoped_to_the_api_path() {
        let cookie = browser_session_cookie(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let cookie = cookie.to_str().unwrap();
        assert!(cookie.contains("Path=/api"));
        assert!(!cookie.contains("Max-Age="));
        assert!(!cookie.contains("Expires="));
        assert!(!cookie.contains("Path=/;"));
    }

    #[tokio::test]
    async fn launch_tickets_are_one_use_and_disable_revokes_sessions() {
        let state = BrowserAccessState::configured("127.0.0.1:8658".parse().unwrap());
        state.mark_available().await;
        state.enable().await.unwrap();
        let launch = state.issue_launch_ticket().await.unwrap();
        let ticket = launch.url.split("#browser-ticket=").nth(1).unwrap();
        let (session, proof, _) = state.redeem(ticket, None).await.unwrap();
        assert!(state.redeem(ticket, None).await.is_err());

        let mut headers = browser_headers(false);
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{BROWSER_SESSION_COOKIE}={session}")).unwrap(),
        );
        assert!(
            state
                .authenticate_cookie(&headers, &Method::GET)
                .await
                .is_err(),
            "the HttpOnly cookie alone must never authorize browser API access"
        );
        headers.insert(BROWSER_PROOF_HEADER, HeaderValue::from_str(&proof).unwrap());
        assert!(
            state
                .authenticate_cookie(&headers, &Method::GET)
                .await
                .is_ok()
        );
        state.disable().await;
        assert!(
            state
                .authenticate_cookie(&headers, &Method::GET)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn browser_stream_authorization_tracks_revocation_and_availability() {
        let state = BrowserAccessState::configured("127.0.0.1:8658".parse().unwrap());
        state.mark_available().await;
        state.enable().await.unwrap();
        let first_launch = state.issue_launch_ticket().await.unwrap();
        let first_ticket = first_launch.url.split("#browser-ticket=").nth(1).unwrap();
        let (_, _, first_auth) = state.redeem(first_ticket, None).await.unwrap();
        assert!(state.session_auth_is_active(first_auth).await);

        state.disable().await;
        state.enable().await.unwrap();
        assert!(
            !state.session_auth_is_active(first_auth).await,
            "a session from the previous enable generation must stay revoked"
        );

        let second_launch = state.issue_launch_ticket().await.unwrap();
        let second_ticket = second_launch.url.split("#browser-ticket=").nth(1).unwrap();
        let (_, _, second_auth) = state.redeem(second_ticket, None).await.unwrap();
        assert!(state.session_auth_is_active(second_auth).await);
        state.mark_unavailable("backend stopped").await;
        assert!(
            !state.session_auth_is_active(second_auth).await,
            "an unavailable backend must revoke browser streams"
        );
    }

    #[tokio::test]
    async fn sessions_survive_elapsed_time_but_launch_tickets_still_expire() {
        let state = BrowserAccessState::configured("127.0.0.1:8658".parse().unwrap());
        state.mark_available().await;
        state.enable().await.unwrap();
        let launch = state.issue_launch_ticket().await.unwrap();
        let ticket = launch.url.split("#browser-ticket=").nth(1).unwrap();
        let (session, proof, auth) = state.redeem(ticket, None).await.unwrap();
        let unused_launch = state.issue_launch_ticket().await.unwrap();
        let unused_ticket = unused_launch.url.split("#browser-ticket=").nth(1).unwrap();

        {
            let mut inner = state.inner.lock().await;
            super::remove_expired(
                &mut inner,
                tokio::time::Instant::now() + std::time::Duration::from_secs(365 * 24 * 60 * 60),
            );
        }
        let mut headers = browser_headers(false);
        add_session_auth(&mut headers, &session, &proof);
        assert!(
            state
                .authenticate_cookie(&headers, &Method::GET)
                .await
                .is_ok()
        );
        assert!(state.session_auth_is_active(auth).await);
        assert!(state.redeem(unused_ticket, None).await.is_err());
        assert_eq!(state.status().await.active_sessions, 1);

        let restarted = BrowserAccessState::configured("127.0.0.1:8658".parse().unwrap());
        restarted.mark_available().await;
        restarted.enable().await.unwrap();
        assert!(
            restarted
                .authenticate_cookie(&headers, &Method::GET)
                .await
                .is_err()
        );
        assert!(!restarted.session_auth_is_active(auth).await);
    }

    #[tokio::test]
    async fn redeem_adds_independent_tab_proofs_to_an_existing_cookie_session() {
        let state = BrowserAccessState::configured("127.0.0.1:8658".parse().unwrap());
        state.mark_available().await;
        state.enable().await.unwrap();

        let first_launch = state.issue_launch_ticket().await.unwrap();
        let first_ticket = first_launch.url.split("#browser-ticket=").nth(1).unwrap();
        let second_launch = state.issue_launch_ticket().await.unwrap();
        let second_ticket = second_launch.url.split("#browser-ticket=").nth(1).unwrap();

        let (first_session, first_proof, first_auth) =
            state.redeem(first_ticket, None).await.unwrap();
        let (second_session, second_proof, second_auth) = state
            .redeem(second_ticket, Some(&first_session))
            .await
            .unwrap();

        assert_eq!(first_session, second_session);
        assert_ne!(first_proof, second_proof);
        assert_eq!(first_auth, second_auth);
        assert_eq!(state.status().await.active_sessions, 2);
        assert!(state.session_auth_is_active(first_auth).await);

        let mut first_tab_headers = browser_headers(false);
        add_session_auth(&mut first_tab_headers, &first_session, &first_proof);
        assert!(
            state
                .authenticate_cookie(&first_tab_headers, &Method::GET)
                .await
                .is_ok(),
            "opening a second tab must not revoke the first tab's proof"
        );

        let mut second_tab_headers = browser_headers(false);
        add_session_auth(&mut second_tab_headers, &second_session, &second_proof);
        assert!(
            state
                .authenticate_cookie(&second_tab_headers, &Method::GET)
                .await
                .is_ok()
        );

        let unknown_proof = ["0".repeat(64), "1".repeat(64), "2".repeat(64)]
            .into_iter()
            .find(|candidate| candidate != &first_proof && candidate != &second_proof)
            .unwrap();
        second_tab_headers.insert(
            BROWSER_PROOF_HEADER,
            HeaderValue::from_str(&unknown_proof).unwrap(),
        );
        assert!(
            state
                .authenticate_cookie(&second_tab_headers, &Method::GET)
                .await
                .is_err(),
            "a shared cookie paired with an unknown tab proof must be rejected"
        );
    }

    #[tokio::test]
    async fn different_browser_cookies_are_independent_and_disable_revokes_all_tabs() {
        let state = BrowserAccessState::configured("127.0.0.1:8658".parse().unwrap());
        state.mark_available().await;
        state.enable().await.unwrap();

        let first_launch = state.issue_launch_ticket().await.unwrap();
        let first_ticket = first_launch.url.split("#browser-ticket=").nth(1).unwrap();
        let (first_session, first_proof, first_auth) =
            state.redeem(first_ticket, None).await.unwrap();

        let second_launch = state.issue_launch_ticket().await.unwrap();
        let second_ticket = second_launch.url.split("#browser-ticket=").nth(1).unwrap();
        let (second_session, second_proof, second_auth) =
            state.redeem(second_ticket, None).await.unwrap();

        assert_ne!(first_session, second_session);
        assert_ne!(first_proof, second_proof);
        assert_ne!(first_auth.session_id, second_auth.session_id);
        assert_eq!(state.status().await.active_sessions, 2);

        let mut first_headers = browser_headers(false);
        add_session_auth(&mut first_headers, &first_session, &first_proof);
        let mut second_headers = browser_headers(false);
        add_session_auth(&mut second_headers, &second_session, &second_proof);
        assert!(
            state
                .authenticate_cookie(&first_headers, &Method::GET)
                .await
                .is_ok()
        );
        assert!(
            state
                .authenticate_cookie(&second_headers, &Method::GET)
                .await
                .is_ok()
        );

        let mut mismatched_headers = browser_headers(false);
        add_session_auth(&mut mismatched_headers, &second_session, &first_proof);
        assert!(
            state
                .authenticate_cookie(&mismatched_headers, &Method::GET)
                .await
                .is_err(),
            "a proof from a different browser cookie must not authenticate"
        );

        let status = state.disable().await;
        assert_eq!(status.active_sessions, 0);
        assert!(
            state
                .authenticate_cookie(&first_headers, &Method::GET)
                .await
                .is_err()
        );
        assert!(
            state
                .authenticate_cookie(&second_headers, &Method::GET)
                .await
                .is_err()
        );
        assert!(!state.session_auth_is_active(first_auth).await);
        assert!(!state.session_auth_is_active(second_auth).await);
    }

    #[tokio::test]
    async fn cookie_mutations_require_the_exact_browser_origin() {
        let state = BrowserAccessState::configured("127.0.0.1:8658".parse().unwrap());
        assert!(
            state
                .validate_browser_headers(&browser_headers(true), true)
                .is_ok()
        );
        assert!(
            state
                .validate_browser_headers(&browser_headers(false), true)
                .is_err()
        );
        let mut wrong = browser_headers(true);
        wrong.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:8658"),
        );
        assert!(state.validate_browser_headers(&wrong, true).is_err());
        assert!(state.validate_browser_headers(&wrong, false).is_err());
    }

    #[test]
    fn cookie_parser_does_not_confuse_similar_names() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("other=1; fyxtez_browser_session=right; suffix=2"),
        );
        assert_eq!(
            cookie_value(&headers, BROWSER_SESSION_COOKIE),
            Some("right")
        );
        assert_eq!(cookie_value(&headers, "browser_session"), None);
    }
}
