use std::time::Duration;

use serde_json::Value;

use crate::{
    binance::BinanceClient,
    error::{AppError, AppResult},
    models::{AlgoOrderResponse, BinanceOrderResponse, OrderSide},
};

pub(crate) struct AutoMarketProtectionRequest<'a> {
    pub symbol: &'a str,
    pub close_side: OrderSide,
    pub trigger_price: f64,
    pub rollback_quantity: f64,
    pub client_algo_id: &'a str,
    pub rollback_client_order_id: &'a str,
}

#[derive(Debug)]
pub(crate) enum AutoMarketProtectionOutcome {
    Protected(AlgoOrderResponse),
    RolledBack(BinanceOrderResponse),
}

trait AutoMarketExchange {
    async fn place_stop(
        &self,
        request: &AutoMarketProtectionRequest<'_>,
    ) -> AppResult<AlgoOrderResponse>;
    async fn query_stop(&self, client_algo_id: &str) -> AppResult<AlgoOrderResponse>;
    async fn cancel_stop(&self, symbol: &str, client_algo_id: &str) -> AppResult<Value>;
    async fn rollback_entry(
        &self,
        request: &AutoMarketProtectionRequest<'_>,
    ) -> AppResult<BinanceOrderResponse>;
}

impl AutoMarketExchange for BinanceClient {
    async fn place_stop(
        &self,
        request: &AutoMarketProtectionRequest<'_>,
    ) -> AppResult<AlgoOrderResponse> {
        self.conditional_order(
            request.symbol,
            request.close_side,
            "STOP_MARKET",
            request.trigger_price,
            None,
            true,
            "CONTRACT_PRICE",
            Some(request.client_algo_id),
        )
        .await
    }

    async fn query_stop(&self, client_algo_id: &str) -> AppResult<AlgoOrderResponse> {
        self.query_algo_order_by_client_id(client_algo_id).await
    }

    async fn cancel_stop(&self, symbol: &str, client_algo_id: &str) -> AppResult<Value> {
        self.cancel_algo_order_by_client_id(symbol, client_algo_id)
            .await
    }

    async fn rollback_entry(
        &self,
        request: &AutoMarketProtectionRequest<'_>,
    ) -> AppResult<BinanceOrderResponse> {
        self.market_order(
            request.symbol,
            request.close_side,
            request.rollback_quantity,
            true,
            Some(request.rollback_client_order_id),
        )
        .await
    }
}

pub(crate) async fn protect_auto_market_entry(
    exchange: &BinanceClient,
    request: AutoMarketProtectionRequest<'_>,
) -> AppResult<AutoMarketProtectionOutcome> {
    const QUERY_DELAYS: [Duration; 3] = [
        Duration::from_millis(0),
        Duration::from_millis(150),
        Duration::from_millis(350),
    ];

    protect_auto_market_entry_with_delays(exchange, &request, &QUERY_DELAYS).await
}

async fn protect_auto_market_entry_with_delays<E: AutoMarketExchange>(
    exchange: &E,
    request: &AutoMarketProtectionRequest<'_>,
    query_delays: &[Duration],
) -> AppResult<AutoMarketProtectionOutcome> {
    let stop_result = exchange.place_stop(request).await;
    let stop_was_ambiguous = matches!(&stop_result, Err(AppError::Http(_) | AppError::Json(_)));

    match stop_result {
        Ok(order) if confirmed_algo_order(&order) => {
            return Ok(AutoMarketProtectionOutcome::Protected(order));
        }
        Ok(order) => tracing::warn!(
            target: "api",
            symbol = request.symbol,
            client_algo_id = request.client_algo_id,
            algo_status = ?order.algo_status,
            "Automatic stop response did not confirm a usable protective order"
        ),
        Err(error) if stop_was_ambiguous => {
            tracing::warn!(
                target: "api",
                symbol = request.symbol,
                client_algo_id = request.client_algo_id,
                %error,
                "Automatic stop response was ambiguous; querying Binance before compensation"
            );

            for delay in query_delays {
                if !delay.is_zero() {
                    tokio::time::sleep(*delay).await;
                }
                match exchange.query_stop(request.client_algo_id).await {
                    Ok(order) if confirmed_algo_order(&order) => {
                        return Ok(AutoMarketProtectionOutcome::Protected(order));
                    }
                    Ok(_) => {}
                    Err(error) => tracing::warn!(
                        target: "api",
                        client_algo_id = request.client_algo_id,
                        %error,
                        "Automatic stop reconciliation attempt did not confirm the order"
                    ),
                }
            }
        }
        Err(error) => tracing::warn!(
            target: "api",
            symbol = request.symbol,
            client_algo_id = request.client_algo_id,
            %error,
            "Binance rejected the automatic stop; compensating the filled entry"
        ),
    }

    let orphan_cleanup_confirmed = if stop_was_ambiguous {
        match exchange
            .cancel_stop(request.symbol, request.client_algo_id)
            .await
        {
            Ok(_) => true,
            Err(AppError::Binance {
                code: -2011 | -2013,
                ..
            }) => true,
            Err(error) => {
                tracing::error!(
                    target: "api",
                    symbol = request.symbol,
                    client_algo_id = request.client_algo_id,
                    %error,
                    "Could not prove cleanup of an ambiguously submitted automatic stop"
                );
                false
            }
        }
    } else {
        true
    };

    let rollback = exchange.rollback_entry(request).await.map_err(|error| {
        AppError::Invalid(format!(
            "CRITICAL: the entry filled, its automatic stop could not be confirmed, and the reduce-only rollback failed ({error}). Verify and close {} manually on Binance immediately",
            request.symbol
        ))
    })?;

    if !orphan_cleanup_confirmed {
        return Err(AppError::Invalid(format!(
            "CRITICAL: the {} entry was closed, but cleanup of an ambiguously submitted stop could not be confirmed. Verify and cancel any remaining conditional order on Binance before trading this symbol again",
            request.symbol
        )));
    }

    Ok(AutoMarketProtectionOutcome::RolledBack(rollback))
}

fn confirmed_algo_order(order: &AlgoOrderResponse) -> bool {
    let has_id = order.algo_id.is_some_and(|algo_id| algo_id > 0);
    let rejected = order.algo_status.as_deref().is_some_and(|status| {
        matches!(
            status.to_ascii_uppercase().as_str(),
            "REJECTED" | "CANCELED" | "CANCELLED" | "EXPIRED" | "FAILED" | "FAILURE"
        )
    });

    has_id && !rejected
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    use serde_json::{Value, json};

    use super::{
        AutoMarketExchange, AutoMarketProtectionOutcome, AutoMarketProtectionRequest,
        protect_auto_market_entry_with_delays,
    };
    use crate::{
        error::{AppError, AppResult},
        models::{AlgoOrderResponse, BinanceOrderResponse, OrderSide},
    };

    #[derive(Clone, Copy)]
    enum Scenario {
        Accepted,
        RejectedRollbackSucceeds,
        ResponseLostQueryConfirms,
        RejectedRollbackFails,
    }

    #[derive(Default)]
    struct Calls {
        place: usize,
        query: usize,
        cancel: usize,
        rollback: usize,
    }

    struct MockExchange {
        scenario: Scenario,
        calls: Arc<Mutex<Calls>>,
    }

    impl MockExchange {
        fn new(scenario: Scenario) -> Self {
            Self {
                scenario,
                calls: Arc::new(Mutex::new(Calls::default())),
            }
        }

        fn algo() -> AlgoOrderResponse {
            AlgoOrderResponse {
                algo_id: Some(42),
                client_algo_id: Some("stop-intent".into()),
                algo_status: Some("NEW".into()),
                symbol: Some("BTCUSDT".into()),
                extra: json!({}),
            }
        }

        fn rollback_order() -> BinanceOrderResponse {
            BinanceOrderResponse {
                order_id: Some(84),
                symbol: Some("BTCUSDT".into()),
                status: Some("FILLED".into()),
                client_order_id: Some("rollback-intent".into()),
                price: Some("0".into()),
                avg_price: Some("100".into()),
                orig_qty: Some("0.1".into()),
                executed_qty: Some("0.1".into()),
                extra: json!({}),
            }
        }
    }

    impl AutoMarketExchange for MockExchange {
        async fn place_stop(
            &self,
            _request: &AutoMarketProtectionRequest<'_>,
        ) -> AppResult<AlgoOrderResponse> {
            self.calls.lock().expect("calls lock").place += 1;
            match self.scenario {
                Scenario::Accepted => Ok(Self::algo()),
                Scenario::ResponseLostQueryConfirms => {
                    Err(AppError::Http("simulated lost response".into()))
                }
                Scenario::RejectedRollbackSucceeds | Scenario::RejectedRollbackFails => {
                    Err(AppError::Binance {
                        code: -2021,
                        message: "simulated rejection".into(),
                    })
                }
            }
        }

        async fn query_stop(&self, _client_algo_id: &str) -> AppResult<AlgoOrderResponse> {
            self.calls.lock().expect("calls lock").query += 1;
            Ok(Self::algo())
        }

        async fn cancel_stop(&self, _symbol: &str, _client_algo_id: &str) -> AppResult<Value> {
            self.calls.lock().expect("calls lock").cancel += 1;
            Ok(json!({ "status": "cancelled" }))
        }

        async fn rollback_entry(
            &self,
            _request: &AutoMarketProtectionRequest<'_>,
        ) -> AppResult<BinanceOrderResponse> {
            self.calls.lock().expect("calls lock").rollback += 1;
            match self.scenario {
                Scenario::RejectedRollbackFails => {
                    Err(AppError::Http("simulated rollback failure".into()))
                }
                _ => Ok(Self::rollback_order()),
            }
        }
    }

    fn request() -> AutoMarketProtectionRequest<'static> {
        AutoMarketProtectionRequest {
            symbol: "BTCUSDT",
            close_side: OrderSide::Sell,
            trigger_price: 95.0,
            rollback_quantity: 0.1,
            client_algo_id: "stop-intent",
            rollback_client_order_id: "rollback-intent",
        }
    }

    #[tokio::test]
    async fn accepted_stop_does_not_query_or_rollback() {
        let exchange = MockExchange::new(Scenario::Accepted);
        let outcome = protect_auto_market_entry_with_delays(&exchange, &request(), &[])
            .await
            .expect("stop should protect entry");

        assert!(matches!(outcome, AutoMarketProtectionOutcome::Protected(_)));
        let calls = exchange.calls.lock().expect("calls lock");
        assert_eq!(
            (calls.place, calls.query, calls.cancel, calls.rollback),
            (1, 0, 0, 0)
        );
    }

    #[tokio::test]
    async fn rejected_stop_rolls_back_exactly_once() {
        let exchange = MockExchange::new(Scenario::RejectedRollbackSucceeds);
        let outcome = protect_auto_market_entry_with_delays(&exchange, &request(), &[])
            .await
            .expect("rollback should complete safely");

        assert!(matches!(
            outcome,
            AutoMarketProtectionOutcome::RolledBack(_)
        ));
        let calls = exchange.calls.lock().expect("calls lock");
        assert_eq!(
            (calls.place, calls.query, calls.cancel, calls.rollback),
            (1, 0, 0, 1)
        );
    }

    #[tokio::test]
    async fn lost_stop_response_is_queried_before_any_compensation() {
        let exchange = MockExchange::new(Scenario::ResponseLostQueryConfirms);
        let outcome =
            protect_auto_market_entry_with_delays(&exchange, &request(), &[Duration::ZERO])
                .await
                .expect("query should confirm the accepted stop");

        assert!(matches!(outcome, AutoMarketProtectionOutcome::Protected(_)));
        let calls = exchange.calls.lock().expect("calls lock");
        assert_eq!(
            (calls.place, calls.query, calls.cancel, calls.rollback),
            (1, 1, 0, 0)
        );
    }

    #[tokio::test]
    async fn failed_rollback_is_a_critical_unprotected_position_error() {
        let exchange = MockExchange::new(Scenario::RejectedRollbackFails);
        let error = protect_auto_market_entry_with_delays(&exchange, &request(), &[])
            .await
            .expect_err("failed compensation must not look successful");

        assert!(error.to_string().contains("CRITICAL"));
        assert!(error.to_string().contains("close BTCUSDT manually"));
        let calls = exchange.calls.lock().expect("calls lock");
        assert_eq!(
            (calls.place, calls.query, calls.cancel, calls.rollback),
            (1, 0, 0, 1)
        );
    }
}
