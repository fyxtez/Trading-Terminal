use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::{
    Json,
    body::{Body, to_bytes},
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, Method, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use tokio::{sync::broadcast, time::Duration};

use crate::{
    diagnostics::DiagnosticsSnapshot,
    error::{AppError, AppResult, ErrorClassification},
    models::{FuturesAccountInfo, HealthResponse},
    operation_safety::{IntentDecision, OperationSafety},
    trading_events::TradingEvent,
};

use super::AppState;

const INTENT_HEADER: &str = "x-fyxtez-intent-id";
const MAX_INTENT_BODY_BYTES: usize = 64 * 1024;
const MAX_INTENT_RESPONSE_BYTES: usize = 1024 * 1024;
pub(super) const INTENT_RESOLUTION_CONFIRMATION: &str = "I VERIFIED BINANCE";

pub(super) async fn record_request_diagnostics(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let is_mutation = matches!(
        *request.method(),
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );
    let path = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or_else(|| request.uri().path())
        .to_owned();
    let response = next.run(request).await;
    let failed = response.status().is_client_error() || response.status().is_server_error();
    let classification = response
        .extensions()
        .get::<ErrorClassification>()
        .copied()
        .unwrap_or(ErrorClassification {
            duplicate_request: response.status() == axum::http::StatusCode::CONFLICT,
            exchange_unavailable: false,
        });

    if is_mutation && failed {
        state.diagnostics.request_rejected(
            &path,
            response.status().as_u16(),
            classification.duplicate_request,
        );
    }
    if failed && classification.exchange_unavailable {
        state
            .diagnostics
            .exchange_failure("Exchange request failed or returned invalid data");
    } else if response.status().is_success() && exchange_backed_path(&path) {
        state.diagnostics.exchange_success();
    }

    response
}

fn exchange_backed_path(path: &str) -> bool {
    path.starts_with("/api/account")
        || path.starts_with("/api/balance")
        || path.starts_with("/api/binance/")
        || path.starts_with("/api/filters/")
        || path.starts_with("/api/leverage")
        || path.starts_with("/api/orders")
        || path.starts_with("/api/positions")
        || path.starts_with("/api/price/")
}

pub(super) async fn authorize(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> AppResult<Response> {
    let path = request.uri().path();

    if matches!(path, "/health" | "/api/ws/trading") {
        return Ok(next.run(request).await);
    }

    let supplied = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let expected = format!("Bearer {}", state.service_token);

    if supplied != Some(expected.as_str()) {
        return Err(AppError::Unauthorized);
    }

    if requires_financial_intent(request.method(), path) {
        return execute_financial_intent(state, request, next).await;
    }

    Ok(next.run(request).await)
}

fn requires_financial_intent(method: &Method, path: &str) -> bool {
    if !matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) {
        return false;
    }

    path.starts_with("/api/orders/")
        || path == "/api/positions/intent"
        || path == "/api/account/close-everything"
        || path == "/api/leverage"
        || path == "/api/sizing"
}

fn can_increase_exposure(method: &Method, path: &str, body: &[u8]) -> bool {
    match (method, path) {
        (&Method::POST, "/api/orders/auto-market") => true,
        (&Method::POST, "/api/orders/market" | "/api/orders/limit") => {
            serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|value| value.get("reduce_only").and_then(Value::as_bool))
                != Some(true)
        }
        (&Method::POST, "/api/positions/intent") => {
            serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|value| {
                    value
                        .get("intent")
                        .and_then(Value::as_str)
                        .map(str::to_ascii_uppercase)
                })
                .as_deref()
                != Some("REDUCE")
        }
        (&Method::POST, path) if path.ends_with("/chase") && path.starts_with("/api/orders/") => {
            true
        }
        (&Method::PUT, path)
            if path.starts_with("/api/orders/")
                && !path.ends_with("/reduce")
                && !path.ends_with("/reprice-reduce") =>
        {
            true
        }
        _ => false,
    }
}

async fn execute_financial_intent(
    state: AppState,
    request: axum::extract::Request,
    next: Next,
) -> AppResult<Response> {
    let intent_id = request
        .headers()
        .get(INTENT_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::Invalid(format!("missing {INTENT_HEADER} header")))?
        .to_owned();
    let method = request.method().as_str().to_owned();
    let path = request.uri().path().to_owned();
    let (parts, body) = request.into_parts();
    let request_body = to_bytes(body, MAX_INTENT_BODY_BYTES)
        .await
        .map_err(|_| AppError::Invalid("financial request body is too large".into()))?;
    let fingerprint = OperationSafety::fingerprint(&method, &path, &request_body);

    let decision = if can_increase_exposure(&parts.method, &path, &request_body) {
        state
            .operation_safety
            .begin_exposure_increase(&intent_id, &method, &path, &fingerprint)
            .await?
    } else {
        state
            .operation_safety
            .begin(&intent_id, &method, &path, &fingerprint)
            .await?
    };

    match decision {
        IntentDecision::Replay {
            status,
            content_type,
            body,
        } => {
            let mut response = Response::builder().status(status);
            if let Some(content_type) = content_type {
                response = response.header(header::CONTENT_TYPE, content_type);
            }
            response = response
                .header(INTENT_HEADER, intent_id)
                .header("x-fyxtez-intent-replayed", "true");
            return response
                .body(Body::from(body))
                .map_err(|error| AppError::Config(format!("cannot replay intent: {error}")));
        }
        IntentDecision::Execute => {}
    }

    let response = next
        .run(axum::extract::Request::from_parts(
            parts,
            Body::from(request_body),
        ))
        .await;
    let (mut parts, body) = response.into_parts();
    let response_body = to_bytes(body, MAX_INTENT_RESPONSE_BYTES)
        .await
        .map_err(|_| AppError::Config("financial response exceeded journal limit".into()))?;
    let content_type = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let status = parts.status.as_u16();

    if let Err(error) = state
        .operation_safety
        .complete(
            &intent_id,
            &method,
            &path,
            status,
            content_type.as_deref(),
            &response_body,
        )
        .await
    {
        // The exchange/handler result has already happened. Preserve that
        // authoritative result and leave the persistent intent in-progress so
        // a retry fails closed instead of creating duplicate exposure.
        tracing::error!(target: "audit", %error, "Failed to complete operation journal entry");
    }

    if let Ok(value) = HeaderValue::from_str(&intent_id) {
        parts.headers.insert(INTENT_HEADER, value);
    }
    Ok(Response::from_parts(parts, Body::from(response_body)))
}

pub(super) async fn reload_desktop_credentials(
    State(state): State<AppState>,
) -> AppResult<Json<Value>> {
    let _guard = state.trade_lock.lock().await;
    let changed = state.binance.reload_secure_credentials()?;
    let configured = state.binance.is_configured();
    state.diagnostics.set_binance_configured(configured);

    if configured {
        state.binance.sync_server_time().await?;
        state.binance.refresh_reference_data().await?;
        state.diagnostics.exchange_success();

        let (account, position_risk) =
            tokio::try_join!(state.binance.account_info(), state.binance.position_risk(),)?;
        state.account_state.replace(account).await;
        state.position_risk_state.replace(position_risk).await;
    } else {
        state
            .account_state
            .replace(FuturesAccountInfo {
                total_wallet_balance: "0".into(),
                available_balance: "0".into(),
                assets: Vec::new(),
                positions: Vec::new(),
                extra: json!({}),
            })
            .await;
        state.position_risk_state.replace(Vec::new()).await;
    }

    Ok(Json(json!({
        "configured": configured,
        "changed": changed,
    })))
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct TradingSocketQuery {
    ticket: String,
}

pub(super) async fn issue_websocket_ticket(State(state): State<AppState>) -> Json<Value> {
    const TICKET_TTL: Duration = Duration::from_secs(30);
    let now = tokio::time::Instant::now();
    let ticket = uuid::Uuid::new_v4().simple().to_string();
    let mut tickets = state.websocket_tickets.lock().await;
    tickets.retain(|_, expires_at| *expires_at > now);
    tickets.insert(ticket.clone(), now + TICKET_TTL);
    Json(json!({ "ticket": ticket, "expires_in_ms": TICKET_TTL.as_millis() }))
}

pub(super) async fn trading_websocket(
    State(state): State<AppState>,
    Query(query): Query<TradingSocketQuery>,
    upgrade: WebSocketUpgrade,
) -> AppResult<Response> {
    let expires_at = state.websocket_tickets.lock().await.remove(&query.ticket);
    if expires_at.is_none_or(|expires_at| expires_at <= tokio::time::Instant::now()) {
        return Err(AppError::Unauthorized);
    }

    Ok(upgrade
        .on_upgrade(move |socket| stream_trading_events(socket, state.trading_events.subscribe()))
        .into_response())
}

async fn stream_trading_events(
    mut socket: WebSocket,
    mut receiver: broadcast::Receiver<TradingEvent>,
) {
    loop {
        match receiver.recv().await {
            Ok(event) => {
                let Ok(payload) = serde_json::to_string(&event) else {
                    continue;
                };
                if socket.send(WsMessage::Text(payload.into())).await.is_err() {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                let event = TradingEvent::SnapshotRequired {
                    reason: format!("browser event stream lagged by {skipped} messages"),
                };
                let Ok(payload) = serde_json::to_string(&event) else {
                    continue;
                };
                if socket.send(WsMessage::Text(payload.into())).await.is_err() {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

pub(super) async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        network: if state.binance.is_testnet() {
            "testnet"
        } else {
            "mainnet"
        },
    })
}

pub(super) async fn diagnostics(State(state): State<AppState>) -> Json<DiagnosticsSnapshot> {
    Json(state.diagnostics.snapshot())
}

pub(super) async fn unresolved_intents(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let unresolved = state
        .operation_safety
        .unresolved_from_previous_run()
        .await?;
    Ok(Json(json!({
        "blocksNewExposure": !unresolved.is_empty(),
        "confirmationPhrase": INTENT_RESOLUTION_CONFIRMATION,
        "unresolved": unresolved,
    })))
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct ResolveIntentRequest {
    confirmation: String,
}

pub(super) async fn resolve_unresolved_intent(
    State(state): State<AppState>,
    axum::extract::Path(intent_id): axum::extract::Path<String>,
    Json(request): Json<ResolveIntentRequest>,
) -> AppResult<Json<Value>> {
    if request.confirmation.trim() != INTENT_RESOLUTION_CONFIRMATION {
        return Err(AppError::Invalid(format!(
            "type {INTENT_RESOLUTION_CONFIRMATION} after checking Binance Positions, Open Orders, and Order History"
        )));
    }

    // Keep reconciliation and journal resolution under the same trade lock.
    // No exchange mutation is replayed here: the user first verifies Binance,
    // then these reads refresh all state the terminal can authoritatively
    // observe before the stale crash marker is removed.
    let _guard = state.trade_lock.lock().await;
    if !state
        .operation_safety
        .unresolved_from_previous_run()
        .await?
        .iter()
        .any(|intent| intent.intent_id == intent_id)
    {
        return Err(AppError::NotFound(
            "recoverable unresolved intent was not found".into(),
        ));
    }
    if !state.binance.is_configured() {
        return Err(AppError::Invalid(
            "connect Binance before resolving an uncertain operation".into(),
        ));
    }

    let (account, position_risk, _open_orders) = tokio::try_join!(
        state.binance.account_info(),
        state.binance.position_risk(),
        state.binance.all_open_orders(),
    )?;
    state.account_state.replace(account).await;
    state.position_risk_state.replace(position_risk).await;
    state.diagnostics.exchange_success();
    state
        .diagnostics
        .reconciliation_success("operator-intent-recovery", false);
    let resolved = state
        .operation_safety
        .resolve_previous_run(&intent_id)
        .await?;
    let _ = state.trading_events.send(TradingEvent::SnapshotRequired {
        reason: format!("uncertain operation {intent_id} reconciled by operator"),
    });

    Ok(Json(json!({
        "resolved": resolved,
        "message": "Binance state refreshed; the operation was not replayed",
    })))
}

pub(super) async fn server_time(State(state): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(state.binance.server_time().await?))
}

#[cfg(test)]
mod tests {
    use axum::http::Method;

    use super::{can_increase_exposure, requires_financial_intent};

    #[test]
    fn intent_boundary_covers_every_financial_mutation_family() {
        for (method, path) in [
            (Method::POST, "/api/orders/market"),
            (Method::DELETE, "/api/orders/BTCUSDT/42"),
            (Method::POST, "/api/positions/intent"),
            (Method::POST, "/api/account/close-everything"),
            (Method::POST, "/api/leverage"),
            (Method::PUT, "/api/sizing"),
        ] {
            assert!(
                requires_financial_intent(&method, path),
                "{method} {path} must require a durable intent"
            );
        }

        assert!(!requires_financial_intent(&Method::GET, "/api/orders/open"));
        assert!(!requires_financial_intent(&Method::POST, "/api/alerts"));
        assert!(!requires_financial_intent(
            &Method::POST,
            "/api/auth/ws-ticket"
        ));
    }

    #[test]
    fn uncertain_intent_gate_blocks_only_exposure_increases() {
        assert!(can_increase_exposure(
            &Method::POST,
            "/api/orders/market",
            br#"{"reduce_only":false}"#,
        ));
        assert!(can_increase_exposure(
            &Method::POST,
            "/api/positions/intent",
            br#"{"intent":"ADD"}"#,
        ));
        assert!(can_increase_exposure(
            &Method::POST,
            "/api/orders/BTCUSDT/42/chase",
            b"",
        ));
        assert!(can_increase_exposure(
            &Method::PUT,
            "/api/orders/BTCUSDT/42",
            b"{}",
        ));

        for (method, path, body) in [
            (
                Method::POST,
                "/api/orders/market",
                br#"{"reduce_only":true}"#.as_slice(),
            ),
            (
                Method::POST,
                "/api/positions/intent",
                br#"{"intent":"REDUCE"}"#.as_slice(),
            ),
            (Method::DELETE, "/api/orders/BTCUSDT/42", b"".as_slice()),
            (
                Method::POST,
                "/api/orders/close-position",
                br#"{"symbol":"BTCUSDT"}"#.as_slice(),
            ),
            (
                Method::POST,
                "/api/account/close-everything",
                b"{}".as_slice(),
            ),
            (Method::POST, "/api/orders/stop-market", b"{}".as_slice()),
            (
                Method::PUT,
                "/api/orders/BTCUSDT/42/reduce",
                b"{}".as_slice(),
            ),
            (
                Method::PUT,
                "/api/orders/BTCUSDT/42/reprice-reduce",
                b"{}".as_slice(),
            ),
        ] {
            assert!(
                !can_increase_exposure(&method, path, body),
                "{method} {path} must remain available for risk reduction"
            );
        }
    }
}
