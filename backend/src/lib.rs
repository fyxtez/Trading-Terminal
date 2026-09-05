mod account_state;
mod alerts;
mod api;
mod auto_market_workflow;
mod binance;
mod binance_stream;
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
mod trade_lock;
mod trading_events;

use std::{collections::HashMap, future::Future, sync::Arc};

use account_state::{AccountState, spawn_refresh_worker};
use alerts::{AlertRuntime, AlertStore, spawn_alert_worker};
use api::{AppState, router};
use binance::BinanceClient;
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
    sync::{RwLock, broadcast},
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
    let binance = BinanceClient::from_secure_store(runtime.use_secure_network)?;
    let diagnostics = DiagnosticsState::new(binance.is_configured());

    info!("Synchronizing Binance server time");
    binance.sync_server_time().await?;
    diagnostics.exchange_success();

    if binance.is_configured() {
        info!("Loading Binance exchange information and leverage brackets");
        binance.initialize_reference_data().await?;
    } else {
        info!("Binance credentials are not configured; loading public exchange information");
        binance.initialize_public_reference_data().await?;
    }
    let reference_data_task = binance.spawn_reference_data_worker();

    let symbol_registry = SymbolRegistry::load(&runtime.symbol_registry_path).await?;

    let icon_store = IconStore::load(&runtime.icon_cache_dir).await?;

    info!("Seeding default token icons");
    icon_store.seed(icons::DEFAULT_SEED_SYMBOLS).await;

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

    // purge token images cached before market_kind existed. Stock tickers
    // such as PLTR can collide with unrelated crypto tokens by symbol alone.
    for entry in registered_symbols
        .iter()
        .filter(|entry| entry.market_kind == MarketKind::Traditional)
    {
        if let Err(error) = icon_store.remove_misclassified(&entry.symbol).await {
            tracing::warn!(symbol = %entry.symbol, %error, "Failed to purge misclassified TradFi icon");
        }
    }

    let registered_tradfi_symbols: Vec<String> = registered_symbols
        .iter()
        .filter(|entry| entry.market_kind == MarketKind::Traditional)
        .map(|entry| entry.symbol.clone())
        .collect();
    let registered_tradfi_symbol_refs: Vec<&str> = registered_tradfi_symbols
        .iter()
        .map(String::as_str)
        .collect();
    info!(
        count = registered_tradfi_symbol_refs.len(),
        "Backfilling icons for pre-existing TradFi symbols"
    );
    icon_store.seed_tradfi(&registered_tradfi_symbol_refs).await;

    let registered_mexc_symbols: Vec<String> = registered_symbols
        .iter()
        .filter(|entry| {
            entry.data_source == MarketDataSource::Mexc && entry.market_kind == MarketKind::Crypto
        })
        .map(|entry| entry.symbol.clone())
        .collect();
    let registered_mexc_symbol_refs: Vec<&str> =
        registered_mexc_symbols.iter().map(String::as_str).collect();
    // self-heal MEXC symbols persisted by older builds that skipped
    // artwork entirely; the resolver no-ops cheaply when an icon is cached.
    info!(
        count = registered_mexc_symbol_refs.len(),
        "Backfilling icons for pre-existing MEXC symbols"
    );
    icon_store.seed_mexc(&registered_mexc_symbol_refs).await;

    let registered_binance_symbols: Vec<String> = registered_symbols
        .iter()
        // startup token-icon backfill applies only to actual crypto.
        .filter(|entry| {
            entry.data_source == MarketDataSource::Binance
                && entry.market_kind == MarketKind::Crypto
        })
        .map(|entry| entry.symbol.clone())
        .collect();
    let registered_binance_symbol_refs: Vec<&str> = registered_binance_symbols
        .iter()
        .map(String::as_str)
        .collect();

    info!(
        count = registered_binance_symbol_refs.len(),
        "Backfilling icons for pre-existing registered symbols"
    );
    icon_store.seed(&registered_binance_symbol_refs).await;

    let sizing_defaults = load_sizing_config()?;
    let sizing_store = SizingStore::new(&runtime.sizing_config_path);
    let sizing = sizing_store.load(sizing_defaults).await?;

    let initial_account = if binance.is_configured() {
        info!("Loading initial Binance account snapshot");
        match account_state::initialize(&binance).await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                // Account connectivity is allowed to be degraded at startup.
                // The authenticated REST routes still fail explicitly until
                // Binance recovers, while charts/settings and manual retry stay
                // available instead of crashing the complete local backend.
                diagnostics.exchange_failure(error.to_string());
                diagnostics.reconciliation_failure("account", error.to_string());
                tracing::warn!(
                    target: "api",
                    %error,
                    "Starting with an empty account cache until Binance reconnects"
                );
                FuturesAccountInfo {
                    total_wallet_balance: "0".into(),
                    available_balance: "0".into(),
                    assets: Vec::new(),
                    positions: Vec::new(),
                    extra: serde_json::json!({}),
                }
            }
        }
    } else {
        FuturesAccountInfo {
            total_wallet_balance: "0".into(),
            available_balance: "0".into(),
            assets: Vec::new(),
            positions: Vec::new(),
            extra: serde_json::json!({}),
        }
    };
    let (account_state, account_refresh_rx) = AccountState::new(initial_account);
    let account_refresh_task = spawn_refresh_worker(
        binance.clone(),
        account_state.clone(),
        account_refresh_rx,
        diagnostics.clone(),
    );

    let initial_position_risk = if binance.is_configured() {
        info!("Loading initial Binance position-risk snapshot");
        match position_risk_state::initialize(&binance).await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                diagnostics.exchange_failure(error.to_string());
                diagnostics.reconciliation_failure("position-risk", error.to_string());
                tracing::warn!(
                    target: "api",
                    %error,
                    "Starting with an empty position-risk cache until Binance reconnects"
                );
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
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

    user_stream_task.abort();
    if let Some(task) = alert_worker_task {
        task.abort();
    }
    reference_data_task.abort();
    account_refresh_task.abort();
    position_risk_refresh_task.abort();
    server_result?;
    Ok(())
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
