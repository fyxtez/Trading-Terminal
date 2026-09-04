use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum OrderSide {
    Buy,
    Sell,
}

impl OrderSide {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Buy => "BUY",
            Self::Sell => "SELL",
        }
    }

    pub fn opposite(self) -> Self {
        match self {
            Self::Buy => Self::Sell,
            Self::Sell => Self::Buy,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MarginSizingConfig {
    pub margin_pct: f64,
    pub leverage_safety: f64,
    pub max_leverage: u32,
}

impl MarginSizingConfig {
    pub fn new(margin_pct: f64, leverage_safety: f64, max_leverage: u32) -> Result<Self, String> {
        if !margin_pct.is_finite() || margin_pct <= 0.0 || margin_pct > 1.0 {
            return Err("margin_pct must be finite and in (0, 1]".into());
        }

        if !(leverage_safety.is_finite() && 0.0 < leverage_safety && leverage_safety <= 1.0) {
            return Err("leverage_safety must be finite and in (0, 1]".into());
        }

        if max_leverage == 0 {
            return Err("max_leverage must be > 0".into());
        }

        Ok(Self {
            margin_pct,
            leverage_safety,
            max_leverage,
        })
    }
}

#[derive(Debug, Deserialize)]
pub struct MarketOrderRequest {
    pub symbol: String,
    pub side: OrderSide,
    pub quantity: Option<f64>,

    #[serde(default)]
    pub auto_size: bool,

    pub stop_loss: Option<f64>,
    pub leverage: Option<u32>,

    #[serde(default)]
    pub reduce_only: bool,

    pub client_order_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LimitOrderRequest {
    pub symbol: String,
    pub side: OrderSide,
    pub price: f64,
    pub quantity: Option<f64>,

    #[serde(default)]
    pub auto_size: bool,

    pub stop_loss: Option<f64>,
    pub leverage: Option<u32>,

    #[serde(default)]
    pub reduce_only: bool,

    #[serde(default = "default_time_in_force")]
    pub time_in_force: String,

    pub client_order_id: Option<String>,
}

fn default_time_in_force() -> String {
    "GTC".into()
}

#[cfg(test)]
mod tests {
    use super::{MarginSizingConfig, OrderSide, PositionIntentRequest};

    #[test]
    fn sizing_policy_accepts_only_bounded_finite_values() {
        assert!(MarginSizingConfig::new(0.02, 0.9, 50).is_ok());

        for invalid_margin in [0.0, -0.01, 1.01, f64::NAN, f64::INFINITY] {
            assert!(MarginSizingConfig::new(invalid_margin, 0.9, 50).is_err());
        }
        for invalid_safety in [0.0, -0.1, 1.01, f64::NAN, f64::INFINITY] {
            assert!(MarginSizingConfig::new(0.02, invalid_safety, 50).is_err());
        }
        assert!(MarginSizingConfig::new(0.02, 0.9, 0).is_err());
    }

    #[test]
    fn opposite_side_is_stable_for_close_plans() {
        assert!(matches!(OrderSide::Buy.opposite(), OrderSide::Sell));
        assert!(matches!(OrderSide::Sell.opposite(), OrderSide::Buy));
    }

    #[test]
    fn position_intent_contract_rejects_removed_reverse_actions() {
        let request = serde_json::json!({
            "symbol": "BTCUSDT",
            "intent": "REVERSE",
            "order_type": "MARKET"
        });

        assert!(serde_json::from_value::<PositionIntentRequest>(request).is_err());
    }
}

#[derive(Debug, Deserialize)]
pub struct ModifyLimitOrderRequest {
    pub side: OrderSide,
    pub quantity: f64,
    pub price: f64,

    #[serde(default = "default_time_in_force")]
    pub time_in_force: String,
}

#[derive(Debug, Deserialize)]
pub struct ConditionalOrderRequest {
    pub symbol: String,
    pub side: OrderSide,
    pub trigger_price: f64,
    pub quantity: Option<f64>,

    #[serde(default)]
    pub close_position: bool,

    pub client_algo_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SetLeverageRequest {
    pub symbol: String,
    pub leverage: u32,
}

#[derive(Debug, Deserialize)]
pub struct SymbolQuery {
    pub symbol: String,
}

/// Like SymbolQuery, but `symbol` is optional - used by GET /api/orders/open
/// so it can return either one symbol's open orders (query provided) or
/// every open order across the whole account (query omitted), matching
/// how GET /api/account already returns positions for every symbol rather
/// than just one. cancel_all_orders still uses the required SymbolQuery
/// above - Binance's DELETE /fapi/v1/allOpenOrders has no "cancel every
/// symbol at once" mode, so that one genuinely needs a symbol either way.
#[derive(Debug, Deserialize)]
pub struct OptionalSymbolQuery {
    pub symbol: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AutoSizeQuery {
    pub side: OrderSide,
    pub stop_loss: f64,
    pub leverage: Option<u32>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum PositionIntent {
    Add,
    Reduce,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum IntentOrderType {
    Market,
    Limit,
}

#[derive(Debug, Deserialize)]
pub struct PositionIntentRequest {
    pub symbol: String,
    pub intent: PositionIntent,
    pub order_type: Option<IntentOrderType>,
    pub price: Option<f64>,

    /// Percentage of the current position to reduce, in the range (0, 100].
    pub reduce_pct: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct ClosePositionRequest {
    pub symbol: String,
}

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub network: &'static str,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinanceOrderResponse {
    pub order_id: Option<i64>,
    pub symbol: Option<String>,
    pub status: Option<String>,
    pub client_order_id: Option<String>,
    pub price: Option<String>,
    pub avg_price: Option<String>,
    pub orig_qty: Option<String>,
    pub executed_qty: Option<String>,

    #[serde(flatten)]
    pub extra: serde_json::Value,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlgoOrderResponse {
    pub algo_id: Option<i64>,
    pub client_algo_id: Option<String>,
    pub algo_status: Option<String>,
    pub symbol: Option<String>,

    #[serde(flatten)]
    pub extra: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FuturesAccountInfo {
    pub total_wallet_balance: String,
    pub available_balance: String,

    #[serde(default)]
    pub assets: Vec<serde_json::Value>,

    #[serde(default)]
    pub positions: Vec<FuturesPosition>,

    #[serde(flatten)]
    pub extra: serde_json::Value,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FuturesPosition {
    pub symbol: String,

    #[serde(default)]
    pub position_amt: String,

    #[serde(default)]
    pub entry_price: String,

    #[serde(default)]
    pub unrealized_profit: String,

    #[serde(flatten)]
    pub extra: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct PriceResponse {
    pub price: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeverageBracketSymbol {
    pub symbol: String,
    pub brackets: Vec<LeverageBracket>,
}

/// A single tier of Binance's tiered leverage/maintenance-margin schedule
/// for one symbol (from `/fapi/v1/leverageBracket`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeverageBracket {
    pub initial_leverage: u32,
    /// Upper bound (USDT notional) of this bracket. Binance's tiers use a
    /// higher maintenance margin ratio for larger positions, so which
    /// tier applies depends on the position's actual notional.
    #[serde(default)]
    pub notional_cap: f64,
    /// The maintenance margin ratio for this notional tier.
    #[serde(default)]
    pub maint_margin_ratio: f64,
    /// Binance's `cum` deduction is required for a faithful projected
    /// liquidation price. Keeping it with the cached bracket lets resting LIMIT
    /// orders show the same tiered maintenance-margin boundary before they fill.
    #[serde(default)]
    pub cum: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeInfo {
    pub symbols: Vec<ExchangeSymbol>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeSymbol {
    pub symbol: String,
    pub status: String,
    pub filters: Vec<ExchangeFilter>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeFilter {
    pub filter_type: String,
    pub tick_size: Option<String>,
    pub step_size: Option<String>,
    pub min_qty: Option<String>,
    pub notional: Option<String>,
    pub min_notional: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SymbolFilters {
    pub step_size: f64,
    pub min_qty: f64,
    pub min_notional: f64,
    pub tick_size: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AutoSizePreview {
    pub symbol: String,
    pub side: OrderSide,
    pub reference_price: f64,
    pub stop_loss: f64,
    pub stop_distance: f64,
    pub stop_distance_pct: f64,
    pub available_balance: f64,
    pub margin_to_use: f64,
    pub theoretical_max_leverage: f64,
    pub safe_stop_leverage: u32,
    pub exchange_max_leverage: u32,
    pub leverage: u32,
    pub quantity: f64,
    pub notional: f64,
    pub estimated_loss_at_stop: f64,
    pub maintenance_margin_ratio: f64,
    pub margin_bumped: bool,
    pub config: MarginSizingConfig,
}
