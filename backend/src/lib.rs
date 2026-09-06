mod account_state;
mod alerts;
mod api;
mod auto_market_workflow;
mod binance;
mod binance_stream;
mod browser_access;
mod diagnostics;
mod error;
mod icons;
mod models;
mod operation_safety;
mod order_mutation_workflow;
mod position_risk_state;
mod runtime_config;
mod secure_store;
mod sizing_store;
mod symbol_registry;
#[cfg(feature = "testnet-drills")]
pub mod testnet_drill;
mod trade_lock;
mod trading_events;

use std::{collections::HashMap, future::Future, sync::Arc};

use account_state::{AccountState, spawn_refresh_worker};
use alerts::{AlertRuntime, AlertStore, spawn_alert_worker};
use api::{AppState, browser_router, router};
use binance::BinanceClient;
use browser_access::BrowserAccessState;
use diagnostics::DiagnosticsState;
pub use error::{AppError, AppResult};
use icons::IconStore;
use models::{FuturesAccountInfo, MarginSizingConfig};
use operation_safety::OperationSafety;
use position_risk_state::{
    PositionRiskState, spawn_refresh_worker as spawn_position_risk_refresh_worker,
};
pub use runtime_config::RuntimeConfig;
use sizing_store::SizingStore;
use symbol_registry::{MarketDataSource, MarketKind, SymbolRegistry};
use tokio::{
    net::TcpListener,
    sync::{RwLock, broadcast, watch},
};
use tracing::info;
use tracing_subscriber::EnvFilter;
use trade_lock::TradeLock;

/// Alert implementation remains available in the source tree, but the product
/// does not expose alert routes or start their market-monitoring worker.
pub(crate) const PRICE_ALERTS_ENABLED: bool = false;

pub async fn run_from_environment() -> AppResult<()> {
    let runtime = RuntimeConfig::load()?;
    if runtime.parent_process_guard {
        runtime_config::spawn_parent_lifetime_guard()?;
    }

    init_tracing();
    serve(runtime, shutdown_signal()).await
}

pub fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .try_init();
}

pub async fn serve<F>(runtime: RuntimeConfig, shutdown: F) -> AppResult<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    let browser_runtime = runtime.browser;
    let browser_access = browser_runtime
        .as_ref()
        .map(|browser| BrowserAccessState::configured(browser.address))
        .unwrap_or_else(BrowserAccessState::disabled);
    let binance = BinanceClient::from_secure_store(runtime.use_secure_network)?;
    let diagnostics = DiagnosticsState::new(binance.is_configured());

    // Only local, deterministic initialization belongs before the API bind.
    // Outbound exchange/metadata work is started below and may complete after
    // first paint; routes that increase exposure already fail closed until the
    // required reference/account data exists.
    let symbol_registry = SymbolRegistry::load(&runtime.symbol_registry_path).await?;
    let icon_store = IconStore::load(&runtime.icon_cache_dir).await?;

    // Backfill icons for symbols already sitting in the registry from
    // before the icon-cache feature existed at all (or symbols.json
    // edited by hand, or added while an older build without this feature
    // was briefly running). Those never went through add_symbol's
    // icon-caching step, so without this backfill they'd silently stay
    // icon-less forever instead of self-healing on the next restart.
    // `seed` already no-ops (a cheap in-memory check, no network call)
    // for anything it's already cached, so re-seeding the 8 majors here
    // too via this same list (if they're also registry entries) is
    // harmless, not a duplicate fetch.
    let registered_symbols = symbol_registry.list().await;
    // Do not mutate/check margin mode for every tracked symbol at startup.
    // Besides delaying first paint, one unavailable private endpoint used to
    // crash the entire local backend before /health could bind. Exposure-
    // increasing routes enforce ISOLATED immediately before submission, and
    // symbol registration performs the same guard for newly added contracts.

    let registered_tradfi_symbols: Vec<String> = registered_symbols
        .iter()
        .filter(|entry| entry.market_kind == MarketKind::Traditional)
        .map(|entry| entry.symbol.clone())
        .collect();
    let registered_mexc_symbols: Vec<String> = registered_symbols
        .iter()
        .filter(|entry| {
            entry.data_source == MarketDataSource::Mexc && entry.market_kind == MarketKind::Crypto
        })
        .map(|entry| entry.symbol.clone())
        .collect();
    let registered_binance_symbols: Vec<String> = registered_symbols
        .iter()
        // startup token-icon backfill applies only to actual crypto.
        .filter(|entry| {
            entry.data_source == MarketDataSource::Binance
                && entry.market_kind == MarketKind::Crypto
        })
        .map(|entry| entry.symbol.clone())
        .collect();
    let sizing_defaults = load_sizing_config()?;
    let sizing_store = SizingStore::new(&runtime.sizing_config_path);
    let sizing = sizing_store.load(sizing_defaults).await?;

    let initial_account = FuturesAccountInfo {
        total_wallet_balance: "0".into(),
        available_balance: "0".into(),
        assets: Vec::new(),
        positions: Vec::new(),
        extra: serde_json::json!({}),
    };
    let (account_state, account_refresh_rx) = AccountState::new(initial_account);
    let account_refresh_task = spawn_refresh_worker(
        binance.clone(),
        account_state.clone(),
        account_refresh_rx,
        diagnostics.clone(),
    );

    let initial_position_risk = Vec::new();
    let (position_risk_state, position_risk_refresh_rx) =
        PositionRiskState::new(initial_position_risk);
    let position_risk_refresh_task = spawn_position_risk_refresh_worker(
        binance.clone(),
        position_risk_state.clone(),
        position_risk_refresh_rx,
        diagnostics.clone(),
    );

    if binance.is_configured() {
        // Coalesced worker requests repair either fallback snapshot as soon as
        // private Binance REST connectivity returns.
        account_state.request_refresh();
        position_risk_state.request_refresh();
    }

    let reference_data_task = binance.spawn_reference_data_worker(false, diagnostics.clone());

    let server_time_task = {
        let binance = binance.clone();
        let diagnostics = diagnostics.clone();
        tokio::spawn(async move {
            info!("Synchronizing Binance server time in background");
            match binance.sync_server_time().await {
                Ok(()) => diagnostics.exchange_success(),
                Err(error) => {
                    diagnostics.exchange_failure(error.to_string());
                    tracing::warn!(target: "api", %error, "Binance time sync will retry on the next signed request");
                }
            }
        })
    };

    let registry_refresh_task = {
        let symbol_registry = symbol_registry.clone();
        tokio::spawn(async move {
            // Registry files created before market_kind deserialize as crypto.
            // Heal them after the app is usable instead of blocking first paint.
            if let Err(error) = symbol_registry.refresh_binance_market_kinds().await {
                tracing::warn!(%error, "Failed to refresh Binance market classifications");
            }
        })
    };

    let icon_seed_task = {
        let icon_store = icon_store.clone();
        tokio::spawn(async move {
            info!("Refreshing cached market icons in background");
            for symbol in &registered_tradfi_symbols {
                if let Err(error) = icon_store.remove_misclassified(symbol).await {
                    tracing::warn!(%symbol, %error, "Failed to purge misclassified TradFi icon");
                }
            }
            let tradfi: Vec<&str> = registered_tradfi_symbols
                .iter()
                .map(String::as_str)
                .collect();
            let mexc: Vec<&str> = registered_mexc_symbols.iter().map(String::as_str).collect();
            let binance: Vec<&str> = registered_binance_symbols
                .iter()
                .map(String::as_str)
                .collect();
            icon_store.seed(icons::DEFAULT_SEED_SYMBOLS).await;
            icon_store.seed_tradfi(&tradfi).await;
            icon_store.seed_mexc(&mexc).await;
            icon_store.seed(&binance).await;
        })
    };

    let (trading_events, _) = broadcast::channel(512);

    let alert_store = if PRICE_ALERTS_ENABLED {
        AlertStore::connect(&runtime.alerts_db_path).await?
    } else {
        AlertStore::disabled()
    };
    let operation_safety = OperationSafety::connect(&runtime.operation_journal_path).await?;
    let (alert_runtime, alert_worker_task) = if PRICE_ALERTS_ENABLED {
        let (runtime, task) = spawn_alert_worker(
            alert_store.clone(),
            binance.user_stream_ws_base().to_string(),
            trading_events.clone(),
            diagnostics.clone(),
        );
        (runtime, Some(task))
    } else {
        info!("Price alerts are dormant; alert market worker is disabled");
        (AlertRuntime::disabled(), None)
    };

    let state = AppState {
        binance: binance.clone(),
        account_state: account_state.clone(),
        position_risk_state: position_risk_state.clone(),
        sizing: Arc::new(RwLock::new(sizing)),
        sizing_store,
        service_token: runtime.service_token,
        trade_lock: TradeLock::new(),
        trading_events: trading_events.clone(),
        alert_store,
        alert_runtime,
        symbol_registry,
        icon_store,
        websocket_tickets: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        browser_access: browser_access.clone(),
        diagnostics: diagnostics.clone(),
        operation_safety,
    };

    info!(
        network = if binance.is_testnet() {
            "testnet"
        } else {
            "mainnet"
        },
        rest_base = binance.user_stream_rest_base(),
        ws_base = binance.user_stream_ws_base(),
        "Launching Binance user-data stream"
    );

    let user_stream_task = binance_stream::spawn_user_stream(
        binance.clone(),
        account_state,
        position_risk_state,
        trading_events,
        diagnostics,
    );

    let listener = TcpListener::bind(runtime.address).await?;

    // Browser access is an optional companion listener. Failure to find the
    // packaged UI or claim its stable port must never prevent the native app
    // and its private API from starting.
    let (browser_shutdown_tx, browser_shutdown_rx) = watch::channel(false);
    let browser_server_task = if let Some(browser) = browser_runtime {
        match std::fs::canonicalize(&browser.ui_dir) {
            Ok(ui_dir) if ui_dir.join("index.html").is_file() => {
                match TcpListener::bind(browser.address).await {
                    Ok(browser_listener) => {
                        browser_access.mark_available().await;
                        let browser_access_for_task = browser_access.clone();
                        let browser_state = state.clone();
                        info!(
                            address = %browser.address,
                            "Local browser access listener is ready"
                        );
                        Some(tokio::spawn(async move {
                            let result = axum::serve(
                                browser_listener,
                                browser_router(browser_state, ui_dir),
                            )
                            .with_graceful_shutdown(wait_for_browser_shutdown(browser_shutdown_rx))
                            .await;
                            if result.is_err() {
                                browser_access_for_task
                                    .mark_unavailable("Browser access stopped unexpectedly")
                                    .await;
                            }
                            result
                        }))
                    }
                    Err(error) => {
                        let reason = if error.kind() == std::io::ErrorKind::AddrInUse {
                            format!(
                                "Browser access port {} is already in use",
                                browser.address.port()
                            )
                        } else {
                            "Browser access could not start".to_string()
                        };
                        tracing::warn!(%error, %reason);
                        browser_access.mark_unavailable(reason).await;
                        None
                    }
                }
            }
            Ok(_) | Err(_) => {
                tracing::warn!("Packaged browser UI is unavailable");
                browser_access
                    .mark_unavailable("Browser files are unavailable; reinstall the app")
                    .await;
                None
            }
        }
    } else {
        None
    };

    info!(
        address = %runtime.address,
        network = if binance.is_testnet() {
            "testnet"
        } else {
            "mainnet"
        },
        "Fyxtez backend API started"
    );

    let server_result = axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown)
        .await
        .map_err(|error| AppError::Config(format!("server error: {error}")));

    let _ = browser_shutdown_tx.send(true);
    if let Some(task) = browser_server_task {
        match task.await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::warn!(%error, "Local browser listener stopped");
            }
            Err(error) => {
                tracing::warn!(%error, "Local browser listener task failed");
            }
        }
    }

    user_stream_task.abort();
    if let Some(task) = alert_worker_task {
        task.abort();
    }
    reference_data_task.abort();
    server_time_task.abort();
    registry_refresh_task.abort();
    icon_seed_task.abort();
    account_refresh_task.abort();
    position_risk_refresh_task.abort();
    server_result?;
    Ok(())
}

async fn wait_for_browser_shutdown(mut receiver: watch::Receiver<bool>) {
    while !*receiver.borrow_and_update() {
        if receiver.changed().await.is_err() {
            break;
        }
    }
}

fn load_sizing_config() -> AppResult<MarginSizingConfig> {
    let margin_pct = env_parse("SIZING_MARGIN_PCT", 0.01)?;
    let leverage_safety = env_parse("SIZING_LEVERAGE_SAFETY", 0.98)?;
    let max_leverage = env_parse("SIZING_MAX_LEVERAGE", 120_u32)?;

    MarginSizingConfig::new(margin_pct, leverage_safety, max_leverage).map_err(AppError::Config)
}

fn env_parse<T>(name: &str, default: T) -> AppResult<T>
where
    T: std::str::FromStr,
{
    match std::env::var(name) {
        Ok(value) => value
            .parse::<T>()
            .map_err(|_| AppError::Config(format!("{name} has an invalid value"))),
        Err(_) => Ok(default),
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler")
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {}
    }
}
