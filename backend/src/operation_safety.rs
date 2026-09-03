use std::{path::Path, time::Duration};

use sha2::{Digest, Sha256};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous},
};

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

#[derive(Clone)]
pub struct OperationSafety {
    pool: SqlitePool,
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
                completed_at_ms INTEGER
            )
            "#,
        )
        .execute(&pool)
        .await
        .map_err(|error| AppError::Config(format!("cannot initialize intent journal: {error}")))?;

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

        Ok(Self { pool })
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
        validate_intent_id(intent_id)?;
        let now = now_ms();

        // Cleanup is intentionally opportunistic. Intent rows are tiny and a
        // failure here must not weaken request safety or block trading.
        let _ = sqlx::query("DELETE FROM request_intents WHERE created_at_ms < ?")
            .bind(now - INTENT_RETENTION_MS)
            .execute(&self.pool)
            .await;
        let _ = sqlx::query("DELETE FROM operation_audit WHERE occurred_at_ms < ?")
            .bind(now - INTENT_RETENTION_MS)
            .execute(&self.pool)
            .await;

        let inserted = sqlx::query(
            r#"
            INSERT INTO request_intents
                (intent_id, method, path, fingerprint, state, created_at_ms)
            VALUES (?, ?, ?, ?, 'in_progress', ?)
            ON CONFLICT(intent_id) DO NOTHING
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

        if inserted.rows_affected() == 1 {
            self.audit(intent_id, method, path, "started", None).await;
            return Ok(IntentDecision::Execute);
        }

        let row = sqlx::query(
            "SELECT method, path, fingerprint, state, status, content_type, response_body FROM request_intents WHERE intent_id = ?",
        )
        .bind(intent_id)
        .fetch_one(&self.pool)
        .await
        .map_err(journal_error)?;

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

        Ok(IntentDecision::Replay {
            status,
            content_type,
            body,
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
            "CREATE TABLE request_intents (intent_id TEXT PRIMARY KEY, method TEXT NOT NULL, path TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, status INTEGER, content_type TEXT, response_body BLOB, created_at_ms INTEGER NOT NULL, completed_at_ms INTEGER)",
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
        OperationSafety { pool }
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
}
