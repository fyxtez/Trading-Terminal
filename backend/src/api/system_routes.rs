use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, Method, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use tokio::{sync::broadcast, time::Duration};

use crate::{
    diagnostics::DiagnosticsSnapshot,
    error::{AppError, AppResult, ErrorClassification},
    models::{FuturesAccountInfo, HealthResponse},
    trading_events::TradingEvent,
};

use super::AppState;

pub(super) async fn record_request_diagnostics(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let is_mutation = matches!(
        *request.method(),
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );
    let path = request.uri().path().to_owned();
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

    Ok(next.run(request).await)
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

pub(super) async fn server_time(State(state): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(state.binance.server_time().await?))
}
