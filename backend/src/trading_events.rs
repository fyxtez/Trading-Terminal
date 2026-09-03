use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TradingEvent {
    StreamStatus {
        connected: bool,
        message: String,
    },
    SnapshotRequired {
        reason: String,
    },
    AlertTriggered {
        id: String,
        symbol: String,
        price: f64,
        trigger_price: f64,
        side: String,
        pattern: Option<String>,
        triggered_at: i64,
    },
    NotificationFailed {
        alert_id: String,
        symbol: String,
        channel: String,
        context: String,
        message: String,
        occurred_at: i64,
    },
    OrderExecuted {
        event_id: String,
        symbol: String,
        side: String,
        order_type: String,
        order_status: String,
        order_id: u64,
        trade_id: Option<i64>,
        price: f64,
        quantity: f64,
        accumulated_quantity: f64,
        event_time: u64,
        transaction_time: Option<u64>,
        reduce_only: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::TradingEvent;

    #[test]
    fn notification_failure_identifies_the_consumed_alert() {
        let event = TradingEvent::NotificationFailed {
            alert_id: "alert-id".into(),
            symbol: "BTCUSDT".into(),
            channel: "telegram".into(),
            context: "BTCUSDT price alert".into(),
            message: "rejected".into(),
            occurred_at: 123,
        };

        let value = serde_json::to_value(event).expect("event must serialize");
        assert_eq!(value["type"], "NOTIFICATION_FAILED");
        assert_eq!(value["alert_id"], "alert-id");
        assert_eq!(value["symbol"], "BTCUSDT");
    }
}
