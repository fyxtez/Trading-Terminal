use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::{
    sync::broadcast,
    time::{Instant, MissedTickBehavior, interval_at, sleep},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::{
    account_state::AccountState,
    binance::BinanceClient,
    binance_stream::{
        keys::{create_listen_key, keepalive_listen_key},
        types::UserStreamEnvelope,
    },
    diagnostics::DiagnosticsState,
    position_risk_state::PositionRiskState,
    trading_events::TradingEvent,
};

const LISTEN_KEY_KEEPALIVE_SECS: u64 = 30 * 60;
const RECONNECT_DELAY_SECS: u64 = 5;

pub fn spawn_user_stream(
    binance: BinanceClient,
    account_state: AccountState,
    position_risk_state: PositionRiskState,
    events: broadcast::Sender<TradingEvent>,
    diagnostics: DiagnosticsState,
) -> tokio::task::JoinHandle<()> {
    tracing::info!(
        target: "api",
        network = if binance.is_testnet() { "testnet" } else { "mainnet" },
        rest_base = binance.user_stream_rest_base(),
        ws_base = binance.user_stream_ws_base(),
        "Starting Binance user-data stream task"
    );

    tokio::spawn(async move {
        let mut attempt = 0_u64;
        let mut waiting_for_credentials = false;

        loop {
            if !binance.is_configured() {
                diagnostics.set_binance_configured(false);
                if !waiting_for_credentials {
                    tracing::info!(
                        target: "api",
                        "Binance user-data stream is idle until desktop credentials are configured"
                    );
                    waiting_for_credentials = true;
                }
                sleep(Duration::from_secs(1)).await;
                continue;
            }

            waiting_for_credentials = false;
            attempt += 1;
            let credential_generation = binance.credential_generation();

            tracing::info!(
                target: "api",
                attempt,
                network = if binance.is_testnet() { "testnet" } else { "mainnet" },
                "Starting Binance user-data stream connection attempt"
            );

            match run_once(
                &binance,
                &account_state,
                &position_risk_state,
                &events,
                credential_generation,
                &diagnostics,
            )
            .await
            {
                Ok(()) => {
                    tracing::warn!(
                        target: "api",
                        attempt,
                        "Binance user-data stream ended without an error"
                    );
                }
                Err(error) => {
                    diagnostics.user_stream_failure(error.to_string());
                    tracing::error!(
                        target: "api",
                        attempt,
                        %error,
                        "Binance user-data stream disconnected"
                    );

                    let _ = events.send(TradingEvent::StreamStatus {
                        connected: false,
                        message: error.to_string(),
                    });
                }
            }

            tracing::info!(
                target: "api",
                reconnect_delay_seconds = RECONNECT_DELAY_SECS,
                "Waiting before reconnecting Binance user-data stream"
            );

            sleep(Duration::from_secs(RECONNECT_DELAY_SECS)).await;
        }
    })
}

async fn run_once(
    binance: &BinanceClient,
    account_state: &AccountState,
    position_risk_state: &PositionRiskState,
    events: &broadcast::Sender<TradingEvent>,
    credential_generation: u64,
    diagnostics: &DiagnosticsState,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let rest_base = binance.user_stream_rest_base();
    let ws_base = binance.user_stream_ws_base();

    let client = reqwest::Client::builder()
        .user_agent("fyxtez-binance-user-stream/1.1")
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .pool_idle_timeout(Duration::from_secs(30))
        .tcp_keepalive(Duration::from_secs(60))
        .tcp_nodelay(true)
        .build()?;

    tracing::info!(
        target: "api",
        rest_base,
        "Creating Binance Futures user-data listen key"
    );

    let api_key = binance.user_stream_api_key()?;
    let listen_key = create_listen_key(&client, rest_base, &api_key).await?;

    tracing::info!(
        target: "api",
        rest_base,
        "Binance Futures user-data listen key created"
    );

    let ws_url = format!("{ws_base}/private/ws/{listen_key}");

    tracing::info!(
        target: "api",
        ws_base,
        "Connecting to Binance Futures user-data WebSocket"
    );

    let (mut socket, response) = connect_async(&ws_url).await.map_err(|error| {
        format!("failed to connect Binance user-data WebSocket at {ws_base}: {error}")
    })?;

    tracing::info!(
        target: "api",
        status = %response.status(),
        network = if binance.is_testnet() { "testnet" } else { "mainnet" },
        ws_base,
        "Binance user-data stream connected"
    );
    diagnostics.exchange_success();
    diagnostics.user_stream_connected();

    let _ = events.send(TradingEvent::StreamStatus {
        connected: true,
        message: "Binance user-data stream connected".into(),
    });

    // Reconcile fields that are not present in ACCOUNT_UPDATE after every reconnect.
    account_state.request_refresh();
    position_risk_state.request_refresh();

    let _ = events.send(TradingEvent::SnapshotRequired {
        reason: "Binance user-data stream connected or reconnected".into(),
    });

    let first_keepalive = Instant::now() + Duration::from_secs(LISTEN_KEY_KEEPALIVE_SECS);
    let mut keepalive = interval_at(
        first_keepalive,
        Duration::from_secs(LISTEN_KEY_KEEPALIVE_SECS),
    );
    keepalive.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut credential_check = tokio::time::interval(Duration::from_secs(1));
    credential_check.set_missed_tick_behavior(MissedTickBehavior::Skip);
    credential_check.tick().await;

    loop {
        tokio::select! {
            _ = credential_check.tick() => {
                if binance.credential_generation() != credential_generation {
                    return Err("Binance credentials changed; reconnecting user-data stream".into());
                }
            }

            _ = keepalive.tick() => {
                tracing::debug!(
                    target: "api",
                    rest_base,
                    "Refreshing Binance Futures user-data listen key"
                );

                keepalive_listen_key(
                    &client,
                    rest_base,
                    &api_key,
                    &listen_key,
                ).await?;

                tracing::info!(
                    target: "api",
                    "Binance Futures user-data listen key refreshed"
                );
            }

            message = socket.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        diagnostics.user_stream_event();
                        if let Err(error) = process_text(
                            text.as_ref(),
                            binance,
                            account_state,
                            position_risk_state,
                            events,
                        )
                        .await
                        {
                            // A malformed/unexpected event should not kill the whole private stream.
                            tracing::error!(
                                target: "api",
                                %error,
                                raw_message = %text,
                                "Failed to process Binance user-data event"
                            );
                        }
                    }

                    Some(Ok(Message::Ping(payload))) => {
                        tracing::trace!(target: "api", "Binance user-data ping received");
                        socket.send(Message::Pong(payload)).await?;
                    }

                    Some(Ok(Message::Pong(_))) => {
                        tracing::trace!(target: "api", "Binance user-data pong received");
                    }

                    Some(Ok(Message::Binary(payload))) => {
                        tracing::debug!(
                            target: "api",
                            bytes = payload.len(),
                            "Ignoring unexpected binary Binance user-data message"
                        );
                    }

                    Some(Ok(Message::Frame(_))) => {}

                    Some(Ok(Message::Close(frame))) => {
                        return Err(format!(
                            "Binance closed user-data stream: {frame:?}"
                        ).into());
                    }

                    Some(Err(error)) => {
                        return Err(format!(
                            "Binance user-data WebSocket read error: {error}"
                        ).into());
                    }

                    None => {
                        return Err("Binance user-data stream ended".into());
                    }
                }
            }
        }
    }
}

async fn process_text(
    text: &str,
    binance: &BinanceClient,
    account_state: &AccountState,
    position_risk_state: &PositionRiskState,
    events: &broadcast::Sender<TradingEvent>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let value: Value = serde_json::from_str(text)?;
    let event_type = value.get("e").and_then(Value::as_str).map(str::to_owned);

    tracing::debug!(
        target: "api",
        event_type = event_type.as_deref().unwrap_or("UNKNOWN"),
        "Binance user-data event received"
    );

    // Binance reuses the top-level `o` field for multiple event families.
    // ORDER_TRADE_UPDATE.o and ALGO_UPDATE.o have different schemas, so do not
    // deserialize every event into UserStreamEnvelope before checking `e`.
    match event_type.as_deref() {
        Some("ORDER_TRADE_UPDATE") => {
            let envelope: UserStreamEnvelope = serde_json::from_value(value)?;

            let Some(order) = envelope.order else {
                tracing::warn!(
                    target: "api",
                    "ORDER_TRADE_UPDATE arrived without an order payload"
                );
                return Ok(());
            };

            tracing::info!(
                target: "api",
                symbol = %order.symbol,
                client_order_id = %order.client_order_id,
                side = %order.side,
                order_type = %order.order_type,
                execution_type = %order.execution_type,
                order_status = %order.order_status,
                order_id = order.order_id,
                trade_id = ?order.trade_id,
                last_filled_qty = %order.last_filled_qty,
                last_filled_price = %order.last_filled_price,
                accumulated_filled_qty = %order.accumulated_filled_qty,
                reduce_only = order.reduce_only,
                "Binance order update received"
            );

            // Binance uses x=TRADE for both partial and complete executions.
            if order.execution_type != "TRADE" {
                return Ok(());
            }

            // Position Information/positionRisk contains fields that are not
            // included in ORDER_TRADE_UPDATE or ACCOUNT_UPDATE, most notably
            // liquidationPrice. Refresh that cache after every actual fill.
            // The channel has capacity one and the worker debounces requests,
            // so a burst of partial fills still collapses into one REST call.
            position_risk_state.request_refresh();

            // Entry orders placed while flat behave as an app-managed OCO group.
            // As soon as one entry receives any execution (partial or full),
            // cancel every other still-open entry order for the same symbol.
            if is_entry_order(&order.client_order_id)
                && let Err(error) =
                    cancel_competing_entry_orders(binance, &order.symbol, order.order_id).await
            {
                tracing::error!(
                    target: "api",
                    symbol = %order.symbol,
                    filled_order_id = order.order_id,
                    %error,
                    "Failed to cancel competing entry orders"
                );
            }

            let quantity = parse_positive("last filled quantity", &order.last_filled_qty)?;
            let price = parse_positive("last filled price", &order.last_filled_price)?;
            let accumulated_quantity = order.accumulated_filled_qty.parse::<f64>()?;

            let event_time = envelope.event_time.unwrap_or_else(current_time_ms);
            let event_id = match order.trade_id {
                Some(trade_id) => {
                    format!("{}:{}:{}", order.symbol, order.order_id, trade_id)
                }
                None => format!(
                    "{}:{}:{}:{}:{}",
                    order.symbol,
                    order.order_id,
                    event_time,
                    order.last_filled_qty,
                    order.last_filled_price,
                ),
            };

            let receiver_count = events.receiver_count();
            let sent = events.send(TradingEvent::OrderExecuted {
                event_id: event_id.clone(),
                symbol: order.symbol.clone(),
                side: order.side.clone(),
                order_type: order.order_type.clone(),
                order_status: order.order_status.clone(),
                order_id: order.order_id,
                trade_id: order.trade_id,
                price,
                quantity,
                accumulated_quantity,
                event_time,
                transaction_time: envelope.transaction_time,
                reduce_only: order.reduce_only,
            });

            match sent {
                Ok(delivered_to) => tracing::info!(
                    target: "api",
                    %event_id,
                    receiver_count,
                    delivered_to,
                    symbol = %order.symbol,
                    side = %order.side,
                    price,
                    quantity,
                    order_status = %order.order_status,
                    "Binance execution broadcast to frontend clients"
                ),
                Err(error) => tracing::warn!(
                    target: "api",
                    %event_id,
                    receiver_count,
                    %error,
                    "Binance execution was received but no frontend event receiver accepted it"
                ),
            }
        }

        Some("ACCOUNT_UPDATE") => {
            let envelope: UserStreamEnvelope = serde_json::from_value(value)?;

            let Some(account) = envelope.account else {
                tracing::warn!(target: "api", "ACCOUNT_UPDATE arrived without account data");
                return Ok(());
            };

            for balance in account.balances {
                account_state
                    .apply_wallet_balance(&balance.asset, &balance.wallet_balance)
                    .await;
            }

            for position in account.positions {
                account_state
                    .apply_position_update(
                        &position.symbol,
                        &position.position_amt,
                        &position.entry_price,
                        &position.unrealized_profit,
                    )
                    .await;
            }

            // ACCOUNT_UPDATE sadrži walletBalance, ali ne sadrži availableBalance.
            // Zato povlačimo kompletan REST account snapshot kako available balance ne bi
            // ostao na vrednosti koja je keširana pre transfera, naloga ili pozicije.
            account_state.request_refresh();

            // ACCOUNT_UPDATE ne sadrži liquidationPrice, pa posebno osvežavamo
            // position-risk cache. Oba workera spajaju više brzih zahteva u jedan.
            position_risk_state.request_refresh();

            tracing::info!(
                target: "api",
                "Binance account-state cache updated from user-data WebSocket"
            );

            let _ = events.send(TradingEvent::SnapshotRequired {
                reason: "Binance ACCOUNT_UPDATE received".into(),
            });
        }

        Some("ALGO_UPDATE") => {
            let order = value.get("o");
            let symbol = order
                .and_then(|order| order.get("s"))
                .and_then(Value::as_str)
                .unwrap_or("UNKNOWN");
            let status = order
                .and_then(|order| order.get("X"))
                .and_then(Value::as_str)
                .unwrap_or("UNKNOWN");
            let client_algo_id = order
                .and_then(|order| order.get("caid"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let algo_id = order
                .and_then(|order| order.get("aid"))
                .and_then(Value::as_u64);
            let order_type = order
                .and_then(|order| order.get("o"))
                .and_then(Value::as_str)
                .unwrap_or("UNKNOWN");

            tracing::info!(
                target: "api",
                symbol,
                status,
                client_algo_id,
                algo_id = ?algo_id,
                order_type,
                "Binance conditional-order update received"
            );

            // ALGO_UPDATE already describes the lifecycle change. Notify the
            // frontend, but do not convert it into accountInfo/positionRisk REST
            // calls. Slow periodic reconciliation remains as a safety net.

            let _ = events.send(TradingEvent::SnapshotRequired {
                reason: format!("Binance ALGO_UPDATE received for {symbol}: {status}"),
            });
        }

        Some("listenKeyExpired") => {
            return Err("Binance listen key expired".into());
        }

        Some(other) => {
            tracing::debug!(
                target: "api",
                event_type = other,
                "Ignoring Binance user-data event"
            );
        }

        None => {
            tracing::warn!(
                target: "api",
                "Binance user-data payload did not contain an event type"
            );
        }
    }

    Ok(())
}

fn is_entry_order(client_order_id: &str) -> bool {
    client_order_id.starts_with("fe-entry-long-") || client_order_id.starts_with("fe-entry-short-")
}

async fn cancel_competing_entry_orders(
    binance: &BinanceClient,
    symbol: &str,
    filled_order_id: u64,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let open_orders = binance.open_orders(symbol).await?;
    let Some(orders) = open_orders.as_array() else {
        return Err("Binance open-orders response was not an array".into());
    };

    for order in orders {
        let Some(client_order_id) = order.get("clientOrderId").and_then(Value::as_str) else {
            continue;
        };

        if !is_entry_order(client_order_id) {
            continue;
        }

        let Some(order_id) = order.get("orderId").and_then(Value::as_i64) else {
            continue;
        };

        if order_id <= 0 || order_id as u64 == filled_order_id {
            continue;
        }

        match binance.cancel_order(symbol, order_id).await {
            Ok(_) => tracing::info!(
                target: "api",
                symbol,
                filled_order_id,
                cancelled_order_id = order_id,
                cancelled_client_order_id = client_order_id,
                "Cancelled competing entry order after entry execution"
            ),
            Err(error) => tracing::warn!(
                target: "api",
                symbol,
                filled_order_id,
                cancelled_order_id = order_id,
                cancelled_client_order_id = client_order_id,
                %error,
                "Unable to cancel competing entry order"
            ),
        }
    }

    Ok(())
}

fn parse_positive(name: &str, raw: &str) -> Result<f64, Box<dyn std::error::Error + Send + Sync>> {
    let value = raw.parse::<f64>()?;

    if !value.is_finite() || value <= 0.0 {
        return Err(format!("invalid {name}: {raw}").into());
    }

    Ok(value)
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
