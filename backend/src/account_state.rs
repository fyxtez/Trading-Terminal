use std::sync::Arc;

use tokio::sync::{RwLock, mpsc};
use tokio::time::{Duration, sleep};

use crate::{
    binance::BinanceClient,
    error::{AppError, AppResult},
    models::{FuturesAccountInfo, FuturesPosition},
};

#[derive(Clone)]
pub struct AccountState {
    snapshot: Arc<RwLock<FuturesAccountInfo>>,
    refresh_tx: mpsc::Sender<()>,
}

impl AccountState {
    pub fn new(initial: FuturesAccountInfo) -> (Self, mpsc::Receiver<()>) {
        let (refresh_tx, refresh_rx) = mpsc::channel(1);
        (
            Self {
                snapshot: Arc::new(RwLock::new(initial)),
                refresh_tx,
            },
            refresh_rx,
        )
    }

    pub async fn snapshot(&self) -> FuturesAccountInfo {
        self.snapshot.read().await.clone()
    }

    pub async fn replace(&self, snapshot: FuturesAccountInfo) {
        *self.snapshot.write().await = snapshot;
    }

    pub fn request_refresh(&self) {
        // Capacity one intentionally coalesces bursts of ACCOUNT_UPDATE events.
        let _ = self.refresh_tx.try_send(());
    }

    pub async fn apply_position_update(
        &self,
        symbol: &str,
        position_amt: &str,
        entry_price: &str,
        unrealized_profit: &str,
    ) {
        let mut snapshot = self.snapshot.write().await;

        if let Some(position) = snapshot
            .positions
            .iter_mut()
            .find(|position| position.symbol == symbol)
        {
            position.position_amt = position_amt.to_owned();
            position.entry_price = entry_price.to_owned();
            position.unrealized_profit = unrealized_profit.to_owned();
            return;
        }

        snapshot.positions.push(FuturesPosition {
            symbol: symbol.to_owned(),
            position_amt: position_amt.to_owned(),
            entry_price: entry_price.to_owned(),
            unrealized_profit: unrealized_profit.to_owned(),
            extra: serde_json::json!({}),
        });
    }

    pub async fn apply_wallet_balance(&self, asset: &str, wallet_balance: &str) {
        // This application sizes USDⓈ-M trades from USDT. ACCOUNT_UPDATE does not
        // include availableBalance, so the refresh worker reconciles that field.
        if asset == "USDT" {
            self.snapshot.write().await.total_wallet_balance = wallet_balance.to_owned();
        }
    }
}

pub fn spawn_refresh_worker(
    binance: BinanceClient,
    account_state: AccountState,
    mut refresh_rx: mpsc::Receiver<()>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while refresh_rx.recv().await.is_some() {
            // Let bursts of position/balance events collapse into one REST snapshot.
            sleep(Duration::from_millis(100)).await;
            while refresh_rx.try_recv().is_ok() {}

            match binance.account_info().await {
                Ok(snapshot) => account_state.replace(snapshot).await,
                Err(error) => tracing::error!(
                    target: "api",
                    %error,
                    "Failed to reconcile local Binance account-state cache"
                ),
            }
        }
    })
}

pub async fn initialize(binance: &BinanceClient) -> AppResult<FuturesAccountInfo> {
    binance.account_info().await.map_err(|error| {
        AppError::Config(format!(
            "failed to initialize Binance account-state cache: {error}"
        ))
    })
}
