mod account_state;
mod alerts;
mod api;
mod binance;
mod binance_stream;
mod error;
mod icons;
mod models;
mod position_risk_state;
mod sizing_store;
mod symbol_registry;
mod trading_events;

use std::{net::SocketAddr, sync::Arc};

use account_state::{AccountState, spawn_refresh_worker};
use alerts::{AlertStore, spawn_alert_worker};
use api::{AppState, router};
use binance::BinanceClient;
use dotenvy::dotenv;
use error::{AppError, AppResult};
use icons::IconStore;
use models::MarginSizingConfig;
use position_risk_state::{
    PositionRiskState, spawn_refresh_worker as spawn_position_risk_refresh_worker,
};
use sizing_store::SizingStore;
use symbol_registry::{MarketDataSource, MarketKind, SymbolRegistry};
use tokio::{
    net::TcpListener,
    sync::{RwLock, broadcast},
};
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> AppResult<()> {
    dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let binance = BinanceClient::from_env()?;

    info!("Synchronizing Binance server time");
    binance.sync_server_time().await?;

    info!("Loading Binance exchange information and leverage brackets");
    binance.initialize_reference_data().await?;
    let reference_data_task = binance.spawn_reference_data_worker();

    let symbol_registry_path =
        std::env::var("SYMBOL_REGISTRY_PATH").unwrap_or_else(|_| "data/symbols.json".into());
    let symbol_registry = SymbolRegistry::load(symbol_registry_path).await?;

    let icon_cache_dir = std::env::var("ICON_CACHE_DIR").unwrap_or_else(|_| "data/icons".into());
    let icon_store = IconStore::load(icon_cache_dir).await?;

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
    // FIX: the previous ISOLATED startup call was disabled and depended on a
    // fixed BTC/ETH/SOL/XRP list, so dynamically registered contracts such as
    // TUT could remain in CROSS mode. Enforce the invariant from the persisted
    // registry itself and fail startup if any Binance-backed symbol cannot be
    // made ISOLATED. MEXC entries are market-data-only and are not Binance
    // trading symbols, so they are intentionally excluded.
    for entry in registered_symbols
        .iter()
        .filter(|entry| entry.data_source == MarketDataSource::Binance)
    {
        binance
            .ensure_isolated_margin(&entry.market_symbol)
            .await
            .map_err(|error| {
                AppError::Config(format!(
                    "cannot enforce ISOLATED margin for existing symbol {}: {error}",
                    entry.market_symbol
                ))
            })?;
    }

    // FIX: purge token images cached before market_kind existed. Stock tickers
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
            entry.data_source == MarketDataSource::Mexc
                && entry.market_kind == MarketKind::Crypto
        })
        .map(|entry| entry.symbol.clone())
        .collect();
    let registered_mexc_symbol_refs: Vec<&str> = registered_mexc_symbols
        .iter()
        .map(String::as_str)
        .collect();
    // FEATURE: self-heal MEXC symbols persisted by older builds that skipped
    // artwork entirely; the resolver no-ops cheaply when an icon is cached.
    info!(
        count = registered_mexc_symbol_refs.len(),
        "Backfilling icons for pre-existing MEXC symbols"
    );
    icon_store.seed_mexc(&registered_mexc_symbol_refs).await;

    let registered_binance_symbols: Vec<String> = registered_symbols
        .iter()
        // FIX: startup token-icon backfill applies only to actual crypto.
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
    let sizing_path =
        std::env::var("SIZING_CONFIG_PATH").unwrap_or_else(|_| "data/sizing.json".into());
    let sizing_store = SizingStore::new(sizing_path);
    let sizing = sizing_store.load(sizing_defaults).await?;

    info!("Loading initial Binance account snapshot");
    let initial_account = account_state::initialize(&binance).await?;
    let (account_state, account_refresh_rx) = AccountState::new(initial_account);
    let account_refresh_task =
        spawn_refresh_worker(binance.clone(), account_state.clone(), account_refresh_rx);

    info!("Loading initial Binance position-risk snapshot");
    let initial_position_risk = position_risk_state::initialize(&binance).await?;
    let (position_risk_state, position_risk_refresh_rx) =
        PositionRiskState::new(initial_position_risk);
    let position_risk_refresh_task = spawn_position_risk_refresh_worker(
        binance.clone(),
        position_risk_state.clone(),
        position_risk_refresh_rx,
    );

    let service_token = std::env::var("SERVICE_API_TOKEN")
        .map_err(|_| AppError::Config("SERVICE_API_TOKEN must be set".into()))?;

    if service_token.len() < 16 {
        return Err(AppError::Config(
            "SERVICE_API_TOKEN must contain at least 16 characters".into(),
        ));
    }

    let host = std::env::var("SERVER_HOST").unwrap_or_else(|_| "127.0.0.1".into());

    let port = std::env::var("SERVER_PORT")
        .unwrap_or_else(|_| "8657".into())
        .parse::<u16>()
        .map_err(|_| AppError::Config("SERVER_PORT must be a valid u16".into()))?;

    let address: SocketAddr = format!("{host}:{port}")
        .parse()
        .map_err(|_| AppError::Config("SERVER_HOST/SERVER_PORT form an invalid address".into()))?;

    let (trading_events, _) = broadcast::channel(512);

    let alerts_db_path =
        std::env::var("ALERTS_DB_PATH").unwrap_or_else(|_| "data/alerts.sqlite3".into());
    let alert_store = AlertStore::connect(&alerts_db_path).await?;
    let (alert_runtime, alert_worker_task) = spawn_alert_worker(
        alert_store.clone(),
        binance.user_stream_ws_base().to_string(),
        trading_events.clone(),
    );

    let state = AppState {
        binance: binance.clone(),
        account_state: account_state.clone(),
        position_risk_state: position_risk_state.clone(),
        sizing: Arc::new(RwLock::new(sizing)),
        sizing_store,
        service_token,
        trade_lock: Arc::new(tokio::sync::Mutex::new(())),
        trading_events: trading_events.clone(),
        alert_store,
        alert_runtime,
        symbol_registry,
        icon_store,
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
    );

    let listener = TcpListener::bind(address).await?;

    info!(
        %address,
        network = if binance.is_testnet() {
            "testnet"
        } else {
            "mainnet"
        },
        "Binance Futures Axum API started"
    );

    let server_result = axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|error| AppError::Config(format!("server error: {error}")));

    user_stream_task.abort();
    alert_worker_task.abort();
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
