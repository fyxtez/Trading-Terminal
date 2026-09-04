use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderValue, StatusCode},
    middleware,
    routing::{get, post, put},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{Mutex, RwLock, broadcast},
    time::Duration,
};
use tower_http::{
    cors::{AllowOrigin, Any, CorsLayer},
    limit::RequestBodyLimitLayer,
    timeout::TimeoutLayer,
    trace::TraceLayer,
};

use crate::{
    account_state::AccountState,
    alerts::{AlertRuntime, AlertStore},
    auto_market_workflow::{
        AutoMarketProtectionOutcome, AutoMarketProtectionRequest, protect_auto_market_entry,
    },
    binance::{BinanceClient, floor_to_step, normalize_symbol, round_to_tick},
    diagnostics::DiagnosticsState,
    error::{AppError, AppResult},
    icons::IconStore,
    models::{
        AutoSizePreview, AutoSizeQuery, BinanceOrderResponse, ClosePositionRequest,
        ConditionalOrderRequest, FuturesAccountInfo, IntentOrderType, LimitOrderRequest,
        MarginSizingConfig, MarketOrderRequest, OrderSide, PositionIntent, PositionIntentRequest,
        SetLeverageRequest, SymbolFilters,
    },
    operation_safety::OperationSafety,
    position_risk_state::PositionRiskState,
    sizing_store::SizingStore,
    symbol_registry::SymbolRegistry,
    trade_lock::TradeLock,
    trading_events::TradingEvent,
};

mod account_routes;
mod alert_routes;
mod catalog_routes;
mod order_routes;
mod system_routes;

const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);

use account_routes::{account, balance, position_realized_pnl};
use alert_routes::{create_alert, delete_alert, list_alerts, update_alert};
use catalog_routes::{
    add_symbol, delete_symbol, get_icon_image, list_icons, list_symbols, mexc_klines,
};
use order_routes::{cancel_all_orders, cancel_order, modify_limit_order, open_orders, query_order};
use system_routes::{
    authorize, diagnostics, health, issue_websocket_ticket, record_request_diagnostics,
    reload_desktop_credentials, server_time, trading_websocket,
};

#[derive(Clone)]
pub struct AppState {
    pub binance: BinanceClient,
    pub account_state: AccountState,
    pub position_risk_state: PositionRiskState,
    pub sizing: Arc<RwLock<MarginSizingConfig>>,
    pub sizing_store: SizingStore,
    pub service_token: String,
    pub trade_lock: TradeLock,
    pub trading_events: broadcast::Sender<TradingEvent>,
    pub alert_store: AlertStore,
    pub alert_runtime: AlertRuntime,
    pub symbol_registry: SymbolRegistry,
    pub icon_store: IconStore,
    pub websocket_tickets: Arc<Mutex<HashMap<String, tokio::time::Instant>>>,
    pub diagnostics: DiagnosticsState,
    pub operation_safety: OperationSafety,
}

pub fn router(state: AppState) -> Router {
    let router = Router::new()
        .route("/health", get(health))
        .route("/api/diagnostics", get(diagnostics))
        .route(
            "/api/desktop/credentials/reload",
            post(reload_desktop_credentials),
        )
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
        .route("/api/auth/ws-ticket", post(issue_websocket_ticket))
        .route(
            "/api/orders/open",
            get(open_orders).delete(cancel_all_orders),
        )
        .route(
            "/api/orders/{symbol}/{order_id}",
            get(query_order)
                .put(modify_limit_order)
                .delete(cancel_order),
        );

    let router = if crate::PRICE_ALERTS_ENABLED {
        router
            .route("/api/alerts", get(list_alerts).post(create_alert))
            .route("/api/alerts/{id}", put(update_alert).delete(delete_alert))
    } else {
        router
    };

    router
        .layer(middleware::from_fn_with_state(state.clone(), authorize))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            record_request_diagnostics,
        ))
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::list([
                    HeaderValue::from_static("http://localhost:5173"),
                    HeaderValue::from_static("http://127.0.0.1:5173"),
                    HeaderValue::from_static("tauri://localhost"),
                    HeaderValue::from_static("http://tauri.localhost"),
                    HeaderValue::from_static("https://tauri.localhost"),
                ]))
                .allow_headers(Any)
                .allow_methods(Any),
        )
        // Trading requests are small JSON documents. Keep this explicit rather
        // than relying on Axum's extractor default so future non-JSON routes
        // cannot accidentally accept unbounded loopback input.
        .layer(RequestBodyLimitLayer::new(MAX_REQUEST_BODY_BYTES))
        // Binance calls have their own shorter client timeouts. This outer
        // deadline bounds multi-step handlers and guarantees a wedged workflow
        // cannot occupy the single-user backend indefinitely.
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            REQUEST_TIMEOUT,
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
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
    let _guard = state.trade_lock.lock().await;
    let configured_max = state.sizing.read().await.max_leverage;
    if req.leverage == 0 || req.leverage > configured_max {
        return Err(AppError::Invalid(format!(
            "leverage {} exceeds the configured maximum {configured_max}",
            req.leverage
        )));
    }
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
    let _guard = state.trade_lock.lock().await;
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

async fn refresh_exposure_prerequisites(state: &AppState, symbol: &str) -> AppResult<()> {
    if !state.binance.is_configured() {
        return Err(AppError::Invalid(
            "Binance is not connected; exposure increases are disabled".into(),
        ));
    }

    state.binance.ensure_reference_data_fresh().await?;
    let (account, position_risk, current_price) = tokio::try_join!(
        state.binance.account_info(),
        state.binance.position_risk(),
        state.binance.price(symbol),
    )?;
    let available_balance = account
        .available_balance
        .parse::<f64>()
        .map_err(|_| AppError::Invalid("invalid available balance from Binance".into()))?;
    if !available_balance.is_finite() || available_balance < 0.0 {
        return Err(AppError::Invalid(
            "fresh Binance account state is invalid; exposure increase blocked".into(),
        ));
    }
    if !current_price.is_finite() || current_price <= 0.0 {
        return Err(AppError::Invalid(
            "fresh Binance market price is unavailable; exposure increase blocked".into(),
        ));
    }

    let account_drifted = serde_json::to_value(state.account_state.snapshot().await).ok()
        != serde_json::to_value(&account).ok();
    let risk_drifted = state.position_risk_state.snapshot().await != position_risk;
    state.account_state.replace(account).await;
    state.position_risk_state.replace(position_risk).await;
    state.diagnostics.exchange_success();
    state
        .diagnostics
        .reconciliation_success("pre-trade", account_drifted || risk_drifted);
    Ok(())
}

async fn auto_market_order(
    State(state): State<AppState>,
    payload: Result<Json<AutoMarketOrderRequest>, axum::extract::rejection::JsonRejection>,
) -> AppResult<Json<Value>> {
    let Json(req) = payload.map_err(|error| {
        AppError::Invalid(format!("invalid JSON request: {}", error.body_text()))
    })?;

    let symbol = normalize_symbol(&req.symbol)?;

    let _guard = state.trade_lock.lock().await;
    // This endpoint is dedicated to opening exposure, so keep the registered
    // execution-symbol check inside the same lock as the final risk checks.
    state
        .symbol_registry
        .ensure_binance_trading_symbol(&symbol)
        .await?;
    refresh_exposure_prerequisites(&state, &symbol).await?;

    // AUTO MARKET is an open-and-protect workflow, not an ADD workflow. A
    // flat starting point makes the compensating reduce-only close precise:
    // it can only remove exposure created by this request.
    ensure_auto_market_starts_flat(&state.account_state.snapshot().await, &symbol)?;

    let filters = state.binance.symbol_filters(&symbol).await?;
    let stop_loss = round_to_tick(req.stop_loss, filters.tick_size);

    // AUTO MARKET previously ignored Settings -> Margin percentage and
    // forced a private 1% constant, while the UI describes this value as the
    // portfolio margin used per trade. Read the persisted setting here so
    // AUTO MARKET and regular MARKET/LIMIT entries use one consistent budget.
    let margin_pct = state.sizing.read().await.margin_pct;
    let preview = build_auto_size_with_margin_pct(
        &state,
        &symbol,
        req.side,
        None,
        stop_loss,
        None,
        margin_pct,
        req.allow_margin_bump,
    )
    .await?;

    // fail closed immediately before creating exposure. Startup/add-time
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

    // Entry and protection remain under one trade lock. The client ID lets us
    // reconcile a lost POST response instead of submitting a duplicate stop.
    let client_algo_id = new_client_order_id("fe-sl-auto");
    let close_side = req.side.opposite();
    let rollback_id = new_client_order_id("fe-auto-rollback");
    let protection = protect_auto_market_entry(
        &state.binance,
        AutoMarketProtectionRequest {
            symbol: &symbol,
            close_side,
            trigger_price: stop_loss,
            rollback_quantity: executed_quantity_or(&order, preview.quantity),
            client_algo_id: &client_algo_id,
            rollback_client_order_id: &rollback_id,
        },
    )
    .await?;

    match protection {
        AutoMarketProtectionOutcome::Protected(stop_order) => {
            request_trading_snapshot(&state, format!("auto market protected for {symbol}"));

            Ok(Json(json!({
            "completed": true,
            "rolled_back": false,
            "symbol": symbol,
            "side": req.side,
            "stop_loss": stop_loss,
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
            "client_algo_id": client_algo_id,
            "stop_order_created": true,
            "stop_trigger_price": stop_loss,
            "stop_algo": stop_order,
            "order": order
            })))
        }
        AutoMarketProtectionOutcome::RolledBack(rollback_order) => {
            request_trading_snapshot(&state, format!("auto market compensation for {symbol}"));

            Ok(Json(json!({
            "completed": false,
            "rolled_back": true,
            "message": "Automatic stop-loss could not be confirmed. The entry was closed with a reduce-only market order; verify the final state on Binance before retrying.",
            "symbol": symbol,
            "side": req.side,
            "stop_loss": stop_loss,
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
            "client_algo_id": client_algo_id,
            "stop_order_created": false,
            "stop_trigger_price": stop_loss,
            "stop_algo": Value::Null,
            "order": order,
            "rollback_order": rollback_order
            })))
        }
    }
}

fn ensure_auto_market_starts_flat(account: &FuturesAccountInfo, symbol: &str) -> AppResult<()> {
    if find_nonzero_position(account, symbol).is_some() {
        return Err(AppError::Invalid(format!(
            "AUTO MARKET only opens a new protected position; {symbol} already has exposure. Use ADD or REDUCE instead"
        )));
    }

    Ok(())
}

fn executed_quantity_or(order: &BinanceOrderResponse, fallback: f64) -> f64 {
    order
        .executed_qty
        .as_deref()
        .and_then(|quantity| quantity.parse::<f64>().ok())
        .filter(|quantity| quantity.is_finite() && *quantity > 0.0)
        .unwrap_or(fallback)
}

fn request_trading_snapshot(state: &AppState, reason: String) {
    state.account_state.request_refresh();
    state.position_risk_state.request_refresh();
    let _ = state
        .trading_events
        .send(TradingEvent::SnapshotRequired { reason });
}

async fn market_order(
    State(state): State<AppState>,
    payload: Result<Json<MarketOrderRequest>, axum::extract::rejection::JsonRejection>,
) -> AppResult<Json<Value>> {
    let Json(req) = payload.map_err(|error| {
        AppError::Invalid(format!("invalid JSON request: {}", error.body_text()))
    })?;

    let symbol = normalize_symbol(&req.symbol)?;

    let _guard = state.trade_lock.lock().await;

    if !req.reduce_only {
        // Only an entry can create new exposure. Check the registered symbol
        // under the trade lock so a concurrent catalog edit cannot race it.
        state
            .symbol_registry
            .ensure_binance_trading_symbol(&symbol)
            .await?;
        refresh_exposure_prerequisites(&state, &symbol).await?;
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

    // Serialize sizing, the final ISOLATED check, and order submission. A
    // reduce-only exit skips only the ISOLATED validation so a legacy CROSS
    // position can still be closed; it remains serialized by TradeLock.
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

    // see the comment on the same call in auto_market_order above -
    // every endpoint that can change a position must force account_state
    // to reconcile, not just rely on ACCOUNT_UPDATE arriving in time.
    state.account_state.request_refresh();
    // liquidationPrice is supplied by the separate positionRisk cache.
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

/// estimate the isolated liquidation boundary for a resting entry LIMIT.
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

    let _guard = state.trade_lock.lock().await;

    if !req.reduce_only {
        state
            .symbol_registry
            .ensure_binance_trading_symbol(&symbol)
            .await?;
        refresh_exposure_prerequisites(&state, &symbol).await?;
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

    // LIMIT entries can rest and fill later, so they must be created only
    // after the same fail-closed ISOLATED check used by MARKET entries.
    if !req.reduce_only {
        state.binance.ensure_isolated_margin(&symbol).await?;
    }

    if let Some(leverage) = leverage_to_set {
        state.binance.set_leverage(&symbol, leverage).await?;
    }

    // compute the projected liquidation before submitting the resting
    // order so the frontend can draw its EST. LIQ guide immediately. This is
    // intentionally omitted for reduce-only orders because they do not create
    // a new leveraged entry leg.
    let account_snapshot = state.account_state.snapshot().await;
    let already_has_position = find_nonzero_position(&account_snapshot, &symbol).is_some();
    let estimated_liquidation_price = if !req.reduce_only && !already_has_position {
        match leverage_to_set {
            Some(leverage) => {
                projected_limit_liquidation_price(
                    &state, &symbol, req.side, price, quantity, leverage,
                )
                .await
            }
            None => None,
        }
    } else {
        // do not show a misleading standalone estimate when this LIMIT
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
/// `stop_market` used
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
        .filter(|position| position.symbol == symbol)
        .find_map(|position| {
            position
                .position_amt
                .parse::<f64>()
                .ok()
                .filter(|amount| amount.abs() > f64::EPSILON)
        })
}

fn close_side_for_position(position_amount: f64) -> OrderSide {
    if position_amount > 0.0 {
        OrderSide::Sell
    } else {
        OrderSide::Buy
    }
}

fn unfilled_order_quantity(original: f64, executed: f64) -> f64 {
    (original - executed).max(0.0)
}

fn validate_stop_trigger(
    position_amount: f64,
    current_price: f64,
    trigger_price: f64,
    liquidation_price: Option<f64>,
) -> AppResult<()> {
    let valid_trigger = if position_amount > 0.0 {
        trigger_price < current_price
    } else {
        trigger_price > current_price
    };

    if !valid_trigger {
        return Err(AppError::Invalid(if position_amount > 0.0 {
            "LONG stop loss must be below the current market price".into()
        } else {
            "SHORT stop loss must be above the current market price".into()
        }));
    }

    if let Some(liquidation_price) = liquidation_price {
        let before_liquidation = if position_amount > 0.0 {
            trigger_price > liquidation_price
        } else {
            trigger_price < liquidation_price
        };

        if !before_liquidation {
            return Err(AppError::Invalid(if position_amount > 0.0 {
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

    Ok(())
}

// resolve the liquidation boundary for the exact open leg instead
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
    let _guard = state.trade_lock.lock().await;

    // was `state.account_state.snapshot()` used directly, with no
    // fallback if the cache didn't have the position yet - see the big
    // comment on find_position_amount above for why that raced.
    let (amount, _account) = find_position_amount(&state, &symbol).await?;

    let close_side = close_side_for_position(amount);

    if req.side.as_str() != close_side.as_str() {
        return Err(AppError::Invalid(
            "stop-loss side does not close the current position".into(),
        ));
    }

    // fetch positionRisk at submission time instead of trusting the
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

    // A stop beyond liquidation would never protect the position. Equality is
    // rejected because liquidation may occur before the stop can execute.
    validate_stop_trigger(amount, current_price, trigger_price, liquidation_price)?;

    let client_algo_id = req
        .client_algo_id
        .unwrap_or_else(|| new_client_order_id("fe-sl-full"));

    // full-position SLs are drawn against the contract/last-price candles and
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
    let _guard = state.trade_lock.lock().await;
    let response = state
        .binance
        .conditional_order(
            &symbol,
            req.side,
            "TAKE_PROFIT_MARKET",
            req.trigger_price,
            req.quantity,
            req.close_position,
            // conditional take-profit triggers should follow the same contract/last
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
    let _guard = state.trade_lock.lock().await;

    // same fallback as stop_market - a position that only just
    // opened (or is being closed right after another rapid action)
    // shouldn't 400 just because ACCOUNT_UPDATE hasn't landed yet.
    let (amount, _account) = find_position_amount(&state, &symbol).await?;

    let side = close_side_for_position(amount);

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
 * close_everything used to be all-or-nothing - every symbol with an
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

fn close_everything_result(
    cancelled_symbols: Vec<String>,
    closed_positions: Vec<Value>,
    errors: Vec<Value>,
) -> Value {
    json!({
        "completed": errors.is_empty(),
        "cancelled_symbols": cancelled_symbols,
        "closed_positions": closed_positions,
        "errors": errors,
    })
}

async fn close_everything(
    State(state): State<AppState>,
    Json(req): Json<CloseEverythingRequest>,
) -> AppResult<Json<Value>> {
    let target_symbol = req.symbol.as_deref().map(normalize_symbol).transpose()?;

    // Freeze trading before taking the snapshot so no new order can appear
    // between discovery and cancellation.
    let _guard = state.trade_lock.lock().await;

    // Close Everything must operate on Binance's live account state, not
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
        let close_side = close_side_for_position(amount);

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

    Ok(Json(close_everything_result(
        cancelled_symbols,
        closed_positions,
        errors,
    )))
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
    let _guard = state.trade_lock.lock().await;
    let (filters, open_orders) = tokio::try_join!(
        state.binance.symbol_filters(&symbol),
        state.binance.open_orders(&symbol),
    )?;
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
    let quantity = floor_to_step(unfilled_order_quantity(orig, executed), filters.step_size);
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
     * this
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
        .modify_limit_order(&symbol, actual_order_id, side, orig, price, time_in_force)
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
    let _guard = state.trade_lock.lock().await;

    let account = state.account_state.snapshot().await;
    let (filters, open_orders) = tokio::try_join!(
        state.binance.symbol_filters(&symbol),
        state.binance.open_orders(&symbol),
    )?;

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
        unfilled_order_quantity(orig, executed)
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

        other_reserved += unfilled_order_quantity(orig, executed);
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
    let _guard = state.trade_lock.lock().await;
    if matches!(req.intent, PositionIntent::Add) {
        refresh_exposure_prerequisites(&state, &symbol).await?;
    }
    let filters = state.binance.symbol_filters(&symbol).await?;

    // same live-fallback pattern as stop_market/close_position - a
    // position acted on immediately after opening (ADD/REDUCE
    // right after an entry fill) must not 400 just because
    // ACCOUNT_UPDATE hasn't landed in the cache yet.
    let (amount, _account) = find_position_amount(&state, &symbol).await?;

    let opposite_side = close_side_for_position(amount);
    let current_side = opposite_side.opposite();

    match req.intent {
        PositionIntent::Add => {
            // ADD only ever grows exposure to this symbol, unlike REDUCE,
            // which must remain available for a legacy unsupported-symbol
            // position so exposure can still be closed safely.
            state
                .symbol_registry
                .ensure_binance_trading_symbol(&symbol)
                .await?;

            // ADD increases exposure to an existing position. Refuse it
            // when that position is CROSS; the user can still REDUCE/CLOSE it.
            state.binance.ensure_isolated_margin(&symbol).await?;

            let order_type = req.order_type.unwrap_or(IntentOrderType::Market);
            let reference_price =
                match order_type {
                    IntentOrderType::Market => None,
                    IntentOrderType::Limit => Some(req.price.ok_or_else(|| {
                        AppError::Invalid("price is required for LIMIT ADD".into())
                    })?),
                };

            // ADD must allocate the configured portfolio-margin
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
    }
}

async fn chase_limit_order(
    State(state): State<AppState>,
    Path((symbol, order_id)): Path<(String, i64)>,
) -> AppResult<Json<Value>> {
    let symbol = normalize_symbol(&symbol)?;
    let _guard = state.trade_lock.lock().await;
    state
        .symbol_registry
        .ensure_binance_trading_symbol(&symbol)
        .await?;
    refresh_exposure_prerequisites(&state, &symbol).await?;

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
        unfilled_order_quantity(original_quantity, executed_quantity),
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

    state.binance.cancel_order(&symbol, order_id).await?;

    // chasing converts a resting entry into immediate market exposure.
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

        total += unfilled_order_quantity(original, executed);
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

        // manual MARKET/LIMIT entries previously sent an explicit
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

    // this manual-quantity path (used by plain, non-auto-sized
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

    let maximum_allowed = exchange_max.min(config.max_leverage);
    if leverage == 0 || leverage > maximum_allowed {
        return Err(AppError::Invalid(format!(
            "leverage {leverage} exceeds exchange/config maximum {maximum_allowed}"
        )));
    }

    let quantity = configured_margin_quantity(
        symbol,
        available_balance,
        config.margin_pct,
        leverage,
        price,
        &filters,
    )?;

    Ok((quantity, leverage))
}

fn configured_margin_quantity(
    symbol: &str,
    available_balance: f64,
    margin_pct: f64,
    leverage: u32,
    price: f64,
    filters: &SymbolFilters,
) -> AppResult<f64> {
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
    if !margin_pct.is_finite() || margin_pct <= 0.0 || margin_pct > 1.0 {
        return Err(AppError::Invalid(
            "margin_pct must be finite and in (0, 1]".into(),
        ));
    }
    if leverage == 0 {
        return Err(AppError::Invalid("leverage must be > 0".into()));
    }

    let margin_to_use = available_balance * margin_pct;
    let raw_quantity = (margin_to_use * leverage as f64) / price;

    // Quantity always rounds down so exchange normalization cannot spend more
    // than the configured portfolio-margin allocation.
    let quantity = floor_to_step(raw_quantity, filters.step_size);
    let min_notional_required = filters.min_notional.max(filters.min_qty * price);
    let notional = quantity * price;

    if quantity < filters.min_qty || notional < min_notional_required {
        let min_margin_required = min_notional_required / leverage as f64;
        return Err(AppError::Invalid(format!(
            "configured margin produces {quantity} {symbol} ({notional:.2} USDT notional), below the exchange minimum; increase margin allocation to at least {min_margin_required:.2} USDT or use higher leverage"
        )));
    }

    Ok(quantity)
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

fn validate_auto_stop_liquidation_room(
    theoretical_max_leverage: f64,
    price: f64,
    stop_loss: f64,
) -> AppResult<()> {
    if theoretical_max_leverage.is_finite() && theoretical_max_leverage > 1.0 {
        return Ok(());
    }

    Err(AppError::Invalid(format!(
        "stop_loss {stop_loss} is beyond the estimated liquidation boundary even at 1x leverage; move the stop closer to entry price {price}"
    )))
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

    // At 1x isolated leverage the liquidation boundary is roughly one entry
    // price away (slightly less after maintenance margin). A farther SHORT
    // stop can therefore never execute before liquidation. The previous
    // `.max(1.0)` above silently converted that impossible result into 1x,
    // opened the position, and only the follow-up stop request exposed the
    // problem. Reject it here, before any exchange mutation occurs.
    validate_auto_stop_liquidation_room(theoretical_max_leverage, price, stop_loss)?;

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

#[cfg(test)]
mod financial_invariant_tests {
    use serde_json::json;

    use super::{
        close_everything_result, close_side_for_position, configured_margin_quantity,
        ensure_auto_market_starts_flat, executed_quantity_or, find_nonzero_position,
        liquidation_price_for_position, unfilled_order_quantity,
        validate_auto_stop_liquidation_room, validate_stop_trigger,
    };
    use crate::models::{
        BinanceOrderResponse, FuturesAccountInfo, FuturesPosition, OrderSide, SymbolFilters,
    };

    fn account_with_positions(positions: Vec<FuturesPosition>) -> FuturesAccountInfo {
        FuturesAccountInfo {
            total_wallet_balance: "1000".into(),
            available_balance: "900".into(),
            assets: Vec::new(),
            positions,
            extra: json!({}),
        }
    }

    fn position(symbol: &str, amount: &str) -> FuturesPosition {
        FuturesPosition {
            symbol: symbol.into(),
            position_amt: amount.into(),
            entry_price: "100".into(),
            unrealized_profit: "0".into(),
            extra: json!({}),
        }
    }

    #[test]
    fn close_uses_the_exposure_reducing_side() {
        assert!(matches!(close_side_for_position(0.5), OrderSide::Sell));
        assert!(matches!(close_side_for_position(-0.5), OrderSide::Buy));
    }

    #[test]
    fn configured_sizing_rounds_down_without_exceeding_the_margin_budget() {
        let filters = SymbolFilters {
            step_size: 0.001,
            min_qty: 0.001,
            min_notional: 20.0,
            tick_size: 0.1,
        };
        let quantity = configured_margin_quantity("BTCUSDT", 1_000.0, 0.02, 10, 30_000.0, &filters)
            .expect("configured sizing should produce a valid order");

        assert_eq!(quantity, 0.006);
        let effective_margin = quantity * 30_000.0 / 10.0;
        assert!(effective_margin <= 1_000.0 * 0.02);
    }

    #[test]
    fn configured_sizing_fails_before_submission_when_minimums_cannot_be_met() {
        let filters = SymbolFilters {
            step_size: 0.001,
            min_qty: 0.001,
            min_notional: 20.0,
            tick_size: 0.1,
        };

        assert!(configured_margin_quantity("BTCUSDT", 10.0, 0.01, 1, 30_000.0, &filters).is_err());
    }

    #[test]
    fn partial_fill_math_never_reuses_executed_or_negative_quantity() {
        assert!((unfilled_order_quantity(0.010, 0.004) - 0.006).abs() < 1e-12);
        assert_eq!(unfilled_order_quantity(0.010, 0.010), 0.0);
        assert_eq!(unfilled_order_quantity(0.010, 0.011), 0.0);
    }

    #[test]
    fn stop_loss_must_be_between_market_and_liquidation() {
        assert!(validate_stop_trigger(1.0, 100.0, 90.0, Some(80.0)).is_ok());
        assert!(validate_stop_trigger(1.0, 100.0, 100.0, Some(80.0)).is_err());
        assert!(validate_stop_trigger(1.0, 100.0, 80.0, Some(80.0)).is_err());

        assert!(validate_stop_trigger(-1.0, 100.0, 110.0, Some(120.0)).is_ok());
        assert!(validate_stop_trigger(-1.0, 100.0, 100.0, Some(120.0)).is_err());
        assert!(validate_stop_trigger(-1.0, 100.0, 120.0, Some(120.0)).is_err());
    }

    #[test]
    fn auto_market_rejects_a_stop_that_cannot_precede_liquidation_at_one_x() {
        assert!(validate_auto_stop_liquidation_room(4.2, 100.0, 120.0).is_ok());

        let error = validate_auto_stop_liquidation_room(0.65, 100.0, 250.0)
            .expect_err("an impossible stop must be rejected before entry");
        assert!(error.to_string().contains("even at 1x leverage"));
    }

    #[test]
    fn cached_position_lookup_rejects_flat_and_invalid_rows() {
        let account = account_with_positions(vec![
            position("BTCUSDT", "0"),
            position("ETHUSDT", "invalid"),
            position("SOLUSDT", "-2.5"),
            position("XRPUSDT", "0"),
            position("XRPUSDT", "125"),
        ]);

        assert_eq!(find_nonzero_position(&account, "BTCUSDT"), None);
        assert_eq!(find_nonzero_position(&account, "ETHUSDT"), None);
        assert_eq!(find_nonzero_position(&account, "SOLUSDT"), Some(-2.5));
        assert_eq!(find_nonzero_position(&account, "XRPUSDT"), Some(125.0));
    }

    #[test]
    fn auto_market_compensation_requires_a_flat_starting_symbol() {
        let flat = account_with_positions(vec![position("BTCUSDT", "0")]);
        assert!(ensure_auto_market_starts_flat(&flat, "BTCUSDT").is_ok());

        let exposed = account_with_positions(vec![position("BTCUSDT", "0.025")]);
        let error = ensure_auto_market_starts_flat(&exposed, "BTCUSDT")
            .expect_err("existing exposure must use an explicit position intent");
        assert!(error.to_string().contains("already has exposure"));
    }

    #[test]
    fn auto_market_rollback_uses_the_executed_fill_quantity() {
        let order = BinanceOrderResponse {
            order_id: Some(1),
            symbol: Some("BTCUSDT".into()),
            status: Some("FILLED".into()),
            client_order_id: Some("entry".into()),
            price: Some("0".into()),
            avg_price: Some("100".into()),
            orig_qty: Some("0.25".into()),
            executed_qty: Some("0.20".into()),
            extra: json!({}),
        };

        assert_eq!(executed_quantity_or(&order, 0.25), 0.20);

        let missing_fill = BinanceOrderResponse {
            executed_qty: Some("0".into()),
            ..order
        };
        assert_eq!(executed_quantity_or(&missing_fill, 0.25), 0.25);
    }

    #[test]
    fn liquidation_lookup_selects_the_matching_hedge_leg() {
        let risks = vec![
            json!({
                "symbol": "BTCUSDT",
                "positionAmt": "1",
                "liquidationPrice": "80"
            }),
            json!({
                "symbol": "BTCUSDT",
                "positionAmt": "-1",
                "liquidationPrice": "120"
            }),
        ];

        assert_eq!(
            liquidation_price_for_position(&risks, "BTCUSDT", 1.0),
            Some(80.0)
        );
        assert_eq!(
            liquidation_price_for_position(&risks, "BTCUSDT", -1.0),
            Some(120.0)
        );
    }

    #[test]
    fn close_everything_reports_partial_failure_instead_of_claiming_completion() {
        let result = close_everything_result(
            vec!["BTCUSDT".into()],
            vec![json!({ "symbol": "BTCUSDT" })],
            vec![json!({
                "stage": "CLOSE_POSITION",
                "symbol": "ETHUSDT",
                "error": "simulated rejection"
            })],
        );

        assert_eq!(result["completed"], false);
        assert_eq!(result["cancelled_symbols"][0], "BTCUSDT");
        assert_eq!(result["errors"][0]["stage"], "CLOSE_POSITION");
    }
}
