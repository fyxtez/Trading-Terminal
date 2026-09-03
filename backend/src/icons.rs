//! Local filesystem cache of token icons, keyed by base symbol (e.g. "BTC").
//!
//! Design notes:
//! - This is intentionally a *separate* store from `SymbolRegistry`. Some of
//!   the seeded majors (USDT, USDC) are quote assets, not tradable
//!   `{BASE}USDT` pairs, so they can never live inside `SymbolRegistry`
//!   itself - but we still want their icons cached and servable.
//! - The only currently-known no-auth Binance endpoint that returns icon
//!   URLs is the Alpha Trading token list. It is scoped to Binance's
//!   "Alpha" (early/small-cap pre-listing) tokens, so well-established
//!   majors are not guaranteed to appear in it. When that lookup misses,
//!   this module falls back to CoinGecko's `/coins/markets` endpoint
//!   (`symbols=` query), which reliably covers majors. Optional Demo/Pro API
//!   keys are supported through environment variables for production limits.
//!   A miss on BOTH sources returns `Ok(None)` - the caller decides whether
//!   that's fatal, it's never treated as an error by this module itself.
//! - CoinGecko's `symbols=` lookup can collide: multiple unrelated coins
//!   sometimes share a ticker, and CoinGecko returns the top-ranked (by
//!   market cap) match for that symbol. That's exactly the behavior we
//!   want for majors, but it does mean an obscure on-demand symbol could
//!   in theory cache an unrelated, higher-cap coin's logo if it happens to
//!   share a ticker and isn't on Binance's Alpha list. Binance Alpha is
//!   always tried first specifically to avoid this for small-cap tokens.
//! - MEXC's public contract API does not expose logo URLs. MEXC-only symbols
//!   therefore try MEXC web metadata, DexScreener (for brand-new on-chain
//!   listings), and CoinGecko before being downloaded into this same cache.
//! - Deleting a symbol from `SymbolRegistry` never deletes its cached icon
//!   here - that's intentional (see `symbol_registry::delete`), so a
//!   re-added symbol doesn't need to re-download its icon and a
//!   momentarily-removed symbol doesn't lose its artwork.

use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{fs, sync::RwLock};

use crate::error::{AppError, AppResult};
use crate::symbol_registry::normalize_base_symbol;

const BINANCE_ALPHA_TOKEN_LIST_URL: &str =
    "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list";
const MEXC_SPOT_ASSET_URL_PREFIX: &str = "https://www.mexc.com/api/platform/asset/spot";
const DEXSCREENER_SEARCH_URL: &str = "https://api.dexscreener.com/latest/dex/search";

const COINGECKO_MARKETS_URL: &str = "https://api.coingecko.com/api/v3/coins/markets";
const COINGECKO_PRO_MARKETS_URL: &str = "https://pro-api.coingecko.com/api/v3/coins/markets";
const STOCK_LOGO_URL_PREFIX: &str = "https://financialmodelingprep.com/image-stock";

/// Symbols pre-cached at startup, independent of `SymbolRegistry`.
pub const DEFAULT_SEED_SYMBOLS: &[&str] =
    &["BTC", "SOL", "XRP", "USDT", "USDC", "BNB", "TRX", "HYPE"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IconEntry {
    pub symbol: String,
    /// File name only (relative to the icon cache directory), e.g. "BTC.png".
    pub file_name: String,
    pub content_type: String,
    /// The upstream URL the bytes were downloaded from, kept for debugging
    /// and so re-fetches aren't required just to know provenance.
    pub source_url: String,
    pub cached_at_ms: i64,
}

#[derive(Clone)]
pub struct IconStore {
    dir: Arc<PathBuf>,
    manifest_path: Arc<PathBuf>,
    entries: Arc<RwLock<BTreeMap<String, IconEntry>>>,
    http: reqwest::Client,
}

impl IconStore {
    pub async fn load(dir: impl Into<PathBuf>) -> AppResult<Self> {
        let dir = dir.into();
        fs::create_dir_all(&dir).await?;

        let manifest_path = dir.join("manifest.json");

        let mut manifest_needs_rewrite = false;
        let entries = match fs::read(&manifest_path).await {
            Ok(bytes) => {
                let loaded: Vec<IconEntry> = serde_json::from_slice(&bytes)?;
                let mut entries = BTreeMap::new();

                // Older deployments could leave manifest entries behind while
                // their image files were missing, empty, or contained a failed
                // upstream response. Such entries looked cached to `seed`, so
                // they were never fetched again and the frontend permanently
                // received broken image URLs. Reconcile the manifest with the
                // actual cache on every startup; the normal startup seed then
                // backfills anything removed here.
                for entry in loaded {
                    let path = dir.join(&entry.file_name);
                    match fs::read(&path).await {
                        Ok(file_bytes) if is_supported_image(&file_bytes) => {
                            entries.insert(entry.symbol.clone(), entry);
                        }
                        Ok(_) => {
                            manifest_needs_rewrite = true;
                            tracing::warn!(
                                symbol = %entry.symbol,
                                file = %entry.file_name,
                                "Discarding invalid cached token icon"
                            );
                            let _ = fs::remove_file(path).await;
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            manifest_needs_rewrite = true;
                            tracing::warn!(
                                symbol = %entry.symbol,
                                file = %entry.file_name,
                                "Discarding token icon whose cache file is missing"
                            );
                        }
                        Err(error) => return Err(error.into()),
                    }
                }

                entries
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(error.into()),
        };

        let http = reqwest::Client::builder()
            .user_agent("fyxtez-backend/0.1")
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(3))
            .build()?;

        let store = Self {
            dir: Arc::new(dir),
            manifest_path: Arc::new(manifest_path),
            entries: Arc::new(RwLock::new(entries)),
            http,
        };

        if manifest_needs_rewrite || fs::metadata(store.manifest_path.as_ref()).await.is_err() {
            store.persist().await?;
        }

        Ok(store)
    }

    /// Best-effort bulk icon resolution. Used both for the fixed
    /// `DEFAULT_SEED_SYMBOLS` list and for backfilling whatever
    /// is already in `SymbolRegistry` at startup (see main.rs) - either
    /// way, never fails the whole process. A symbol that can't be
    /// resolved (not present on Binance's Alpha token list or CoinGecko,
    /// or a transient network error) is logged and skipped, since a
    /// missing icon should never be able to take the whole API down.
    pub async fn seed(&self, symbols: &[&str]) {
        for &symbol in symbols {
            match self.ensure_cached(symbol).await {
                Ok(Some(_)) => {
                    tracing::info!(symbol, "Seeded token icon");
                }
                Ok(None) => {
                    tracing::warn!(
                        symbol,
                        "No icon found for seeded symbol on Binance's Alpha token list or \
                         CoinGecko; it will stay uncached until one of them lists it"
                    );
                }
                Err(error) => {
                    tracing::warn!(symbol, %error, "Failed to seed token icon");
                }
            }
        }
    }

    /// startup backfill for MEXC-only crypto symbols. Unlike Binance
    /// symbols, these intentionally skip Binance Alpha because a matching
    /// ticker there could describe a different asset; CoinGecko is the neutral
    /// metadata source used to populate the same local icon cache.
    pub async fn seed_mexc(&self, symbols: &[&str]) {
        for &symbol in symbols {
            match self.ensure_cached_from_mexc(symbol).await {
                Ok(Some(_)) => tracing::info!(symbol, "Seeded MEXC token icon"),
                Ok(None) => {
                    tracing::warn!(symbol, "No CoinGecko icon found for registered MEXC symbol")
                }
                Err(error) => {
                    tracing::warn!(symbol, %error, "Failed to seed MEXC token icon");
                }
            }
        }
    }

    /// startup backfill for verified TradFi logos. Equity/ETF symbols
    /// use a stock-logo endpoint, while commodities use explicit URLs below.
    pub async fn seed_tradfi(&self, symbols: &[&str]) {
        for &symbol in symbols {
            match self.ensure_cached_tradfi(symbol).await {
                Ok(Some(_)) => tracing::info!(symbol, "Seeded TradFi icon"),
                Ok(None) => tracing::warn!(symbol, "No TradFi icon source configured"),
                Err(error) => tracing::warn!(symbol, %error, "Failed to seed TradFi icon"),
            }
        }
    }

    pub async fn list(&self) -> Vec<IconEntry> {
        self.entries.read().await.values().cloned().collect()
    }

    /// Reads the cached image bytes + content type for a symbol, if any.
    pub async fn read_bytes(&self, symbol: &str) -> AppResult<Option<(Vec<u8>, String)>> {
        let base = normalize_icon_symbol(symbol)?;
        let entry = { self.entries.read().await.get(&base).cloned() };

        let Some(entry) = entry else {
            return Ok(None);
        };

        let path = self.dir.join(&entry.file_name);
        let bytes = fs::read(&path).await?;
        Ok(Some((bytes, entry.content_type)))
    }

    /// remove a token image cached before a Binance contract was known to
    /// be TradFi. This is deliberately separate from normal registry deletion,
    /// which continues to retain valid crypto icons for inexpensive re-adds.
    pub async fn remove_misclassified(&self, symbol: &str) -> AppResult<()> {
        let base = normalize_icon_symbol(symbol)?;
        let mut entries = self.entries.write().await;
        // only purge old crypto-source collisions. Once a valid TradFi
        // icon has been cached, future restarts must retain it cheaply.
        if entries.get(&base).is_some_and(|entry| {
            entry.source_url.starts_with(STOCK_LOGO_URL_PREFIX)
                || entry.source_url.contains("s3-symbol-logo.tradingview.com")
        }) {
            return Ok(());
        }
        let removed = entries.remove(&base);
        drop(entries);
        let Some(entry) = removed else {
            return Ok(());
        };
        let file_name = entry.file_name.clone();

        if let Err(error) = self.persist().await {
            self.entries.write().await.insert(base, entry);
            return Err(error);
        }
        let _ = fs::remove_file(self.dir.join(file_name)).await;
        Ok(())
    }

    /// Downloads and caches `symbol`'s icon from Binance's Alpha token
    /// list if it isn't already cached. Returns `Ok(None)` (not an error)
    /// when Binance simply doesn't have a matching entry - that's an
    /// expected outcome for majors outside the Alpha program, not a
    /// failure of this store.
    pub async fn ensure_cached_from_binance(&self, symbol: &str) -> AppResult<Option<IconEntry>> {
        self.ensure_cached(symbol).await
    }

    /// dynamically resolves MEXC artwork through exchange, DEX, and
    /// CoinGecko metadata, then stores it in the existing manifest-backed cache.
    /// MEXC's official futures contract payload itself supplies no logo URL.
    pub async fn ensure_cached_from_mexc(&self, symbol: &str) -> AppResult<Option<IconEntry>> {
        self.ensure_cached_from_mexc_inner(symbol).await
    }

    /// TradFi has its own resolver so stock tickers never pass through
    /// Binance Alpha or CoinGecko token matching.
    pub async fn ensure_cached_from_tradfi(&self, symbol: &str) -> AppResult<Option<IconEntry>> {
        self.ensure_cached_tradfi(symbol).await
    }

    async fn ensure_cached_tradfi(&self, symbol: &str) -> AppResult<Option<IconEntry>> {
        let base = normalize_base_symbol(symbol)?;
        let icon_url = tradfi_icon_url(&base);
        self.cache_resolved_icon(base.clone(), icon_url, "tradfi", base)
            .await
            .map(Some)
    }

    async fn ensure_cached(&self, symbol: &str) -> AppResult<Option<IconEntry>> {
        let base = normalize_icon_symbol(symbol)?;

        if let Some(existing) = self.entries.read().await.get(&base).cloned() {
            return Ok(Some(existing));
        }

        let (icon_url, source_label, matched_symbol) =
            match self.lookup_binance_alpha_icon_url(&base).await? {
                Some((icon_url, matched_symbol)) => (icon_url, "binance-alpha", matched_symbol),
                None => match self.lookup_coingecko_icon_url(&base).await? {
                    Some((icon_url, matched_id)) => (icon_url, "coingecko", matched_id),
                    None => return Ok(None),
                },
            };

        self.cache_resolved_icon(base, icon_url, source_label, matched_symbol)
            .await
            .map(Some)
    }

    async fn ensure_cached_from_mexc_inner(&self, symbol: &str) -> AppResult<Option<IconEntry>> {
        let base = normalize_icon_symbol(symbol)?;

        if let Some(existing) = self.entries.read().await.get(&base).cloned() {
            return Ok(Some(existing));
        }
        // freshly listed MEXC Meme+/on-chain tokens may be absent from both
        // MEXC's legacy spot-asset payload and CoinGecko for several days.
        // Try DexScreener between them because it indexes the token's live DEX
        // pair and artwork immediately; this fixes BASECAT without hardcoding it.
        let resolved = match self.lookup_mexc_platform_icon_url(&base).await {
            Ok(Some(icon_url)) => Some((icon_url, "mexc-asset", base.clone())),
            Ok(None) => None,
            Err(error) => {
                tracing::warn!(symbol = %base, %error, "MEXC asset-icon lookup failed; trying DexScreener");
                None
            }
        };
        let resolved = match resolved {
            Some(value) => Some(value),
            None => match self.lookup_dexscreener_icon_url(&base).await {
                Ok(Some((icon_url, matched_id))) => {
                    Some((icon_url, "dexscreener-mexc", matched_id))
                }
                Ok(None) => None,
                Err(error) => {
                    tracing::warn!(symbol = %base, %error, "DexScreener icon lookup failed; trying CoinGecko");
                    None
                }
            },
        };
        let (icon_url, source, matched_id) = match resolved {
            Some(value) => value,
            None => match self.lookup_coingecko_icon_url(&base).await? {
                Some((icon_url, matched_id)) => (icon_url, "coingecko-mexc", matched_id),
                None => return Ok(None),
            },
        };

        self.cache_resolved_icon(base, icon_url, source, matched_id)
            .await
            .map(Some)
    }

    async fn cache_resolved_icon(
        &self,
        base: String,
        icon_url: String,
        source_label: &str,
        matched_symbol: String,
    ) -> AppResult<IconEntry> {
        if let Some(existing) = self.entries.read().await.get(&base).cloned() {
            return Ok(existing);
        }
        let (bytes, content_type) = self.download(&icon_url).await?;
        if !is_supported_image(&bytes) {
            return Err(AppError::Config(format!(
                "icon download for {base} did not contain a supported image"
            )));
        }
        let file_name = format!("{base}.{}", extension_for(&content_type, &icon_url));

        let entry = IconEntry {
            symbol: base.clone(),
            file_name: file_name.clone(),
            content_type,
            source_url: icon_url,
            cached_at_ms: now_millis(),
        };

        fs::write(self.dir.join(&file_name), &bytes).await?;

        // Re-check under the write lock because another concurrent request may
        // have cached this exact symbol while the image was downloading.
        let mut entries = self.entries.write().await;
        if let Some(existing) = entries.get(&base) {
            return Ok(existing.clone());
        }

        entries.insert(base.clone(), entry.clone());
        drop(entries);

        if let Err(error) = self.persist().await {
            self.entries.write().await.remove(&base);
            let _ = fs::remove_file(self.dir.join(&file_name)).await;
            return Err(error);
        }

        tracing::debug!(symbol = %base, source = source_label, matched_symbol, "Cached icon");
        Ok(entry)
    }

    /// Searches the Binance Alpha token list for a case-insensitive symbol
    /// match. Returns the icon URL and the exact-cased symbol Binance
    /// reported it under (for logging only).
    async fn lookup_binance_alpha_icon_url(
        &self,
        base: &str,
    ) -> AppResult<Option<(String, String)>> {
        let response = self.http.get(BINANCE_ALPHA_TOKEN_LIST_URL).send().await?;
        let status = response.status();
        let payload: Value = response.json().await?;

        if !status.is_success() {
            return Err(AppError::Config(format!(
                "Binance Alpha token-list probe returned HTTP {status}"
            )));
        }

        let Some(tokens) = payload.get("data").and_then(Value::as_array) else {
            return Ok(None);
        };

        // Prefer a non-delisted match if there are several (Binance keeps
        // historical/delisted entries in the same array); otherwise fall
        // back to the first match found.
        let mut fallback: Option<(String, String)> = None;

        for token in tokens {
            let Some(token_symbol) = token.get("symbol").and_then(Value::as_str) else {
                continue;
            };
            if !token_symbol.eq_ignore_ascii_case(base) {
                continue;
            }
            let Some(icon_url) = token.get("iconUrl").and_then(Value::as_str) else {
                continue;
            };

            let fully_delisted = token
                .get("fullyDelisted")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            if !fully_delisted {
                return Ok(Some((icon_url.to_string(), token_symbol.to_string())));
            }
            if fallback.is_none() {
                fallback = Some((icon_url.to_string(), token_symbol.to_string()));
            }
        }

        Ok(fallback)
    }

    /// MEXC's trading API confirms contracts but omits artwork; its
    /// public web asset metadata contains the same token icon shown by MEXC's
    /// own UI. Parse defensively because this web payload is less stable than
    /// the documented trading API, and fall back to CoinGecko on any miss.
    async fn lookup_mexc_platform_icon_url(&self, base: &str) -> AppResult<Option<String>> {
        let url = format!("{MEXC_SPOT_ASSET_URL_PREFIX}/{base}");
        let response = self.http.get(url).send().await?;
        if !response.status().is_success() {
            return Ok(None);
        }
        let payload: Value = response.json().await?;
        Ok(find_mexc_asset_image_url(&payload))
    }

    /// resolve artwork for just-listed MEXC tokens through their DEX
    /// pairs. Exact base-symbol matching prevents quote-token false positives;
    /// highest liquidity makes the canonical pair win when several exist.
    async fn lookup_dexscreener_icon_url(&self, base: &str) -> AppResult<Option<(String, String)>> {
        let response = self
            .http
            .get(DEXSCREENER_SEARCH_URL)
            .query(&[("q", base)])
            .send()
            .await?;
        if !response.status().is_success() {
            return Ok(None);
        }

        let payload: Value = response.json().await?;
        let Some(pairs) = payload.get("pairs").and_then(Value::as_array) else {
            return Ok(None);
        };

        let mut matches: Vec<&Value> = pairs
            .iter()
            .filter(|pair| {
                pair.pointer("/baseToken/symbol")
                    .and_then(Value::as_str)
                    .is_some_and(|symbol| symbol.eq_ignore_ascii_case(base))
                    && pair
                        .pointer("/info/imageUrl")
                        .and_then(Value::as_str)
                        .is_some()
            })
            .collect();
        matches.sort_by(|left, right| {
            dex_pair_liquidity(right)
                .partial_cmp(&dex_pair_liquidity(left))
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let Some(pair) = matches.first() else {
            return Ok(None);
        };
        let icon_url = pair
            .pointer("/info/imageUrl")
            .and_then(Value::as_str)
            .expect("filtered pairs always have an image URL")
            .to_string();
        let matched_id = pair
            .pointer("/baseToken/address")
            .and_then(Value::as_str)
            .unwrap_or(base)
            .to_string();
        Ok(Some((icon_url, matched_id)))
    }

    /// Fallback lookup via CoinGecko's public `/coins/markets` endpoint
    /// (`symbols=` query - ticker-based, no API key required). CoinGecko
    /// returns the top-ranked (by market cap) coin for a given ticker when
    /// several unrelated coins share one, which is exactly what we want
    /// for majors that Binance's Alpha list doesn't carry.
    ///
    /// Returns the image URL and CoinGecko's own coin id (for logging
    /// only). `Ok(None)` means CoinGecko has no coin under this ticker at
    /// all - not an error.
    async fn lookup_coingecko_icon_url(&self, base: &str) -> AppResult<Option<(String, String)>> {
        let lower_base = base.to_ascii_lowercase();

        // production deployments can opt into CoinGecko's supported
        // authentication without placing secrets in the frontend. Demo keys
        // use api.coingecko.com; Pro keys require the separate Pro origin.
        let (url, auth_header) = if let Ok(key) = std::env::var("COINGECKO_PRO_API_KEY") {
            (COINGECKO_PRO_MARKETS_URL, Some(("x-cg-pro-api-key", key)))
        } else if let Ok(key) = std::env::var("COINGECKO_DEMO_API_KEY") {
            (COINGECKO_MARKETS_URL, Some(("x-cg-demo-api-key", key)))
        } else {
            (COINGECKO_MARKETS_URL, None)
        };

        let mut request = self
            .http
            .get(url)
            .query(&[("vs_currency", "usd"), ("symbols", lower_base.as_str())]);
        if let Some((header, key)) = auth_header {
            request = request.header(header, key);
        }
        let response = request.send().await?;
        let status = response.status();
        let payload: Value = response.json().await?;

        if !status.is_success() {
            return Err(AppError::Config(format!(
                "CoinGecko /coins/markets probe returned HTTP {status}"
            )));
        }

        let Some(coins) = payload.as_array() else {
            return Ok(None);
        };

        // CoinGecko already returns results ordered top-ranked-first for a
        // `symbols=` lookup, so the first entry is the one we want.
        let Some(coin) = coins.first() else {
            return Ok(None);
        };

        let Some(image_url) = coin.get("image").and_then(Value::as_str) else {
            return Ok(None);
        };

        let id = coin
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or(base)
            .to_string();

        Ok(Some((image_url.to_string(), id)))
    }

    async fn download(&self, url: &str) -> AppResult<(Vec<u8>, String)> {
        let response = self.http.get(url).send().await?;
        let status = response.status();

        if !status.is_success() {
            return Err(AppError::Config(format!(
                "failed to download icon from {url}: HTTP {status}"
            )));
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
            .unwrap_or_else(|| "image/png".to_string());

        let bytes = response.bytes().await?;
        Ok((bytes.to_vec(), content_type))
    }

    async fn persist(&self) -> AppResult<()> {
        let entries: Vec<IconEntry> = self.entries.read().await.values().cloned().collect();
        let bytes = serde_json::to_vec_pretty(&entries)?;

        let temporary = self.manifest_path.with_extension("json.tmp");
        fs::write(&temporary, bytes).await?;
        fs::rename(&temporary, self.manifest_path.as_ref()).await?;
        Ok(())
    }
}

fn normalize_icon_symbol(raw: &str) -> AppResult<String> {
    let symbol = raw.trim().to_ascii_uppercase();

    // Icon seeds intentionally include quote assets USDT and USDC, but
    // the trading-pair normalizer strips a trailing "USDT" and rejects the
    // empty result. Keep these standalone asset tickers intact for icon-only
    // operations while all ordinary symbols retain the stricter validation.
    if matches!(symbol.as_str(), "USDT" | "USDC") {
        return Ok(symbol);
    }

    normalize_base_symbol(&symbol)
}

fn extension_for(content_type: &str, url: &str) -> &'static str {
    let lowered = content_type.to_ascii_lowercase();
    if lowered.contains("webp") {
        return "webp";
    }
    if lowered.contains("jpeg") || lowered.contains("jpg") {
        return "jpg";
    }
    if lowered.contains("svg") {
        return "svg";
    }
    if lowered.contains("png") {
        return "png";
    }

    // Content-Type was missing/unhelpful - fall back to the URL's own
    // extension before defaulting.
    let lowered_url = url.to_ascii_lowercase();
    if lowered_url.ends_with(".webp") {
        "webp"
    } else if lowered_url.ends_with(".jpg") || lowered_url.ends_with(".jpeg") {
        "jpg"
    } else if lowered_url.ends_with(".svg") {
        "svg"
    } else {
        "png"
    }
}

fn tradfi_icon_url(base: &str) -> String {
    // commodities do not have stock tickers, so map them to explicit
    // asset icons. Equities and ETFs use the exact exchange ticker against the
    // stock-only provider, avoiding the crypto ticker collisions fixed above.
    let special = match base {
        "XAU" | "GOLD" => Some("https://s3-symbol-logo.tradingview.com/metal/gold--big.svg"),
        "XAG" | "SILVER" => Some("https://s3-symbol-logo.tradingview.com/metal/silver--big.svg"),
        "XPT" | "PLATINUM" => {
            Some("https://s3-symbol-logo.tradingview.com/metal/platinum--big.svg")
        }
        "XPD" | "PALLADIUM" => {
            Some("https://s3-symbol-logo.tradingview.com/metal/palladium--big.svg")
        }
        "OIL" | "WTI" | "BRENT" => {
            Some("https://s3-symbol-logo.tradingview.com/crude-oil--big.svg")
        }
        "NG" | "NATGAS" => Some("https://s3-symbol-logo.tradingview.com/natural-gas--big.svg"),
        _ => None,
    };
    special
        .map(str::to_string)
        .unwrap_or_else(|| format!("{STOCK_LOGO_URL_PREFIX}/{base}.png"))
}

fn find_mexc_asset_image_url(value: &Value) -> Option<String> {
    match value {
        Value::Object(fields) => {
            // prefer explicitly named artwork fields before recursively
            // inspecting nested network metadata, which may contain a chain
            // logo that is not the requested token's own icon.
            for (key, candidate) in fields {
                let normalized_key = key.to_ascii_lowercase();
                if !(normalized_key.contains("icon")
                    || normalized_key.contains("logo")
                    || normalized_key.contains("image"))
                {
                    continue;
                }
                if let Some(url) = candidate.as_str().and_then(normalize_mexc_image_url) {
                    return Some(url);
                }
            }
            fields.values().find_map(find_mexc_asset_image_url)
        }
        Value::Array(items) => items.iter().find_map(find_mexc_asset_image_url),
        _ => None,
    }
}

fn normalize_mexc_image_url(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.starts_with("https://") || value.starts_with("http://") {
        Some(value.to_string())
    } else if value.starts_with("//") {
        Some(format!("https:{value}"))
    } else if value.starts_with('/') {
        Some(format!("https://www.mexc.com{value}"))
    } else {
        None
    }
}

fn dex_pair_liquidity(pair: &Value) -> f64 {
    // DexScreener can encode numeric fields as either JSON numbers or
    // strings; accepting both keeps canonical-pair ranking stable over time.
    let value = pair.pointer("/liquidity/usd");
    value
        .and_then(Value::as_f64)
        .or_else(|| value.and_then(Value::as_str)?.parse().ok())
        .unwrap_or(0.0)
}

fn is_supported_image(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(&[0xff, 0xd8, 0xff])
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || (bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP")
        || looks_like_svg(bytes)
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    let prefix = &bytes[..bytes.len().min(1024)];
    let Ok(text) = std::str::from_utf8(prefix) else {
        return false;
    };
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();
    trimmed.starts_with("<svg")
        || (trimmed.starts_with("<?xml") && trimmed.to_ascii_lowercase().contains("<svg"))
}

fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
