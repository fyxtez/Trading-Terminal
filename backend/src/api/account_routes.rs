use axum::{Json, extract::State};
use serde_json::{Value, json};

use crate::error::AppResult;

use super::AppState;

pub(super) async fn account(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let (account, position_risk) =
        tokio::try_join!(state.binance.account_info(), state.binance.position_risk(),)?;

    state.account_state.replace(account.clone()).await;
    state
        .position_risk_state
        .replace(position_risk.clone())
        .await;

    let mut value = serde_json::to_value(account)?;
    merge_position_risk(&mut value, &position_risk);
    Ok(Json(value))
}

pub(super) async fn position_realized_pnl(State(state): State<AppState>) -> AppResult<Json<Value>> {
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
            "LONG" => {
                if side == "BUY" {
                    quantity
                } else {
                    -quantity
                }
            }
            "SHORT" => {
                if side == "SELL" {
                    quantity
                } else {
                    -quantity
                }
            }
            _ => {
                if side == "BUY" {
                    quantity
                } else {
                    -quantity
                }
            }
        };
        let previous = exposure - delta;

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
            risk.get("symbol").and_then(Value::as_str) == Some(symbol)
                && risk
                    .get("positionSide")
                    .and_then(Value::as_str)
                    .unwrap_or("BOTH")
                    == account_position_side
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

pub(super) async fn balance(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let account = state.account_state.snapshot().await;
    Ok(Json(json!({
        "total_wallet_balance": account.total_wallet_balance,
        "available_balance": account.available_balance
    })))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::current_position_realized_pnl;

    #[test]
    fn realized_pnl_stops_at_the_current_position_flat_boundary() {
        let trades = vec![
            json!({
                "id": 1,
                "time": 100,
                "positionSide": "BOTH",
                "side": "BUY",
                "qty": "2",
                "realizedPnl": "0"
            }),
            json!({
                "id": 2,
                "time": 200,
                "positionSide": "BOTH",
                "side": "SELL",
                "qty": "1",
                "realizedPnl": "5.5"
            }),
        ];

        let lifecycle = current_position_realized_pnl(&trades, "BOTH", 1.0);
        assert!(lifecycle.complete);
        assert_eq!(lifecycle.realized_pnl, 5.5);
        assert_eq!(lifecycle.lifecycle_started_at, Some(100));
    }

    #[test]
    fn realized_pnl_is_not_authoritative_without_a_flat_boundary() {
        let trades = vec![json!({
            "id": 2,
            "time": 200,
            "positionSide": "LONG",
            "side": "SELL",
            "qty": "1",
            "realizedPnl": "3"
        })];

        let lifecycle = current_position_realized_pnl(&trades, "LONG", 2.0);
        assert!(!lifecycle.complete);
        assert_eq!(lifecycle.realized_pnl, 3.0);
    }
}
