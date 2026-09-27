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

struct CachedValue {
    expires_at: Instant,
    value: Value,
}

type Entry = Arc<Mutex<Option<CachedValue>>>;

#[derive(Clone, Default)]
pub(crate) struct MarketDataCache(Arc<Mutex<HashMap<String, Entry>>>);

impl MarketDataCache {
    async fn get<F>(&self, key: String, ttl: Duration, fetch: F) -> AppResult<Value>
    where
        F: Future<Output = AppResult<Value>>,
    {
        let entry = {
            let mut entries = self.0.lock().await;
            let now = Instant::now();
            // TTL must also bound retention: history requests use distinct
            // timestamps and may never read the same key again. Preserve active
            // readers/fetches so eviction cannot break request coalescing.
            entries.retain(|_, entry| {
                if Arc::strong_count(entry) > 1 {
                    return true;
                }
                match entry.try_lock() {
                    Ok(cached) => cached.as_ref().is_some_and(|value| value.expires_at > now),
                    Err(_) => true,
                }
            });
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
        if let Some(cached) = &*cached
            && cached.expires_at > Instant::now()
        {
            return Ok(cached.value.clone());
        }
        let value = fetch.await?;
        *cached = Some(CachedValue {
            expires_at: Instant::now() + ttl,
            value: value.clone(),
        });
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

    #[tokio::test]
    async fn unrelated_live_reads_release_expired_history_before_the_entry_limit() {
        let cache = MarketDataCache::default();
        let reference = serde_json::json!({"symbols": ["BTCUSDT"]});
        cache
            .get("exchangeInfo".into(), Duration::from_secs(3600), async {
                Ok(reference.clone())
            })
            .await
            .unwrap();
        let mut expired = Vec::new();
        for index in 0..32 {
            let key = format!("history-endTime-{index}");
            cache
                .get(key.clone(), Duration::ZERO, async {
                    Ok(serde_json::json!([[1, "100", "110", "90", "105"]]))
                })
                .await
                .unwrap();
            expired.push(Arc::downgrade(cache.0.lock().await.get(&key).unwrap()));
        }
        cache
            .get("live".into(), Duration::from_secs(1), async {
                Ok(serde_json::json!([[2, "105"]]))
            })
            .await
            .unwrap();
        assert_eq!(cache.0.lock().await.len(), 2);
        assert!(expired.iter().all(|entry| entry.upgrade().is_none()));
        let cached_reference = cache
            .get("exchangeInfo".into(), Duration::from_secs(3600), async {
                panic!("Fresh reference data must remain cached")
            })
            .await
            .unwrap();
        assert_eq!(cached_reference, reference);
    }

    #[tokio::test]
    async fn pruning_preserves_in_flight_requests_and_their_waiters() {
        let cache = MarketDataCache::default();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
        let expected = serde_json::json!([[1, "123"]]);
        let first = cache.get("BTC".into(), Duration::from_secs(30), async {
            started_tx.send(()).unwrap();
            finish_rx.await.unwrap();
            Ok(expected.clone())
        });
        let second = async {
            started_rx.await.unwrap();
            cache
                .get("unrelated".into(), Duration::from_secs(30), async {
                    Ok(Value::Null)
                })
                .await
                .unwrap();
            finish_tx.send(()).unwrap();
            cache
                .get("BTC".into(), Duration::from_secs(30), async {
                    panic!("Pruning must not duplicate an in-flight fetch")
                })
                .await
        };
        let (first, second) = tokio::join!(first, second);
        assert_eq!(first.unwrap(), expected);
        assert_eq!(second.unwrap(), expected);
    }

    #[tokio::test]
    async fn pruning_releases_entries_left_by_failed_fetches() {
        let cache = MarketDataCache::default();
        assert!(
            cache
                .get("failed".into(), Duration::from_secs(30), async {
                    Err(AppError::Invalid("upstream unavailable".into()))
                })
                .await
                .is_err()
        );
        let failed = Arc::downgrade(cache.0.lock().await.get("failed").unwrap());
        cache
            .get("live".into(), Duration::from_secs(1), async {
                Ok(Value::Null)
            })
            .await
            .unwrap();
        assert!(failed.upgrade().is_none());
        assert_eq!(cache.0.lock().await.len(), 1);
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
