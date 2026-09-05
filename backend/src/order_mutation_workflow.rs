use std::time::Duration;

use serde_json::Value;

use crate::{
    binance::BinanceClient,
    error::{AppError, AppResult},
    models::{BinanceOrderResponse, OrderSide},
};

pub(crate) struct ModifyLimitRequest<'a> {
    pub symbol: &'a str,
    pub order_id: i64,
    pub side: OrderSide,
    pub quantity: f64,
    pub price: f64,
    pub time_in_force: &'a str,
}

pub(crate) struct ReduceReplacementRequest<'a> {
    pub symbol: &'a str,
    pub order_id: i64,
    pub side: OrderSide,
    pub replacement_quantity: f64,
    pub rollback_quantity: f64,
    pub price: f64,
    pub time_in_force: &'a str,
    pub replacement_client_order_id: &'a str,
    pub rollback_client_order_id: &'a str,
}

pub(crate) struct ChaseLimitRequest<'a> {
    pub symbol: &'a str,
    pub order_id: i64,
    pub side: OrderSide,
    pub remaining_quantity: f64,
    pub client_order_id: &'a str,
}

trait OrderMutationExchange {
    async fn modify_limit(
        &self,
        request: &ModifyLimitRequest<'_>,
    ) -> AppResult<BinanceOrderResponse>;
    async fn cancel(&self, symbol: &str, order_id: i64) -> AppResult<Value>;
    async fn cancel_all(&self, symbol: &str) -> AppResult<Value>;
    async fn place_reduce_limit(
        &self,
        request: &ReduceReplacementRequest<'_>,
        quantity: f64,
        client_order_id: &str,
    ) -> AppResult<BinanceOrderResponse>;
    async fn query_replacement(
        &self,
        symbol: &str,
        client_order_id: &str,
    ) -> AppResult<BinanceOrderResponse>;
    async fn ensure_isolated(&self, symbol: &str) -> AppResult<()>;
    async fn place_chase_market(
        &self,
        request: &ChaseLimitRequest<'_>,
    ) -> AppResult<BinanceOrderResponse>;
}

impl OrderMutationExchange for BinanceClient {
    async fn modify_limit(
        &self,
        request: &ModifyLimitRequest<'_>,
    ) -> AppResult<BinanceOrderResponse> {
        self.modify_limit_order(
            request.symbol,
            request.order_id,
            request.side,
            request.quantity,
            request.price,
            request.time_in_force,
        )
        .await
    }

    async fn cancel(&self, symbol: &str, order_id: i64) -> AppResult<Value> {
        self.cancel_order(symbol, order_id).await
    }

    async fn cancel_all(&self, symbol: &str) -> AppResult<Value> {
        self.cancel_all_orders(symbol).await
    }

    async fn place_reduce_limit(
        &self,
        request: &ReduceReplacementRequest<'_>,
        quantity: f64,
        client_order_id: &str,
    ) -> AppResult<BinanceOrderResponse> {
        self.limit_order(
            request.symbol,
            request.side,
            quantity,
            request.price,
            request.time_in_force,
            true,
            Some(client_order_id),
        )
        .await
    }

    async fn query_replacement(
        &self,
        symbol: &str,
        client_order_id: &str,
    ) -> AppResult<BinanceOrderResponse> {
        self.query_order_by_client_id(symbol, client_order_id).await
    }

    async fn ensure_isolated(&self, symbol: &str) -> AppResult<()> {
        self.ensure_isolated_margin(symbol).await
    }

    async fn place_chase_market(
        &self,
        request: &ChaseLimitRequest<'_>,
    ) -> AppResult<BinanceOrderResponse> {
        self.market_order(
            request.symbol,
            request.side,
            request.remaining_quantity,
            false,
            Some(request.client_order_id),
        )
        .await
    }
}

pub(crate) async fn modify_limit_and_reconcile<R>(
    exchange: &BinanceClient,
    request: ModifyLimitRequest<'_>,
    reconcile: R,
) -> AppResult<BinanceOrderResponse>
where
    R: FnOnce(),
{
    modify_limit_and_reconcile_with_exchange(exchange, &request, reconcile).await
}

async fn modify_limit_and_reconcile_with_exchange<E, R>(
    exchange: &E,
    request: &ModifyLimitRequest<'_>,
    reconcile: R,
) -> AppResult<BinanceOrderResponse>
where
    E: OrderMutationExchange,
    R: FnOnce(),
{
    let result = exchange.modify_limit(request).await;
    // A transport failure after PUT is ambiguous: Binance may have amended or
    // filled the order even though the response never reached us. Always fetch
    // authoritative orders and exposure after an attempt.
    reconcile();
    result
}

pub(crate) async fn cancel_order_and_reconcile<R>(
    exchange: &BinanceClient,
    symbol: &str,
    order_id: i64,
    reconcile: R,
) -> AppResult<Value>
where
    R: FnOnce(),
{
    cancel_order_and_reconcile_with_exchange(exchange, symbol, order_id, reconcile).await
}

async fn cancel_order_and_reconcile_with_exchange<E, R>(
    exchange: &E,
    symbol: &str,
    order_id: i64,
    reconcile: R,
) -> AppResult<Value>
where
    E: OrderMutationExchange,
    R: FnOnce(),
{
    let result = exchange.cancel(symbol, order_id).await;
    // DELETE can succeed remotely and still lose its response locally, while
    // the resting order can fill concurrently with the cancellation.
    reconcile();
    result
}

pub(crate) async fn cancel_all_orders_and_reconcile<R>(
    exchange: &BinanceClient,
    symbol: &str,
    reconcile: R,
) -> AppResult<Value>
where
    R: FnOnce(),
{
    cancel_all_orders_and_reconcile_with_exchange(exchange, symbol, reconcile).await
}

async fn cancel_all_orders_and_reconcile_with_exchange<E, R>(
    exchange: &E,
    symbol: &str,
    reconcile: R,
) -> AppResult<Value>
where
    E: OrderMutationExchange,
    R: FnOnce(),
{
    let result = exchange.cancel_all(symbol).await;
    reconcile();
    result
}

pub(crate) async fn replace_reduce_order_and_reconcile<R>(
    exchange: &BinanceClient,
    request: ReduceReplacementRequest<'_>,
    reconcile: R,
) -> AppResult<BinanceOrderResponse>
where
    R: FnOnce(),
{
    const QUERY_DELAYS: [Duration; 4] = [
        Duration::from_millis(0),
        Duration::from_millis(250),
        Duration::from_millis(750),
        Duration::from_millis(1_500),
    ];

    replace_reduce_order_and_reconcile_with_exchange(exchange, &request, &QUERY_DELAYS, reconcile)
        .await
}

async fn replace_reduce_order_and_reconcile_with_exchange<E, R>(
    exchange: &E,
    request: &ReduceReplacementRequest<'_>,
    query_delays: &[Duration],
    reconcile: R,
) -> AppResult<BinanceOrderResponse>
where
    E: OrderMutationExchange,
    R: FnOnce(),
{
    if let Err(error) = exchange.cancel(request.symbol, request.order_id).await {
        // The cancel result may be ambiguous, but no replacement was submitted.
        // Exposure still needs reconciliation because the resting order could
        // have filled concurrently with the cancellation attempt.
        reconcile();
        return Err(error);
    }

    let replacement_result = exchange
        .place_reduce_limit(
            request,
            request.replacement_quantity,
            request.replacement_client_order_id,
        )
        .await;
    let replacement_was_ambiguous = matches!(
        &replacement_result,
        Err(AppError::Http(_) | AppError::Json(_))
    );

    let result = match replacement_result {
        Ok(order) => Ok(order),
        Err(replacement_error) if replacement_was_ambiguous => {
            let mut absence_confirmed = !query_delays.is_empty();

            for delay in query_delays {
                if !delay.is_zero() {
                    tokio::time::sleep(*delay).await;
                }

                match exchange
                    .query_replacement(request.symbol, request.replacement_client_order_id)
                    .await
                {
                    Ok(order) if confirmed_order(&order) => {
                        reconcile();
                        return Ok(order);
                    }
                    Err(AppError::Binance {
                        code: -2011 | -2013,
                        ..
                    }) => {}
                    Ok(_) | Err(_) => absence_confirmed = false,
                }
            }

            if absence_confirmed {
                submit_reduce_rollback(exchange, request, replacement_error).await
            } else {
                Err(AppError::Invalid(format!(
                    "CRITICAL: reduce replacement response was lost ({replacement_error}) and Binance did not confirm whether the replacement exists. No rollback was submitted to avoid duplicating a possibly accepted reduce order; verify {symbol} open orders manually",
                    symbol = request.symbol
                )))
            }
        }
        Err(replacement_error) => {
            submit_reduce_rollback(exchange, request, replacement_error).await
        }
    };

    // A reduce-only replacement can fill while this workflow is running, and
    // either POST response can be lost. Refresh orders and exposure even when
    // rollback appears to have succeeded.
    reconcile();
    result
}

async fn submit_reduce_rollback<E: OrderMutationExchange>(
    exchange: &E,
    request: &ReduceReplacementRequest<'_>,
    replacement_error: AppError,
) -> AppResult<BinanceOrderResponse> {
    match exchange
        .place_reduce_limit(
            request,
            request.rollback_quantity,
            request.rollback_client_order_id,
        )
        .await
    {
        Ok(_) => Err(AppError::Invalid(format!(
            "failed to replace reduce order: {replacement_error}; rollback submitted"
        ))),
        Err(rollback_error) => Err(AppError::Invalid(format!(
            "CRITICAL: failed to replace reduce order ({replacement_error}); rollback also failed ({rollback_error}). The original reduce order was cancelled; verify the position and restore protection manually on Binance"
        ))),
    }
}

fn confirmed_order(order: &BinanceOrderResponse) -> bool {
    let has_id = order.order_id.is_some_and(|order_id| order_id > 0);
    let rejected = order.status.as_deref().is_some_and(|status| {
        matches!(
            status.to_ascii_uppercase().as_str(),
            "REJECTED" | "CANCELED" | "CANCELLED" | "EXPIRED"
        )
    });

    has_id && !rejected
}

pub(crate) async fn chase_limit_order_and_reconcile<R>(
    exchange: &BinanceClient,
    request: ChaseLimitRequest<'_>,
    reconcile: R,
) -> AppResult<BinanceOrderResponse>
where
    R: FnOnce(),
{
    chase_limit_order_and_reconcile_with_exchange(exchange, &request, reconcile).await
}

async fn chase_limit_order_and_reconcile_with_exchange<E, R>(
    exchange: &E,
    request: &ChaseLimitRequest<'_>,
    reconcile: R,
) -> AppResult<BinanceOrderResponse>
where
    E: OrderMutationExchange,
    R: FnOnce(),
{
    if let Err(error) = exchange.cancel(request.symbol, request.order_id).await {
        reconcile();
        return Err(error);
    }

    let result = match exchange.ensure_isolated(request.symbol).await {
        Ok(()) => exchange.place_chase_market(request).await.map_err(|error| {
            AppError::Invalid(format!(
                "limit order was cancelled, but market chase failed: {error}"
            ))
        }),
        Err(error) => Err(AppError::Invalid(format!(
            "limit order was cancelled, but isolated-margin verification failed: {error}"
        ))),
    };

    // After cancellation, the resting order is gone and the market POST may
    // have an unknown result. Reconcile both the order list and exposure for
    // success as well as every failure branch.
    reconcile();
    result
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    use serde_json::{Value, json};

    use super::{
        ChaseLimitRequest, ModifyLimitRequest, OrderMutationExchange, ReduceReplacementRequest,
        cancel_all_orders_and_reconcile_with_exchange, cancel_order_and_reconcile_with_exchange,
        chase_limit_order_and_reconcile_with_exchange, modify_limit_and_reconcile_with_exchange,
        replace_reduce_order_and_reconcile_with_exchange,
    };
    use crate::{
        error::{AppError, AppResult},
        models::{BinanceOrderResponse, OrderSide},
    };

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Failure {
        None,
        Modify,
        Cancel,
        CancelAll,
        Replacement,
        ReplacementAndRollback,
        ReplacementLostConfirmed,
        ReplacementLostUnknown,
        ReplacementLostAbsent,
        Isolated,
        Market,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum ReconciliationScope {
        OrdersAndExposure,
    }

    struct MockExchange {
        failure: Failure,
        calls: Mutex<Vec<&'static str>>,
        reduce_submissions: Mutex<usize>,
    }

    impl MockExchange {
        fn new(failure: Failure) -> Self {
            Self {
                failure,
                calls: Mutex::new(Vec::new()),
                reduce_submissions: Mutex::new(0),
            }
        }

        fn order() -> BinanceOrderResponse {
            BinanceOrderResponse {
                order_id: Some(42),
                symbol: Some("BTCUSDT".into()),
                status: Some("NEW".into()),
                client_order_id: Some("mock-order".into()),
                price: Some("100".into()),
                avg_price: None,
                orig_qty: Some("0.1".into()),
                executed_qty: Some("0".into()),
                extra: json!({}),
            }
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().expect("calls lock").clone()
        }
    }

    impl OrderMutationExchange for MockExchange {
        async fn modify_limit(
            &self,
            _request: &ModifyLimitRequest<'_>,
        ) -> AppResult<BinanceOrderResponse> {
            self.calls.lock().expect("calls lock").push("modify");
            if self.failure == Failure::Modify {
                Err(AppError::Http("simulated lost modify response".into()))
            } else {
                Ok(Self::order())
            }
        }

        async fn cancel(&self, _symbol: &str, _order_id: i64) -> AppResult<Value> {
            self.calls.lock().expect("calls lock").push("cancel");
            if self.failure == Failure::Cancel {
                Err(AppError::Http("simulated lost cancel response".into()))
            } else {
                Ok(json!({ "status": "CANCELED" }))
            }
        }

        async fn cancel_all(&self, _symbol: &str) -> AppResult<Value> {
            self.calls.lock().expect("calls lock").push("cancel_all");
            if self.failure == Failure::CancelAll {
                Err(AppError::Http("simulated lost cancel-all response".into()))
            } else {
                Ok(json!({ "code": 200 }))
            }
        }

        async fn place_reduce_limit(
            &self,
            _request: &ReduceReplacementRequest<'_>,
            _quantity: f64,
            _client_order_id: &str,
        ) -> AppResult<BinanceOrderResponse> {
            self.calls.lock().expect("calls lock").push("reduce_limit");
            let mut submissions = self.reduce_submissions.lock().expect("submissions lock");
            *submissions += 1;

            let replacement_fails = matches!(
                self.failure,
                Failure::Replacement
                    | Failure::ReplacementAndRollback
                    | Failure::ReplacementLostConfirmed
                    | Failure::ReplacementLostUnknown
                    | Failure::ReplacementLostAbsent
            ) && *submissions == 1;
            let rollback_fails =
                self.failure == Failure::ReplacementAndRollback && *submissions == 2;

            if replacement_fails
                && matches!(
                    self.failure,
                    Failure::ReplacementLostConfirmed
                        | Failure::ReplacementLostUnknown
                        | Failure::ReplacementLostAbsent
                )
            {
                Err(AppError::Http("simulated reduce submission failure".into()))
            } else if replacement_fails || rollback_fails {
                Err(AppError::Binance {
                    code: -2010,
                    message: "simulated reduce rejection".into(),
                })
            } else {
                Ok(Self::order())
            }
        }

        async fn query_replacement(
            &self,
            _symbol: &str,
            _client_order_id: &str,
        ) -> AppResult<BinanceOrderResponse> {
            self.calls
                .lock()
                .expect("calls lock")
                .push("query_replacement");
            match self.failure {
                Failure::ReplacementLostConfirmed => Ok(Self::order()),
                Failure::ReplacementLostAbsent => Err(AppError::Binance {
                    code: -2013,
                    message: "order does not exist".into(),
                }),
                _ => Err(AppError::Http("simulated query failure".into())),
            }
        }

        async fn ensure_isolated(&self, _symbol: &str) -> AppResult<()> {
            self.calls
                .lock()
                .expect("calls lock")
                .push("ensure_isolated");
            if self.failure == Failure::Isolated {
                Err(AppError::Binance {
                    code: -4046,
                    message: "simulated margin failure".into(),
                })
            } else {
                Ok(())
            }
        }

        async fn place_chase_market(
            &self,
            _request: &ChaseLimitRequest<'_>,
        ) -> AppResult<BinanceOrderResponse> {
            self.calls.lock().expect("calls lock").push("market");
            if self.failure == Failure::Market {
                Err(AppError::Http("simulated lost market response".into()))
            } else {
                Ok(Self::order())
            }
        }
    }

    fn modify_request() -> ModifyLimitRequest<'static> {
        ModifyLimitRequest {
            symbol: "BTCUSDT",
            order_id: 7,
            side: OrderSide::Buy,
            quantity: 0.1,
            price: 100.0,
            time_in_force: "GTC",
        }
    }

    fn replacement_request() -> ReduceReplacementRequest<'static> {
        ReduceReplacementRequest {
            symbol: "BTCUSDT",
            order_id: 7,
            side: OrderSide::Sell,
            replacement_quantity: 0.05,
            rollback_quantity: 0.1,
            price: 100.0,
            time_in_force: "GTC",
            replacement_client_order_id: "replace-intent",
            rollback_client_order_id: "rollback-intent",
        }
    }

    fn chase_request() -> ChaseLimitRequest<'static> {
        ChaseLimitRequest {
            symbol: "BTCUSDT",
            order_id: 7,
            side: OrderSide::Buy,
            remaining_quantity: 0.06,
            client_order_id: "chase-intent",
        }
    }

    fn reconciliation_recorder() -> (Arc<Mutex<Vec<ReconciliationScope>>>, impl FnOnce()) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let captured = calls.clone();
        (calls, move || {
            captured
                .lock()
                .expect("reconcile lock")
                .push(ReconciliationScope::OrdersAndExposure)
        })
    }

    #[tokio::test]
    async fn lost_modify_response_forces_an_authoritative_order_refresh() {
        let exchange = MockExchange::new(Failure::Modify);
        let (reconciliations, reconcile) = reconciliation_recorder();

        modify_limit_and_reconcile_with_exchange(&exchange, &modify_request(), reconcile)
            .await
            .expect_err("ambiguous modify must remain an error");

        assert_eq!(exchange.calls(), vec!["modify"]);
        assert_eq!(
            *reconciliations.lock().expect("reconcile lock"),
            vec![ReconciliationScope::OrdersAndExposure]
        );
    }

    #[tokio::test]
    async fn lost_cancel_response_never_submits_a_replacement_and_refreshes_all_state() {
        let exchange = MockExchange::new(Failure::Cancel);
        let (reconciliations, reconcile) = reconciliation_recorder();

        replace_reduce_order_and_reconcile_with_exchange(
            &exchange,
            &replacement_request(),
            &[],
            reconcile,
        )
        .await
        .expect_err("ambiguous cancel must stop the workflow");

        assert_eq!(exchange.calls(), vec!["cancel"]);
        assert_eq!(
            *reconciliations.lock().expect("reconcile lock"),
            vec![ReconciliationScope::OrdersAndExposure]
        );
    }

    #[tokio::test]
    async fn failed_reduce_replacement_rolls_back_and_refreshes_all_state() {
        let exchange = MockExchange::new(Failure::Replacement);
        let (reconciliations, reconcile) = reconciliation_recorder();

        let error = replace_reduce_order_and_reconcile_with_exchange(
            &exchange,
            &replacement_request(),
            &[],
            reconcile,
        )
        .await
        .expect_err("failed replacement must not look successful");

        assert!(error.to_string().contains("rollback submitted"));
        assert_eq!(
            exchange.calls(),
            vec!["cancel", "reduce_limit", "reduce_limit"]
        );
        assert_eq!(
            *reconciliations.lock().expect("reconcile lock"),
            vec![ReconciliationScope::OrdersAndExposure]
        );
    }

    #[tokio::test]
    async fn failed_reduce_rollback_reports_critical_unprotected_state() {
        let exchange = MockExchange::new(Failure::ReplacementAndRollback);
        let (reconciliations, reconcile) = reconciliation_recorder();

        let error = replace_reduce_order_and_reconcile_with_exchange(
            &exchange,
            &replacement_request(),
            &[],
            reconcile,
        )
        .await
        .expect_err("double failure must be critical");

        assert!(error.to_string().contains("CRITICAL"));
        assert!(error.to_string().contains("restore protection manually"));
        assert_eq!(
            *reconciliations.lock().expect("reconcile lock"),
            vec![ReconciliationScope::OrdersAndExposure]
        );
    }

    #[tokio::test]
    async fn lost_replacement_response_is_queried_before_rollback() {
        let exchange = MockExchange::new(Failure::ReplacementLostConfirmed);
        let (reconciliations, reconcile) = reconciliation_recorder();

        replace_reduce_order_and_reconcile_with_exchange(
            &exchange,
            &replacement_request(),
            &[Duration::ZERO],
            reconcile,
        )
        .await
        .expect("authoritative query should confirm the replacement");

        assert_eq!(
            exchange.calls(),
            vec!["cancel", "reduce_limit", "query_replacement"]
        );
        assert_eq!(
            *reconciliations.lock().expect("reconcile lock"),
            vec![ReconciliationScope::OrdersAndExposure]
        );
    }

    #[tokio::test]
    async fn unknown_replacement_outcome_never_submits_a_duplicate_rollback() {
        let exchange = MockExchange::new(Failure::ReplacementLostUnknown);
        let (reconciliations, reconcile) = reconciliation_recorder();

        let error = replace_reduce_order_and_reconcile_with_exchange(
            &exchange,
            &replacement_request(),
            &[Duration::ZERO],
            reconcile,
        )
        .await
        .expect_err("unresolved replacement must fail closed");

        assert!(error.to_string().contains("CRITICAL"));
        assert!(error.to_string().contains("No rollback was submitted"));
        assert_eq!(
            exchange.calls(),
            vec!["cancel", "reduce_limit", "query_replacement"]
        );
        assert_eq!(
            *reconciliations.lock().expect("reconcile lock"),
            vec![ReconciliationScope::OrdersAndExposure]
        );
    }

    #[tokio::test]
    async fn confirmed_absent_replacement_restores_the_original_reduce_order() {
        let exchange = MockExchange::new(Failure::ReplacementLostAbsent);
        let (reconciliations, reconcile) = reconciliation_recorder();

        let error = replace_reduce_order_and_reconcile_with_exchange(
            &exchange,
            &replacement_request(),
            &[Duration::ZERO],
            reconcile,
        )
        .await
        .expect_err("requested resize failed even though rollback succeeded");

        assert!(error.to_string().contains("rollback submitted"));
        assert_eq!(
            exchange.calls(),
            vec![
                "cancel",
                "reduce_limit",
                "query_replacement",
                "reduce_limit"
            ]
        );
        assert_eq!(
            *reconciliations.lock().expect("reconcile lock"),
            vec![ReconciliationScope::OrdersAndExposure]
        );
    }

    #[tokio::test]
    async fn chase_margin_failure_after_cancel_refreshes_orders_and_exposure() {
        let exchange = MockExchange::new(Failure::Isolated);
        let (reconciliations, reconcile) = reconciliation_recorder();

        let error =
            chase_limit_order_and_reconcile_with_exchange(&exchange, &chase_request(), reconcile)
                .await
                .expect_err("margin failure must stop the market submission");

        assert!(error.to_string().contains("limit order was cancelled"));
        assert_eq!(exchange.calls(), vec!["cancel", "ensure_isolated"]);
        assert_eq!(
            *reconciliations.lock().expect("reconcile lock"),
            vec![ReconciliationScope::OrdersAndExposure]
        );
    }

    #[tokio::test]
    async fn lost_chase_market_response_refreshes_orders_and_exposure() {
        let exchange = MockExchange::new(Failure::Market);
        let (reconciliations, reconcile) = reconciliation_recorder();

        let error =
            chase_limit_order_and_reconcile_with_exchange(&exchange, &chase_request(), reconcile)
                .await
                .expect_err("ambiguous market response must remain an error");

        assert!(error.to_string().contains("market chase failed"));
        assert_eq!(
            exchange.calls(),
            vec!["cancel", "ensure_isolated", "market"]
        );
        assert_eq!(
            *reconciliations.lock().expect("reconcile lock"),
            vec![ReconciliationScope::OrdersAndExposure]
        );
    }

    #[tokio::test]
    async fn standalone_cancel_failures_always_request_authoritative_snapshots() {
        let exchange = MockExchange::new(Failure::Cancel);
        let (reconciliations, reconcile) = reconciliation_recorder();
        cancel_order_and_reconcile_with_exchange(&exchange, "BTCUSDT", 7, reconcile)
            .await
            .expect_err("lost cancel response must remain an error");

        assert_eq!(exchange.calls(), vec!["cancel"]);
        assert_eq!(
            *reconciliations.lock().expect("reconcile lock"),
            vec![ReconciliationScope::OrdersAndExposure]
        );

        let exchange = MockExchange::new(Failure::CancelAll);
        let (reconciliations, reconcile) = reconciliation_recorder();
        cancel_all_orders_and_reconcile_with_exchange(&exchange, "BTCUSDT", reconcile)
            .await
            .expect_err("lost cancel-all response must remain an error");

        assert_eq!(exchange.calls(), vec!["cancel_all"]);
        assert_eq!(
            *reconciliations.lock().expect("reconcile lock"),
            vec![ReconciliationScope::OrdersAndExposure]
        );
    }

    #[tokio::test]
    async fn successful_replacement_and_chase_reconcile_once_each() {
        let exchange = MockExchange::new(Failure::None);
        let (replacement_reconciliations, replacement_reconcile) = reconciliation_recorder();
        replace_reduce_order_and_reconcile_with_exchange(
            &exchange,
            &replacement_request(),
            &[],
            replacement_reconcile,
        )
        .await
        .expect("replacement should succeed");
        assert_eq!(
            *replacement_reconciliations.lock().expect("reconcile lock"),
            vec![ReconciliationScope::OrdersAndExposure]
        );

        let exchange = MockExchange::new(Failure::None);
        let (chase_reconciliations, chase_reconcile) = reconciliation_recorder();
        chase_limit_order_and_reconcile_with_exchange(&exchange, &chase_request(), chase_reconcile)
            .await
            .expect("chase should succeed");
        assert_eq!(
            *chase_reconciliations.lock().expect("reconcile lock"),
            vec![ReconciliationScope::OrdersAndExposure]
        );
    }
}
