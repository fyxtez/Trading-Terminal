use std::{collections::HashSet, path::Path, sync::Arc, time::Duration};

use sha2::{Digest, Sha256};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous},
};
use tokio::sync::{Mutex, RwLock};

use crate::error::{AppError, AppResult};

const INTENT_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1_000;

#[derive(Debug)]
pub enum IntentDecision {
    Execute,
    Replay {
        status: u16,
        content_type: Option<String>,
        body: Vec<u8>,
    },
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedIntent {
    pub intent_id: String,
    pub method: String,
    pub path: String,
    pub created_at_ms: i64,
    pub age_ms: i64,
}

#[derive(Clone)]
pub struct OperationSafety {
    pool: SqlitePool,
    gate: Arc<Mutex<()>>,
    startup_unresolved: Arc<RwLock<HashSet<String>>>,
}

impl OperationSafety {
    pub async fn connect(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePool::connect_with(options)
            .await
            .map_err(|error| AppError::Config(format!("cannot open operation journal: {error}")))?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS request_intents (
                intent_id TEXT PRIMARY KEY,
                method TEXT NOT NULL,
                path TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('in_progress', 'completed')),
                status INTEGER,
                content_type TEXT,
                response_body BLOB,
                created_at_ms INTEGER NOT NULL,
                completed_at_ms INTEGER,
                operator_resolved_at_ms INTEGER
            )
            "#,
        )
        .execute(&pool)
        .await
        .map_err(|error| AppError::Config(format!("cannot initialize intent journal: {error}")))?;

        let intent_columns = sqlx::query("PRAGMA table_info(request_intents)")
            .fetch_all(&pool)
            .await
            .map_err(journal_error)?;
        if !intent_columns.iter().any(|row| {
            row.try_get::<String, _>("name").ok().as_deref() == Some("operator_resolved_at_ms")
        }) {
            sqlx::query("ALTER TABLE request_intents ADD COLUMN operator_resolved_at_ms INTEGER")
                .execute(&pool)
                .await
                .map_err(journal_error)?;
        }

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS operation_audit (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                occurred_at_ms INTEGER NOT NULL,
                intent_id TEXT NOT NULL,
                method TEXT NOT NULL,
                path TEXT NOT NULL,
                outcome TEXT NOT NULL,
                status INTEGER
            )
            "#,
        )
        .execute(&pool)
        .await
        .map_err(|error| AppError::Config(format!("cannot initialize operation audit: {error}")))?;

        // Only rows which existed before this backend process started are
        // operator-recoverable. A row created by this process may still be an
        // actively executing request and must never be cleared from another
        // concurrent HTTP request.
        let startup_unresolved =
            sqlx::query("SELECT intent_id FROM request_intents WHERE state = 'in_progress'")
                .fetch_all(&pool)
                .await
                .map_err(journal_error)?
                .into_iter()
                .filter_map(|row| row.try_get::<String, _>("intent_id").ok())
                .collect();

        Ok(Self {
            pool,
            gate: Arc::new(Mutex::new(())),
            startup_unresolved: Arc::new(RwLock::new(startup_unresolved)),
        })
    }

    pub fn fingerprint(method: &str, path: &str, body: &[u8]) -> String {
        let mut digest = Sha256::new();
        digest.update(method.as_bytes());
        digest.update([0]);
        digest.update(path.as_bytes());
        digest.update([0]);
        digest.update(body);
        hex::encode(digest.finalize())
    }

    pub async fn begin(
        &self,
        intent_id: &str,
        method: &str,
        path: &str,
        fingerprint: &str,
    ) -> AppResult<IntentDecision> {
        self.begin_with_policy(intent_id, method, path, fingerprint, false)
            .await
    }

    pub async fn begin_exposure_increase(
        &self,
        intent_id: &str,
        method: &str,
        path: &str,
        fingerprint: &str,
    ) -> AppResult<IntentDecision> {
        self.begin_with_policy(intent_id, method, path, fingerprint, true)
            .await
    }

    async fn begin_with_policy(
        &self,
        intent_id: &str,
        method: &str,
        path: &str,
        fingerprint: &str,
        block_on_other_unresolved: bool,
    ) -> AppResult<IntentDecision> {
        validate_intent_id(intent_id)?;
        let _guard = self.gate.lock().await;
        let now = now_ms();

        // Cleanup is intentionally opportunistic. Intent rows are tiny and a
        // failure here must not weaken request safety or block trading. Never
        // age out an in-progress row: after a crash it is the durable evidence
        // that Binance may have accepted a request whose response was lost.
        let _ = sqlx::query(
            "DELETE FROM request_intents WHERE state = 'completed' AND operator_resolved_at_ms IS NULL AND created_at_ms < ?",
        )
        .bind(now - INTENT_RETENTION_MS)
        .execute(&self.pool)
        .await;
        let _ = sqlx::query("DELETE FROM operation_audit WHERE occurred_at_ms < ?")
            .bind(now - INTENT_RETENTION_MS)
            .execute(&self.pool)
            .await;

        let row = sqlx::query(
            "SELECT method, path, fingerprint, state, status, content_type, response_body FROM request_intents WHERE intent_id = ?",
        )
        .bind(intent_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(journal_error)?;

        if let Some(row) = row {
            let stored_method: String = row.try_get("method").map_err(journal_error)?;
            let stored_path: String = row.try_get("path").map_err(journal_error)?;
            let stored_fingerprint: String = row.try_get("fingerprint").map_err(journal_error)?;
            if stored_method != method || stored_path != path || stored_fingerprint != fingerprint {
                self.audit(intent_id, method, path, "rejected-intent-reuse", None)
                    .await;
                return Err(AppError::Conflict(
                    "intent ID was already used for a different request".into(),
                ));
            }

            let state: String = row.try_get("state").map_err(journal_error)?;
            if state != "completed" {
                self.audit(intent_id, method, path, "duplicate-in-progress", None)
                    .await;
                return Err(AppError::Conflict(
                    "intent is already in progress or has an uncertain result; reconcile exchange state before creating a new intent"
                        .into(),
                ));
            }

            let status = row
                .try_get::<i64, _>("status")
                .map_err(journal_error)?
                .try_into()
                .map_err(|_| AppError::Config("invalid cached intent status".into()))?;
            let content_type = row.try_get("content_type").map_err(journal_error)?;
            let body = row.try_get("response_body").map_err(journal_error)?;
            self.audit(intent_id, method, path, "replayed", Some(status))
                .await;

            return Ok(IntentDecision::Replay {
                status,
                content_type,
                body,
            });
        }

        if block_on_other_unresolved {
            let unresolved = sqlx::query(
                "SELECT intent_id FROM request_intents WHERE state = 'in_progress' LIMIT 1",
            )
            .fetch_optional(&self.pool)
            .await
            .map_err(journal_error)?;
            if unresolved.is_some() {
                self.audit(
                    intent_id,
                    method,
                    path,
                    "blocked-by-unresolved-intent",
                    None,
                )
                .await;
                return Err(AppError::Conflict(
                    "new exposure is blocked because a previous operation has an uncertain result; verify Binance and resolve it in Settings > Diagnostics"
                        .into(),
                ));
            }
        }

        sqlx::query(
            r#"
            INSERT INTO request_intents
                (intent_id, method, path, fingerprint, state, created_at_ms)
            VALUES (?, ?, ?, ?, 'in_progress', ?)
            "#,
        )
        .bind(intent_id)
        .bind(method)
        .bind(path)
        .bind(fingerprint)
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(journal_error)?;

        self.audit(intent_id, method, path, "started", None).await;
        Ok(IntentDecision::Execute)
    }

    pub async fn unresolved_from_previous_run(&self) -> AppResult<Vec<UnresolvedIntent>> {
        let startup_ids = self.startup_unresolved.read().await.clone();
        if startup_ids.is_empty() {
            return Ok(Vec::new());
        }

        let now = now_ms();
        let rows = sqlx::query(
            "SELECT intent_id, method, path, created_at_ms FROM request_intents WHERE state = 'in_progress' ORDER BY created_at_ms ASC",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(journal_error)?;

        let mut unresolved = Vec::new();
        for row in rows {
            let intent_id: String = row.try_get("intent_id").map_err(journal_error)?;
            if !startup_ids.contains(&intent_id) {
                continue;
            }
            let created_at_ms: i64 = row.try_get("created_at_ms").map_err(journal_error)?;
            unresolved.push(UnresolvedIntent {
                intent_id,
                method: row.try_get("method").map_err(journal_error)?,
                path: row.try_get("path").map_err(journal_error)?,
                created_at_ms,
                age_ms: now.saturating_sub(created_at_ms),
            });
        }
        Ok(unresolved)
    }

    pub async fn resolve_previous_run(&self, intent_id: &str) -> AppResult<UnresolvedIntent> {
        validate_intent_id(intent_id)?;
        let _guard = self.gate.lock().await;
        if !self.startup_unresolved.read().await.contains(intent_id) {
            return Err(AppError::NotFound(
                "recoverable unresolved intent was not found".into(),
            ));
        }

        let row = sqlx::query(
            "SELECT method, path, created_at_ms FROM request_intents WHERE intent_id = ? AND state = 'in_progress'",
        )
        .bind(intent_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(journal_error)?
        .ok_or_else(|| AppError::NotFound("unresolved intent was not found".into()))?;
        let method: String = row.try_get("method").map_err(journal_error)?;
        let path: String = row.try_get("path").map_err(journal_error)?;
        let created_at_ms: i64 = row.try_get("created_at_ms").map_err(journal_error)?;

        let tombstone = br#"{"error":"this uncertain operation was explicitly resolved after Binance reconciliation; submit any new action as a new intent"}"#;
        sqlx::query(
            r#"
            UPDATE request_intents
            SET state = 'completed', status = 409, content_type = 'application/json',
                response_body = ?, completed_at_ms = ?, operator_resolved_at_ms = ?
            WHERE intent_id = ? AND state = 'in_progress'
            "#,
        )
        .bind(tombstone.as_slice())
        .bind(now_ms())
        .bind(now_ms())
        .bind(intent_id)
        .execute(&self.pool)
        .await
        .map_err(journal_error)?;
        self.startup_unresolved.write().await.remove(intent_id);
        self.audit(
            intent_id,
            &method,
            &path,
            "operator-resolved-after-reconciliation",
            None,
        )
        .await;
        Ok(UnresolvedIntent {
            intent_id: intent_id.to_owned(),
            method,
            path,
            created_at_ms,
            age_ms: now_ms().saturating_sub(created_at_ms),
        })
    }

    pub async fn complete(
        &self,
        intent_id: &str,
        method: &str,
        path: &str,
        status: u16,
        content_type: Option<&str>,
        body: &[u8],
    ) -> AppResult<()> {
        let _guard = self.gate.lock().await;
        sqlx::query(
            r#"
            UPDATE request_intents
            SET state = 'completed', status = ?, content_type = ?, response_body = ?, completed_at_ms = ?
            WHERE intent_id = ? AND state = 'in_progress'
            "#,
        )
        .bind(i64::from(status))
        .bind(content_type)
        .bind(body)
        .bind(now_ms())
        .bind(intent_id)
        .execute(&self.pool)
        .await
        .map_err(journal_error)?;

        let outcome = if status < 400 {
            "completed"
        } else {
            "rejected"
        };
        self.audit(intent_id, method, path, outcome, Some(status))
            .await;
        Ok(())
    }

    async fn audit(
        &self,
        intent_id: &str,
        method: &str,
        path: &str,
        outcome: &str,
        status: Option<u16>,
    ) {
        if let Err(error) = sqlx::query(
            "INSERT INTO operation_audit (occurred_at_ms, intent_id, method, path, outcome, status) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(now_ms())
        .bind(intent_id)
        .bind(method)
        .bind(path)
        .bind(outcome)
        .bind(status.map(i64::from))
        .execute(&self.pool)
        .await
        {
            tracing::error!(target: "audit", %error, "Failed to persist redacted operation audit event");
        }
    }
}

fn validate_intent_id(value: &str) -> AppResult<()> {
    let parsed = uuid::Uuid::parse_str(value)
        .map_err(|_| AppError::Invalid("X-Fyxtez-Intent-Id must be a valid UUID".into()))?;
    if parsed.is_nil() {
        return Err(AppError::Invalid(
            "X-Fyxtez-Intent-Id must not be nil".into(),
        ));
    }
    Ok(())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn journal_error(error: sqlx::Error) -> AppError {
    AppError::Config(format!("operation journal failed: {error}"))
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    async fn store() -> OperationSafety {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .shared_cache(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE request_intents (intent_id TEXT PRIMARY KEY, method TEXT NOT NULL, path TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, status INTEGER, content_type TEXT, response_body BLOB, created_at_ms INTEGER NOT NULL, completed_at_ms INTEGER, operator_resolved_at_ms INTEGER)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE operation_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at_ms INTEGER NOT NULL, intent_id TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, outcome TEXT NOT NULL, status INTEGER)",
        )
        .execute(&pool)
        .await
        .unwrap();
        OperationSafety {
            pool,
            gate: Arc::new(Mutex::new(())),
            startup_unresolved: Arc::new(RwLock::new(HashSet::new())),
        }
    }

    #[tokio::test]
    async fn completed_intent_replays_the_exact_response() {
        let store = store().await;
        let id = uuid::Uuid::new_v4().to_string();
        let fingerprint = OperationSafety::fingerprint("POST", "/api/orders/market", b"{}");
        assert!(matches!(
            store
                .begin(&id, "POST", "/api/orders/market", &fingerprint)
                .await
                .unwrap(),
            IntentDecision::Execute
        ));
        store
            .complete(
                &id,
                "POST",
                "/api/orders/market",
                200,
                Some("application/json"),
                br#"{"order":"ok"}"#,
            )
            .await
            .unwrap();

        match store
            .begin(&id, "POST", "/api/orders/market", &fingerprint)
            .await
            .unwrap()
        {
            IntentDecision::Replay { status, body, .. } => {
                assert_eq!(status, 200);
                assert_eq!(body, br#"{"order":"ok"}"#);
            }
            IntentDecision::Execute => panic!("completed intent executed twice"),
        }
    }

    #[tokio::test]
    async fn in_progress_or_reused_intent_fails_closed() {
        let store = store().await;
        let id = uuid::Uuid::new_v4().to_string();
        let fingerprint = OperationSafety::fingerprint("POST", "/api/orders/market", b"{}");
        store
            .begin(&id, "POST", "/api/orders/market", &fingerprint)
            .await
            .unwrap();

        assert!(matches!(
            store
                .begin(&id, "POST", "/api/orders/market", &fingerprint)
                .await,
            Err(AppError::Conflict(_))
        ));
        assert!(matches!(
            store
                .begin(
                    &id,
                    "POST",
                    "/api/orders/market",
                    &OperationSafety::fingerprint("POST", "/api/orders/market", b"different"),
                )
                .await,
            Err(AppError::Conflict(_))
        ));
    }

    #[tokio::test]
    async fn restart_blocks_new_exposure_until_operator_resolution() {
        let path = std::env::temp_dir().join(format!(
            "fyxtez-operation-safety-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let stale_id = uuid::Uuid::new_v4().to_string();
        let stale_fingerprint =
            OperationSafety::fingerprint("POST", "/api/orders/market", b"stale");

        let first_run = OperationSafety::connect(&path).await.unwrap();
        assert!(matches!(
            first_run
                .begin_exposure_increase(
                    &stale_id,
                    "POST",
                    "/api/orders/market",
                    &stale_fingerprint,
                )
                .await
                .unwrap(),
            IntentDecision::Execute
        ));
        first_run.pool.close().await;

        let second_run = OperationSafety::connect(&path).await.unwrap();
        let unresolved = second_run.unresolved_from_previous_run().await.unwrap();
        assert_eq!(unresolved.len(), 1);
        assert_eq!(unresolved[0].intent_id, stale_id);

        let blocked_id = uuid::Uuid::new_v4().to_string();
        assert!(matches!(
            second_run
                .begin_exposure_increase(
                    &blocked_id,
                    "POST",
                    "/api/orders/limit",
                    &OperationSafety::fingerprint("POST", "/api/orders/limit", b"new"),
                )
                .await,
            Err(AppError::Conflict(message)) if message.contains("new exposure is blocked")
        ));

        // Risk reduction remains executable even while the previous result is
        // uncertain. Complete it so it does not become another crash marker.
        let reduce_id = uuid::Uuid::new_v4().to_string();
        let reduce_fingerprint =
            OperationSafety::fingerprint("POST", "/api/orders/close-position", b"reduce");
        assert!(matches!(
            second_run
                .begin(
                    &reduce_id,
                    "POST",
                    "/api/orders/close-position",
                    &reduce_fingerprint,
                )
                .await
                .unwrap(),
            IntentDecision::Execute
        ));
        second_run
            .complete(
                &reduce_id,
                "POST",
                "/api/orders/close-position",
                200,
                Some("application/json"),
                b"{}",
            )
            .await
            .unwrap();

        second_run.resolve_previous_run(&stale_id).await.unwrap();
        assert!(
            second_run
                .unresolved_from_previous_run()
                .await
                .unwrap()
                .is_empty()
        );
        sqlx::query("UPDATE request_intents SET created_at_ms = ? WHERE intent_id = ?")
            .bind(now_ms() - INTENT_RETENTION_MS - 1)
            .bind(&stale_id)
            .execute(&second_run.pool)
            .await
            .unwrap();
        match second_run
            .begin_exposure_increase(&stale_id, "POST", "/api/orders/market", &stale_fingerprint)
            .await
            .unwrap()
        {
            IntentDecision::Replay { status, body, .. } => {
                assert_eq!(status, 409);
                assert!(String::from_utf8_lossy(&body).contains("explicitly resolved"));
            }
            IntentDecision::Execute => panic!("resolved intent was executed again"),
        }

        let new_id = uuid::Uuid::new_v4().to_string();
        assert!(matches!(
            second_run
                .begin_exposure_increase(
                    &new_id,
                    "POST",
                    "/api/orders/limit",
                    &OperationSafety::fingerprint("POST", "/api/orders/limit", b"after"),
                )
                .await
                .unwrap(),
            IntentDecision::Execute
        ));

        let resolution_audits: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM operation_audit WHERE intent_id = ? AND outcome = 'operator-resolved-after-reconciliation'",
        )
        .bind(&stale_id)
        .fetch_one(&second_run.pool)
        .await
        .unwrap();
        assert_eq!(resolution_audits, 1);

        second_run.pool.close().await;
        for candidate in [
            path.clone(),
            path.with_extension("sqlite3-wal"),
            path.with_extension("sqlite3-shm"),
        ] {
            let _ = tokio::fs::remove_file(candidate).await;
        }
    }

    #[tokio::test]
    async fn existing_journal_is_migrated_for_permanent_resolution_tombstones() {
        let path = std::env::temp_dir().join(format!(
            "fyxtez-operation-safety-migration-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE request_intents (intent_id TEXT PRIMARY KEY, method TEXT NOT NULL, path TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, status INTEGER, content_type TEXT, response_body BLOB, created_at_ms INTEGER NOT NULL, completed_at_ms INTEGER)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let migrated = OperationSafety::connect(&path).await.unwrap();
        let column_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('request_intents') WHERE name = 'operator_resolved_at_ms'",
        )
        .fetch_one(&migrated.pool)
        .await
        .unwrap();
        assert_eq!(column_count, 1);
        migrated.pool.close().await;
        let _ = tokio::fs::remove_file(path).await;
    }
}
