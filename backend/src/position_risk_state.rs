use std::sync::Arc;

use serde_json::Value;
use tokio::sync::{RwLock, mpsc};
use tokio::time::{Duration, MissedTickBehavior, interval, sleep};

use crate::{
    binance::BinanceClient,
    diagnostics::DiagnosticsState,
    error::{AppError, AppResult},
};

// User-data websocket events request immediate reconciliation when trading state
// changes. This slow periodic tick is only a safety reconciliation, not a live feed.
const POSITION_RISK_REFRESH_INTERVAL: Duration = Duration::from_secs(300);
const POSITION_RISK_REFRESH_DEBOUNCE: Duration = Duration::from_millis(75);

#[derive(Clone)]
pub struct PositionRiskState {
    snapshot: Arc<RwLock<Vec<Value>>>,
    refresh_tx: mpsc::Sender<()>,
}

impl PositionRiskState {
    pub fn new(initial: Vec<Value>) -> (Self, mpsc::Receiver<()>) {
        let (refresh_tx, refresh_rx) = mpsc::channel(1);

        (
            Self {
                snapshot: Arc::new(RwLock::new(initial)),
                refresh_tx,
            },
            refresh_rx,
        )
    }

    pub async fn replace(&self, snapshot: Vec<Value>) {
        *self.snapshot.write().await = snapshot;
    }

    pub async fn snapshot(&self) -> Vec<Value> {
        self.snapshot.read().await.clone()
    }

    pub fn request_refresh(&self) {
        // Capacity one intentionally coalesces bursts from fills, leverage changes,
        // ACCOUNT_UPDATE events, and frontend-triggered trading actions.
        let _ = self.refresh_tx.try_send(());
    }
}

pub fn spawn_refresh_worker(
    binance: BinanceClient,
    position_risk_state: PositionRiskState,
    mut refresh_rx: mpsc::Receiver<()>,
    diagnostics: DiagnosticsState,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut periodic = interval(POSITION_RISK_REFRESH_INTERVAL);
        periodic.set_missed_tick_behavior(MissedTickBehavior::Skip);

        // `interval` ticks immediately once. Startup already fetched the initial
        // snapshot, so consume that first tick without issuing a duplicate call.
        periodic.tick().await;

        loop {
            tokio::select! {
                _ = periodic.tick() => {}

                refresh = refresh_rx.recv() => {
                    if refresh.is_none() {
                        break;
                    }

                    // Let a burst of related events collapse into one Binance call.
                    sleep(POSITION_RISK_REFRESH_DEBOUNCE).await;
                    while refresh_rx.try_recv().is_ok() {}
                }
            }

            if !binance.is_configured() {
                periodic.reset();
                continue;
            }

            match binance.position_risk().await {
                Ok(snapshot) => {
                    let drifted = position_risk_state.snapshot().await != snapshot;
                    position_risk_state.replace(snapshot).await;
                    diagnostics.exchange_success();
                    diagnostics.reconciliation_success("position-risk", drifted);
                    tracing::debug!(
                        target: "api",
                        "Binance position-risk cache refreshed"
                    );
                }
                Err(error) => {
                    diagnostics.exchange_failure(error.to_string());
                    diagnostics.reconciliation_failure("position-risk", error.to_string());
                    tracing::error!(
                        target: "api",
                        %error,
                        "Failed to refresh Binance position-risk cache"
                    );
                }
            }

            // An event-triggered refresh can happen just before the periodic tick.
            // Restart the period here so those two causes never produce back-to-back
            // Binance requests.
            periodic.reset();
        }
    })
}

pub async fn initialize(binance: &BinanceClient) -> AppResult<Vec<Value>> {
    binance.position_risk().await.map_err(|error| {
        AppError::Config(format!(
            "failed to initialize Binance position-risk cache: {error}"
        ))
    })
}
