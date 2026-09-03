use axum::{
    Json,
    extract::{Path, Query, State},
    http::header,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use crate::{
    error::{AppError, AppResult},
    icons::IconEntry,
    symbol_registry::{AddSymbolRequest, MarketDataSource, MarketKind},
};

use super::AppState;

pub(super) async fn list_symbols(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "symbols": state.symbol_registry.list().await }))
}

pub(super) async fn add_symbol(
    State(state): State<AppState>,
    Json(request): Json<AddSymbolRequest>,
) -> AppResult<(axum::http::StatusCode, Json<Value>)> {
    // Registry membership is part of the backend allow-list for new exposure.
    // Serialize its mutation with trading, then release before cosmetic icon IO.
    let registry_guard = state.trade_lock.lock().await;
    let (symbol, created) = state.symbol_registry.add(&request.symbol).await?;

    if symbol.data_source == MarketDataSource::Binance {
        // startup enforcement only covers symbols already persisted at
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
    drop(registry_guard);

    // Icon resolution is best-effort and never limits the local symbol registry.
    // Select the venue/asset-specific resolver. MEXC crypto uses
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

pub(super) async fn delete_symbol(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
) -> AppResult<Json<Value>> {
    // NOTE: intentionally does NOT touch `state.icon_store`. Deleting a
    // symbol from the trading registry must not delete its cached icon -
    // see the module doc-comment on `icons.rs` for why (cheap re-adds,
    // and a symbol that briefly disappears from the list shouldn't lose
    // its artwork).
    let _guard = state.trade_lock.lock().await;
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
pub(super) async fn list_icons(State(state): State<AppState>) -> Json<Value> {
    let entries = state.icon_store.list().await;

    Json(json!({
        "count": entries.len(),
        "icons": entries.into_iter().map(icon_json).collect::<Vec<_>>(),
    }))
}

pub(super) async fn get_icon_image(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
) -> AppResult<Response> {
    let (bytes, content_type) = state
        .icon_store
        .read_bytes(&symbol)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("no cached icon for {symbol}")))?;

    Ok(([(header::CONTENT_TYPE, content_type)], bytes).into_response())
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct MexcKlineQuery {
    symbol: String,
    interval: String,
    start: Option<u64>,
    end: Option<u64>,
}

/// Server-side MEXC proxy. Browsers cannot call contract.mexc.com directly
/// because that API does not send CORS headers for localhost/web origins.
/// Keep this endpoint deliberately narrow so it cannot become an open proxy.
pub(super) async fn mexc_klines(
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

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()?;
    let mut request = client
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
