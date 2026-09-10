use crate::{
    binance::BinanceClient,
    error::{AppError, AppResult},
    models::{AlgoOrderResponse, OrderSide},
};
use serde_json::Value;

pub(crate) fn full_stop<'a>(
    orders: &'a [Value],
    symbol: &str,
    side: OrderSide,
) -> AppResult<Option<&'a Value>> {
    let mut matches = orders.iter().filter(|order| {
        order["symbol"].as_str() == Some(symbol)
            && order["side"].as_str() == Some(side.as_str())
            && order["orderType"].as_str() == Some("STOP_MARKET")
            && (order["closePosition"] == true || order["closePosition"] == "true")
            && matches!(order["positionSide"].as_str(), Some("BOTH") | None)
    });
    let result = matches.next();
    if matches.next().is_some() {
        return Err(AppError::Conflict(
            "Multiple full-position stops found; no orders were changed".into(),
        ));
    }
    Ok(result)
}

trait StopExchange {
    async fn open(&self, symbol: &str) -> AppResult<Vec<Value>>;
    async fn cancel(&self, symbol: &str, id: i64) -> AppResult<Value>;
    async fn place(
        &self,
        symbol: &str,
        side: OrderSide,
        price: f64,
        working: &str,
        client_id: &str,
    ) -> AppResult<AlgoOrderResponse>;
    async fn query(&self, client_id: &str) -> AppResult<AlgoOrderResponse>;
}
impl StopExchange for BinanceClient {
    async fn open(&self, symbol: &str) -> AppResult<Vec<Value>> {
        self.open_algo_orders(symbol).await
    }
    async fn cancel(&self, symbol: &str, id: i64) -> AppResult<Value> {
        self.cancel_algo_order(symbol, id).await
    }
    async fn place(
        &self,
        symbol: &str,
        side: OrderSide,
        price: f64,
        working: &str,
        client_id: &str,
    ) -> AppResult<AlgoOrderResponse> {
        self.conditional_order(
            symbol,
            side,
            "STOP_MARKET",
            price,
            None,
            true,
            working,
            Some(client_id),
        )
        .await
    }
    async fn query(&self, client_id: &str) -> AppResult<AlgoOrderResponse> {
        self.query_algo_order_by_client_id(client_id).await
    }
}

pub(crate) async fn replace_full_stop(
    exchange: &BinanceClient,
    symbol: &str,
    side: OrderSide,
    price: f64,
    client_id: &str,
) -> AppResult<AlgoOrderResponse> {
    replace(exchange, symbol, side, price, client_id).await
}

async fn replace(
    exchange: &impl StopExchange,
    symbol: &str,
    side: OrderSide,
    price: f64,
    client_id: &str,
) -> AppResult<AlgoOrderResponse> {
    let client_id = crate::binance::validate_id(client_id)?;
    let client_id = client_id.as_str();
    let orders = exchange.open(symbol).await?;
    let old = full_stop(&orders, symbol, side)?;
    let rollback = if let Some(old) = old {
        let id = old["algoId"]
            .as_i64()
            .or_else(|| old["algoId"].as_str()?.parse().ok())
            .filter(|id| *id > 0)
            .ok_or_else(|| {
                AppError::Invalid("Existing stop has an invalid ID; no orders were changed".into())
            })?;
        let old_price = old["triggerPrice"]
            .as_f64()
            .or_else(|| old["triggerPrice"].as_str()?.parse().ok())
            .filter(|p| p.is_finite() && *p > 0.0)
            .ok_or_else(|| {
                AppError::Invalid(
                    "Existing stop has an invalid price; no orders were changed".into(),
                )
            })?;
        let working = old["workingType"]
            .as_str()
            .filter(|w| matches!(*w, "MARK_PRICE" | "CONTRACT_PRICE"))
            .ok_or_else(|| {
                AppError::Invalid(
                    "Existing stop has an invalid trigger source; no orders were changed".into(),
                )
            })?;
        // Never swallow cancellation errors or send a replacement on an uncertain result.
        exchange.cancel(symbol, id).await?;
        let remaining = exchange.open(symbol).await?;
        if full_stop(&remaining, symbol, side)?.is_some() {
            return Err(AppError::Conflict("Stop cancellation is not yet confirmed. No replacement was sent; refresh the position before retrying".into()));
        }
        Some((old_price, working))
    } else {
        None
    };
    match exchange
        .place(symbol, side, price, "CONTRACT_PRICE", client_id)
        .await
    {
        Ok(order) => Ok(order),
        Err(error) => {
            // A lost acknowledgement is not a rejection. Query the same client ID
            // before attempting compensation, so we cannot create a duplicate.
            match exchange.query(client_id).await {
                Ok(order)
                    if matches!(
                        order.algo_status.as_deref(),
                        Some("NEW" | "TRIGGERING" | "TRIGGERED" | "FINISHED")
                    ) =>
                {
                    return Ok(order);
                }
                Ok(_) => {
                    return Err(AppError::Conflict(format!(
                        "Stop update returned an inactive or unknown order status. Check protection before retrying. {error}"
                    )));
                }
                Err(AppError::Binance { code: -2013, .. }) => {}
                Err(_) => {
                    return Err(AppError::Conflict(format!(
                        "Stop update could not be confirmed: {error}. Check the live stop before retrying; no duplicate was sent"
                    )));
                }
            }
            if let Some((old_price, working)) = rollback {
                let restore_id = format!("{}-r", &client_id[..client_id.len().min(34)]);
                match exchange
                    .place(symbol, side, old_price, working, &restore_id)
                    .await
                {
                    Ok(_) => Err(AppError::Conflict(format!(
                        "Stop update failed; the previous stop price was restored. {error}"
                    ))),
                    Err(_) => Err(AppError::Conflict(format!(
                        "Stop update failed and restoring the previous stop could not be confirmed. Check protection immediately. {error}"
                    ))),
                }
            } else {
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{cell::RefCell, collections::VecDeque};
    fn stop() -> Value {
        json!({"symbol":"BTCUSDT", "side":"BUY", "positionSide":"BOTH", "orderType":"STOP_MARKET", "closePosition":true, "algoId":9007199254740993_i64, "triggerPrice":"78000", "workingType":"CONTRACT_PRICE"})
    }
    fn ack() -> AlgoOrderResponse {
        serde_json::from_value(json!({"algoId":42,"algoStatus":"NEW"})).unwrap()
    }
    fn rejected() -> AppError {
        AppError::Binance {
            code: -4130,
            message: "duplicate".into(),
        }
    }
    struct Fake {
        open: RefCell<VecDeque<Vec<Value>>>,
        fail_cancel: bool,
        fail_place: bool,
        query_found: bool,
        calls: RefCell<Vec<String>>,
    }
    impl Fake {
        fn new() -> Self {
            Self {
                open: RefCell::new(VecDeque::from([vec![stop()], vec![]])),
                fail_cancel: false,
                fail_place: false,
                query_found: false,
                calls: RefCell::new(vec![]),
            }
        }
    }
    impl StopExchange for Fake {
        async fn open(&self, _: &str) -> AppResult<Vec<Value>> {
            self.calls.borrow_mut().push("open".into());
            Ok(self.open.borrow_mut().pop_front().unwrap())
        }
        async fn cancel(&self, _: &str, id: i64) -> AppResult<Value> {
            self.calls.borrow_mut().push(format!("cancel:{id}"));
            if self.fail_cancel {
                Err(rejected())
            } else {
                Ok(json!({"success":true}))
            }
        }
        async fn place(
            &self,
            _: &str,
            _: OrderSide,
            price: f64,
            _: &str,
            _: &str,
        ) -> AppResult<AlgoOrderResponse> {
            self.calls.borrow_mut().push(format!("place:{price}"));
            if self.fail_place && price != 78000.0 {
                Err(rejected())
            } else {
                Ok(ack())
            }
        }
        async fn query(&self, _: &str) -> AppResult<AlgoOrderResponse> {
            self.calls.borrow_mut().push("query".into());
            if self.query_found {
                Ok(ack())
            } else {
                Err(AppError::Binance {
                    code: -2013,
                    message: "not found".into(),
                })
            }
        }
    }
    #[tokio::test]
    async fn resolves_live_id_before_replacing() {
        let fake = Fake::new();
        replace(&fake, "BTCUSDT", OrderSide::Buy, 77735.1, "new-sl")
            .await
            .unwrap();
        assert_eq!(
            *fake.calls.borrow(),
            ["open", "cancel:9007199254740993", "open", "place:77735.1"]
        );
    }
    #[tokio::test]
    async fn cancellation_failure_never_places_another_stop() {
        let mut fake = Fake::new();
        fake.fail_cancel = true;
        assert!(
            replace(&fake, "BTCUSDT", OrderSide::Buy, 77735.1, "new-sl")
                .await
                .is_err()
        );
        assert_eq!(fake.calls.borrow().len(), 2);
    }
    #[tokio::test]
    async fn unconfirmed_cancellation_never_places_another_stop() {
        let fake = Fake::new();
        *fake.open.borrow_mut() = VecDeque::from([vec![stop()], vec![stop()]]);
        assert!(
            replace(&fake, "BTCUSDT", OrderSide::Buy, 77735.1, "new-sl")
                .await
                .is_err()
        );
        assert_eq!(fake.calls.borrow().len(), 3);
    }
    #[tokio::test]
    async fn rejected_replacement_restores_the_previous_price() {
        let mut fake = Fake::new();
        fake.fail_place = true;
        let error = replace(&fake, "BTCUSDT", OrderSide::Buy, 77735.1, "new-sl")
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("previous stop price was restored")
        );
        assert_eq!(fake.calls.borrow().last().unwrap(), "place:78000");
    }
    #[tokio::test]
    async fn lost_acknowledgement_does_not_restore_over_a_successful_replacement() {
        let mut fake = Fake::new();
        fake.fail_place = true;
        fake.query_found = true;
        replace(&fake, "BTCUSDT", OrderSide::Buy, 77735.1, "new-sl")
            .await
            .unwrap();
        assert_eq!(fake.calls.borrow().last().unwrap(), "query");
    }
    #[test]
    fn never_selects_take_profit_other_symbol_or_other_side() {
        let mut tp = stop();
        tp["orderType"] = json!("TAKE_PROFIT_MARKET");
        let mut other = stop();
        other["symbol"] = json!("ETHUSDT");
        let mut partial = stop();
        partial["closePosition"] = json!(false);
        assert!(
            full_stop(&[tp, other, partial], "BTCUSDT", OrderSide::Buy)
                .unwrap()
                .is_none()
        );
        assert!(
            full_stop(&[stop()], "BTCUSDT", OrderSide::Sell)
                .unwrap()
                .is_none()
        );
        assert!(full_stop(&[stop(), stop()], "BTCUSDT", OrderSide::Buy).is_err());
    }
}
