//! Shared manual chart documents. Per-ID patches prevent unrelated edits in
//! separate clients from replacing each other; tombstones prevent stale seeds
//! from resurrecting deleted drawings after reconnecting.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use tokio::{fs, sync::Mutex};

#[derive(Clone)]
pub struct ChartDocuments {
    path: PathBuf,
    data: Arc<Mutex<BTreeMap<String, Document>>>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Document {
    pub revision: u64,
    pub items: BTreeMap<String, Option<Value>>,
}
#[derive(Default, Deserialize)]
pub struct Patch {
    #[serde(default)]
    pub upserts: Vec<Value>,
    #[serde(default)]
    pub deleted: Vec<String>,
    #[serde(default)]
    pub seed: bool,
}
impl Document {
    fn apply(&mut self, patch: Patch) -> AppResult<()> {
        for item in &patch.upserts {
            if item.get("orderSide").is_some()
                || item.get("orderId").is_some()
                || item["id"]
                    .as_str()
                    .is_none_or(|id| id.is_empty() || id.len() > 200)
            {
                return Err(AppError::Invalid(
                    "Only manual chart drawings can be shared".into(),
                ));
            }
        }
        for item in patch.upserts {
            let id = item["id"].as_str().unwrap().to_owned();
            if !patch.seed || !self.items.contains_key(&id) {
                self.items.insert(id, Some(item));
            }
        }
        if !patch.seed {
            for id in patch.deleted {
                self.items.insert(id, None);
            }
        }
        self.revision += 1;
        Ok(())
    }
}
impl ChartDocuments {
    pub async fn load(path: PathBuf) -> AppResult<Self> {
        let data = match fs::read(&path).await {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(error.into()),
        };
        Ok(Self {
            path,
            data: Arc::new(Mutex::new(data)),
        })
    }
    pub async fn get(&self, symbol: &str) -> Document {
        self.data
            .lock()
            .await
            .get(symbol)
            .cloned()
            .unwrap_or_default()
    }
    pub async fn patch(&self, symbol: &str, patch: Patch) -> AppResult<Document> {
        let mut data = self.data.lock().await;
        let mut next = data.clone();
        let doc = next.entry(symbol.into()).or_default();
        doc.apply(patch)?;
        let result = doc.clone();
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let temp = self.path.with_extension("json.tmp");
        fs::write(&temp, serde_json::to_vec(&next)?).await?;
        fs::rename(temp, &self.path).await?;
        *data = next;
        Ok(result)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn merges_edits_and_retains_deletions_during_seed() {
        let mut doc = Document::default();
        doc.apply(Patch {
            upserts: vec![json!({"id":"a"})],
            ..Default::default()
        })
        .unwrap();
        doc.apply(Patch {
            upserts: vec![json!({"id":"b"})],
            ..Default::default()
        })
        .unwrap();
        doc.apply(Patch {
            deleted: vec!["a".into()],
            ..Default::default()
        })
        .unwrap();
        doc.apply(Patch {
            upserts: vec![json!({"id":"a"}), json!({"id":"c"})],
            seed: true,
            ..Default::default()
        })
        .unwrap();
        assert!(doc.items["a"].is_none());
        assert!(doc.items["b"].is_some());
        assert!(doc.items["c"].is_some());
    }
    #[test]
    fn rejects_exchange_order_lines() {
        assert!(
            Document::default()
                .apply(Patch {
                    upserts: vec![json!({"id":"a","orderSide":"BUY"})],
                    ..Default::default()
                })
                .is_err()
        );
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    async fn persists_edits_and_tombstones_per_symbol_across_restart() {
        let dir = std::env::temp_dir().join(format!(
            "fyxtez-chart-doc-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = dir.join("documents.json");
        let store = ChartDocuments::load(path.clone()).await.unwrap();
        store
            .patch(
                "BTCUSDT",
                Patch {
                    upserts: vec![json!({"id":"a","price":10})],
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        store
            .patch(
                "BTCUSDT",
                Patch {
                    deleted: vec!["a".into()],
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        store
            .patch(
                "SOLUSDT",
                Patch {
                    upserts: vec![json!({"id":"a","price":20})],
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let reloaded = ChartDocuments::load(path).await.unwrap();
        assert!(reloaded.get("BTCUSDT").await.items["a"].is_none());
        assert_eq!(
            reloaded.get("SOLUSDT").await.items["a"].as_ref().unwrap()["price"],
            20
        );
        fs::remove_dir_all(dir).await.unwrap();
    }
}
