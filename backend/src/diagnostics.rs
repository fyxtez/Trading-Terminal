use std::{
    sync::{Arc, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDiagnostic {
    pub status: String,
    pub last_success_at_ms: Option<u64>,
    pub last_event_at_ms: Option<u64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationDiagnostic {
    pub status: String,
    pub last_success_at_ms: Option<u64>,
    pub last_drift_at_ms: Option<u64>,
    pub drift_count: u64,
    pub last_component: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestDiagnostic {
    pub rejected_count: u64,
    pub duplicate_count: u64,
    pub last_rejected_at_ms: Option<u64>,
    pub last_duplicate_at_ms: Option<u64>,
    pub last_rejection: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationDiagnostic {
    pub failure_count: u64,
    pub last_failure_at_ms: Option<u64>,
    pub last_failure: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSnapshot {
    pub started_at_ms: u64,
    pub exchange: ServiceDiagnostic,
    pub user_stream: ServiceDiagnostic,
    pub reconciliation: ReconciliationDiagnostic,
    pub requests: RequestDiagnostic,
    pub notifications: NotificationDiagnostic,
}

#[derive(Clone)]
pub struct DiagnosticsState {
    inner: Arc<RwLock<DiagnosticsSnapshot>>,
}

impl DiagnosticsState {
    pub fn new(binance_configured: bool) -> Self {
        Self {
            inner: Arc::new(RwLock::new(DiagnosticsSnapshot {
                started_at_ms: now_ms(),
                exchange: ServiceDiagnostic {
                    // Public exchange/reference requests exist in chart-only mode,
                    // so exchange reachability is independent of account credentials.
                    status: "connecting".into(),
                    last_success_at_ms: None,
                    last_event_at_ms: None,
                    last_error: None,
                },
                user_stream: ServiceDiagnostic {
                    status: if binance_configured {
                        "connecting"
                    } else {
                        "disabled"
                    }
                    .into(),
                    last_success_at_ms: None,
                    last_event_at_ms: None,
                    last_error: None,
                },
                reconciliation: ReconciliationDiagnostic {
                    status: if binance_configured {
                        "pending"
                    } else {
                        "disabled"
                    }
                    .into(),
                    last_success_at_ms: None,
                    last_drift_at_ms: None,
                    drift_count: 0,
                    last_component: None,
                    last_error: None,
                },
                requests: RequestDiagnostic {
                    rejected_count: 0,
                    duplicate_count: 0,
                    last_rejected_at_ms: None,
                    last_duplicate_at_ms: None,
                    last_rejection: None,
                },
                notifications: NotificationDiagnostic {
                    failure_count: 0,
                    last_failure_at_ms: None,
                    last_failure: None,
                },
            })),
        }
    }

    pub fn snapshot(&self) -> DiagnosticsSnapshot {
        self.inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn set_binance_configured(&self, configured: bool) {
        let mut state = self.write();
        if configured {
            if state.exchange.status == "disabled" {
                state.exchange.status = "connecting".into();
            }
            if state.user_stream.status == "disabled" {
                state.user_stream.status = "connecting".into();
            }
            if state.reconciliation.status == "disabled" {
                state.reconciliation.status = "pending".into();
            }
        } else {
            state.user_stream.status = "disabled".into();
            state.reconciliation.status = "disabled".into();
        }
    }

    pub fn exchange_success(&self) {
        let mut state = self.write();
        state.exchange.status = "connected".into();
        state.exchange.last_success_at_ms = Some(now_ms());
        state.exchange.last_error = None;
    }

    pub fn exchange_failure(&self, message: impl Into<String>) {
        let mut state = self.write();
        state.exchange.status = "degraded".into();
        state.exchange.last_error = Some(redact_and_bound(message.into()));
    }

    pub fn user_stream_connected(&self) {
        let now = now_ms();
        let mut state = self.write();
        state.user_stream.status = "connected".into();
        state.user_stream.last_success_at_ms = Some(now);
        state.user_stream.last_event_at_ms = Some(now);
        state.user_stream.last_error = None;
    }

    pub fn user_stream_event(&self) {
        self.write().user_stream.last_event_at_ms = Some(now_ms());
    }

    pub fn user_stream_failure(&self, message: impl Into<String>) {
        let mut state = self.write();
        state.user_stream.status = "degraded".into();
        state.user_stream.last_error = Some(redact_and_bound(message.into()));
    }

    pub fn reconciliation_success(&self, component: &str, drifted: bool) {
        let now = now_ms();
        let mut state = self.write();
        state.reconciliation.status = if drifted { "drift-repaired" } else { "healthy" }.into();
        state.reconciliation.last_success_at_ms = Some(now);
        state.reconciliation.last_component = Some(component.into());
        state.reconciliation.last_error = None;
        if drifted {
            state.reconciliation.drift_count += 1;
            state.reconciliation.last_drift_at_ms = Some(now);
        }
    }

    pub fn reconciliation_failure(&self, component: &str, message: impl Into<String>) {
        let mut state = self.write();
        state.reconciliation.status = "degraded".into();
        state.reconciliation.last_component = Some(component.into());
        state.reconciliation.last_error = Some(redact_and_bound(message.into()));
    }

    pub fn request_rejected(&self, path: &str, status: u16, duplicate: bool) {
        let now = now_ms();
        let mut state = self.write();
        state.requests.rejected_count += 1;
        state.requests.last_rejected_at_ms = Some(now);
        state.requests.last_rejection = Some(format!("{status} {path}"));
        if duplicate {
            state.requests.duplicate_count += 1;
            state.requests.last_duplicate_at_ms = Some(now);
        }
    }

    pub fn notification_failure(&self, channel: &str, message: impl Into<String>) {
        let mut state = self.write();
        state.notifications.failure_count += 1;
        state.notifications.last_failure_at_ms = Some(now_ms());
        state.notifications.last_failure =
            Some(format!("{channel}: {}", redact_and_bound(message.into())));
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, DiagnosticsSnapshot> {
        self.inner
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn redact_and_bound(message: String) -> String {
    let sanitized = message
        .split_whitespace()
        .map(|token| {
            let lower = token.to_ascii_lowercase();
            if lower.contains("signature=")
                || lower.contains("listenkey=")
                || lower.contains("api_key=")
                || lower.contains("token=")
            {
                return "[redacted]".to_owned();
            }
            if let Some((scheme, remainder)) = token.split_once("://") {
                let authority = remainder
                    .split(['/', '?', '#'])
                    .next()
                    .unwrap_or_default()
                    .rsplit('@')
                    .next()
                    .unwrap_or_default();
                return format!("{scheme}://{authority}/[redacted]");
            }
            token.to_owned()
        })
        .collect::<Vec<_>>()
        .join(" ");
    sanitized.chars().take(240).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_rejections_duplicates_and_drift() {
        let diagnostics = DiagnosticsState::new(true);
        diagnostics.request_rejected("/api/orders/market", 422, true);
        diagnostics.reconciliation_success("account", true);

        let snapshot = diagnostics.snapshot();
        assert_eq!(snapshot.requests.rejected_count, 1);
        assert_eq!(snapshot.requests.duplicate_count, 1);
        assert_eq!(snapshot.reconciliation.drift_count, 1);
        assert_eq!(snapshot.reconciliation.status, "drift-repaired");
    }

    #[test]
    fn removes_sensitive_query_values_from_diagnostic_errors() {
        let diagnostics = DiagnosticsState::new(true);
        diagnostics.exchange_failure(
            "request failed https://example.test/path?signature=secret&token=also-secret",
        );

        let error = diagnostics.snapshot().exchange.last_error.unwrap();
        assert!(!error.contains("secret"));
        assert!(error.contains("[redacted]"));
    }

    #[test]
    fn removes_private_topics_tokens_and_url_credentials_from_diagnostics() {
        let message = redact_and_bound(
            "delivery https://user:password@ntfy.sh/private-topic?auth=secret and https://api.telegram.org/bot123:secret/sendMessage"
                .into(),
        );

        assert_eq!(
            message,
            "delivery https://ntfy.sh/[redacted] and https://api.telegram.org/[redacted]"
        );
        assert!(!message.contains("private-topic"));
        assert!(!message.contains("password"));
        assert!(!message.contains("bot123"));
    }
}
