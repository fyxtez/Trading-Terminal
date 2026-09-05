use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{fs, sync::RwLock};

use crate::error::{AppError, AppResult};

const BINANCE_EXCHANGE_INFO_URL: &str = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const MEXC_CONTRACT_DETAIL_URL: &str = "https://api.mexc.com/api/v1/contract/detail";
const PROTECTED_BASE_SYMBOLS: &[&str] = &["BTC", "ETH", "SOL", "XRP"];
// these built-ins were originally persisted as MEXC contracts. Limit the
// startup promotion to the requested symbols so unrelated user-added MEXC
// entries do not silently change venue if Binance lists them later.
const LEGACY_MEXC_SYMBOLS_TO_PROMOTE: &[&str] = &["PLUME", "ZEC"];
const PRESEEDED_TRADITIONAL_SYMBOLS: &[(&str, &str)] = &[("XAU", "XAUUSDT"), ("XAG", "XAGUSDT")];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MarketDataSource {
    Binance,
    Mexc,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MarketKind {
    #[default]
    Crypto,
    Traditional,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisteredSymbol {
    pub symbol: String,
    pub display_symbol: String,
    pub market_symbol: String,
    pub data_source: MarketDataSource,
    /// Binance's asset class lets clients distinguish TradFi from
    /// crypto without maintaining an incomplete ticker allow-list.
    #[serde(default)]
    pub market_kind: MarketKind,
    pub protected: bool,
}

#[derive(Debug, Deserialize)]
pub struct AddSymbolRequest {
    pub symbol: String,
}

#[derive(Clone)]
pub struct SymbolRegistry {
    path: Arc<PathBuf>,
    symbols: Arc<RwLock<BTreeMap<String, RegisteredSymbol>>>,
    http: reqwest::Client,
}

impl SymbolRegistry {
    pub async fn load(path: impl Into<PathBuf>) -> AppResult<Self> {
        let path = path.into();
        let http = reqwest::Client::builder()
            .user_agent("fyxtez-backend/0.1")
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(3))
            .build()?;

        let symbols = match fs::read(&path).await {
            Ok(bytes) => {
                let loaded: Vec<RegisteredSymbol> = serde_json::from_slice(&bytes)?;
                loaded
                    .into_iter()
                    .map(|entry| (entry.symbol.clone(), entry))
                    .collect()
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => default_symbols(),
            Err(error) => return Err(error.into()),
        };

        let registry = Self {
            path: Arc::new(path),
            symbols: Arc::new(RwLock::new(symbols)),
            http,
        };

        // Create the file on first startup so the registry is explicit and
        // subsequent API changes are durable across restarts.
        if fs::metadata(registry.path.as_ref()).await.is_err() {
            registry.persist().await?;
        }

        // defaults must also reach existing installations whose
        // symbols.json predates Binance's TradFi contracts.
        registry.seed_traditional_symbols().await?;

        // migrate legacy PLUME/ZEC entries before serving requests.
        // Changing default_symbols() alone would only fix fresh installs
        // because an existing symbols.json wins over the built-in defaults.
        registry.migrate_legacy_mexc_symbols().await?;

        // registry files created before market_kind deserialize as crypto.
        // Refresh existing Binance entries so SNDK/PLTR-like contracts heal on
        // restart without requiring the user to delete and re-add each symbol.
        if let Err(error) = registry.refresh_binance_market_kinds().await {
            tracing::warn!(%error, "Failed to refresh Binance market classifications");
        }

        Ok(registry)
    }

    pub async fn list(&self) -> Vec<RegisteredSymbol> {
        self.symbols.read().await.values().cloned().collect()
    }

    pub async fn get(&self, raw: &str) -> AppResult<Option<RegisteredSymbol>> {
        let base = normalize_base_symbol(raw)?;
        Ok(self.symbols.read().await.get(&base).cloned())
    }

    pub async fn ensure_binance_trading_symbol(&self, binance_symbol: &str) -> AppResult<()> {
        let base = binance_symbol.strip_suffix("USDT").ok_or_else(|| {
            AppError::Invalid(format!("unsupported trading symbol: {binance_symbol}"))
        })?;

        match self.symbols.read().await.get(base) {
            Some(entry) if entry.data_source == MarketDataSource::Binance => Ok(()),
            Some(entry) => Err(AppError::Invalid(format!(
                "{binance_symbol} is registered for {:?} market data, not Binance trading",
                entry.data_source
            ))),
            None => Err(AppError::Invalid(format!(
                "unsupported symbol: {binance_symbol}; add it first with POST /api/symbols"
            ))),
        }
    }

    pub async fn add(&self, raw: &str) -> AppResult<(RegisteredSymbol, bool)> {
        let base = normalize_base_symbol(raw)?;

        if let Some(existing) = self.symbols.read().await.get(&base).cloned() {
            return Ok((existing, false));
        }

        let binance_symbol = format!("{base}USDT");
        let mexc_symbol = format!("{base}_USDT");

        let entry = if let Some(market_kind) = self.binance_market_kind(&binance_symbol).await? {
            RegisteredSymbol {
                symbol: base.clone(),
                display_symbol: format!("{base}/USDT"),
                market_symbol: binance_symbol,
                data_source: MarketDataSource::Binance,
                market_kind,
                protected: is_protected(&base),
            }
        } else if self.mexc_has_symbol(&mexc_symbol).await? {
            RegisteredSymbol {
                symbol: base.clone(),
                display_symbol: format!("{base}/USDT"),
                market_symbol: mexc_symbol,
                data_source: MarketDataSource::Mexc,
                market_kind: MarketKind::Crypto,
                protected: is_protected(&base),
            }
        } else {
            return Err(AppError::NotFound(format!(
                "{base}/USDT was not found on Binance Futures or MEXC Futures"
            )));
        };

        self.symbols.write().await.insert(base, entry.clone());
        if let Err(error) = self.persist().await {
            self.symbols.write().await.remove(&entry.symbol);
            return Err(error);
        }

        Ok((entry, true))
    }

    pub async fn delete(&self, raw: &str) -> AppResult<RegisteredSymbol> {
        let base = normalize_base_symbol(raw)?;

        if is_protected(&base) {
            return Err(AppError::Invalid(format!(
                "{base} is a protected major symbol and cannot be deleted"
            )));
        }

        let removed = self
            .symbols
            .write()
            .await
            .remove(&base)
            .ok_or_else(|| AppError::NotFound(format!("symbol {base} is not registered")))?;

        if let Err(error) = self.persist().await {
            self.symbols.write().await.insert(base, removed.clone());
            return Err(error);
        }

        Ok(removed)
    }

    async fn binance_market_kind(&self, symbol: &str) -> AppResult<Option<MarketKind>> {
        let response = self.http.get(BINANCE_EXCHANGE_INFO_URL).send().await?;
        let status = response.status();
        let payload: Value = response.json().await?;

        if !status.is_success() {
            return Err(AppError::Config(format!(
                "Binance exchangeInfo probe returned HTTP {status}"
            )));
        }

        Ok(payload
            .get("symbols")
            .and_then(Value::as_array)
            .and_then(|symbols| {
                symbols.iter().find_map(|item| {
                    (item.get("symbol").and_then(Value::as_str) == Some(symbol)
                        && item.get("status").and_then(Value::as_str) == Some("TRADING"))
                    .then(|| market_kind_from_binance_symbol(item))
                })
            }))
    }

    async fn migrate_legacy_mexc_symbols(&self) -> AppResult<()> {
        let mut changed = false;
        {
            let mut entries = self.symbols.write().await;
            for base in LEGACY_MEXC_SYMBOLS_TO_PROMOTE {
                let Some(entry) = entries.get_mut(*base) else {
                    continue;
                };
                if entry.data_source != MarketDataSource::Mexc {
                    continue;
                }

                // rewrite every venue-dependent field together; changing
                // only data_source would still send PLUME_USDT/ZEC_USDT (MEXC
                // notation) to Binance's market-data and order endpoints.
                entry.market_symbol = format!("{base}USDT");
                entry.data_source = MarketDataSource::Binance;
                entry.market_kind = MarketKind::Crypto;
                changed = true;
            }
        }

        if changed {
            self.persist().await?;
        }
        Ok(())
    }

    async fn seed_traditional_symbols(&self) -> AppResult<()> {
        let mut changed = false;
        {
            let mut entries = self.symbols.write().await;
            for (base, market_symbol) in PRESEEDED_TRADITIONAL_SYMBOLS {
                if entries.contains_key(*base) {
                    continue;
                }

                entries.insert(
                    (*base).to_owned(),
                    RegisteredSymbol {
                        symbol: (*base).to_owned(),
                        display_symbol: format!("{base}/USDT"),
                        market_symbol: (*market_symbol).to_owned(),
                        data_source: MarketDataSource::Binance,
                        market_kind: MarketKind::Traditional,
                        protected: false,
                    },
                );
                changed = true;
            }
        }

        if changed {
            self.persist().await?;
        }
        Ok(())
    }

    async fn refresh_binance_market_kinds(&self) -> AppResult<()> {
        let response = self.http.get(BINANCE_EXCHANGE_INFO_URL).send().await?;
        let status = response.status();
        let payload: Value = response.json().await?;
        if !status.is_success() {
            return Err(AppError::Config(format!(
                "Binance exchangeInfo classification refresh returned HTTP {status}"
            )));
        }

        let Some(symbols) = payload.get("symbols").and_then(Value::as_array) else {
            return Ok(());
        };
        let classifications: BTreeMap<&str, MarketKind> = symbols
            .iter()
            .filter_map(|item| {
                // ignore delisted/non-trading contracts so stale exchange
                // metadata cannot reclassify a symbol as actively Binance-backed.
                if item.get("status").and_then(Value::as_str) != Some("TRADING") {
                    return None;
                }
                let symbol = item.get("symbol")?.as_str()?;
                Some((symbol, market_kind_from_binance_symbol(item)))
            })
            .collect();

        let mut changed = false;
        {
            let mut entries = self.symbols.write().await;
            for entry in entries.values_mut() {
                if entry.data_source != MarketDataSource::Binance {
                    continue;
                }
                if let Some(next) = classifications.get(entry.market_symbol.as_str())
                    && entry.market_kind != *next
                {
                    entry.market_kind = *next;
                    changed = true;
                }
            }
        }
        if changed {
            self.persist().await?;
        }
        Ok(())
    }

    async fn mexc_has_symbol(&self, symbol: &str) -> AppResult<bool> {
        let response = self.http.get(MEXC_CONTRACT_DETAIL_URL).send().await?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(false);
        }
        let payload: Value = response.json().await?;

        if !status.is_success() {
            return Err(AppError::Config(format!(
                "MEXC contract-detail probe returned HTTP {status}"
            )));
        }

        Ok(payload
            .get("data")
            .and_then(Value::as_array)
            .map(|contracts| {
                contracts
                    .iter()
                    .any(|item| item.get("symbol").and_then(Value::as_str) == Some(symbol))
            })
            .unwrap_or(false))
    }

    async fn persist(&self) -> AppResult<()> {
        let entries: Vec<RegisteredSymbol> = self.symbols.read().await.values().cloned().collect();
        let bytes = serde_json::to_vec_pretty(&entries)?;

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).await?;
        }

        let temporary = self.path.with_extension("json.tmp");
        fs::write(&temporary, bytes).await?;
        fs::rename(&temporary, self.path.as_ref()).await?;
        Ok(())
    }
}

pub fn normalize_base_symbol(raw: &str) -> AppResult<String> {
    let mut value = raw.trim().to_ascii_uppercase();
    if value.is_empty() {
        return Err(AppError::Invalid("symbol cannot be empty".into()));
    }

    if let Some((base, quote)) = value.split_once('/') {
        if quote != "USDT" {
            return Err(AppError::Invalid(
                "only USDT pairs are supported; use e.g. POWER or POWER/USDT".into(),
            ));
        }
        value = base.to_string();
    } else if let Some(base) = value.strip_suffix("_USDT") {
        value = base.to_string();
    } else if let Some(base) = value.strip_suffix("USDT") {
        value = base.to_string();
    }

    if value.is_empty()
        || value.len() > 24
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err(AppError::Invalid(format!("invalid symbol: {raw}")));
    }

    Ok(value)
}

fn is_protected(base: &str) -> bool {
    PROTECTED_BASE_SYMBOLS.contains(&base)
}

fn default_symbols() -> BTreeMap<String, RegisteredSymbol> {
    let defaults = [
        ("BTC", MarketDataSource::Binance, MarketKind::Crypto),
        ("ETH", MarketDataSource::Binance, MarketKind::Crypto),
        ("SOL", MarketDataSource::Binance, MarketKind::Crypto),
        ("XRP", MarketDataSource::Binance, MarketKind::Crypto),
        // Binance now exposes these USD-M perpetuals directly, so fresh
        // registries should never seed their old MEXC contract identifiers.
        ("PLUME", MarketDataSource::Binance, MarketKind::Crypto),
        ("ZEC", MarketDataSource::Binance, MarketKind::Crypto),
        ("XAU", MarketDataSource::Binance, MarketKind::Traditional),
        ("XAG", MarketDataSource::Binance, MarketKind::Traditional),
    ];

    defaults
        .into_iter()
        .map(|(base, data_source, market_kind)| {
            let market_symbol = match data_source {
                MarketDataSource::Binance => format!("{base}USDT"),
                MarketDataSource::Mexc => format!("{base}_USDT"),
            };
            let entry = RegisteredSymbol {
                symbol: base.to_string(),
                display_symbol: format!("{base}/USDT"),
                market_symbol,
                data_source,
                market_kind,
                protected: is_protected(base),
            };
            (base.to_string(), entry)
        })
        .collect()
}

fn market_kind_from_binance_symbol(symbol: &Value) -> MarketKind {
    // regular crypto futures are marked COIN. Every other explicit
    // underlying type represents an equity, commodity, index, or another
    // traditional-market contract and belongs in Traditional Markets.
    match symbol.get("underlyingType").and_then(Value::as_str) {
        Some(value) if !value.eq_ignore_ascii_case("COIN") => MarketKind::Traditional,
        _ => MarketKind::Crypto,
    }
}
