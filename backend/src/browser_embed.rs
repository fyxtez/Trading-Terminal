//! Explicit pairing for the isolated OpCore frame. Credentials never cross postMessage.
use super::*;
use axum::extract::Query;

pub(crate) const EMBEDDED_SESSION_HEADER: &str = "x-fyxtez-embedded-session";
const PAIR_TTL: Duration = Duration::from_secs(180);
const MAX_PENDING: usize = 64;
const FRAME_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://127.0.0.1:37373",
];

pub(crate) fn frame_ancestors() -> String {
    let mut origins = FRAME_ORIGINS.join(" ");
    if cfg!(debug_assertions) {
        origins.push_str(" http://127.0.0.1:1420 http://127.0.0.1:31420");
    }
    origins
}

fn allowed_parent(origin: &str) -> bool {
    FRAME_ORIGINS.contains(&origin)
        || (cfg!(debug_assertions)
            && matches!(origin, "http://127.0.0.1:1420" | "http://127.0.0.1:31420"))
}

pub(super) struct PendingConnection {
    pub(super) expires_at: Instant,
    poll_hash: [u8; 32],
    parent_origin: String,
    approved: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectRequest {
    parent_origin: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PollRequest {
    request_id: String,
    poll_secret: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewRequest {
    request_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApproveRequest {
    request_id: String,
    approve: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionRequest {
    request_id: String,
    poll_secret: String,
    expires_in_ms: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionReview {
    parent_origin: String,
    expires_in_ms: u64,
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum ConnectionPoll {
    Pending,
    Denied,
    Connected {
        #[serde(rename = "sessionSecret")]
        session_secret: String,
        #[serde(rename = "sessionProof")]
        session_proof: String,
    },
}

impl BrowserAccessState {
    async fn request_embed(&self, parent_origin: &str) -> AppResult<ConnectionRequest> {
        if !self.is_remote() || !allowed_parent(parent_origin) {
            return Err(AppError::Unauthorized);
        }
        let mut inner = self.inner.lock().await;
        remove_expired(&mut inner, Instant::now());
        if !inner.available || !inner.enabled {
            return Err(AppError::Conflict(
                "Enable browser access in Terminal first".into(),
            ));
        }
        if inner.embed_requests.len() >= MAX_PENDING {
            return Err(AppError::Conflict(
                "Too many pending connections. Try again shortly.".into(),
            ));
        }
        let request_id = random_secret()?;
        let poll_secret = random_secret()?;
        inner.embed_requests.insert(
            request_id.clone(),
            PendingConnection {
                expires_at: Instant::now() + PAIR_TTL,
                poll_hash: secret_hash(&poll_secret),
                parent_origin: parent_origin.to_owned(),
                approved: None,
            },
        );
        Ok(ConnectionRequest {
            request_id,
            poll_secret,
            expires_in_ms: duration_millis(PAIR_TTL),
        })
    }

    async fn review_embed(
        &self,
        auth: BrowserSessionAuth,
        request_id: &str,
        decision: Option<bool>,
    ) -> AppResult<ConnectionReview> {
        let mut inner = self.inner.lock().await;
        remove_expired(&mut inner, Instant::now());
        // Approval cannot be delegated by an embedded session, or outlive its authorizing browser.
        if !inner.available
            || !inner.enabled
            || !inner
                .sessions
                .values()
                .any(|record| record.auth == auth && !record.embedded)
        {
            return Err(AppError::Unauthorized);
        }
        let pending = inner
            .embed_requests
            .get_mut(request_id)
            .ok_or(AppError::Unauthorized)?;
        if pending.approved.is_some() {
            return Err(AppError::Conflict(
                "This connection has already been reviewed".into(),
            ));
        }
        if let Some(decision) = decision {
            pending.approved = Some(decision);
        }
        Ok(ConnectionReview {
            parent_origin: pending.parent_origin.clone(),
            expires_in_ms: duration_millis(
                pending.expires_at.saturating_duration_since(Instant::now()),
            ),
        })
    }

    async fn poll_embed(&self, request: &PollRequest) -> AppResult<ConnectionPoll> {
        if !valid_secret(&request.poll_secret) {
            return Err(AppError::Unauthorized);
        }
        let mut inner = self.inner.lock().await;
        remove_expired(&mut inner, Instant::now());
        if !inner.available || !inner.enabled {
            return Err(AppError::Unauthorized);
        }
        let pending = inner
            .embed_requests
            .get(&request.request_id)
            .ok_or(AppError::Unauthorized)?;
        if pending.poll_hash != secret_hash(&request.poll_secret) {
            return Err(AppError::Unauthorized);
        }
        match pending.approved {
            None => return Ok(ConnectionPoll::Pending),
            Some(false) => {
                inner.embed_requests.remove(&request.request_id);
                return Ok(ConnectionPoll::Denied);
            }
            Some(true) => {}
        }
        let session_secret = random_secret()?;
        let session_proof = random_secret()?;
        let auth = BrowserSessionAuth {
            session_id: inner.next_session_id,
            generation: inner.generation,
        };
        inner.next_session_id = inner.next_session_id.wrapping_add(1);
        let key = session_key(&session_secret);
        inner.sessions.insert(
            key.clone(),
            BrowserSessionRecord {
                embedded: true,
                auth,
                proof_hashes: HashSet::from([secret_hash(&session_proof)]),
                expires_at: unix_seconds() + SESSION_TTL_SECONDS,
            },
        );
        if let Err(error) = self.persist(&inner) {
            inner.sessions.remove(&key);
            return Err(error);
        }
        // Under the same lock: a connection is redeemed at most once.
        inner.embed_requests.remove(&request.request_id);
        Ok(ConnectionPoll::Connected {
            session_secret,
            session_proof,
        })
    }
}

pub(crate) async fn request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ConnectRequest>,
) -> AppResult<Response> {
    state
        .browser_access
        .validate_browser_headers(&headers, true)?;
    Ok(no_store_json(
        state
            .browser_access
            .request_embed(&request.parent_origin)
            .await?,
    ))
}
pub(crate) async fn poll(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<PollRequest>,
) -> AppResult<Response> {
    state
        .browser_access
        .validate_browser_headers(&headers, true)?;
    Ok(no_store_json(
        state.browser_access.poll_embed(&request).await?,
    ))
}
pub(crate) async fn review(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(request): Query<ReviewRequest>,
) -> AppResult<Response> {
    let auth = state
        .browser_access
        .authenticate_cookie(&headers, &Method::GET)
        .await?;
    Ok(no_store_json(
        state
            .browser_access
            .review_embed(auth, &request.request_id, None)
            .await?,
    ))
}
pub(crate) async fn approve(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ApproveRequest>,
) -> AppResult<Response> {
    let auth = state
        .browser_access
        .authenticate_cookie(&headers, &Method::POST)
        .await?;
    Ok(no_store_json(
        state
            .browser_access
            .review_embed(auth, &request.request_id, Some(request.approve))
            .await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn state() -> BrowserAccessState {
        let mut state = BrowserAccessState::configured("127.0.0.1:8658".parse().unwrap());
        state.origin = Some("https://terminal.fyxtez.com".into());
        state.host = Some("terminal.fyxtez.com".into());
        state.inner.lock().await.available = true;
        state.enable().await.unwrap();
        state
    }
    async fn normal_session(state: &BrowserAccessState) -> BrowserSessionAuth {
        let ticket = state.issue_launch_ticket().await.unwrap();
        state
            .redeem(ticket.url.split('=').nth(1).unwrap(), None)
            .await
            .unwrap()
            .2
    }
    fn headers(secret: &str, proof: &str) -> HeaderMap {
        HeaderMap::from_iter([
            (
                header::HOST,
                HeaderValue::from_static("terminal.fyxtez.com"),
            ),
            (
                header::ORIGIN,
                HeaderValue::from_static("https://terminal.fyxtez.com"),
            ),
            (
                header::HeaderName::from_static(EMBEDDED_SESSION_HEADER),
                HeaderValue::from_str(secret).unwrap(),
            ),
            (
                header::HeaderName::from_static(BROWSER_PROOF_HEADER),
                HeaderValue::from_str(proof).unwrap(),
            ),
        ])
    }
    #[tokio::test]
    async fn pairing_requires_explicit_approval_and_both_credentials_then_revokes() {
        let state = state().await;
        let pair = state.request_embed("tauri://localhost").await.unwrap();
        let poll = PollRequest {
            request_id: pair.request_id.clone(),
            poll_secret: pair.poll_secret.clone(),
        };
        assert!(matches!(
            state.poll_embed(&poll).await.unwrap(),
            ConnectionPoll::Pending
        ));
        let wrong = PollRequest {
            request_id: pair.request_id.clone(),
            poll_secret: "0".repeat(64),
        };
        assert!(state.poll_embed(&wrong).await.is_err());
        let auth = normal_session(&state).await;
        state
            .review_embed(auth, &pair.request_id, Some(true))
            .await
            .unwrap();
        let ConnectionPoll::Connected {
            session_secret,
            session_proof,
        } = state.poll_embed(&poll).await.unwrap()
        else {
            panic!("not connected")
        };
        assert!(state.poll_embed(&poll).await.is_err());
        let headers = headers(&session_secret, &session_proof);
        let embedded_auth = state
            .authenticate_cookie(&headers, &Method::POST)
            .await
            .unwrap();
        let next = state.request_embed("http://127.0.0.1:37373").await.unwrap();
        assert!(
            state
                .review_embed(embedded_auth, &next.request_id, Some(true))
                .await
                .is_err()
        );
        let mut cookie = headers.clone();
        cookie.remove(EMBEDDED_SESSION_HEADER);
        cookie.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{BROWSER_SESSION_COOKIE}={session_secret}")).unwrap(),
        );
        assert!(
            state
                .authenticate_cookie(&cookie, &Method::GET)
                .await
                .is_err()
        );
        let mut no_proof = headers.clone();
        no_proof.remove(BROWSER_PROOF_HEADER);
        assert!(
            state
                .authenticate_cookie(&no_proof, &Method::GET)
                .await
                .is_err()
        );
        let mut foreign = headers.clone();
        foreign.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://evil.example"),
        );
        assert!(
            state
                .authenticate_cookie(&foreign, &Method::POST)
                .await
                .is_err()
        );
        state.disable().await.unwrap();
        assert!(!state.session_auth_is_active(embedded_auth).await);
        assert!(
            state
                .authenticate_cookie(&headers, &Method::GET)
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn pairing_is_bounded_and_rejects_expiry_denial_and_untrusted_parents() {
        let state = state().await;
        assert!(state.request_embed("https://evil.example").await.is_err());
        assert!(
            state
                .request_embed("http://127.0.0.1:37373.evil.example")
                .await
                .is_err()
        );
        let pair = state.request_embed("tauri://localhost").await.unwrap();
        let auth = normal_session(&state).await;
        state
            .review_embed(auth, &pair.request_id, Some(false))
            .await
            .unwrap();
        let poll = PollRequest {
            request_id: pair.request_id,
            poll_secret: pair.poll_secret,
        };
        assert!(matches!(
            state.poll_embed(&poll).await.unwrap(),
            ConnectionPoll::Denied
        ));
        assert!(state.poll_embed(&poll).await.is_err());
        for _ in 0..MAX_PENDING {
            state.request_embed("tauri://localhost").await.unwrap();
        }
        assert!(state.request_embed("tauri://localhost").await.is_err());
        for pending in state.inner.lock().await.embed_requests.values_mut() {
            pending.expires_at = Instant::now();
        }
        assert!(state.request_embed("tauri://localhost").await.is_ok());
    }
}
