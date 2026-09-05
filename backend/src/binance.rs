use std::{
    collections::HashMap,
    sync::{
        Arc, RwLock as StdRwLock,
        atomic::{AtomicI64, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use hmac::{Hmac, Mac};
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde_json::Value;
use sha2::Sha256;
use tokio::sync::RwLock;
use tokio::time::Instant;
use url::form_urlencoded;
use zeroize::Zeroizing;

use crate::{
    error::{AppError, AppResult},
    models::{
        AlgoOrderResponse, BinanceOrderResponse, ExchangeInfo, FuturesAccountInfo, LeverageBracket,
        LeverageBracketSymbol, OrderSide, PriceResponse, SymbolFilters,
    },
    secure_store::{
        self, BINANCE_API_KEY, BINANCE_API_SECRET, BINANCE_NETWORK, PlatformSecretReader,
        SecretReader,
    },
};

const TESTNET_BASE: &str = "https://demo-fapi.binance.com";
const MAINNET_BASE: &str = "https://fapi.binance.com";
const RECV_WINDOW: &str = "10000";
const REFERENCE_DATA_REFRESH_INTERVAL: Duration = Duration::from_secs(3 * 24 * 60 * 60);

/// Binance's code for "the symbol is already in the requested margin
/// mode" - a true no-op, not a genuine rejection (see ensure_isolated_margin).
const MARGIN_TYPE_ALREADY_SET: i64 = -4046;

#[derive(Default)]
struct ReferenceDataCache {
    symbol_filters: HashMap<String, SymbolFilters>,
    max_leverage: HashMap<String, u32>,
    // Sorted ascending by notional_cap - see maintenance_margin_ratio()'s
    // lookup below, which relies on that ordering to find the first
    // bracket whose cap covers a given notional.
    maintenance_brackets: HashMap<String, Vec<LeverageBracket>>,
    refreshed_at: Option<Instant>,
}

#[derive(Clone)]
struct BinanceCredentials {
    api_key: Zeroizing<String>,
    api_secret: Zeroizing<String>,
}

#[derive(Clone)]
pub struct BinanceClient {
    http: reqwest::Client,
    base_url: String,
    credentials: Arc<StdRwLock<Option<BinanceCredentials>>>,
    credential_generation: Arc<AtomicU64>,
    testnet: bool,
    reference_data: Arc<RwLock<ReferenceDataCache>>,
    server_time_offset_ms: Arc<AtomicI64>,
}

impl BinanceClient {
    pub fn from_secure_store(desktop_sidecar: bool) -> AppResult<Self> {
        let (testnet, credentials) = if desktop_sidecar {
            load_desktop_configuration(&PlatformSecretReader)?
        } else {
            let testnet = env_bool("BINANCE_TESTNET", true)?;
            if !testnet && !env_bool("ALLOW_MAINNET", false)? {
                return Err(AppError::Config(
                    "Mainnet is blocked. Set BINANCE_TESTNET=false and ALLOW_MAINNET=true intentionally".into(),
                ));
            }
            (testnet, load_secure_credentials()?)
        };

        let base_url = if testnet { TESTNET_BASE } else { MAINNET_BASE };

        let http = reqwest::Client::builder()
            .user_agent("fyxtez-backend/0.1")
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .pool_idle_timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(10)
            .tcp_keepalive(Duration::from_secs(60))
            .tcp_nodelay(true)
            .build()?;

        Ok(Self {
            http,
            base_url: base_url.into(),
            credentials: Arc::new(StdRwLock::new(credentials)),
            credential_generation: Arc::new(AtomicU64::new(0)),
            testnet,
            reference_data: Arc::new(RwLock::new(ReferenceDataCache::default())),
            server_time_offset_ms: Arc::new(AtomicI64::new(0)),
        })
    }

    pub fn is_testnet(&self) -> bool {
        self.testnet
    }

    pub fn is_configured(&self) -> bool {
        self.credentials
            .read()
            .map(|credentials| credentials.is_some())
            .unwrap_or(false)
    }

    pub fn credential_generation(&self) -> u64 {
        self.credential_generation.load(Ordering::Acquire)
    }

    /// Testnet drill hook: emulate a badly skewed local clock and exercise the
    /// normal -1021 resynchronization path on the next signed request.
    #[cfg(feature = "testnet-drills")]
    pub(crate) fn force_time_drift_for_drill(&self, offset_ms: i64) -> AppResult<()> {
        if !self.testnet {
            return Err(AppError::Config(
                "testnet drill hooks refuse to run against Mainnet".into(),
            ));
        }
        self.server_time_offset_ms
            .store(offset_ms, Ordering::Relaxed);
        Ok(())
    }

    /// Testnet drill hook: invalidate the active user-stream credential
    /// generation. The production reconnect loop observes this change, closes
    /// its current socket and establishes a fresh stream with reconciliation.
    #[cfg(feature = "testnet-drills")]
    pub(crate) fn force_user_stream_reconnect_for_drill(&self) -> AppResult<()> {
        if !self.testnet {
            return Err(AppError::Config(
                "testnet drill hooks refuse to run against Mainnet".into(),
            ));
        }
        self.credential_generation.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }

    pub fn reload_secure_credentials(&self) -> AppResult<bool> {
        let next = load_secure_credentials()?;
        let mut current = self
            .credentials
            .write()
            .map_err(|_| AppError::Config("Binance credential lock is poisoned".into()))?;

        let changed = match (current.as_ref(), next.as_ref()) {
            (Some(current), Some(next)) => {
                current.api_key.as_str() != next.api_key.as_str()
                    || current.api_secret.as_str() != next.api_secret.as_str()
            }
            (None, None) => false,
            _ => true,
        };

        if changed {
            *current = next;
            self.credential_generation.fetch_add(1, Ordering::AcqRel);
        }

        Ok(changed)
    }

    pub(crate) fn user_stream_rest_base(&self) -> &str {
        &self.base_url
    }

    pub(crate) fn user_stream_ws_base(&self) -> &'static str {
        if self.testnet {
            "wss://fstream.binancefuture.com"
        } else {
            "wss://fstream.binance.com"
        }
    }

    pub(crate) fn user_stream_api_key(&self) -> AppResult<Zeroizing<String>> {
        Ok(self.credentials()?.api_key)
    }

    /// Reuse the client that already performed the startup time/reference
    /// requests. In particular, repeatedly creating a fresh TLS/DNS pool on
    /// Android made a temporary network failure snowball into a permanently
    /// degraded user stream.
    pub(crate) fn http_client(&self) -> &reqwest::Client {
        &self.http
    }

    pub async fn server_time(&self) -> AppResult<Value> {
        self.public(Method::GET, "/fapi/v1/time", Vec::new()).await
    }

    /// Synchronize signed-request timestamps with Binance's clock.
    ///
    /// The midpoint between the local send/receive timestamps reduces the
    /// effect of request latency when calculating the offset.
    pub async fn sync_server_time(&self) -> AppResult<()> {
        let local_before = timestamp_ms_i64()?;
        let response = self.server_time().await?;
        let local_after = timestamp_ms_i64()?;

        let server_time = response
            .get("serverTime")
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                AppError::Invalid("Binance server-time response did not contain serverTime".into())
            })?;

        let local_midpoint = local_before + (local_after - local_before) / 2;
        let offset = server_time - local_midpoint;

        self.server_time_offset_ms.store(offset, Ordering::Relaxed);

        tracing::info!(
            target: "api",
            offset_ms = offset,
            "Synchronized Binance server time"
        );

        Ok(())
    }

    fn signed_timestamp_ms(&self) -> AppResult<i64> {
        timestamp_ms_i64()?
            .checked_add(self.server_time_offset_ms.load(Ordering::Relaxed))
            .ok_or_else(|| AppError::Config("Binance timestamp overflow".into()))
    }

    pub async fn account_info(&self) -> AppResult<FuturesAccountInfo> {
        self.signed(Method::GET, "/fapi/v3/account", Vec::new())
            .await
    }

    pub async fn position_risk(&self) -> AppResult<Vec<Value>> {
        self.signed(Method::GET, "/fapi/v3/positionRisk", Vec::new())
            .await
    }

    /// Fetch the exchange-configured leverage for one symbol.
    ///
    /// Position Information V3 only returns symbols that currently have a
    /// position or an open order. That makes it unsuitable for reading the
    /// remembered leverage of a flat symbol. V2 still returns the requested
    /// symbol while flat, including its configured leverage.
    pub async fn current_leverage(&self, symbol: &str) -> AppResult<u32> {
        let symbol = normalize_symbol(symbol)?;
        let risks: Vec<Value> = self
            .signed(
                Method::GET,
                "/fapi/v2/positionRisk",
                vec![("symbol".into(), symbol.clone())],
            )
            .await?;

        // In one-way mode Binance returns positionSide=BOTH. In hedge mode it
        // can return LONG/SHORT entries, but leverage is shared for the symbol,
        // so matching the symbol alone is the correct and mode-independent rule.
        let risk = risks
            .into_iter()
            .find(|risk| risk.get("symbol").and_then(Value::as_str) == Some(symbol.as_str()))
            .ok_or_else(|| {
                AppError::Invalid(format!(
                    "Binance did not return V2 position risk for {symbol}"
                ))
            })?;

        let raw = risk
            .get("leverage")
            .ok_or_else(|| AppError::Invalid(format!("missing leverage for {symbol}")))?;

        if let Some(value) = raw.as_u64() {
            return u32::try_from(value)
                .map_err(|_| AppError::Invalid(format!("invalid leverage for {symbol}")));
        }

        raw.as_str()
            .ok_or_else(|| AppError::Invalid(format!("invalid leverage for {symbol}")))?
            .parse::<u32>()
            .map_err(|_| AppError::Invalid(format!("invalid leverage for {symbol}")))
    }

    pub async fn price(&self, symbol: &str) -> AppResult<f64> {
        let symbol = normalize_symbol(symbol)?;
        let response: PriceResponse = self
            .public(
                Method::GET,
                "/fapi/v2/ticker/price",
                vec![("symbol".into(), symbol)],
            )
            .await?;
        parse_f64("price", &response.price)
    }

    pub async fn initialize_reference_data(&self) -> AppResult<()> {
        self.refresh_reference_data().await
    }

    pub async fn initialize_public_reference_data(&self) -> AppResult<()> {
        let exchange_info = self
            .public::<ExchangeInfo>(Method::GET, "/fapi/v1/exchangeInfo", Vec::new())
            .await?;
        let filters = parse_exchange_filters(exchange_info)?;

        if filters.is_empty() {
            return Err(AppError::Invalid(
                "Binance exchangeInfo produced an empty symbol-filter cache".into(),
            ));
        }

        let filter_count = filters.len();
        *self.reference_data.write().await = ReferenceDataCache {
            symbol_filters: filters,
            refreshed_at: Some(Instant::now()),
            ..ReferenceDataCache::default()
        };

        tracing::info!(
            target: "api",
            filter_count,
            "Binance public reference-data cache refreshed"
        );
        Ok(())
    }

    pub fn spawn_reference_data_worker(&self) -> tokio::task::JoinHandle<()> {
        let client = self.clone();

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(REFERENCE_DATA_REFRESH_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

            // The initial cache load is performed synchronously during startup.
            // Consume the immediate first interval tick, then wait three days.
            interval.tick().await;

            loop {
                interval.tick().await;

                let result = if client.is_configured() {
                    client.refresh_reference_data().await
                } else {
                    client.initialize_public_reference_data().await
                };

                if let Err(error) = result {
                    tracing::error!(
                        target: "api",
                        %error,
                        "Failed to refresh Binance reference-data caches; keeping previous data"
                    );
                }
            }
        })
    }

    pub async fn refresh_reference_data(&self) -> AppResult<()> {
        let exchange_info_request =
            self.public::<ExchangeInfo>(Method::GET, "/fapi/v1/exchangeInfo", Vec::new());
        let leverage_brackets_request = self.signed::<Vec<LeverageBracketSymbol>>(
            Method::GET,
            "/fapi/v1/leverageBracket",
            Vec::new(),
        );

        let (exchange_info, leverage_brackets) =
            tokio::try_join!(exchange_info_request, leverage_brackets_request,)?;

        let filters = parse_exchange_filters(exchange_info)?;
        let (leverage, maintenance_brackets) =
            parse_leverage_and_maintenance_data(leverage_brackets);

        if filters.is_empty() {
            return Err(AppError::Invalid(
                "Binance exchangeInfo produced an empty symbol-filter cache".into(),
            ));
        }

        if leverage.is_empty() {
            return Err(AppError::Invalid(
                "Binance leverageBracket produced an empty leverage cache".into(),
            ));
        }

        let filter_count = filters.len();
        let leverage_count = leverage.len();

        // Build both maps first, then atomically replace the complete live snapshot.
        *self.reference_data.write().await = ReferenceDataCache {
            symbol_filters: filters,
            max_leverage: leverage,
            maintenance_brackets,
            refreshed_at: Some(Instant::now()),
        };

        tracing::info!(
            target: "api",
            filter_count,
            leverage_count,
            "Binance reference-data caches refreshed"
        );

        Ok(())
    }

    pub async fn ensure_reference_data_fresh(&self) -> AppResult<()> {
        const MAX_REFERENCE_DATA_AGE: Duration = Duration::from_secs(4 * 24 * 60 * 60);
        let fresh = self
            .reference_data
            .read()
            .await
            .refreshed_at
            .is_some_and(|refreshed_at| refreshed_at.elapsed() <= MAX_REFERENCE_DATA_AGE);
        if fresh {
            return Ok(());
        }

        // Exposure increases fail closed if an overdue cache cannot be
        // refreshed. Reduction/close paths deliberately do not use this guard.
        self.refresh_reference_data().await
    }

    pub async fn symbol_filters(&self, symbol: &str) -> AppResult<SymbolFilters> {
        let symbol = normalize_symbol(symbol)?;

        self.reference_data
            .read()
            .await
            .symbol_filters
            .get(&symbol)
            .cloned()
            .ok_or_else(|| {
                AppError::Invalid(format!(
                    "symbol filters for {symbol} are not available in the Binance cache"
                ))
            })
    }

    pub async fn max_leverage(&self, symbol: &str) -> AppResult<u32> {
        let symbol = normalize_symbol(symbol)?;

        self.reference_data
            .read()
            .await
            .max_leverage
            .get(&symbol)
            .copied()
            .ok_or_else(|| {
                AppError::Invalid(format!(
                    "maximum leverage for {symbol} is not available in the Binance cache"
                ))
            })
    }

    /// Maintenance margin ratio for the bracket that `notional` (USDT)
    /// falls into for `symbol`. Falls back to the highest-notional
    /// bracket if `notional` exceeds every known cap, matching Binance's
    /// own behavior (the last bracket's cap is effectively unbounded).
    ///
    /// This is what `build_auto_size_with_margin_pct` (api.rs) uses to
    /// keep an auto-market stop-loss strictly inside the actual
    /// liquidation distance instead of past it - see the comment on
    /// `theoretical_max_leverage` there for the full explanation.
    /// returns the complete maintenance-margin terms for a notional.
    /// `cum` matters when projecting liquidation; using only the ratio can move
    /// the displayed boundary noticeably on larger Binance bracket tiers.
    pub async fn maintenance_margin_terms(
        &self,
        symbol: &str,
        notional: f64,
    ) -> AppResult<(f64, f64)> {
        let symbol = normalize_symbol(symbol)?;

        let cache = self.reference_data.read().await;
        let brackets = cache.maintenance_brackets.get(&symbol).ok_or_else(|| {
            AppError::Invalid(format!(
                "maintenance margin brackets for {symbol} are not available in the Binance cache"
            ))
        })?;

        let bracket = brackets
            .iter()
            .find(|bracket| notional <= bracket.notional_cap)
            .or_else(|| brackets.last())
            .ok_or_else(|| {
                AppError::Invalid(format!("no maintenance margin brackets found for {symbol}"))
            })?;

        Ok((bracket.maint_margin_ratio, bracket.cum))
    }

    pub async fn maintenance_margin_ratio(&self, symbol: &str, notional: f64) -> AppResult<f64> {
        let symbol = normalize_symbol(symbol)?;

        let cache = self.reference_data.read().await;
        let brackets = cache.maintenance_brackets.get(&symbol).ok_or_else(|| {
            AppError::Invalid(format!(
                "maintenance margin brackets for {symbol} are not available in the Binance cache"
            ))
        })?;

        let bracket = brackets
            .iter()
            .find(|bracket| notional <= bracket.notional_cap)
            .or_else(|| brackets.last())
            .ok_or_else(|| {
                AppError::Invalid(format!("no maintenance margin brackets found for {symbol}"))
            })?;

        Ok(bracket.maint_margin_ratio)
    }

    pub async fn set_leverage(&self, symbol: &str, leverage: u32) -> AppResult<Value> {
        if leverage == 0 || leverage > 125 {
            return Err(AppError::Invalid("leverage must be in 1..=125".into()));
        }
        self.signed(
            Method::POST,
            "/fapi/v1/leverage",
            vec![
                ("symbol".into(), normalize_symbol(symbol)?),
                ("leverage".into(), leverage.to_string()),
            ],
        )
        .await
    }

    /// Sets a symbol's margin mode (ISOLATED or CROSSED) via Binance's
    /// `/fapi/v1/marginType`. Kept private so callers cannot accidentally
    /// request CROSSED; the public guard below exposes only ISOLATED.
    async fn set_margin_type(&self, symbol: &str, margin_type: &str) -> AppResult<Value> {
        if !matches!(margin_type, "ISOLATED" | "CROSSED") {
            return Err(AppError::Invalid(
                "margin_type must be ISOLATED or CROSSED".into(),
            ));
        }
        self.signed(
            Method::POST,
            "/fapi/v1/marginType",
            vec![
                ("symbol".into(), normalize_symbol(symbol)?),
                ("marginType".into(), margin_type.into()),
            ],
        )
        .await
    }

    /// read the exchange's current margin mode before trying to change
    /// it. Calling `/marginType` unconditionally while a position or open
    /// order exists can be rejected even when the symbol is already ISOLATED,
    /// which previously made legitimate ADD orders fail.
    async fn current_margin_type(&self, symbol: &str) -> AppResult<String> {
        let symbol = normalize_symbol(symbol)?;
        let risks: Vec<Value> = self
            .signed(
                Method::GET,
                "/fapi/v2/positionRisk",
                vec![("symbol".into(), symbol.clone())],
            )
            .await?;

        let margin_type = risks
            .iter()
            .find(|risk| risk.get("symbol").and_then(Value::as_str) == Some(symbol.as_str()))
            .and_then(|risk| risk.get("marginType"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::Invalid(format!("Binance did not return marginType for {symbol}"))
            })?
            .to_ascii_uppercase();

        if !matches!(margin_type.as_str(), "ISOLATED" | "CROSS" | "CROSSED") {
            return Err(AppError::Invalid(format!(
                "Binance returned unsupported marginType {margin_type} for {symbol}"
            )));
        }

        Ok(margin_type)
    }

    /// enforce ISOLATED for one dynamically registered Binance symbol.
    /// The old startup-only helper iterated a fixed four-symbol array and was
    /// disabled, which left TUT and every newly added contract free to trade in
    /// CROSS mode. This guard is deliberately safe to call at startup, during
    /// symbol registration, and immediately before exposure-increasing orders.
    /// Binance code -4046 means the symbol is already ISOLATED and is success;
    /// every other rejection blocks trading instead of silently risking the
    /// entire futures wallet.
    pub async fn ensure_isolated_margin(&self, symbol: &str) -> AppResult<()> {
        let symbol = normalize_symbol(symbol)?;

        // treat the read-back value as the source of truth. An already
        // isolated symbol needs no mutation, so ADD can proceed while its
        // position and protective TP/SL orders remain open. CROSS symbols
        // still go through Binance's change endpoint and fail closed when an
        // existing position/order makes a safe conversion impossible.
        if self.current_margin_type(&symbol).await? == "ISOLATED" {
            tracing::debug!(%symbol, "Margin mode already ISOLATED");
            return Ok(());
        }

        match self.set_margin_type(&symbol, "ISOLATED").await {
            Ok(_) => {
                tracing::info!(%symbol, "Margin mode set to ISOLATED");
                Ok(())
            }
            Err(AppError::Binance { code, .. }) if code == MARGIN_TYPE_ALREADY_SET => {
                tracing::debug!(%symbol, "Margin mode already ISOLATED");
                Ok(())
            }
            Err(AppError::Binance { code, message }) => Err(AppError::Invalid(format!(
                "ISOLATED margin is required for {symbol}; Binance rejected the margin-mode change ({code}: {message}). Close any CROSS position and cancel its open orders, then retry"
            ))),
            Err(error) => Err(error),
        }
    }

    pub async fn market_order(
        &self,
        symbol: &str,
        side: OrderSide,
        quantity: f64,
        reduce_only: bool,
        client_order_id: Option<&str>,
    ) -> AppResult<BinanceOrderResponse> {
        validate_positive("quantity", quantity)?;
        let mut params = vec![
            ("symbol".into(), normalize_symbol(symbol)?),
            ("side".into(), side.as_str().into()),
            ("type".into(), "MARKET".into()),
            ("quantity".into(), decimal(quantity)),
            ("newOrderRespType".into(), "RESULT".into()),
        ];
        append_reduce_only(&mut params, reduce_only);
        if let Some(id) = client_order_id {
            params.push(("newClientOrderId".into(), validate_id(id)?));
        }
        self.signed(Method::POST, "/fapi/v1/order", params).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn limit_order(
        &self,
        symbol: &str,
        side: OrderSide,
        quantity: f64,
        price: f64,
        time_in_force: &str,
        reduce_only: bool,
        client_order_id: Option<&str>,
    ) -> AppResult<BinanceOrderResponse> {
        validate_positive("quantity", quantity)?;
        validate_positive("price", price)?;
        let tif = time_in_force.trim().to_ascii_uppercase();
        if !matches!(tif.as_str(), "GTC" | "IOC" | "FOK" | "GTX") {
            return Err(AppError::Invalid(
                "time_in_force must be GTC, IOC, FOK, or GTX".into(),
            ));
        }
        let mut params = vec![
            ("symbol".into(), normalize_symbol(symbol)?),
            ("side".into(), side.as_str().into()),
            ("type".into(), "LIMIT".into()),
            ("quantity".into(), decimal(quantity)),
            ("price".into(), decimal(price)),
            ("timeInForce".into(), tif),
            ("newOrderRespType".into(), "RESULT".into()),
        ];
        append_reduce_only(&mut params, reduce_only);
        if let Some(id) = client_order_id {
            params.push(("newClientOrderId".into(), validate_id(id)?));
        }
        self.signed(Method::POST, "/fapi/v1/order", params).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn conditional_order(
        &self,
        symbol: &str,
        side: OrderSide,
        order_type: &str,
        trigger_price: f64,
        quantity: Option<f64>,
        close_position: bool,
        working_type: &str,
        client_algo_id: Option<&str>,
    ) -> AppResult<AlgoOrderResponse> {
        validate_positive("trigger_price", trigger_price)?;
        validate_conditional_quantity_shape(quantity, close_position)?;
        let working_type = working_type.trim().to_ascii_uppercase();
        if !matches!(working_type.as_str(), "MARK_PRICE" | "CONTRACT_PRICE") {
            return Err(AppError::Invalid(
                "working_type must be MARK_PRICE or CONTRACT_PRICE".into(),
            ));
        }
        let mut params = vec![
            ("algoType".into(), "CONDITIONAL".into()),
            ("symbol".into(), normalize_symbol(symbol)?),
            ("side".into(), side.as_str().into()),
            ("type".into(), order_type.into()),
            ("triggerPrice".into(), decimal(trigger_price)),
            ("workingType".into(), working_type),
        ];
        if close_position {
            params.push(("closePosition".into(), "true".into()));
        }
        if let Some(qty) = quantity {
            validate_positive("quantity", qty)?;
            params.push(("quantity".into(), decimal(qty)));
        }
        if let Some(id) = client_algo_id {
            params.push(("clientAlgoId".into(), validate_id(id)?));
        }
        self.signed(Method::POST, "/fapi/v1/algoOrder", params)
            .await
    }

    /// Resolve an ambiguous conditional-order submission by the stable client
    /// identifier that was chosen before the POST was sent. A transport error
    /// does not prove that Binance rejected the order, so callers must query
    /// before compensating or retrying the mutation.
    pub async fn query_algo_order_by_client_id(
        &self,
        client_algo_id: &str,
    ) -> AppResult<AlgoOrderResponse> {
        self.signed(
            Method::GET,
            "/fapi/v1/algoOrder",
            vec![("clientAlgoId".into(), validate_id(client_algo_id)?)],
        )
        .await
    }

    pub async fn cancel_algo_order(&self, symbol: &str, algo_id: i64) -> AppResult<Value> {
        if algo_id <= 0 {
            return Err(AppError::Invalid("algo_id must be > 0".into()));
        }

        self.signed(
            Method::DELETE,
            "/fapi/v1/algoOrder",
            vec![
                ("symbol".into(), normalize_symbol(symbol)?),
                ("algoId".into(), algo_id.to_string()),
            ],
        )
        .await
    }

    pub async fn cancel_algo_order_by_client_id(
        &self,
        symbol: &str,
        client_algo_id: &str,
    ) -> AppResult<Value> {
        self.signed(
            Method::DELETE,
            "/fapi/v1/algoOrder",
            vec![
                ("symbol".into(), normalize_symbol(symbol)?),
                ("clientAlgoId".into(), validate_id(client_algo_id)?),
            ],
        )
        .await
    }

    pub async fn modify_limit_order(
        &self,
        symbol: &str,
        order_id: i64,
        side: OrderSide,
        quantity: f64,
        price: f64,
        time_in_force: &str,
    ) -> AppResult<BinanceOrderResponse> {
        validate_positive("quantity", quantity)?;
        validate_positive("price", price)?;

        if order_id <= 0 {
            return Err(AppError::Invalid("order_id must be > 0".into()));
        }

        // PUT /fapi/v1/order (Modify Order) does NOT accept a
        // timeInForce parameter at all - per Binance's own docs its
        // parameter list is orderId/origClientOrderId, symbol, side,
        // quantity, price, priceMatch, recvWindow, timestamp. The
        // original order's time-in-force can't be changed by a modify
        // call anyway; Binance just keeps whatever it was set to when
        // the order was first placed. This used to send timeInForce as
        // a real request parameter on every single modify call, which
        // Binance rejected outright (surfaced here as a 422 "Binance API
        // error", regardless of what price/quantity was being sent) -
        // every attempt to drag a limit/TP order to a new price was
        // failing for this reason, not because of anything
        // price-specific. `time_in_force` is still accepted and
        // validated as an input here (harmless, and callers already pass
        // it through from the original order's own drawing metadata),
        // it's just no longer forwarded to Binance.
        let tif = time_in_force.trim().to_ascii_uppercase();
        if !matches!(tif.as_str(), "GTC" | "IOC" | "FOK" | "GTX") {
            return Err(AppError::Invalid(
                "time_in_force must be GTC, IOC, FOK, or GTX".into(),
            ));
        }

        self.signed(
            Method::PUT,
            "/fapi/v1/order",
            vec![
                ("symbol".into(), normalize_symbol(symbol)?),
                ("orderId".into(), order_id.to_string()),
                ("side".into(), side.as_str().into()),
                ("quantity".into(), decimal(quantity)),
                ("price".into(), decimal(price)),
            ],
        )
        .await
    }

    pub async fn query_order(&self, symbol: &str, order_id: i64) -> AppResult<Value> {
        self.signed(
            Method::GET,
            "/fapi/v1/order",
            vec![
                ("symbol".into(), normalize_symbol(symbol)?),
                ("orderId".into(), order_id.to_string()),
            ],
        )
        .await
    }

    pub async fn query_order_by_client_id(
        &self,
        symbol: &str,
        client_order_id: &str,
    ) -> AppResult<BinanceOrderResponse> {
        self.signed(
            Method::GET,
            "/fapi/v1/order",
            vec![
                ("symbol".into(), normalize_symbol(symbol)?),
                ("origClientOrderId".into(), validate_id(client_order_id)?),
            ],
        )
        .await
    }

    pub async fn cancel_order(&self, symbol: &str, order_id: i64) -> AppResult<Value> {
        self.signed(
            Method::DELETE,
            "/fapi/v1/order",
            vec![
                ("symbol".into(), normalize_symbol(symbol)?),
                ("orderId".into(), order_id.to_string()),
            ],
        )
        .await
    }

    pub async fn open_orders(&self, symbol: &str) -> AppResult<Value> {
        self.signed(
            Method::GET,
            "/fapi/v1/openOrders",
            vec![("symbol".into(), normalize_symbol(symbol)?)],
        )
        .await
    }

    pub async fn all_open_orders(&self) -> AppResult<Value> {
        self.signed(Method::GET, "/fapi/v1/openOrders", Vec::new())
            .await
    }

    /// current-position realized PNL is only available on individual
    /// fills, not account/positionRisk snapshots. Fetch the newest 1000 fills
    /// from Binance's default seven-day window for lifecycle reconstruction.
    pub async fn user_trades(&self, symbol: &str) -> AppResult<Vec<Value>> {
        self.signed(
            Method::GET,
            "/fapi/v1/userTrades",
            vec![
                ("symbol".into(), normalize_symbol(symbol)?),
                ("limit".into(), "1000".into()),
            ],
        )
        .await
    }

    pub async fn cancel_all_orders(&self, symbol: &str) -> AppResult<Value> {
        self.signed(
            Method::DELETE,
            "/fapi/v1/allOpenOrders",
            vec![("symbol".into(), normalize_symbol(symbol)?)],
        )
        .await
    }

    async fn public<T: DeserializeOwned>(
        &self,
        method: Method,
        endpoint: &str,
        params: Vec<(String, String)>,
    ) -> AppResult<T> {
        let query = encode(&params);
        let url = if query.is_empty() {
            format!("{}{}", self.base_url, endpoint)
        } else {
            format!("{}{}?{}", self.base_url, endpoint, query)
        };
        let response = self.http.request(method, url).send().await?;
        parse_response(response).await
    }

    async fn signed<T: DeserializeOwned>(
        &self,
        method: Method,
        endpoint: &str,
        params: Vec<(String, String)>,
    ) -> AppResult<T> {
        match self
            .signed_once(method.clone(), endpoint, params.clone())
            .await
        {
            Err(AppError::Binance { code: -1021, .. }) => {
                tracing::warn!(
                    target: "api",
                    endpoint,
                    "Binance rejected request timestamp; resynchronizing time"
                );

                self.sync_server_time().await?;
                self.signed_once(method, endpoint, params).await
            }
            result => result,
        }
    }

    async fn signed_once<T: DeserializeOwned>(
        &self,
        method: Method,
        endpoint: &str,
        mut params: Vec<(String, String)>,
    ) -> AppResult<T> {
        let credentials = self.credentials()?;
        params.push(("recvWindow".into(), RECV_WINDOW.into()));
        params.push(("timestamp".into(), self.signed_timestamp_ms()?.to_string()));

        let query = encode(&params);
        let signature = sign(&query, &credentials.api_secret)?;
        let url = format!(
            "{}{}?{}&signature={}",
            self.base_url, endpoint, query, signature
        );

        let response = self
            .http
            .request(method, url)
            .header("X-MBX-APIKEY", credentials.api_key.as_str())
            .send()
            .await?;

        parse_response(response).await
    }

    fn credentials(&self) -> AppResult<BinanceCredentials> {
        self.credentials
            .read()
            .map_err(|_| AppError::Config("Binance credential lock is poisoned".into()))?
            .clone()
            .ok_or_else(|| {
                AppError::Config(
                    "Binance is not connected. Configure it in desktop Settings.".into(),
                )
            })
    }
}

fn load_secure_network_from<R: SecretReader>(reader: &R) -> AppResult<Option<String>> {
    let network = reader.read(BINANCE_NETWORK).map_err(AppError::Config)?;
    match network.as_ref().map(|value| value.as_str().trim()) {
        Some("mainnet") => Ok(Some("mainnet".into())),
        Some("testnet") => Ok(Some("testnet".into())),
        Some(_) => Err(AppError::Config(
            "stored Binance network is invalid; trading is blocked until Settings replaces or clears the complete connection"
                .into(),
        )),
        None => Ok(None),
    }
}

fn load_secure_credentials() -> AppResult<Option<BinanceCredentials>> {
    load_secure_credentials_from(&PlatformSecretReader)
}

fn load_secure_credentials_from<R: SecretReader>(
    reader: &R,
) -> AppResult<Option<BinanceCredentials>> {
    secure_store::read_pair_from(reader, BINANCE_API_KEY, BINANCE_API_SECRET)
        .map(|pair| {
            pair.map(|(api_key, api_secret)| BinanceCredentials {
                api_key,
                api_secret,
            })
        })
        .map_err(AppError::Config)
}

fn load_desktop_configuration<R: SecretReader>(
    reader: &R,
) -> AppResult<(bool, Option<BinanceCredentials>)> {
    let network = load_secure_network_from(reader)?;
    let api_key = reader.read(BINANCE_API_KEY).map_err(AppError::Config)?;
    let api_secret = reader.read(BINANCE_API_SECRET).map_err(AppError::Config)?;

    match (network.as_deref(), api_key, api_secret) {
        (None, None, None) => Ok((true, None)),
        (Some("testnet"), Some(api_key), Some(api_secret)) => Ok((
            true,
            Some(BinanceCredentials {
                api_key,
                api_secret,
            }),
        )),
        (Some("mainnet"), Some(api_key), Some(api_secret)) => Ok((
            false,
            Some(BinanceCredentials {
                api_key,
                api_secret,
            }),
        )),
        _ => Err(AppError::Config(
            "stored Binance connection is incomplete; trading is blocked until Settings replaces or clears the complete key, secret and network set"
                .into(),
        )),
    }
}

async fn parse_response<T: DeserializeOwned>(response: reqwest::Response) -> AppResult<T> {
    let status = response.status();
    let text = response.text().await?;
    if !status.is_success() {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            let code = value
                .get("code")
                .and_then(Value::as_i64)
                .unwrap_or(status.as_u16() as i64);
            let message = value
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or(&text)
                .to_string();
            return Err(AppError::Binance { code, message });
        }
        return Err(AppError::Binance {
            code: status.as_u16() as i64,
            message: text,
        });
    }
    Ok(serde_json::from_str(&text)?)
}

fn parse_exchange_filters(info: ExchangeInfo) -> AppResult<HashMap<String, SymbolFilters>> {
    let mut result = HashMap::with_capacity(info.symbols.len());

    for item in info.symbols {
        if item.status != "TRADING" {
            continue;
        }

        let mut step_size = None;
        let mut min_qty = None;
        let mut min_notional = None;
        let mut tick_size = None;

        for filter in item.filters {
            match filter.filter_type.as_str() {
                "LOT_SIZE" => {
                    step_size = filter
                        .step_size
                        .as_deref()
                        .map(|value| parse_f64("stepSize", value))
                        .transpose()?;
                    min_qty = filter
                        .min_qty
                        .as_deref()
                        .map(|value| parse_f64("minQty", value))
                        .transpose()?;
                }
                "PRICE_FILTER" => {
                    tick_size = filter
                        .tick_size
                        .as_deref()
                        .map(|value| parse_f64("tickSize", value))
                        .transpose()?;
                }
                "MIN_NOTIONAL" => {
                    let raw = filter.notional.or(filter.min_notional);
                    min_notional = raw
                        .as_deref()
                        .map(|value| parse_f64("notional", value))
                        .transpose()?;
                }
                _ => {}
            }
        }

        let filters = SymbolFilters {
            step_size: step_size.ok_or_else(|| {
                AppError::Invalid(format!("{}.LOT_SIZE.stepSize missing", item.symbol))
            })?,
            min_qty: min_qty.ok_or_else(|| {
                AppError::Invalid(format!("{}.LOT_SIZE.minQty missing", item.symbol))
            })?,
            min_notional: min_notional.unwrap_or(0.0),
            tick_size: tick_size.ok_or_else(|| {
                AppError::Invalid(format!("{}.PRICE_FILTER.tickSize missing", item.symbol))
            })?,
        };

        result.insert(item.symbol, filters);
    }

    Ok(result)
}

/// Builds both the plain "max leverage per symbol" map this codebase
/// already had, and a new "sorted maintenance-margin brackets per symbol"
/// map, from a single pass over the same `/fapi/v1/leverageBracket`
/// response - so nothing needs to be fetched twice or cloned.
///
/// this replaces the old `parse_max_leverage`, which discarded
/// `notionalCap`/`maintMarginRatio` from each bracket entirely. See the
/// comment on `LeverageBracket` in models.rs and on
/// `theoretical_max_leverage` in api.rs for why that mattered.
fn parse_leverage_and_maintenance_data(
    response: Vec<LeverageBracketSymbol>,
) -> (HashMap<String, u32>, HashMap<String, Vec<LeverageBracket>>) {
    let mut max_leverage = HashMap::with_capacity(response.len());
    let mut maintenance_brackets = HashMap::with_capacity(response.len());

    for item in response {
        let Some(maximum) = item
            .brackets
            .iter()
            .map(|bracket| bracket.initial_leverage)
            .max()
        else {
            continue;
        };

        let mut brackets = item.brackets;
        // Ascending by notional_cap so maintenance_margin_ratio()'s lookup
        // can find the first bracket whose cap covers a given notional.
        brackets.sort_by(|left, right| {
            left.notional_cap
                .partial_cmp(&right.notional_cap)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        max_leverage.insert(item.symbol.clone(), maximum);
        maintenance_brackets.insert(item.symbol, brackets);
    }

    (max_leverage, maintenance_brackets)
}

pub(crate) fn normalize_symbol(raw: &str) -> AppResult<String> {
    let symbol = raw.trim().to_ascii_uppercase().replace(['/', '-', '_'], "");
    // Binance has valid one-character base assets such as QUSDT. The old
    // six-character minimum rejected them and aborted startup while enforcing
    // ISOLATED margin; five still rejects a bare quote asset such as "USDT".
    if symbol.len() < 5 || !symbol.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(AppError::Invalid(format!("invalid symbol: {raw}")));
    }
    Ok(symbol)
}

/*
 * Rejects any symbol outside SUPPORTED_SYMBOLS - the "we only trade these
 * 3 symbols, full stop" guarantee the user asked for.
 *
 * Deliberately NOT folded into normalize_symbol above: that function is
 * used by every Binance-facing call in this file, including the ones
 * that CLOSE or CANCEL existing exposure (cancel_order, cancel_all_orders,
 * close_position/close_everything's underlying market_order call,
 * conditional_order for stop-loss/take-profit, etc.). If the account ever
 * ends up holding a position in a symbol outside this whitelist - a
 * leftover from before this app existed, or opened manually on Binance
 * directly - the panic-button "close everything" endpoint (and ordinary
 * SL/TP/reduce management of that position) must still work for it.
 * Blocking normalize_symbol universally would make an unsupported-symbol
 * position permanently un-closeable through this app, which is the
 * opposite of "protecting funds".
 *
 * This check is instead called explicitly, only at the handlers in
 * api.rs that can open NEW exposure to a symbol (market/limit entries,
 * the auto-market endpoint and the ADD arm of position_intent -
 * see the call sites for the full reasoning per-endpoint). Every reduce/
 * close/cancel/query path is intentionally left unrestricted.
 */
// #[allow(dead_code)] // Superseded by SymbolRegistry checks; retained for fixed-list deployments.
// pub(crate) fn ensure_supported_symbol(symbol: &str) -> AppResult<()> {
//     if !SUPPORTED_SYMBOLS.contains(&symbol) {
//         return Err(AppError::Invalid(format!(
//             "unsupported symbol: {symbol} (this app only opens new positions in {})",
//             SUPPORTED_SYMBOLS.join(", ")
//         )));
//     }
//     Ok(())
// }

fn validate_positive(name: &str, value: f64) -> AppResult<()> {
    if !value.is_finite() || value <= 0.0 {
        return Err(AppError::Invalid(format!("{name} must be finite and > 0")));
    }
    Ok(())
}

fn append_reduce_only(params: &mut Vec<(String, String)>, reduce_only: bool) {
    if reduce_only {
        params.push(("reduceOnly".into(), "true".into()));
    }
}

fn validate_conditional_quantity_shape(
    quantity: Option<f64>,
    close_position: bool,
) -> AppResult<()> {
    if !close_position && quantity.is_none() {
        return Err(AppError::Invalid(
            "quantity is required when close_position=false".into(),
        ));
    }
    if close_position && quantity.is_some() {
        return Err(AppError::Invalid(
            "quantity must be omitted when close_position=true".into(),
        ));
    }
    Ok(())
}

fn validate_id(value: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 36
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err(AppError::Invalid(
            "client order id must be 1..=36 ASCII letters, digits, '-' or '_'".into(),
        ));
    }
    Ok(value.into())
}

fn encode(params: &[(String, String)]) -> String {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    for (key, value) in params {
        serializer.append_pair(key, value);
    }
    serializer.finish()
}

fn sign(query: &str, secret: &str) -> AppResult<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| AppError::Config("invalid HMAC key".into()))?;
    mac.update(query.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn timestamp_ms_i64() -> AppResult<i64> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AppError::Config("system clock is before UNIX epoch".into()))?
        .as_millis();

    i64::try_from(millis).map_err(|_| AppError::Config("system timestamp exceeds i64".into()))
}

pub fn decimal(value: f64) -> String {
    value.to_string()
}

pub fn floor_to_step(value: f64, step: f64) -> f64 {
    if step <= 0.0 {
        return value;
    }
    let precision = decimals_from_step(step);
    let result = (value / step).floor() * step;
    let factor = 10_f64.powi(precision as i32);
    (result * factor).round() / factor
}

pub fn round_to_tick(value: f64, tick: f64) -> f64 {
    if tick <= 0.0 {
        return value;
    }
    let precision = decimals_from_step(tick);
    let result = (value / tick).round() * tick;
    let factor = 10_f64.powi(precision as i32);
    (result * factor).round() / factor
}

fn decimals_from_step(step: f64) -> usize {
    let s = format!("{step:.16}");
    s.trim_end_matches('0')
        .split('.')
        .nth(1)
        .map(str::len)
        .unwrap_or(0)
}

fn parse_f64(name: &str, raw: &str) -> AppResult<f64> {
    raw.parse::<f64>()
        .map_err(|_| AppError::Invalid(format!("invalid {name}: {raw}")))
}

fn env_bool(name: &str, default: bool) -> AppResult<bool> {
    match std::env::var(name) {
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" => Ok(false),
            _ => Err(AppError::Config(format!("{name} must be true or false"))),
        },
        Err(_) => Ok(default),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{
            Mutex,
            atomic::{AtomicBool, Ordering},
        },
    };

    use serde_json::json;
    use zeroize::Zeroizing;

    use super::{
        append_reduce_only, floor_to_step, load_desktop_configuration, parse_exchange_filters,
        parse_leverage_and_maintenance_data, round_to_tick, validate_conditional_quantity_shape,
    };
    use crate::{
        models::{ExchangeInfo, LeverageBracketSymbol},
        secure_store::{BINANCE_API_KEY, BINANCE_API_SECRET, BINANCE_NETWORK, SecretReader},
    };

    struct MockSecretReader {
        values: Mutex<HashMap<String, String>>,
        unavailable: AtomicBool,
    }

    impl MockSecretReader {
        fn new(values: &[(&str, &str)]) -> Self {
            Self {
                values: Mutex::new(
                    values
                        .iter()
                        .map(|(name, value)| ((*name).into(), (*value).into()))
                        .collect(),
                ),
                unavailable: AtomicBool::new(false),
            }
        }
    }

    impl SecretReader for MockSecretReader {
        fn read(&self, name: &str) -> Result<Option<Zeroizing<String>>, String> {
            if self.unavailable.load(Ordering::Acquire) {
                return Err("credential store locked".into());
            }
            Ok(self
                .values
                .lock()
                .expect("value lock")
                .get(name)
                .cloned()
                .map(Zeroizing::new))
        }
    }

    fn complete_testnet_reader() -> MockSecretReader {
        MockSecretReader::new(&[
            (BINANCE_API_KEY, "private-key"),
            (BINANCE_API_SECRET, "private-secret"),
            (BINANCE_NETWORK, "testnet"),
        ])
    }

    #[test]
    fn desktop_configuration_requires_key_secret_and_network_as_one_set() {
        let empty = MockSecretReader::new(&[]);
        let (testnet, credentials) =
            load_desktop_configuration(&empty).expect("empty chart-only setup is valid");
        assert!(testnet);
        assert!(credentials.is_none());

        for incomplete in [
            MockSecretReader::new(&[(BINANCE_API_KEY, "private-key")]),
            MockSecretReader::new(&[
                (BINANCE_API_KEY, "private-key"),
                (BINANCE_API_SECRET, "private-secret"),
            ]),
            MockSecretReader::new(&[(BINANCE_NETWORK, "testnet")]),
        ] {
            let error = match load_desktop_configuration(&incomplete) {
                Err(error) => error,
                Ok(_) => panic!("incomplete desktop credentials must fail"),
            };
            assert!(error.to_string().contains("trading is blocked"));
            assert!(!error.to_string().contains("private"));
        }
    }

    #[test]
    fn desktop_configuration_rejects_corrupt_network_and_recovers_after_unlock() {
        let corrupt = MockSecretReader::new(&[
            (BINANCE_API_KEY, "private-key"),
            (BINANCE_API_SECRET, "private-secret"),
            (BINANCE_NETWORK, "invalid"),
        ]);
        assert!(load_desktop_configuration(&corrupt).is_err());

        let recovered = complete_testnet_reader();
        recovered.unavailable.store(true, Ordering::Release);
        assert!(load_desktop_configuration(&recovered).is_err());
        recovered.unavailable.store(false, Ordering::Release);

        let (testnet, credentials) =
            load_desktop_configuration(&recovered).expect("unlocked store recovers");
        assert!(testnet);
        assert!(credentials.is_some());
    }

    #[test]
    fn quantity_rounding_always_floors_to_the_exchange_step() {
        assert_eq!(floor_to_step(1.239, 0.01), 1.23);
        assert_eq!(floor_to_step(0.0099, 0.001), 0.009);
        assert!(floor_to_step(1.239, 0.01) <= 1.239);
    }

    #[test]
    fn price_rounding_uses_the_nearest_exchange_tick_without_float_noise() {
        assert_eq!(round_to_tick(76_605.74, 0.1), 76_605.7);
        assert_eq!(round_to_tick(0.512_345, 0.0001), 0.5123);
    }

    #[test]
    fn exchange_filters_preserve_step_tick_quantity_and_notional_minimums() {
        let info: ExchangeInfo = serde_json::from_value(json!({
            "symbols": [{
                "symbol": "BTCUSDT",
                "status": "TRADING",
                "filters": [
                    { "filterType": "PRICE_FILTER", "tickSize": "0.10" },
                    { "filterType": "LOT_SIZE", "stepSize": "0.001", "minQty": "0.002" },
                    { "filterType": "MIN_NOTIONAL", "notional": "20" }
                ]
            }]
        }))
        .expect("exchange-info fixture must deserialize");

        let filters = parse_exchange_filters(info).expect("valid filters");
        let btc = filters.get("BTCUSDT").expect("BTC filters");
        assert_eq!(btc.tick_size, 0.1);
        assert_eq!(btc.step_size, 0.001);
        assert_eq!(btc.min_qty, 0.002);
        assert_eq!(btc.min_notional, 20.0);
    }

    #[test]
    fn maintenance_brackets_are_sorted_and_keep_the_exchange_max_leverage() {
        let response: Vec<LeverageBracketSymbol> = serde_json::from_value(json!([{
            "symbol": "BTCUSDT",
            "brackets": [
                { "initialLeverage": 20, "notionalCap": 250000.0, "maintMarginRatio": 0.01, "cum": 100.0 },
                { "initialLeverage": 125, "notionalCap": 50000.0, "maintMarginRatio": 0.004, "cum": 0.0 }
            ]
        }]))
        .expect("leverage fixture must deserialize");

        let (maximums, brackets) = parse_leverage_and_maintenance_data(response);
        assert_eq!(maximums["BTCUSDT"], 125);
        assert_eq!(brackets["BTCUSDT"][0].notional_cap, 50_000.0);
        assert_eq!(brackets["BTCUSDT"][1].notional_cap, 250_000.0);
    }

    #[test]
    fn reduce_only_is_emitted_only_for_exposure_reducing_orders() {
        let mut close_params = Vec::new();
        append_reduce_only(&mut close_params, true);
        assert_eq!(
            close_params,
            vec![("reduceOnly".to_string(), "true".to_string())]
        );

        let mut entry_params = Vec::new();
        append_reduce_only(&mut entry_params, false);
        assert!(entry_params.is_empty());
    }

    #[test]
    fn full_position_protection_cannot_also_submit_a_quantity() {
        assert!(validate_conditional_quantity_shape(None, true).is_ok());
        assert!(validate_conditional_quantity_shape(Some(0.01), true).is_err());
        assert!(validate_conditional_quantity_shape(None, false).is_err());
        assert!(validate_conditional_quantity_shape(Some(0.01), false).is_ok());
    }
}
