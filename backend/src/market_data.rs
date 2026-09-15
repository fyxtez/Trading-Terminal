use std::{collections::HashMap, sync::Arc, time::Duration};

use axum::{
    Json,
    extract::{Query, State},
};
use serde::Deserialize;
use serde_json::Value;
use tokio::{sync::Mutex, time::Instant};

use crate::{
    api::AppState,
    binance::normalize_symbol,
    error::{AppError, AppResult},
};

type Entry = Arc<Mutex<Option<(Instant, Value)>>>;

#[derive(Clone, Default)]
pub(crate) struct MarketDataCache(Arc<Mutex<HashMap<String, Entry>>>);

impl MarketDataCache {
    async fn get<F>(&self, key: String, ttl: Duration, fetch: F) -> AppResult<Value>
    where
        F: Future<Output = AppResult<Value>>,
    {
        let entry = {
            let mut entries = self.0.lock().await;
            if entries.len() >= 256 && !entries.contains_key(&key) {
                // Only discard idle entries; a request already in flight keeps
                // its shared lock so a second client cannot duplicate it.
                entries.retain(|_, entry| Arc::strong_count(entry) > 1);
                if entries.len() >= 256 {
                    return Err(AppError::Invalid(
                        "Too many concurrent market data requests".into(),
                    ));
                }
            }
            entries.entry(key).or_default().clone()
        };
        let mut cached = entry.lock().await;
        if let Some((at, value)) = &*cached
            && at.elapsed() < ttl
        {
            return Ok(value.clone());
        }
        let value = fetch.await?;
        *cached = Some((Instant::now(), value.clone()));
        Ok(value)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KlineQuery {
    symbol: String,
    interval: String,
    limit: Option<u16>,
    start_time: Option<u64>,
    end_time: Option<u64>,
}

impl KlineQuery {
    fn params(self) -> AppResult<Vec<(String, String)>> {
        let limit = self.limit.unwrap_or(500);
        if !(1..=1500).contains(&limit)
            || ![
                "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d",
                "1w", "1M",
            ]
            .contains(&self.interval.as_str())
        {
            return Err(AppError::Invalid("Invalid candle interval or limit".into()));
        }
        let mut params = vec![
            ("symbol".into(), normalize_symbol(&self.symbol)?),
            ("interval".into(), self.interval),
            ("limit".into(), limit.to_string()),
        ];
        if let Some(value) = self.start_time {
            params.push(("startTime".into(), value.to_string()));
        }
        if let Some(value) = self.end_time {
            params.push(("endTime".into(), value.to_string()));
        }
        Ok(params)
    }
}

pub(crate) async fn klines(
    State(state): State<AppState>,
    Query(query): Query<KlineQuery>,
) -> AppResult<Json<Value>> {
    let ttl = if query.end_time.is_some() {
        Duration::from_secs(30)
    } else {
        Duration::from_millis(750)
    };
    let params = query.params()?;
    let key = serde_json::to_string(&params)?;
    let value = state
        .market_data
        .get(key, ttl, state.binance.market_data("klines", params))
        .await?;
    Ok(Json(value))
}

pub(crate) async fn exchange_info(State(state): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(
        state
            .market_data
            .get(
                "exchangeInfo".into(),
                Duration::from_secs(3600),
                state.binance.market_data("exchangeInfo", vec![]),
            )
            .await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn concurrent_clients_share_one_upstream_fetch() {
        let cache = MarketDataCache::default();
        let calls = AtomicUsize::new(0);
        let fetch = || async {
            calls.fetch_add(1, Ordering::Relaxed);
            tokio::task::yield_now().await;
            Ok(serde_json::json!([[1, "123"]]))
        };
        let (first, second) = tokio::join!(
            cache.get("BTC".into(), Duration::from_secs(1), fetch()),
            cache.get("BTC".into(), Duration::from_secs(1), fetch())
        );
        assert_eq!(first.unwrap(), second.unwrap());
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn rejects_unbounded_or_unsupported_candle_queries() {
        for query in [
            serde_json::json!({"symbol":"BTCUSDT","interval":"1m","limit":1501}),
            serde_json::json!({"symbol":"BTCUSDT","interval":"oops"}),
        ] {
            assert!(
                serde_json::from_value::<KlineQuery>(query)
                    .unwrap()
                    .params()
                    .is_err()
            );
        }
    }
}
