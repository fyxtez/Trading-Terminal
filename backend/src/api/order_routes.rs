use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde_json::{Value, json};

use crate::{
    binance::{floor_to_step, normalize_symbol, round_to_tick},
    error::{AppError, AppResult},
    models::{ModifyLimitOrderRequest, OptionalSymbolQuery, SymbolQuery},
    order_mutation_workflow::{
        ModifyLimitRequest, cancel_all_orders_and_reconcile, cancel_order_and_reconcile,
        modify_limit_and_reconcile,
    },
};

use super::{AppState, request_authoritative_refresh};

pub(super) async fn query_order(
    State(state): State<AppState>,
    Path((symbol, order_id)): Path<(String, i64)>,
) -> AppResult<Json<Value>> {
    let symbol = normalize_symbol(&symbol)?;
    Ok(Json(state.binance.query_order(&symbol, order_id).await?))
}

pub(super) async fn modify_limit_order(
    State(state): State<AppState>,
    Path((symbol, order_id)): Path<(String, i64)>,
    Json(req): Json<ModifyLimitOrderRequest>,
) -> AppResult<Json<Value>> {
    let symbol = normalize_symbol(&symbol)?;
    let _guard = state.trade_lock.lock().await;
    let filters = state.binance.symbol_filters(&symbol).await?;
    let (quantity, price) = normalize_limit_values(req.quantity, req.price, &filters)?;

    tracing::info!(
        %symbol,
        order_id,
        side = %req.side.as_str(),
        quantity,
        price,
        time_in_force = %req.time_in_force,
        "Received LIMIT order modification"
    );
    let response = modify_limit_and_reconcile(
        &state.binance,
        ModifyLimitRequest {
            symbol: &symbol,
            order_id,
            side: req.side,
            quantity,
            price,
            time_in_force: &req.time_in_force,
        },
        || {
            request_authoritative_refresh(
                &state,
                format!("limit order {order_id} modification attempted"),
            )
        },
    )
    .await?;

    Ok(Json(json!({
        "submitted_quantity": quantity,
        "submitted_price": price,
        "order": response
    })))
}

fn normalize_limit_values(
    raw_quantity: f64,
    raw_price: f64,
    filters: &crate::models::SymbolFilters,
) -> AppResult<(f64, f64)> {
    let price = round_to_tick(raw_price, filters.tick_size);
    let quantity = floor_to_step(raw_quantity, filters.step_size);

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
    Ok((quantity, price))
}

pub(super) async fn cancel_order(
    State(state): State<AppState>,
    Path((symbol, order_id)): Path<(String, i64)>,
) -> AppResult<Json<Value>> {
    let symbol = normalize_symbol(&symbol)?;
    let _guard = state.trade_lock.lock().await;
    let response = cancel_order_and_reconcile(&state.binance, &symbol, order_id, || {
        request_authoritative_refresh(&state, format!("order {order_id} cancellation attempted"))
    })
    .await?;
    Ok(Json(response))
}

pub(super) async fn open_orders(
    State(state): State<AppState>,
    Query(query): Query<OptionalSymbolQuery>,
) -> AppResult<Json<Value>> {
    match query.symbol {
        Some(symbol) => {
            let symbol = normalize_symbol(&symbol)?;
            Ok(Json(state.binance.open_orders(&symbol).await?))
        }
        None => Ok(Json(state.binance.all_open_orders().await?)),
    }
}

pub(super) async fn cancel_all_orders(
    State(state): State<AppState>,
    Query(query): Query<SymbolQuery>,
) -> AppResult<Json<Value>> {
    let symbol = normalize_symbol(&query.symbol)?;
    let _guard = state.trade_lock.lock().await;
    let response = cancel_all_orders_and_reconcile(&state.binance, &symbol, || {
        request_authoritative_refresh(
            &state,
            format!("all {symbol} order cancellations attempted"),
        )
    })
    .await?;
    Ok(Json(response))
}

#[cfg(test)]
mod tests {
    use super::normalize_limit_values;
    use crate::models::SymbolFilters;

    fn filters() -> SymbolFilters {
        SymbolFilters {
            step_size: 0.001,
            min_qty: 0.002,
            min_notional: 20.0,
            tick_size: 0.1,
        }
    }

    #[test]
    fn modification_normalizes_quantity_and_price_before_submission() {
        assert_eq!(
            normalize_limit_values(0.0029, 10_000.06, &filters()).expect("valid order"),
            (0.002, 10_000.1)
        );
    }

    #[test]
    fn modification_rejects_quantity_and_notional_below_exchange_minimums() {
        assert!(normalize_limit_values(0.0019, 20_000.0, &filters()).is_err());
        assert!(normalize_limit_values(0.0029, 9_000.0, &filters()).is_err());
    }
}
