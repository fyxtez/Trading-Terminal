use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{Mutex, RwLock, broadcast},
    time::{Duration, sleep},
};
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};

use crate::{
    account_state::AccountState,
    alerts::{
        AlertListQuery, AlertRuntime, AlertStore, CreatePriceAlert, PriceAlert, UpdatePriceAlert,
    },
    binance::{BinanceClient, floor_to_step, normalize_symbol, round_to_tick},
    error::{AppError, AppResult},
    icons::{IconEntry, IconStore, MAX_ICONS},
    models::{
        AutoSizePreview, AutoSizeQuery, ClosePositionRequest, ConditionalOrderRequest,
        FuturesAccountInfo, HealthResponse, IntentOrderType, LimitOrderRequest, MarginSizingConfig,
        MarketOrderRequest, ModifyLimitOrderRequest, OptionalSymbolQuery, OrderSide,
        PositionIntent, PositionIntentRequest, SetLeverageRequest, SymbolFilters, SymbolQuery,
    },
    position_risk_state::PositionRiskState,
    sizing_store::SizingStore,
    symbol_registry::{AddSymbolRequest, MarketDataSource, MarketKind, SymbolRegistry},
    trading_events::TradingEvent,
};

#[derive(Clone)]
pub struct AppState {
    pub binance: BinanceClient,
    pub account_state: AccountState,
    pub position_risk_state: PositionRiskState,
    pub sizing: Arc<RwLock<MarginSizingConfig>>,
    pub sizing_store: SizingStore,
    pub service_token: String,
    pub trade_lock: Arc<Mutex<()>>,
    pub trading_events: broadcast::Sender<TradingEvent>,
    pub alert_store: AlertStore,
    pub alert_runtime: AlertRuntime,
    pub symbol_registry: SymbolRegistry,
    pub icon_store: IconStore,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/binance/time", get(server_time))
        .route("/api/market-data/mexc/klines", get(mexc_klines))
        .route("/api/symbols", get(list_symbols).post(add_symbol))
        .route(
            "/api/symbols/{symbol}",
            axum::routing::delete(delete_symbol),
        )
        .route("/api/icons", get(list_icons))
        .route("/api/icons/{symbol}/image", get(get_icon_image))
        .route("/api/account", get(account))
        .route("/api/positions/realized-pnl", get(position_realized_pnl))
        .route("/api/balance", get(balance))
        .route("/api/price/{symbol}", get(price))
        .route("/api/filters/{symbol}", get(filters))
        .route("/api/leverage/max/{symbol}", get(max_leverage))
        .route("/api/leverage/current/{symbol}", get(current_leverage))
        .route("/api/leverage", post(set_leverage))
        .route("/api/sizing", get(get_sizing).put(update_sizing))
        .route("/api/sizing/preview/{symbol}", get(sizing_preview))
        .route("/api/orders/auto-market", post(auto_market_order))
        .route("/api/orders/market", post(market_order))
        .route("/api/orders/limit", post(limit_order))
        .route("/api/orders/stop-market", post(stop_market))
        .route("/api/orders/take-profit-market", post(take_profit_market))
        .route(
            "/api/orders/algo/{symbol}/{algo_id}",
            axum::routing::delete(cancel_algo_order),
        )
        .route("/api/orders/close-position", post(close_position))
        .route("/api/positions/intent", post(position_intent))
        .route("/api/account/close-everything", post(close_everything))
        .route(
            "/api/orders/{symbol}/{order_id}/reduce",
            put(update_reduce_order),
        )
        .route(
            "/api/orders/{symbol}/{order_id}/reprice-reduce",
            put(reprice_reduce_order),
        )
        .route(
            "/api/orders/{symbol}/{order_id}/chase",
            post(chase_limit_order),
        )
        .route("/api/ws/trading", get(trading_websocket))
        .route("/api/alerts", get(list_alerts).post(create_alert))
        .route("/api/alerts/{id}", put(update_alert).delete(delete_alert))
        .route(
            "/api/orders/open",
            get(open_orders).delete(cancel_all_orders),
        )
        .route(
            "/api/orders/{symbol}/{order_id}",
            get(query_order)
                .put(modify_limit_order)
                .delete(cancel_order),
        )
        .layer(middleware::from_fn_with_state(state.clone(), authorize))
        .layer(
            CorsLayer::new()
                // .allow_origin("https://frontend-domain.com".parse::<HeaderValue>().unwrap())
                // .allow_origin("other-backend.com".parse::<HeaderValue>().unwrap())
                .allow_origin(Any)
                .allow_headers(Any)
                .allow_methods(Any),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn authorize(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> AppResult<Response> {
    let path = request.uri().path();

    if matches!(path, "/health" | "/api/ws/trading") {
        return Ok(next.run(request).await);
    }

    // Icon images are loaded via plain `<img src>` elements in the
    // frontend, which - like the WebSocket upgrade above - cannot attach
    // a custom Authorization header. This route authenticates via its own
    // `?token=` query parameter instead; see get_icon_image below.
    if path.starts_with("/api/icons/") && path.ends_with("/image") {
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

#[derive(Debug, serde::Deserialize)]
struct TradingSocketQuery {
    token: String,
}

async fn trading_websocket(
    State(state): State<AppState>,
    Query(query): Query<TradingSocketQuery>,
    upgrade: WebSocketUpgrade,
) -> AppResult<Response> {
    if query.token != state.service_token {
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

async fn list_alerts(
    State(state): State<AppState>,
    Query(query): Query<AlertListQuery>,
) -> AppResult<Json<Vec<PriceAlert>>> {
    let symbol = query
        .symbol
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let normalized = symbol.map(|value| value.to_uppercase());
    Ok(Json(
        state.alert_store.list_active(normalized.as_deref()).await?,
    ))
}

async fn create_alert(
    State(state): State<AppState>,
    Json(request): Json<CreatePriceAlert>,
) -> AppResult<(axum::http::StatusCode, Json<PriceAlert>)> {
    let alert = state.alert_store.create(request).await?;
    state.alert_runtime.refresh();
    Ok((axum::http::StatusCode::CREATED, Json(alert)))
}

async fn update_alert(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(request): Json<UpdatePriceAlert>,
) -> AppResult<Json<PriceAlert>> {
    let id = uuid::Uuid::parse_str(&id)
        .map_err(|_| AppError::Invalid("alert id must be a valid UUID".into()))?;
    let alert = state.alert_store.update(id, request).await?;
    state.alert_runtime.refresh();
    Ok(Json(alert))
}

async fn delete_alert(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<axum::http::StatusCode> {
    let id = uuid::Uuid::parse_str(&id)
        .map_err(|_| AppError::Invalid("alert id must be a valid UUID".into()))?;
    state.alert_store.delete(id).await?;
    state.alert_runtime.refresh();
    Ok(axum::http::StatusCode::NO_CONTENT)
}

async fn list_symbols(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "symbols": state.symbol_registry.list().await }))
}

async fn add_symbol(
    State(state): State<AppState>,
    Json(request): Json<AddSymbolRequest>,
) -> AppResult<(axum::http::StatusCode, Json<Value>)> {
    let (symbol, created) = state.symbol_registry.add(&request.symbol).await?;

    if symbol.data_source == MarketDataSource::Binance {
        // FIX: startup enforcement only covers symbols already persisted at
        // boot. A newly registered Binance contract must be switched to
        // ISOLATED before the add request succeeds; per-order guards below
        // provide a second fail-closed check. Roll back a fresh registry entry
        // when Binance refuses the mode change so it never appears tradeable.
        if let Err(error) = state
            .binance
            .ensure_isolated_margin(&symbol.market_symbol)
            .await
        {
            if created {
                let _ = state.symbol_registry.delete(&symbol.symbol).await;
            }
            return Err(error);
        }
    }

    // FIX: both Binance and MEXC symbols now use the shared bounded icon cache.
    // Check capacity before resolving artwork so neither source can silently
    // exceed MAX_ICONS; roll back only a registry row created by this request.
    if symbol.market_kind == MarketKind::Crypto {
        let has_icon_room = match state.icon_store.has_room_for(&symbol.symbol).await {
            Ok(value) => value,
            Err(error) => {
                if created {
                    let _ = state.symbol_registry.delete(&symbol.symbol).await;
                }
                return Err(error);
            }
        };
        if !has_icon_room {
            if created {
                let _ = state.symbol_registry.delete(&symbol.symbol).await;
            }
            return Err(AppError::Invalid(format!(
                "maximum of {MAX_ICONS} symbols reached; delete an unused symbol before adding another"
            )));
        }
    }

    // FEATURE: select the venue/asset-specific resolver. MEXC crypto now uses
    // CoinGecko and the same local cache/API as Binance instead of remaining
    // permanently icon-less. Lookup failure stays cosmetic, not a symbol error.
    let icon = {
        let result = if symbol.market_kind == MarketKind::Traditional {
            state
                .icon_store
                .ensure_cached_from_tradfi(&symbol.symbol)
                .await
        } else if symbol.data_source == MarketDataSource::Mexc {
            state
                .icon_store
                .ensure_cached_from_mexc(&symbol.symbol)
                .await
        } else {
            state
                .icon_store
                .ensure_cached_from_binance(&symbol.symbol)
                .await
        };
        match result {
            Ok(icon) => icon,
            Err(error) => {
                tracing::warn!(
                    symbol = %symbol.symbol,
                    %error,
                    "Failed to cache icon for newly added symbol"
                );
                None
            }
        }
    };

    let status = if created {
        axum::http::StatusCode::CREATED
    } else {
        axum::http::StatusCode::OK
    };

    Ok((
        status,
        Json(json!({
            "created": created,
            "symbol": symbol,
            "icon": icon.map(icon_json),
        })),
    ))
}

async fn delete_symbol(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
) -> AppResult<Json<Value>> {
    // NOTE: intentionally does NOT touch `state.icon_store`. Deleting a
    // symbol from the trading registry must not delete its cached icon -
    // see the module doc-comment on `icons.rs` for why (cheap re-adds,
    // and a symbol that briefly disappears from the list shouldn't lose
    // its artwork).
    let removed = state.symbol_registry.delete(&symbol).await?;
    Ok(Json(json!({
        "deleted": true,
        "symbol": removed
    })))
}

fn icon_json(entry: IconEntry) -> Value {
    json!({
        "symbol": entry.symbol,
        "url": format!("/api/icons/{}/image", entry.symbol),
        "source_url": entry.source_url,
        "cached_at_ms": entry.cached_at_ms,
    })
}

/// Returns the full symbol -> icon map (metadata only, not image bytes) so
/// the frontend can build its own symbol -> `<img>` lookup in one call.
async fn list_icons(State(state): State<AppState>) -> Json<Value> {
    let entries = state.icon_store.list().await;

    Json(json!({
        "count": entries.len(),
        "max": MAX_ICONS,
        "icons": entries.into_iter().map(icon_json).collect::<Vec<_>>(),
    }))
}

/// Serves the raw cached image bytes for a symbol, e.g. for direct use as
/// an `<img src="/api/icons/BTC/image?token=...">` source. 404s if nothing
/// is cached for that symbol yet - the frontend should treat that as "no
/// icon", not retry indefinitely.
///
/// Authenticated via `?token=` rather than the usual Authorization header
/// - see the comment on `authorize` above for why: a plain `<img>` element
///   can't attach custom headers, the same limitation the WebSocket upgrade
///   already has to work around.
#[derive(Debug, serde::Deserialize)]
struct IconImageQuery {
    token: String,
}

async fn get_icon_image(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
    Query(query): Query<IconImageQuery>,
) -> AppResult<Response> {
    if query.token != state.service_token {
        return Err(AppError::Unauthorized);
    }

    let (bytes, content_type) = state
        .icon_store
        .read_bytes(&symbol)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("no cached icon for {symbol}")))?;

    Ok(([(header::CONTENT_TYPE, content_type)], bytes).into_response())
}

#[derive(Debug, serde::Deserialize)]
struct MexcKlineQuery {
    symbol: String,
    interval: String,
    start: Option<u64>,
    end: Option<u64>,
}

/// Server-side MEXC proxy. Browsers cannot call contract.mexc.com directly
/// because that API does not send CORS headers for localhost/web origins.
/// Keep this endpoint deliberately narrow so it cannot become an open proxy.
async fn mexc_klines(
    State(state): State<AppState>,
    Query(query): Query<MexcKlineQuery>,
) -> AppResult<Json<Value>> {
    const ALLOWED_INTERVALS: &[&str] = &[
        "Min1", "Min5", "Min15", "Min60", "Hour4", "Day1", "Week1", "Month1",
    ];

    let requested = state
        .symbol_registry
        .get(&query.symbol)
        .await?
        .ok_or_else(|| {
            AppError::Invalid(format!("unsupported market-data symbol: {}", query.symbol))
        })?;

    if requested.data_source != MarketDataSource::Mexc {
        return Err(AppError::Invalid(format!(
            "{} uses {:?} market data, not MEXC",
            requested.display_symbol, requested.data_source
        )));
    }

    let symbol = requested.market_symbol;

    let interval = query.interval.trim();
    if !ALLOWED_INTERVALS.contains(&interval) {
        return Err(AppError::Invalid(format!(
            "unsupported MEXC kline interval: {interval}"
        )));
    }

    if let (Some(start), Some(end)) = (query.start, query.end)
        && start >= end
    {
        return Err(AppError::Invalid(
            "MEXC kline start must be earlier than end".into(),
        ));
    }

    let mut request = reqwest::Client::new()
        .get(format!(
            "https://api.mexc.com/api/v1/contract/kline/{symbol}"
        ))
        .query(&[("interval", interval)]);

    if let Some(start) = query.start {
        request = request.query(&[("start", start)]);
    }
    if let Some(end) = query.end {
        request = request.query(&[("end", end)]);
    }

    let response = request
        .send()
        .await
        .map_err(|error| AppError::Config(format!("MEXC request failed: {error}")))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| AppError::Config(format!("failed to read MEXC response: {error}")))?;

    if !status.is_success() {
        return Err(AppError::Config(format!(
            "MEXC returned HTTP {status}: {body}"
        )));
    }

    let payload = serde_json::from_str::<Value>(&body)
        .map_err(|error| AppError::Config(format!("invalid MEXC JSON response: {error}")))?;

    Ok(Json(payload))
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        network: if state.binance.is_testnet() {
            "testnet"
        } else {
            "mainnet"
        },
    })
}

async fn server_time(State(state): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(state.binance.server_time().await?))
}

async fn account(State(state): State<AppState>) -> AppResult<Json<Value>> {
    // FIX: `/api/account` previously started from the in-memory account cache and
    // only fetched live `positionRisk`. `merge_position_risk` can enrich positions
    // already present in that cache, but it cannot create a position that the
    // cache never saw. Therefore a BTC position opened directly on Binance could
    // remain completely absent from the terminal if its ACCOUNT_UPDATE event was
    // missed/delayed, even after the frontend explicitly refreshed the panel.
    // Fetch the authoritative account snapshot together with positionRisk on every
    // account refresh, then repair both caches from those same live responses.
    let (account, position_risk) = tokio::try_join!(
        state.binance.account_info(),
        state.binance.position_risk(),
    )?;

    state.account_state.replace(account.clone()).await;
    state
        .position_risk_state
        .replace(position_risk.clone())
        .await;

    let mut value = serde_json::to_value(account)?;
    merge_position_risk(&mut value, &position_risk);

    Ok(Json(value))
}

async fn position_realized_pnl(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let position_risk = state.binance.position_risk().await?;
    let mut results = Vec::new();

    for position in position_risk.iter().filter(|position| {
        position
            .get("positionAmt")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<f64>().ok())
            .is_some_and(|amount| amount.abs() > 1e-12)
    }) {
        let Some(symbol) = position.get("symbol").and_then(Value::as_str) else {
            continue;
        };
        let position_side = position
            .get("positionSide")
            .and_then(Value::as_str)
            .unwrap_or("BOTH");
        let amount = position
            .get("positionAmt")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);

        let trades = match state.binance.user_trades(symbol).await {
            Ok(trades) => trades,
            Err(error) => {
                // FIX: one unavailable symbol history must not hide valid RPNL
                // for every other open position in the aggregate response.
                tracing::warn!(symbol, %error, "Could not load position trade history");
                results.push(json!({
                    "symbol": symbol,
                    "position_side": position_side,
                    "realized_pnl": null,
                    "complete": false,
                    "lifecycle_started_at": null,
                }));
                continue;
            }
        };
        let lifecycle = current_position_realized_pnl(&trades, position_side, amount);
        results.push(json!({
            "symbol": symbol,
            "position_side": position_side,
            "realized_pnl": lifecycle.complete.then_some(lifecycle.realized_pnl),
            "complete": lifecycle.complete,
            "lifecycle_started_at": lifecycle.lifecycle_started_at,
        }));
    }

    Ok(Json(json!({ "positions": results })))
}

struct PositionLifecyclePnl {
    realized_pnl: f64,
    complete: bool,
    lifecycle_started_at: Option<i64>,
}

fn current_position_realized_pnl(
    trades: &[Value],
    position_side: &str,
    current_amount: f64,
) -> PositionLifecyclePnl {
    let mut matching: Vec<&Value> = trades
        .iter()
        .filter(|trade| {
            trade
                .get("positionSide")
                .and_then(Value::as_str)
                .unwrap_or("BOTH")
                == position_side
        })
        .collect();
    matching.sort_by_key(|trade| {
        (
            trade.get("time").and_then(Value::as_i64).unwrap_or(0),
            trade.get("id").and_then(Value::as_i64).unwrap_or(0),
        )
    });

    // FEATURE: walk fills backwards from Binance's authoritative current size.
    // Reversing each signed fill reveals the last flat/sign-flip boundary, so
    // realized PNL from older closed positions never leaks into this lifecycle.
    let mut exposure = if position_side == "BOTH" {
        current_amount
    } else {
        current_amount.abs()
    };
    let mut realized_pnl = 0.0;
    let mut lifecycle_started_at = None;

    for trade in matching.into_iter().rev() {
        let quantity = trade
            .get("qty")
            .or_else(|| trade.get("baseQty"))
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);
        let side = trade.get("side").and_then(Value::as_str).unwrap_or("");
        let delta = match position_side {
            "LONG" => if side == "BUY" { quantity } else { -quantity },
            "SHORT" => if side == "SELL" { quantity } else { -quantity },
            _ => if side == "BUY" { quantity } else { -quantity },
        };
        let previous = exposure - delta;

        // FIX: a single reversal fill realizes the old leg and opens the new
        // one. Its realizedPnl belongs to the previous lifecycle, so stop before
        // adding it when reversing crosses through zero.
        if exposure * previous < -1e-12 {
            return PositionLifecyclePnl {
                realized_pnl,
                complete: true,
                lifecycle_started_at,
            };
        }

        realized_pnl += trade
            .get("realizedPnl")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);
        lifecycle_started_at = trade.get("time").and_then(Value::as_i64);

        if previous.abs() <= 1e-12 {
            return PositionLifecyclePnl {
                realized_pnl,
                complete: true,
                lifecycle_started_at,
            };
        }
        exposure = previous;
    }

    // FIX: do not expose a partial seven-day/1000-fill sum as authoritative.
    // A missing flat boundary means the position began outside Binance's window.
    PositionLifecyclePnl {
        realized_pnl,
        complete: false,
        lifecycle_started_at,
    }
}

fn merge_position_risk(account: &mut Value, position_risk: &[Value]) {
    let Some(account_positions) = account.get_mut("positions").and_then(Value::as_array_mut) else {
        return;
    };

    for account_position in account_positions {
        let Some(symbol) = account_position.get("symbol").and_then(Value::as_str) else {
            continue;
        };

        let account_position_side = account_position
            .get("positionSide")
            .and_then(Value::as_str)
            .unwrap_or("BOTH");

        let matching_risk = position_risk.iter().find(|risk| {
            let same_symbol = risk.get("symbol").and_then(Value::as_str) == Some(symbol);

            let risk_position_side = risk
                .get("positionSide")
                .and_then(Value::as_str)
                .unwrap_or("BOTH");

            same_symbol && risk_position_side == account_position_side
        });

        let (Some(account_object), Some(risk_object)) = (
            account_position.as_object_mut(),
            matching_risk.and_then(Value::as_object),
        ) else {
            continue;
        };

        account_object.extend(risk_object.clone());

        if let Some(live_unrealized_profit) = account_object.remove("unRealizedProfit") {
            account_object.insert("unrealizedProfit".to_string(), live_unrealized_profit);
        }
    }
}

async fn balance(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let account = state.account_state.snapshot().await;

    Ok(Json(json!({
        "total_wallet_balance": account.total_wallet_balance,
        "available_balance": account.available_balance
    })))
}

async fn price(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
) -> AppResult<Json<Value>> {
    let symbol = normalize_symbol(&symbol)?;
    Ok(Json(json!({
        "symbol": symbol,
        "price": state.binance.price(&symbol).await?
    })))
}

async fn filters(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
) -> AppResult<Json<SymbolFilters>> {
    let symbol = normalize_symbol(&symbol)?;
    Ok(Json(state.binance.symbol_filters(&symbol).await?))
}

async fn max_leverage(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
) -> AppResult<Json<Value>> {
    let symbol = normalize_symbol(&symbol)?;
    Ok(Json(json!({
        "symbol": symbol,
        "max_leverage": state.binance.max_leverage(&symbol).await?
    })))
}

async fn current_leverage(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
) -> AppResult<Json<Value>> {
    let symbol = normalize_symbol(&symbol)?;
    let leverage = state.binance.current_leverage(&symbol).await?;

    Ok(Json(json!({
        "symbol": symbol,
        "leverage": leverage
    })))
}

async fn set_leverage(
    State(state): State<AppState>,
    Json(req): Json<SetLeverageRequest>,
) -> AppResult<Json<Value>> {
    let symbol = normalize_symbol(&req.symbol)?;
    let response = state.binance.set_leverage(&symbol, req.leverage).await?;

    state.position_risk_state.request_refresh();

    Ok(Json(response))
}

async fn get_sizing(State(state): State<AppState>) -> Json<MarginSizingConfig> {
    Json(state.sizing.read().await.clone())
}

async fn update_sizing(
    State(state): State<AppState>,
    Json(req): Json<MarginSizingConfig>,
) -> AppResult<Json<MarginSizingConfig>> {
    let validated = MarginSizingConfig::new(req.margin_pct, req.leverage_safety, req.max_leverage)
        .map_err(AppError::Invalid)?;

    state.sizing_store.save(&validated).await?;
    *state.sizing.write().await = validated.clone();

    Ok(Json(validated))
}

async fn sizing_preview(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
    Query(query): Query<AutoSizeQuery>,
) -> AppResult<Json<AutoSizePreview>> {
    let symbol = normalize_symbol(&symbol)?;
    let preview = build_auto_size(
        &state,
        &symbol,
        query.side,
        None,
        query.stop_loss,
        query.leverage,
    )
    .await?;

    Ok(Json(preview))
}

#[derive(Debug, serde::Deserialize)]
struct AutoMarketOrderRequest {
    symbol: String,
    side: OrderSide,
    stop_loss: f64,
    client_order_id: Option<String>,
    #[serde(default)]
    allow_margin_bump: bool,
}

async fn auto_market_order(
    State(state): State<AppState>,
    payload: Result<Json<AutoMarketOrderRequest>, axum::extract::rejection::JsonRejection>,
) -> AppResult<Json<Value>> {
    let Json(req) = payload.map_err(|error| {
        AppError::Invalid(format!("invalid JSON request: {}", error.body_text()))
    })?;

    let symbol = normalize_symbol(&req.symbol)?;

    // Unlike market_order/limit_order above, this endpoint has no
    // reduce_only concept at all - it's dedicated entirely to opening a
    // new auto-sized entry, so the check is unconditional here.
    state
        .symbol_registry
        .ensure_binance_trading_symbol(&symbol)
        .await?;

    // FIX: AUTO MARKET previously ignored Settings -> Margin percentage and
    // forced a private 1% constant, while the UI describes this value as the
    // portfolio margin used per trade. Read the persisted setting here so
    // AUTO MARKET and regular MARKET/LIMIT entries use one consistent budget.
    let margin_pct = state.sizing.read().await.margin_pct;
    let preview = build_auto_size_with_margin_pct(
        &state,
        &symbol,
        req.side,
        None,
        req.stop_loss,
        None,
        margin_pct,
        req.allow_margin_bump,
    )
    .await?;

    let _guard = state.trade_lock.lock().await;

    // FIX: fail closed immediately before creating exposure. Startup/add-time
    // enforcement is not enough because margin mode can be changed directly
    // on Binance while this process is running.
    state.binance.ensure_isolated_margin(&symbol).await?;

    state
        .binance
        .set_leverage(&symbol, preview.leverage)
        .await?;

    let client_order_id = req.client_order_id.unwrap_or_else(|| {
        let prefix = match req.side {
            OrderSide::Buy => "fe-entry-long-auto",
            OrderSide::Sell => "fe-entry-short-auto",
        };
        new_client_order_id(prefix)
    });

    let order = state
        .binance
        .market_order(
            &symbol,
            req.side,
            preview.quantity,
            false,
            Some(&client_order_id),
        )
        .await?;

    // FIX: this endpoint previously relied ENTIRELY on the Binance
    // user-data WebSocket's ACCOUNT_UPDATE event to ever tell
    // `account_state` a position now exists. That event normally arrives
    // within milliseconds - but if it's ever delayed, dropped, or fails
    // to parse (network hiccups, a flaky connection, etc.), the very
    // next request in this same flow - the frontend's immediate
    // stop-market call for this auto-market order - would find
    // `account_state` still showing no position at all and reject with
    // "position not found", even though the fill genuinely happened on
    // Binance. Requesting a refresh here (which the spawn_refresh_worker
    // debounces/coalesces with any refresh ACCOUNT_UPDATE already
    // triggered) closes that race without waiting on the websocket
    // alone.
    state.account_state.request_refresh();
    // FIX: the chart's liquidation line comes from positionRisk, not the
    // account snapshot alone. Refresh both caches as soon as AUTO MARKET
    // fills so the frontend does not wait for a later websocket event or
    // the slow safety poll before it can render the risk boundary.
    state.position_risk_state.request_refresh();

    Ok(Json(json!({
        "symbol": symbol,
        "side": req.side,
        "stop_loss": preview.stop_loss,
        "entry_reference_price": preview.reference_price,
        "stop_distance": preview.stop_distance,
        "stop_distance_pct": preview.stop_distance_pct,
        "margin_pct": margin_pct,
        "margin_used": preview.margin_to_use,
        "theoretical_max_leverage": preview.theoretical_max_leverage,
        "safe_stop_leverage": preview.safe_stop_leverage,
        "exchange_max_leverage": preview.exchange_max_leverage,
        "maintenance_margin_ratio": preview.maintenance_margin_ratio,
        "margin_bumped": preview.margin_bumped,
        "applied_leverage": preview.leverage,
        "submitted_quantity": preview.quantity,
        "notional": preview.notional,
        "estimated_loss_at_stop": preview.estimated_loss_at_stop,
        "client_order_id": client_order_id,
        "stop_order_created": false,
        "order": order
    })))
}

async fn market_order(
    State(state): State<AppState>,
    payload: Result<Json<MarketOrderRequest>, axum::extract::rejection::JsonRejection>,
) -> AppResult<Json<Value>> {
    let Json(req) = payload.map_err(|error| {
        AppError::Invalid(format!("invalid JSON request: {}", error.body_text()))
    })?;

    let symbol = normalize_symbol(&req.symbol)?;

    // Only an entry (not reduce_only) can create NEW exposure to a
    // symbol - see ensure_supported_symbol's own doc comment for why a
    // reduce/close order must never be blocked here.
    if !req.reduce_only {
        state
            .symbol_registry
            .ensure_binance_trading_symbol(&symbol)
            .await?;
    }

    let (quantity, leverage_to_set, preview) = resolve_quantity(
        &state,
        &symbol,
        req.side,
        req.quantity,
        req.auto_size,
        None,
        req.stop_loss,
        req.leverage,
    )
    .await?;

    // FIX: serialize the final ISOLATED check with leverage/order submission.
    // Reduce-only exits deliberately skip this guard so a legacy CROSS
    // position can always be closed instead of becoming trapped.
    let _guard = state.trade_lock.lock().await;
    if !req.reduce_only {
        state.binance.ensure_isolated_margin(&symbol).await?;
    }

    if let Some(leverage) = leverage_to_set {
        state.binance.set_leverage(&symbol, leverage).await?;
    }

    let response = state
        .binance
        .market_order(
            &symbol,
            req.side,
            quantity,
            req.reduce_only,
            req.client_order_id.as_deref(),
        )
        .await?;

    // FIX: see the comment on the same call in auto_market_order above -
    // every endpoint that can change a position must force account_state
    // to reconcile, not just rely on ACCOUNT_UPDATE arriving in time.
    state.account_state.request_refresh();
    // FIX: liquidationPrice is supplied by the separate positionRisk cache.
    // Refreshing only account_state made the position appear first and its
    // liquidation line arrive seconds later on the next independent update.
    state.position_risk_state.request_refresh();

    Ok(Json(json!({
        "submitted_quantity": quantity,
        "applied_leverage": leverage_to_set,
        "sizing": preview,
        "order": response
    })))
}

/// FEATURE: estimate the isolated liquidation boundary for a resting entry LIMIT.
/// Binance cannot return `liquidationPrice` until the order fills, so the chart
/// needs a projected value. This mirrors isolated-position equity versus Binance's
/// tiered maintenance margin (`maintMarginRatio * notional - cum`).
async fn projected_limit_liquidation_price(
    state: &AppState,
    symbol: &str,
    side: OrderSide,
    entry_price: f64,
    quantity: f64,
    leverage: u32,
) -> Option<f64> {
    if !entry_price.is_finite()
        || entry_price <= 0.0
        || !quantity.is_finite()
        || quantity <= 0.0
        || leverage == 0
    {
        return None;
    }

    let notional = entry_price * quantity;
    let (mmr, cum) = state
        .binance
        .maintenance_margin_terms(symbol, notional)
        .await
        .ok()?;
    let leverage = leverage as f64;

    let projected = match side {
        OrderSide::Buy => {
            let denominator = 1.0 - mmr;
            if denominator <= 0.0 {
                return None;
            }
            (entry_price * (1.0 - 1.0 / leverage) - cum / quantity) / denominator
        }
        OrderSide::Sell => {
            let denominator = 1.0 + mmr;
            (entry_price * (1.0 + 1.0 / leverage) + cum / quantity) / denominator
        }
    };

    (projected.is_finite() && projected > 0.0).then_some(projected)
}

async fn limit_order(
    State(state): State<AppState>,
    Json(req): Json<LimitOrderRequest>,
) -> AppResult<Json<Value>> {
    tracing::info!(
        target: "api",
        "Received LIMIT order request: {:?}",
        req
    );

    let symbol = normalize_symbol(&req.symbol)?;

    // Same reasoning as market_order above - only gate the entry path.
    if !req.reduce_only {
        state
            .symbol_registry
            .ensure_binance_trading_symbol(&symbol)
            .await?;
    }

    let filters = state.binance.symbol_filters(&symbol).await?;
    let price = round_to_tick(req.price, filters.tick_size);

    let (quantity, leverage_to_set, preview) = resolve_quantity(
        &state,
        &symbol,
        req.side,
        req.quantity,
        req.auto_size,
        Some(price),
        req.stop_loss,
        req.leverage,
    )
    .await?;

    // FIX: LIMIT entries can rest and fill later, so they must be created only
    // after the same fail-closed ISOLATED check used by MARKET entries.
    let _guard = state.trade_lock.lock().await;
    if !req.reduce_only {
        state.binance.ensure_isolated_margin(&symbol).await?;
    }

    if let Some(leverage) = leverage_to_set {
        state.binance.set_leverage(&symbol, leverage).await?;
    }

    // FEATURE: compute the projected liquidation before submitting the resting
    // order so the frontend can draw its EST. LIQ guide immediately. This is
    // intentionally omitted for reduce-only orders because they do not create
    // a new leveraged entry leg.
    let account_snapshot = state.account_state.snapshot().await;
    let already_has_position = find_nonzero_position(&account_snapshot, &symbol).is_some();
    let estimated_liquidation_price = if !req.reduce_only && !already_has_position {
        match leverage_to_set {
            Some(leverage) => {
                projected_limit_liquidation_price(
                    &state,
                    &symbol,
                    req.side,
                    price,
                    quantity,
                    leverage,
                )
                .await
            }
            None => None,
        }
    } else {
        // FEATURE: do not show a misleading standalone estimate when this LIMIT
        // would add to an existing position; that case needs the current entry,
        // isolated wallet and resulting blended size to project liquidation.
        None
    };

    let response = state
        .binance
        .limit_order(
            &symbol,
            req.side,
            quantity,
            price,
            &req.time_in_force,
            req.reduce_only,
            req.client_order_id.as_deref(),
        )
        .await?;

    // A resting LIMIT order doesn't change the position until it fills,
    // so this isn't strictly required the way it is for market fills -
    // but requesting it anyway is harmless (coalesced by the refresh
    // worker) and keeps this endpoint consistent with every other
    // order-placing one, rather than being a special case to remember.
    state.account_state.request_refresh();

    Ok(Json(json!({
        "submitted_quantity": quantity,
        "submitted_price": price,
        "applied_leverage": leverage_to_set,
        "estimated_liquidation_price": estimated_liquidation_price,
        "sizing": preview,
        "order": response
    })))
}

/// Live (non-cached) lookup of a single symbol's open position, used as a
/// fallback when `account_state`'s in-memory snapshot doesn't have it yet.
///
/// FIX (the actual bug behind "stop-market 400s right after an auto-market
/// fill, position missing from the UI until restart"): `stop_market` used
/// to trust `state.account_state.snapshot()` unconditionally - a purely
/// in-memory cache that is ONLY updated by the Binance user-data
/// WebSocket's ACCOUNT_UPDATE event (or an explicit `request_refresh()`
/// call elsewhere). If that event is ever delayed, dropped, or fails to
/// parse - which this same machine's network has already been observed
/// to do to other persistent Binance connections - the cache can still
/// show "no position" for a fill that genuinely happened seconds ago on
/// Binance, and there was no fallback at all: the request just failed.
///
/// This does one direct, uncached `account_info()` REST call and also
/// writes the result back into `account_state` (so every OTHER cheap
/// cache read benefits from the same fresh data, not just this one
/// request), before giving up.
async fn find_position_amount(
    state: &AppState,
    symbol: &str,
) -> AppResult<(f64, FuturesAccountInfo)> {
    let cached = state.account_state.snapshot().await;

    if let Some(position) = find_nonzero_position(&cached, symbol) {
        return Ok((position, cached));
    }

    tracing::warn!(
        target: "api",
        symbol,
        "Position not found in cached account-state; falling back to a live Binance fetch"
    );

    let fresh = state.binance.account_info().await?;
    state.account_state.replace(fresh.clone()).await;

    match find_nonzero_position(&fresh, symbol) {
        Some(position) => Ok((position, fresh)),
        None => Err(AppError::Invalid(format!("position {symbol} not found"))),
    }
}

fn find_nonzero_position(account: &FuturesAccountInfo, symbol: &str) -> Option<f64> {
    account
        .positions
        .iter()
        .find(|position| position.symbol == symbol)
        .and_then(|position| position.position_amt.parse::<f64>().ok())
        .filter(|amount| amount.abs() > f64::EPSILON)
}

// FEATURE: resolve the liquidation boundary for the exact open leg instead
// of merely matching its symbol. The sign check keeps LONG and SHORT legs
// distinct in hedge mode, where two positionRisk rows can share one symbol.
fn liquidation_price_for_position(
    position_risk: &[Value],
    symbol: &str,
    position_amount: f64,
) -> Option<f64> {
    position_risk
        .iter()
        .find(|risk| {
            let same_symbol = risk.get("symbol").and_then(Value::as_str) == Some(symbol);
            let same_leg = risk
                .get("positionAmt")
                .and_then(Value::as_str)
                .and_then(|raw| raw.parse::<f64>().ok())
                .is_some_and(|risk_amount| {
                    risk_amount.abs() > f64::EPSILON
                        && risk_amount.is_sign_positive() == position_amount.is_sign_positive()
                });

            same_symbol && same_leg
        })
        .and_then(|risk| risk.get("liquidationPrice"))
        .and_then(Value::as_str)
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|price| price.is_finite() && *price > 0.0)
}

async fn stop_market(
    State(state): State<AppState>,
    Json(req): Json<ConditionalOrderRequest>,
) -> AppResult<Json<Value>> {
    if !req.close_position || req.quantity.is_some() {
        return Err(AppError::Invalid(
            "full-position stop loss requires close_position=true and no quantity".into(),
        ));
    }

    let symbol = normalize_symbol(&req.symbol)?;

    // FIX: was `state.account_state.snapshot()` used directly, with no
    // fallback if the cache didn't have the position yet - see the big
    // comment on find_position_amount above for why that raced.
    let (amount, _account) = find_position_amount(&state, &symbol).await?;

    let close_side = if amount > 0.0 {
        OrderSide::Sell
    } else {
        OrderSide::Buy
    };

    if req.side.as_str() != close_side.as_str() {
        return Err(AppError::Invalid(
            "stop-loss side does not close the current position".into(),
        ));
    }

    // FEATURE: fetch positionRisk at submission time instead of trusting the
    // slower cache used for display. Cross-margin liquidation can move as the
    // wallet or other positions change, so a stale boundary is not adequate
    // for a server-side safety check on a real protection order.
    let (current_price, filters, position_risk) = tokio::try_join!(
        state.binance.price(&symbol),
        state.binance.symbol_filters(&symbol),
        state.binance.position_risk(),
    )?;
    let liquidation_price = liquidation_price_for_position(&position_risk, &symbol, amount);
    state.position_risk_state.replace(position_risk).await;
    let trigger_price = round_to_tick(req.trigger_price, filters.tick_size);

    let _guard = state.trade_lock.lock().await;

    let valid_trigger = if amount > 0.0 {
        trigger_price < current_price
    } else {
        trigger_price > current_price
    };

    if !valid_trigger {
        return Err(AppError::Invalid(if amount > 0.0 {
            "LONG stop loss must be below the current market price".into()
        } else {
            "SHORT stop loss must be above the current market price".into()
        }));
    }

    // FEATURE: a stop beyond liquidation would never protect the position.
    // Reject it even if a caller bypasses the chart's visual clamp. Equality
    // is rejected too because liquidation may occur before an equal-price
    // conditional stop can execute.
    if let Some(liquidation_price) = liquidation_price {
        let before_liquidation = if amount > 0.0 {
            trigger_price > liquidation_price
        } else {
            trigger_price < liquidation_price
        };

        if !before_liquidation {
            return Err(AppError::Invalid(if amount > 0.0 {
                format!(
                    "LONG stop loss {trigger_price} must stay above liquidation price {liquidation_price}"
                )
            } else {
                format!(
                    "SHORT stop loss {trigger_price} must stay below liquidation price {liquidation_price}"
                )
            }));
        }
    }

    let client_algo_id = req
        .client_algo_id
        .unwrap_or_else(|| new_client_order_id("fe-sl-full"));

    // FIX: full-position SLs are drawn against the contract/last-price candles and
    // the validation above also reads Binance's contract price. Force CONTRACT_PRICE
    // here so an older client cannot accidentally submit MARK_PRICE and create a stop
    // that visibly trades through its chart level before Binance triggers it.
    let response = state
        .binance
        .conditional_order(
            &symbol,
            close_side,
            "STOP_MARKET",
            trigger_price,
            None,
            true,
            "CONTRACT_PRICE",
            Some(&client_algo_id),
        )
        .await?;

    let _ = state.trading_events.send(TradingEvent::SnapshotRequired {
        reason: format!("full stop loss created for {symbol}"),
    });

    Ok(Json(json!({
        "symbol": symbol,
        "side": close_side,
        "trigger_price": trigger_price,
        "close_position": true,
        "algo": response,
    })))
}

async fn cancel_algo_order(
    State(state): State<AppState>,
    Path((symbol, algo_id)): Path<(String, i64)>,
) -> AppResult<Json<Value>> {
    let _guard = state.trade_lock.lock().await;

    let symbol = normalize_symbol(&symbol)?;

    let response = state.binance.cancel_algo_order(&symbol, algo_id).await?;

    let _ = state.trading_events.send(TradingEvent::SnapshotRequired {
        reason: format!("conditional order {algo_id} cancelled for {symbol}"),
    });

    Ok(Json(response))
}

async fn take_profit_market(
    State(state): State<AppState>,
    Json(req): Json<ConditionalOrderRequest>,
) -> AppResult<Json<Value>> {
    let symbol = normalize_symbol(&req.symbol)?;
    let response = state
        .binance
        .conditional_order(
            &symbol,
            req.side,
            "TAKE_PROFIT_MARKET",
            req.trigger_price,
            req.quantity,
            req.close_position,
            // FIX: conditional take-profit triggers should follow the same contract/last
            // price shown by the terminal candles. Using MARK_PRICE here could let the
            // visible market trade through the TP level without triggering immediately,
            // so force CONTRACT_PRICE just like the protective full-position stop-loss.
            "CONTRACT_PRICE",
            req.client_algo_id.as_deref(),
        )
        .await?;

    Ok(Json(serde_json::to_value(response)?))
}

async fn close_position(
    State(state): State<AppState>,
    Json(req): Json<ClosePositionRequest>,
) -> AppResult<Json<Value>> {
    let symbol = normalize_symbol(&req.symbol)?;

    // FIX: same fallback as stop_market - a position that only just
    // opened (or is being closed right after another rapid action)
    // shouldn't 400 just because ACCOUNT_UPDATE hasn't landed yet.
    let (amount, _account) = find_position_amount(&state, &symbol).await?;

    let side = if amount > 0.0 {
        OrderSide::Sell
    } else {
        OrderSide::Buy
    };

    let response = state
        .binance
        .market_order(&symbol, side, amount.abs(), true, None)
        .await?;

    state.account_state.request_refresh();

    Ok(Json(json!({
        "closed_quantity": amount.abs(),
        "side": side,
        "order": response
    })))
}

/*
 * FIX: close_everything used to be all-or-nothing - every symbol with an
 * open order or open position, no exceptions. Same convention as
 * open_orders' own optional `?symbol=` (see its own comment above): symbol
 * omitted/null means "everything, unchanged behavior"; symbol provided
 * scopes the whole operation (both order cancellation and position
 * closing) down to just that one symbol, so closing out of one bad trade
 * can't accidentally take out every other open position on the account
 * too.
 */
#[derive(Debug, serde::Deserialize, Default)]
struct CloseEverythingRequest {
    symbol: Option<String>,
}

async fn close_everything(
    State(state): State<AppState>,
    Json(req): Json<CloseEverythingRequest>,
) -> AppResult<Json<Value>> {
    let target_symbol = req.symbol.as_deref().map(normalize_symbol).transpose()?;

    // Freeze trading before taking the snapshot so no new order can appear
    // between discovery and cancellation.
    let _guard = state.trade_lock.lock().await;

    // FIX: Close Everything must operate on Binance's live account state, not
    // the opportunistic WebSocket-backed cache. If an externally opened position
    // was missing from that cache, the old implementation could cancel orders
    // yet silently leave the real position open. The trade lock is already held,
    // so take the authoritative REST snapshot before deciding what to close.
    let (account, all_open_orders) = tokio::try_join!(
        state.binance.account_info(),
        state.binance.all_open_orders(),
    )?;
    state.account_state.replace(account.clone()).await;

    let mut symbols_to_cancel = HashSet::new();
    if let Some(orders) = all_open_orders.as_array() {
        for order in orders {
            if let Some(symbol) = order.get("symbol").and_then(Value::as_str) {
                let matches_target = target_symbol
                    .as_deref()
                    .is_none_or(|target| target == symbol);

                if matches_target {
                    symbols_to_cancel.insert(symbol.to_string());
                }
            }
        }
    }

    let open_positions: Vec<(String, f64)> = account
        .positions
        .into_iter()
        .filter_map(|position| {
            let amount = position.position_amt.parse::<f64>().ok()?;
            if amount.abs() <= f64::EPSILON {
                return None;
            }

            if let Some(target) = target_symbol.as_deref()
                && target != position.symbol
            {
                return None;
            }

            symbols_to_cancel.insert(position.symbol.clone());
            Some((position.symbol, amount))
        })
        .collect();

    let mut cancelled_symbols = Vec::new();
    let mut closed_positions = Vec::new();
    let mut errors = Vec::new();

    for symbol in symbols_to_cancel {
        match state.binance.cancel_all_orders(&symbol).await {
            Ok(_) => cancelled_symbols.push(symbol),
            Err(error) => errors.push(json!({
                "stage": "CANCEL_ORDERS",
                "symbol": symbol,
                "error": error.to_string(),
            })),
        }
    }

    for (symbol, amount) in open_positions {
        let close_side = if amount > 0.0 {
            OrderSide::Sell
        } else {
            OrderSide::Buy
        };

        match state
            .binance
            .market_order(
                &symbol,
                close_side,
                amount.abs(),
                true,
                Some(&new_client_order_id("fe-close-all")),
            )
            .await
        {
            Ok(order) => {
                // Surfaced at the top level (not just buried in the nested
                // `order` blob) so the frontend can place a trade marker at
                // the real fill price even for a symbol that isn't the
                // currently active chart - see appendTradeMarkerForSymbol
                // in tradeMarkers.ts on the frontend for why that matters.
                let avg_price = order
                    .avg_price
                    .as_deref()
                    .and_then(|value| value.parse::<f64>().ok())
                    .filter(|value| *value > 0.0);

                closed_positions.push(json!({
                    "symbol": symbol,
                    "closed_quantity": amount.abs(),
                    "side": close_side,
                    "avg_price": avg_price,
                    "order": order,
                }))
            }
            Err(error) => errors.push(json!({
                "stage": "CLOSE_POSITION",
                "symbol": symbol,
                "error": error.to_string(),
            })),
        }
    }

    // Reconcile the backend caches once after the batch operation. These
    // requests are coalesced by the capacity-one refresh channels.
    state.account_state.request_refresh();
    state.position_risk_state.request_refresh();

    let _ = state.trading_events.send(TradingEvent::SnapshotRequired {
        reason: "close everything completed".into(),
    });

    Ok(Json(json!({
        "completed": errors.is_empty(),
        "cancelled_symbols": cancelled_symbols,
        "closed_positions": closed_positions,
        "errors": errors,
    })))
}

#[derive(Debug, serde::Deserialize)]
struct RepriceReduceOrderRequest {
    price: f64,
    client_order_id: Option<String>,
    reduce_pct: Option<f64>,
}

async fn reprice_reduce_order(
    State(state): State<AppState>,
    Path((symbol, order_id)): Path<(String, i64)>,
    Json(req): Json<RepriceReduceOrderRequest>,
) -> AppResult<Json<Value>> {
    if !req.price.is_finite() || req.price <= 0.0 {
        return Err(AppError::Invalid("price must be finite and > 0".into()));
    }

    let symbol = normalize_symbol(&symbol)?;
    let (filters, open_orders) = tokio::try_join!(
        state.binance.symbol_filters(&symbol),
        state.binance.open_orders(&symbol),
    )?;
    let _guard = state.trade_lock.lock().await;

    let orders = open_orders
        .as_array()
        .ok_or_else(|| AppError::Invalid("invalid open orders response from Binance".into()))?;

    let requested_client_id = req.client_order_id.as_deref();
    let target = orders
        .iter()
        .find(|order| {
            if order.get("orderId").and_then(Value::as_i64) == Some(order_id) {
                return true;
            }
            if let Some(client_id) = requested_client_id
                && order.get("clientOrderId").and_then(Value::as_str) == Some(client_id)
            {
                return true;
            }
            false
        })
        .or_else(|| {
            let reduce_pct = req.reduce_pct?;
            let pct = reduce_pct.round().clamp(1.0, 100.0) as u32;
            let prefix = format!("fe-red-{pct}-");
            orders.iter().find(|order| {
                order
                    .get("reduceOnly")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    && order
                        .get("clientOrderId")
                        .and_then(Value::as_str)
                        .map(|id| id.starts_with(&prefix))
                        .unwrap_or(false)
            })
        })
        .ok_or_else(|| {
            AppError::Invalid(format!(
                "no matching open reduce-only order found for {symbol}"
            ))
        })?;

    let actual_order_id = target
        .get("orderId")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::Invalid("reduce order has no orderId".into()))?;
    let reduce_only = target
        .get("reduceOnly")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let order_type = target
        .get("type")
        .or_else(|| target.get("origType"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if !reduce_only || order_type != "LIMIT" {
        return Err(AppError::Invalid(
            "only open reduce-only LIMIT orders can be repriced".into(),
        ));
    }

    let side = match target.get("side").and_then(Value::as_str).unwrap_or("") {
        "BUY" => OrderSide::Buy,
        "SELL" => OrderSide::Sell,
        _ => return Err(AppError::Invalid("invalid reduce order side".into())),
    };
    let orig = target
        .get("origQty")
        .and_then(Value::as_str)
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    let executed = target
        .get("executedQty")
        .and_then(Value::as_str)
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    let quantity = floor_to_step((orig - executed).max(0.0), filters.step_size);
    if quantity < filters.min_qty {
        return Err(AppError::Invalid(
            "reduce order has no remaining quantity".into(),
        ));
    }

    let price = round_to_tick(req.price, filters.tick_size);
    if quantity * price < filters.min_notional {
        return Err(AppError::Invalid(format!(
            "notional {} is below min_notional {}",
            quantity * price,
            filters.min_notional
        )));
    }
    let time_in_force = target
        .get("timeInForce")
        .and_then(Value::as_str)
        .unwrap_or("GTC");
    /*
     * FIX (dragging a Binance-created reduce LIMIT deleted the order): this
     * endpoint used to cancel the live order first, derive a replacement
     * clientOrderId from Binance's existing ID, and only then validate/place
     * the replacement. Binance-generated IDs may contain characters or be
     * long enough that our stricter validate_id rejects the derived value;
     * by that point the original had already been irreversibly cancelled.
     *
     * Binance supports atomic LIMIT amendment through PUT /fapi/v1/order and
     * the client already exposes it as modify_limit_order. Amend the existing
     * order in place instead: no replacement client ID is needed, and any
     * rejected price/filter request leaves the original resting order intact.
     * For a partially filled order Binance expects the amended TOTAL quantity
     * (and cancels when quantity <= executedQty), so pass origQty rather than
     * the remaining quantity calculated above.
     */
    let replacement = state
        .binance
        .modify_limit_order(
            &symbol,
            actual_order_id,
            side,
            orig,
            price,
            time_in_force,
        )
        .await?;

    let _ = state.trading_events.send(TradingEvent::SnapshotRequired {
        reason: format!("reduce order {actual_order_id} repriced"),
    });

    Ok(Json(json!({
        "old_order_id": actual_order_id,
        "submitted_quantity": orig,
        "submitted_price": price,
        "order": replacement,
    })))
}

#[derive(Debug, serde::Deserialize)]
struct UpdateReduceOrderRequest {
    reduce_pct: f64,
}

async fn update_reduce_order(
    State(state): State<AppState>,
    Path((symbol, order_id)): Path<(String, i64)>,
    Json(req): Json<UpdateReduceOrderRequest>,
) -> AppResult<Json<Value>> {
    if !req.reduce_pct.is_finite() || req.reduce_pct <= 0.0 || req.reduce_pct > 100.0 {
        return Err(AppError::Invalid(
            "reduce_pct must be finite and in (0, 100]".into(),
        ));
    }

    let symbol = normalize_symbol(&symbol)?;

    let account = state.account_state.snapshot().await;
    let (filters, open_orders) = tokio::try_join!(
        state.binance.symbol_filters(&symbol),
        state.binance.open_orders(&symbol),
    )?;

    let _guard = state.trade_lock.lock().await;

    let amount = account
        .positions
        .iter()
        .find(|position| position.symbol == symbol)
        .and_then(|position| position.position_amt.parse::<f64>().ok())
        .unwrap_or(0.0);

    if amount.abs() <= f64::EPSILON {
        return Err(AppError::Invalid(format!("no open position for {symbol}")));
    }

    let current_side = if amount > 0.0 {
        OrderSide::Buy
    } else {
        OrderSide::Sell
    };
    let reduce_side = current_side.opposite();

    let orders = open_orders
        .as_array()
        .ok_or_else(|| AppError::Invalid("invalid open orders response from Binance".into()))?;

    let target = orders
        .iter()
        .find(|order| order.get("orderId").and_then(Value::as_i64) == Some(order_id))
        .ok_or_else(|| AppError::Invalid(format!("open order {order_id} not found")))?;

    let target_reduce_only = target
        .get("reduceOnly")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let target_type = target
        .get("type")
        .or_else(|| target.get("origType"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let target_side = target.get("side").and_then(Value::as_str).unwrap_or("");

    if !target_reduce_only || target_type != "LIMIT" {
        return Err(AppError::Invalid(
            "only open reduce-only LIMIT orders can be resized".into(),
        ));
    }

    if target_side != reduce_side.as_str() {
        return Err(AppError::Invalid(
            "reduce order side does not match the current position".into(),
        ));
    }

    let price = target
        .get("price")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .ok_or_else(|| AppError::Invalid("invalid reduce order price".into()))?;

    let time_in_force = target
        .get("timeInForce")
        .and_then(Value::as_str)
        .unwrap_or("GTC")
        .to_string();

    let original_open_quantity = {
        let orig = target
            .get("origQty")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);
        let executed = target
            .get("executedQty")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);
        (orig - executed).max(0.0)
    };

    let mut other_reserved = 0.0;
    for order in orders {
        if order.get("orderId").and_then(Value::as_i64) == Some(order_id) {
            continue;
        }

        let reduce_only = order
            .get("reduceOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let side = order.get("side").and_then(Value::as_str).unwrap_or("");

        if !reduce_only || side != reduce_side.as_str() {
            continue;
        }

        let orig = order
            .get("origQty")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);
        let executed = order
            .get("executedQty")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);

        other_reserved += (orig - executed).max(0.0);
    }

    let available_before =
        floor_to_step((amount.abs() - other_reserved).max(0.0), filters.step_size);

    if available_before < filters.min_qty {
        return Err(AppError::Invalid(
            "the full reducible position size is reserved by other reduce-only orders".into(),
        ));
    }

    let requested_raw = available_before * (req.reduce_pct / 100.0);
    let mut quantity = if req.reduce_pct >= 100.0 {
        available_before
    } else {
        floor_to_step(requested_raw, filters.step_size)
    };

    if quantity < filters.min_qty {
        quantity = filters.min_qty.min(available_before);
    }

    let mut available_after =
        floor_to_step((available_before - quantity).max(0.0), filters.step_size);

    if available_after > 0.0 && available_after < filters.min_qty {
        quantity = available_before;
        available_after = 0.0;
    }

    if quantity * price < filters.min_notional {
        return Err(AppError::Invalid(format!(
            "notional {} is below min_notional {}",
            quantity * price,
            filters.min_notional
        )));
    }

    let remaining_position_pct = if amount.abs() > 0.0 {
        ((available_after / amount.abs()) * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };

    let effective_reduce_pct = if available_before > 0.0 {
        ((quantity / available_before) * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };

    let pct_label = effective_reduce_pct.round().clamp(1.0, 100.0) as u32;
    let left_label = remaining_position_pct.round().clamp(0.0, 100.0) as u32;
    let replacement_client_id = new_client_order_id(&format!("fe-red-{pct_label}-l{left_label}"));

    state.binance.cancel_order(&symbol, order_id).await?;

    let replacement = match state
        .binance
        .limit_order(
            &symbol,
            reduce_side,
            quantity,
            price,
            &time_in_force,
            true,
            Some(&replacement_client_id),
        )
        .await
    {
        Ok(order) => order,
        Err(error) => {
            let rollback_id = new_client_order_id("fe-red-rollback");
            let rollback = state
                .binance
                .limit_order(
                    &symbol,
                    reduce_side,
                    original_open_quantity,
                    price,
                    &time_in_force,
                    true,
                    Some(&rollback_id),
                )
                .await;

            return Err(AppError::Invalid(format!(
                "failed to replace reduce order: {error}; rollback {}",
                if rollback.is_ok() {
                    "submitted"
                } else {
                    "also failed"
                }
            )));
        }
    };

    let _ = state.trading_events.send(TradingEvent::SnapshotRequired {
        reason: format!("reduce order {order_id} resized"),
    });

    Ok(Json(json!({
        "old_order_id": order_id,
        "requested_reduce_pct": req.reduce_pct,
        "reduce_pct": effective_reduce_pct,
        "submitted_quantity": quantity,
        "submitted_price": price,
        "remaining_quantity": available_after,
        "remaining_position_pct": remaining_position_pct,
        "order": replacement,
    })))
}

async fn position_intent(
    State(state): State<AppState>,
    Json(req): Json<PositionIntentRequest>,
) -> AppResult<Json<Value>> {
    let symbol = normalize_symbol(&req.symbol)?;
    let filters = state.binance.symbol_filters(&symbol).await?;

    // FIX: same live-fallback pattern as stop_market/close_position - a
    // position acted on immediately after opening (ADD/REDUCE/REVERSE
    // right after an entry fill) must not 400 just because
    // ACCOUNT_UPDATE hasn't landed in the cache yet.
    let (amount, _account) = find_position_amount(&state, &symbol).await?;

    let current_side = if amount > 0.0 {
        OrderSide::Buy
    } else {
        OrderSide::Sell
    };
    let opposite_side = current_side.opposite();

    match req.intent {
        PositionIntent::Add => {
            // ADD only ever grows exposure to this symbol - unlike REDUCE
            // (must always work, even for a legacy unsupported-symbol
            // position) and REVERSE (gated further down, right before its
            // own re-entry leg, not at its close leg).
            state
                .symbol_registry
                .ensure_binance_trading_symbol(&symbol)
                .await?;

            let _guard = state.trade_lock.lock().await;

            // FIX: ADD increases exposure to an existing position. Refuse it
            // when that position is CROSS; the user can still REDUCE/CLOSE it.
            state.binance.ensure_isolated_margin(&symbol).await?;

            let order_type = req.order_type.unwrap_or(IntentOrderType::Market);
            let reference_price = match order_type {
                IntentOrderType::Market => None,
                IntentOrderType::Limit => Some(req.price.ok_or_else(|| {
                    AppError::Invalid("price is required for LIMIT ADD".into())
                })?),
            };

            // FIX: ADD must allocate the configured portfolio-margin
            // percentage again, not a fixed 50 USDT notional (which adds only
            // 50 / leverage of actual margin). Size it on the backend from the
            // current available balance and the leverage already active on the
            // position. This also keeps the earlier -4161 fix: leverage is read
            // for sizing but never changed while the ISOLATED position is open.
            // MARKET and LIMIT ADD share this calculation.
            let existing_leverage = state.binance.current_leverage(&symbol).await?;
            let (quantity, _) = build_configured_margin_quantity(
                &state,
                &symbol,
                reference_price,
                Some(existing_leverage),
            )
            .await?;

            match order_type {
                IntentOrderType::Market => {
                    let order = state
                        .binance
                        .market_order(&symbol, current_side, quantity, false, None)
                        .await?;
                    state.account_state.request_refresh();
                    Ok(Json(json!({
                        "intent":"ADD",
                        "order_type":"MARKET",
                        "side":current_side,
                        "submitted_quantity":quantity,
                        "order":order
                    })))
                }
                IntentOrderType::Limit => {
                    // `reference_price` was validated above before it was used
                    // for configured-margin sizing, so LIMIT cannot reach this
                    // branch without a finite request price.
                    let raw_price = reference_price.expect("validated LIMIT ADD price");
                    let price = round_to_tick(raw_price, filters.tick_size);
                    if quantity * price < filters.min_notional {
                        return Err(AppError::Invalid(format!(
                            "notional {} is below min_notional {}",
                            quantity * price,
                            filters.min_notional
                        )));
                    }
                    let order = state
                        .binance
                        .limit_order(&symbol, current_side, quantity, price, "GTC", false, None)
                        .await?;
                    state.account_state.request_refresh();
                    Ok(Json(json!({
                        "intent":"ADD",
                        "order_type":"LIMIT",
                        "side":current_side,
                        "submitted_quantity":quantity,
                        "submitted_price":price,
                        "order":order
                    })))
                }
            }
        }
        PositionIntent::Reduce => {
            let reduce_pct = req.reduce_pct.unwrap_or(100.0);
            if !reduce_pct.is_finite() || reduce_pct <= 0.0 || reduce_pct > 100.0 {
                return Err(AppError::Invalid(
                    "reduce_pct must be finite and in (0, 100]".into(),
                ));
            }

            match req.order_type.unwrap_or(IntentOrderType::Market) {
                IntentOrderType::Market => {
                    let raw_quantity = amount.abs() * (reduce_pct / 100.0);
                    let quantity = if reduce_pct >= 100.0 {
                        amount.abs()
                    } else {
                        floor_to_step(raw_quantity, filters.step_size)
                    };

                    if quantity < filters.min_qty {
                        return Err(AppError::Invalid(format!(
                            "reduced quantity {quantity} is below min_qty {}; choose a larger percentage",
                            filters.min_qty
                        )));
                    }

                    let _guard = state.trade_lock.lock().await;
                    let client_order_id = new_client_order_id("fe-reduce-market");
                    let close_order = state
                        .binance
                        .market_order(
                            &symbol,
                            opposite_side,
                            quantity,
                            true,
                            Some(&client_order_id),
                        )
                        .await?;

                    state.account_state.request_refresh();

                    Ok(Json(json!({
                        "intent":"REDUCE",
                        "order_type":"MARKET",
                        "reduce_pct":reduce_pct,
                        "closed_quantity":quantity,
                        "remaining_quantity":(amount.abs() - quantity).max(0.0),
                        "side":opposite_side,
                        "close_order":close_order
                    })))
                }
                IntentOrderType::Limit => {
                    let raw_price = req.price.ok_or_else(|| {
                        AppError::Invalid("price is required for LIMIT REDUCE".into())
                    })?;
                    let price = round_to_tick(raw_price, filters.tick_size);

                    let already_reserved =
                        open_reduce_only_quantity(&state.binance, &symbol, opposite_side).await?;

                    let available_before = floor_to_step(
                        (amount.abs() - already_reserved).max(0.0),
                        filters.step_size,
                    );

                    if available_before < filters.min_qty {
                        return Err(AppError::Invalid(
                            "the full reducible position size is already reserved by existing limit-reduce orders"
                                .into(),
                        ));
                    }

                    let requested_raw = available_before * (reduce_pct / 100.0);
                    let mut quantity = if reduce_pct >= 100.0 {
                        available_before
                    } else {
                        floor_to_step(requested_raw, filters.step_size)
                    };

                    if quantity < filters.min_qty {
                        quantity = filters.min_qty.min(available_before);
                    }

                    let mut available_after =
                        floor_to_step((available_before - quantity).max(0.0), filters.step_size);

                    if available_after > 0.0 && available_after < filters.min_qty {
                        quantity = available_before;
                        available_after = 0.0;
                    }

                    if quantity <= 0.0 || quantity > available_before + filters.step_size / 2.0 {
                        return Err(AppError::Invalid(
                            "unable to derive a valid limit-reduce quantity".into(),
                        ));
                    }

                    if quantity * price < filters.min_notional {
                        return Err(AppError::Invalid(format!(
                            "notional {} is below min_notional {}",
                            quantity * price,
                            filters.min_notional
                        )));
                    }

                    let remaining_position_pct = if amount.abs() > 0.0 {
                        ((available_after / amount.abs()) * 100.0).clamp(0.0, 100.0)
                    } else {
                        0.0
                    };

                    let effective_reduce_pct = if available_before > 0.0 {
                        ((quantity / available_before) * 100.0).clamp(0.0, 100.0)
                    } else {
                        0.0
                    };

                    let pct_label = effective_reduce_pct.round().clamp(1.0, 100.0) as u32;
                    let left_label = remaining_position_pct.round().clamp(0.0, 100.0) as u32;
                    let client_order_id =
                        new_client_order_id(&format!("fe-red-{pct_label}-l{left_label}"));
                    let _guard = state.trade_lock.lock().await;
                    let order = state
                        .binance
                        .limit_order(
                            &symbol,
                            opposite_side,
                            quantity,
                            price,
                            "GTC",
                            true,
                            Some(&client_order_id),
                        )
                        .await?;

                    state.account_state.request_refresh();

                    Ok(Json(json!({
                        "intent":"REDUCE",
                        "order_type":"LIMIT",
                        "requested_reduce_pct":reduce_pct,
                        "reduce_pct":effective_reduce_pct,
                        "submitted_quantity":quantity,
                        "submitted_price":price,
                        "reserved_before":already_reserved,
                        "available_before":available_before,
                        "remaining_quantity":available_after,
                        "remaining_position_pct":remaining_position_pct,
                        "side":opposite_side,
                        "order":order
                    })))
                }
            }
        }
        PositionIntent::Reverse => {
            if matches!(req.order_type, Some(IntentOrderType::Limit)) {
                return Err(AppError::Invalid(
                    "LIMIT REVERSE is not supported; use MARKET REVERSE".into(),
                ));
            }

            let _guard = state.trade_lock.lock().await;
            state.binance.cancel_all_orders(&symbol).await?;

            let quantity = amount.abs();
            let close_order = state
                .binance
                .market_order(&symbol, opposite_side, quantity, true, None)
                .await?;

            state.account_state.request_refresh();

            let mut flat = false;
            for _ in 0..20 {
                let refreshed = state.account_state.snapshot().await;
                let remaining = refreshed
                    .positions
                    .iter()
                    .find(|position| position.symbol == symbol)
                    .and_then(|position| position.position_amt.parse::<f64>().ok())
                    .unwrap_or(0.0);

                if remaining.abs() < f64::EPSILON {
                    flat = true;
                    break;
                }

                sleep(Duration::from_millis(100)).await;
            }

            if !flat {
                return Err(AppError::Invalid(format!(
                    "{symbol} did not become flat after close; reverse aborted"
                )));
            }

            // The close leg above (reduce_only=true) must always be
            // allowed, even for a legacy position in an unsupported
            // symbol - it's only the re-entry into the OPPOSITE side
            // below that creates new exposure, so that's the only half
            // of REVERSE gated here.
            state
                .symbol_registry
                .ensure_binance_trading_symbol(&symbol)
                .await?;

            // FIX: a REVERSE closes first, then creates fresh exposure in the
            // opposite direction. Enforce ISOLATED after the account becomes
            // flat and before that new leg is submitted.
            state.binance.ensure_isolated_margin(&symbol).await?;

            if let Some(leverage) = req.leverage {
                state.binance.set_leverage(&symbol, leverage).await?;
            }

            let open_order = state
                .binance
                .market_order(&symbol, opposite_side, quantity, false, None)
                .await?;

            state.account_state.request_refresh();

            Ok(Json(json!({
                "intent":"REVERSE",
                "order_type":"MARKET",
                "closed_quantity":quantity,
                "opened_quantity":quantity,
                "side":opposite_side,
                "close_order":close_order,
                "open_order":open_order
            })))
        }
    }
}

async fn chase_limit_order(
    State(state): State<AppState>,
    Path((symbol, order_id)): Path<(String, i64)>,
) -> AppResult<Json<Value>> {
    let symbol = normalize_symbol(&symbol)?;

    let (open_orders, filters) = tokio::try_join!(
        state.binance.open_orders(&symbol),
        state.binance.symbol_filters(&symbol),
    )?;
    let orders = open_orders
        .as_array()
        .ok_or_else(|| AppError::Invalid("invalid open orders response from Binance".into()))?;

    let target = orders
        .iter()
        .find(|order| order.get("orderId").and_then(Value::as_i64) == Some(order_id))
        .ok_or_else(|| AppError::Invalid(format!("open order {order_id} not found")))?;

    let order_type = target
        .get("type")
        .or_else(|| target.get("origType"))
        .and_then(Value::as_str)
        .unwrap_or("");

    if order_type != "LIMIT" {
        return Err(AppError::Invalid(
            "only open LIMIT orders can be chased".into(),
        ));
    }

    if target
        .get("reduceOnly")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(AppError::Invalid(
            "reduce-only limits cannot be chased; use Market Reduce".into(),
        ));
    }

    let side_raw = target
        .get("side")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Invalid("limit order side is missing".into()))?;

    let side = match side_raw {
        "BUY" => OrderSide::Buy,
        "SELL" => OrderSide::Sell,
        _ => {
            return Err(AppError::Invalid(format!(
                "unsupported limit order side {side_raw}"
            )));
        }
    };

    let original_quantity = target
        .get("origQty")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .ok_or_else(|| AppError::Invalid("invalid original order quantity".into()))?;

    let executed_quantity = target
        .get("executedQty")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);

    let remaining_quantity = floor_to_step(
        (original_quantity - executed_quantity).max(0.0),
        filters.step_size,
    );

    if remaining_quantity < filters.min_qty {
        return Err(AppError::Invalid(format!(
            "remaining quantity {remaining_quantity} is below min_qty {}",
            filters.min_qty
        )));
    }

    let original_client_id = target
        .get("clientOrderId")
        .and_then(Value::as_str)
        .unwrap_or("");

    let chase_prefix = if original_client_id.starts_with("fe-entry-long-") {
        "fe-entry-long-chase"
    } else if original_client_id.starts_with("fe-entry-short-") {
        "fe-entry-short-chase"
    } else if original_client_id.starts_with("fe-add-") {
        "fe-add-chase"
    } else {
        "fe-chase"
    };
    let chase_client_id = new_client_order_id(chase_prefix);

    let _guard = state.trade_lock.lock().await;
    state.binance.cancel_order(&symbol, order_id).await?;

    // FIX: chasing converts a resting entry into immediate market exposure.
    // Check ISOLATED after cancelling the old order (Binance cannot change
    // margin mode while it is open) and abort before the market replacement.
    state.binance.ensure_isolated_margin(&symbol).await?;

    let market_order = state
        .binance
        .market_order(
            &symbol,
            side,
            remaining_quantity,
            false,
            Some(&chase_client_id),
        )
        .await
        .map_err(|error| {
            AppError::Invalid(format!(
                "limit order was cancelled, but market chase failed: {error}"
            ))
        })?;

    state.account_state.request_refresh();

    let _ = state.trading_events.send(TradingEvent::SnapshotRequired {
        reason: format!("limit order {order_id} chased to market"),
    });

    Ok(Json(json!({
        "chased_order_id": order_id,
        "side": side,
        "remaining_quantity": remaining_quantity,
        "market_order": market_order,
    })))
}

async fn query_order(
    State(state): State<AppState>,
    Path((symbol, order_id)): Path<(String, i64)>,
) -> AppResult<Json<Value>> {
    let symbol = normalize_symbol(&symbol)?;
    Ok(Json(state.binance.query_order(&symbol, order_id).await?))
}

async fn modify_limit_order(
    State(state): State<AppState>,
    Path((symbol, order_id)): Path<(String, i64)>,
    Json(req): Json<ModifyLimitOrderRequest>,
) -> AppResult<Json<Value>> {
    let symbol = normalize_symbol(&symbol)?;
    let filters = state.binance.symbol_filters(&symbol).await?;
    let price = round_to_tick(req.price, filters.tick_size);
    let quantity = floor_to_step(req.quantity, filters.step_size);

    if quantity < filters.min_qty {
        return Err(AppError::Invalid(format!(
            "quantity {quantity} is below min_qty {}",
            filters.min_qty
        )));
    }

    if quantity * price < filters.min_notional {
        return Err(AppError::Invalid(format!(
            "notional {} is below min_notional {}",
            quantity * price,
            filters.min_notional
        )));
    }

    tracing::info!(
        %symbol,
        order_id,
        side = %req.side.as_str(),
        quantity,
        price,
        time_in_force = %req.time_in_force,
        "Received LIMIT order modification"
    );

    let response = state
        .binance
        .modify_limit_order(
            &symbol,
            order_id,
            req.side,
            quantity,
            price,
            &req.time_in_force,
        )
        .await?;

    Ok(Json(json!({
        "submitted_quantity": quantity,
        "submitted_price": price,
        "order": response
    })))
}

async fn cancel_order(
    State(state): State<AppState>,
    Path((symbol, order_id)): Path<(String, i64)>,
) -> AppResult<Json<Value>> {
    let symbol = normalize_symbol(&symbol)?;
    Ok(Json(state.binance.cancel_order(&symbol, order_id).await?))
}

async fn open_orders(
    State(state): State<AppState>,
    Query(query): Query<OptionalSymbolQuery>,
) -> AppResult<Json<Value>> {
    // FIX: this used to require `symbol` and only ever return one symbol's
    // open orders - fine for a single-symbol frontend, but once a user can
    // hold positions on several symbols at once, the "Open Orders" list
    // needs to cover all of them, the same way GET /api/account already
    // returns positions for every symbol rather than just one. Omitting
    // `symbol` now returns everything; a caller that still wants just one
    // symbol's orders (e.g. the chart's own order-line rendering) can
    // continue passing `?symbol=X` exactly as before.
    match query.symbol {
        Some(symbol) => {
            let symbol = normalize_symbol(&symbol)?;
            Ok(Json(state.binance.open_orders(&symbol).await?))
        }
        None => Ok(Json(state.binance.all_open_orders().await?)),
    }
}

async fn cancel_all_orders(
    State(state): State<AppState>,
    Query(query): Query<SymbolQuery>,
) -> AppResult<Json<Value>> {
    let symbol = normalize_symbol(&query.symbol)?;
    Ok(Json(state.binance.cancel_all_orders(&symbol).await?))
}

async fn open_reduce_only_quantity(
    binance: &BinanceClient,
    symbol: &str,
    side: OrderSide,
) -> AppResult<f64> {
    let value = binance.open_orders(symbol).await?;
    let orders = value
        .as_array()
        .ok_or_else(|| AppError::Invalid("Binance open-orders response was not an array".into()))?;

    let mut total = 0.0;

    for order in orders {
        let is_reduce_only = order
            .get("reduceOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let order_side = order
            .get("side")
            .and_then(Value::as_str)
            .unwrap_or_default();

        if !is_reduce_only || order_side != side.as_str() {
            continue;
        }

        let original = order
            .get("origQty")
            .and_then(Value::as_str)
            .and_then(|raw| raw.parse::<f64>().ok())
            .unwrap_or(0.0);
        let executed = order
            .get("executedQty")
            .and_then(Value::as_str)
            .and_then(|raw| raw.parse::<f64>().ok())
            .unwrap_or(0.0);

        total += (original - executed).max(0.0);
    }

    Ok(total)
}

fn new_client_order_id(prefix: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);

    format!("{prefix}-{millis}")
}

#[allow(clippy::too_many_arguments)]
async fn resolve_quantity(
    state: &AppState,
    symbol: &str,
    side: OrderSide,
    quantity: Option<f64>,
    auto_size: bool,
    reference_price: Option<f64>,
    stop_loss: Option<f64>,
    leverage: Option<u32>,
) -> AppResult<(f64, Option<u32>, Option<AutoSizePreview>)> {
    if auto_size && quantity.is_some() {
        return Err(AppError::Invalid(
            "provide either quantity or auto_size=true, not both".into(),
        ));
    }

    if auto_size {
        if let Some(stop_loss) = stop_loss {
            let preview =
                build_auto_size(state, symbol, side, reference_price, stop_loss, leverage).await?;

            return Ok((preview.quantity, Some(preview.leverage), Some(preview)));
        }

        // FIX: manual MARKET/LIMIT entries previously sent an explicit
        // frontend-computed quantity with auto_size=false, so the persisted
        // margin_pct setting was completely bypassed. When the manual flow
        // requests auto sizing without a stop, size from configured portfolio
        // margin and the leverage selected in the UI; stop-aware auto sizing
        // above keeps its existing liquidation-safety calculation unchanged.
        let (quantity, leverage) =
            build_configured_margin_quantity(state, symbol, reference_price, leverage).await?;

        return Ok((quantity, Some(leverage), None));
    }

    let quantity = quantity
        .ok_or_else(|| AppError::Invalid("quantity is required unless auto_size=true".into()))?;

    if !quantity.is_finite() || quantity <= 0.0 {
        return Err(AppError::Invalid("quantity must be finite and > 0".into()));
    }

    let filters = state.binance.symbol_filters(symbol).await?;
    let quantity = floor_to_step(quantity, filters.step_size);

    if quantity < filters.min_qty {
        return Err(AppError::Invalid(format!(
            "quantity {quantity} is below min_qty {}",
            filters.min_qty
        )));
    }

    // FIX: this manual-quantity path (used by plain, non-auto-sized
    // MARKET/LIMIT orders and by ADD) used to stop at the min_qty check
    // above and hand the quantity straight to Binance - unlike the
    // auto_size path below, it never checked MIN_NOTIONAL at all. A
    // quantity that cleared min_qty could still be worth well under
    // Binance's minimum order value (e.g. a fixed base-asset quantity
    // sized for BTC applied to a much cheaper symbol), and would only
    // fail once it actually reached Binance's own order endpoint with a
    // raw "-4164: Order's notional must be no smaller than 20" - no
    // context, no mention of which value was too small or why.
    //
    // For MARKET orders `reference_price` is None (the real fill price
    // isn't known yet) - fetch the current price purely as an estimate
    // for this validation; it doesn't affect what's actually submitted,
    // it's only used to catch an obviously-too-small order before making
    // a real request to Binance.
    let notional_reference_price = match reference_price {
        Some(price) => price,
        None => state.binance.price(symbol).await?,
    };

    let notional = quantity * notional_reference_price;

    if notional < filters.min_notional {
        return Err(AppError::Invalid(format!(
            "quantity {quantity} at price {notional_reference_price:.4} gives a notional of \
             {notional:.2} USDT, below {symbol}'s exchange minimum of {:.2} USDT - increase the \
             order quantity",
            filters.min_notional
        )));
    }

    Ok((quantity, leverage, None))
}

async fn build_configured_margin_quantity(
    state: &AppState,
    symbol: &str,
    reference_price: Option<f64>,
    requested_leverage: Option<u32>,
) -> AppResult<(f64, u32)> {
    let config = state.sizing.read().await.clone();
    let leverage = requested_leverage.ok_or_else(|| {
        AppError::Invalid("leverage is required for configured-margin sizing".into())
    })?;

    let price_request = async {
        match reference_price {
            Some(value) => Ok::<f64, AppError>(value),
            None => state.binance.price(symbol).await,
        }
    };

    let account = state.account_state.snapshot().await;
    let (price, filters, exchange_max) = tokio::try_join!(
        price_request,
        state.binance.symbol_filters(symbol),
        state.binance.max_leverage(symbol),
    )?;

    let available_balance = account
        .available_balance
        .parse::<f64>()
        .map_err(|_| AppError::Invalid("invalid available balance from Binance".into()))?;

    if !available_balance.is_finite() || available_balance <= 0.0 {
        return Err(AppError::Invalid(
            "available balance must be finite and > 0".into(),
        ));
    }

    if !price.is_finite() || price <= 0.0 {
        return Err(AppError::Invalid(
            "reference price must be finite and > 0".into(),
        ));
    }

    let maximum_allowed = exchange_max.min(config.max_leverage);
    if leverage == 0 || leverage > maximum_allowed {
        return Err(AppError::Invalid(format!(
            "leverage {leverage} exceeds exchange/config maximum {maximum_allowed}"
        )));
    }

    let margin_to_use = available_balance * config.margin_pct;
    let raw_quantity = (margin_to_use * leverage as f64) / price;

    // FIX: always round DOWN to Binance's quantity step. Rounding up could
    // silently exceed the configured portfolio-margin percentage; for coarse
    // steps (BTC at low leverage, for example) the effective margin can
    // therefore be lower than the target, but never higher because of sizing.
    let quantity = floor_to_step(raw_quantity, filters.step_size);
    let min_notional_required = filters.min_notional.max(filters.min_qty * price);
    let notional = quantity * price;

    if quantity < filters.min_qty || notional < min_notional_required {
        let min_margin_required = min_notional_required / leverage as f64;
        return Err(AppError::Invalid(format!(
            "configured margin produces {quantity} {symbol} ({notional:.2} USDT notional), below the exchange minimum; increase margin allocation to at least {min_margin_required:.2} USDT or use higher leverage"
        )));
    }

    Ok((quantity, leverage))
}

async fn build_auto_size(
    state: &AppState,
    symbol: &str,
    side: OrderSide,
    reference_price: Option<f64>,
    stop_loss: f64,
    requested_leverage: Option<u32>,
) -> AppResult<AutoSizePreview> {
    let margin_pct = state.sizing.read().await.margin_pct;

    build_auto_size_with_margin_pct(
        state,
        symbol,
        side,
        reference_price,
        stop_loss,
        requested_leverage,
        margin_pct,
        false,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn build_auto_size_with_margin_pct(
    state: &AppState,
    symbol: &str,
    side: OrderSide,
    reference_price: Option<f64>,
    stop_loss: f64,
    requested_leverage: Option<u32>,
    margin_pct: f64,
    allow_margin_bump: bool,
) -> AppResult<AutoSizePreview> {
    if !margin_pct.is_finite() || margin_pct <= 0.0 || margin_pct > 1.0 {
        return Err(AppError::Invalid(
            "margin_pct must be finite and in (0, 1]".into(),
        ));
    }

    let mut config = state.sizing.read().await.clone();
    config.margin_pct = margin_pct;

    let price_request = async {
        match reference_price {
            Some(value) => Ok::<f64, AppError>(value),
            None => state.binance.price(symbol).await,
        }
    };

    let account = state.account_state.snapshot().await;
    let (price, filters, exchange_max) = tokio::try_join!(
        price_request,
        state.binance.symbol_filters(symbol),
        state.binance.max_leverage(symbol),
    )?;

    let available_balance = account
        .available_balance
        .parse::<f64>()
        .map_err(|_| AppError::Invalid("invalid available balance from Binance".into()))?;

    if !available_balance.is_finite() || available_balance <= 0.0 {
        return Err(AppError::Invalid(
            "available balance must be finite and > 0".into(),
        ));
    }

    if !price.is_finite() || price <= 0.0 {
        return Err(AppError::Invalid(
            "reference price must be finite and > 0".into(),
        ));
    }

    if !stop_loss.is_finite() || stop_loss <= 0.0 {
        return Err(AppError::Invalid("stop_loss must be finite and > 0".into()));
    }

    match side {
        OrderSide::Buy if stop_loss >= price => {
            return Err(AppError::Invalid(format!(
                "BUY stop_loss {stop_loss} must be below entry price {price}"
            )));
        }
        OrderSide::Sell if stop_loss <= price => {
            return Err(AppError::Invalid(format!(
                "SELL stop_loss {stop_loss} must be above entry price {price}"
            )));
        }
        _ => {}
    }

    let stop_distance = (price - stop_loss).abs();
    let stop_distance_pct = stop_distance / price;

    if !stop_distance_pct.is_finite() || stop_distance_pct <= 0.0 {
        return Err(AppError::Invalid(
            "stop distance must be finite and > 0".into(),
        ));
    }

    let margin_to_use = available_balance * config.margin_pct;
    let maximum_allowed = exchange_max.min(config.max_leverage);

    const MIN_LIQUIDATION_BUFFER_PCT: f64 = 0.002;

    let mut maint_margin_ratio = state
        .binance
        .maintenance_margin_ratio(symbol, margin_to_use * maximum_allowed as f64)
        .await
        .unwrap_or(0.0);

    let mut leverage = requested_leverage.unwrap_or(1).max(1);
    let mut calculated_leverage = 1_u32;
    let mut theoretical_max_leverage = 1.0_f64;
    let mut safe_stop_leverage = 1_u32;

    for _ in 0..4 {
        theoretical_max_leverage =
            1.0 / (stop_distance_pct + maint_margin_ratio + MIN_LIQUIDATION_BUFFER_PCT);
        safe_stop_leverage = (theoretical_max_leverage * config.leverage_safety)
            .floor()
            .max(1.0) as u32;
        calculated_leverage = safe_stop_leverage.min(maximum_allowed);
        leverage = requested_leverage.unwrap_or(calculated_leverage);

        let notional_estimate = margin_to_use * leverage as f64;
        let refined_ratio = state
            .binance
            .maintenance_margin_ratio(symbol, notional_estimate)
            .await
            .unwrap_or(maint_margin_ratio);

        let converged = (refined_ratio - maint_margin_ratio).abs() < 1e-12;
        maint_margin_ratio = refined_ratio;

        if converged {
            break;
        }
    }

    if leverage == 0 || leverage > exchange_max || leverage > config.max_leverage {
        return Err(AppError::Invalid(format!(
            "leverage {leverage} exceeds exchange/config maximum {}",
            maximum_allowed
        )));
    }

    if leverage > calculated_leverage {
        return Err(AppError::Invalid(format!(
            "leverage {leverage} is too high for entry {price} and stop_loss {stop_loss} \
             once the maintenance margin requirement is accounted for; \
             stop-based safe maximum is {calculated_leverage}"
        )));
    }

    let min_notional_required = filters.min_notional.max(filters.min_qty * price);

    let raw_quantity = (margin_to_use * leverage as f64) / price;
    let mut quantity = floor_to_step(raw_quantity, filters.step_size);
    let mut effective_margin_to_use = margin_to_use;
    let mut margin_bumped = false;

    if quantity < filters.min_qty || quantity * price < min_notional_required {
        if !allow_margin_bump {
            let min_margin_required = min_notional_required / leverage as f64;

            return Err(AppError::Invalid(format!(
                "Stop distance of {:.2}% only allows {leverage}x safe leverage here, which \
                 produces a ${:.2} notional (${:.2} margin x {leverage}x) for {symbol} - below \
                 the ${:.2} minimum order size. Increase your margin allocation to at least \
                 ${min_margin_required:.2} (currently ${margin_to_use:.2}), tighten the stop \
                 distance, or resubmit with allow_margin_bump=true to automatically raise the \
                 margin used for this trade only.",
                stop_distance_pct * 100.0,
                margin_to_use * leverage as f64,
                margin_to_use,
                min_notional_required,
            )));
        }

        let mut bumped_quantity = filters.min_qty.max(min_notional_required / price);
        bumped_quantity = (bumped_quantity / filters.step_size).ceil() * filters.step_size;

        quantity = bumped_quantity;
        effective_margin_to_use = (quantity * price) / leverage as f64;
        margin_bumped = true;
    }

    let notional = quantity * price;
    let estimated_loss_at_stop = quantity * stop_distance;

    if quantity < filters.min_qty {
        return Err(AppError::Invalid(format!(
            "auto-sized quantity {quantity} is below min_qty {}",
            filters.min_qty
        )));
    }

    if notional < filters.min_notional {
        return Err(AppError::Invalid(format!(
            "auto-sized notional {notional} is below min_notional {}",
            filters.min_notional
        )));
    }

    Ok(AutoSizePreview {
        symbol: symbol.to_ascii_uppercase(),
        side,
        reference_price: price,
        stop_loss,
        stop_distance,
        stop_distance_pct,
        available_balance,
        margin_to_use: effective_margin_to_use,
        theoretical_max_leverage,
        safe_stop_leverage,
        exchange_max_leverage: exchange_max,
        leverage,
        quantity,
        notional,
        estimated_loss_at_stop,
        maintenance_margin_ratio: maint_margin_ratio,
        margin_bumped,
        config,
    })
}
