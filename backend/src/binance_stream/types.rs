use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct ListenKeyResponse {
    #[serde(rename = "listenKey")]
    pub listen_key: String,
}

#[derive(Debug, Deserialize)]
pub struct UserStreamEnvelope {
    #[serde(rename = "E")]
    pub event_time: Option<u64>,
    #[serde(rename = "T")]
    pub transaction_time: Option<u64>,
    #[serde(rename = "o")]
    pub order: Option<FuturesOrderUpdate>,
    #[serde(rename = "a")]
    pub account: Option<FuturesAccountUpdate>,
}

#[derive(Debug, Deserialize)]
pub struct FuturesOrderUpdate {
    #[serde(rename = "s")]
    pub symbol: String,
    #[serde(rename = "c")]
    pub client_order_id: String,
    #[serde(rename = "S")]
    pub side: String,
    #[serde(rename = "o")]
    pub order_type: String,
    #[serde(rename = "x")]
    pub execution_type: String,
    #[serde(rename = "X")]
    pub order_status: String,
    #[serde(rename = "i")]
    pub order_id: u64,
    #[serde(rename = "t")]
    pub trade_id: Option<i64>,
    #[serde(rename = "l")]
    pub last_filled_qty: String,
    #[serde(rename = "z")]
    pub accumulated_filled_qty: String,
    #[serde(rename = "L")]
    pub last_filled_price: String,
    #[serde(rename = "R", default)]
    pub reduce_only: bool,
}

#[derive(Debug, Deserialize)]
pub struct FuturesAccountUpdate {
    #[serde(rename = "B", default)]
    pub balances: Vec<FuturesBalanceUpdate>,
    #[serde(rename = "P", default)]
    pub positions: Vec<FuturesPositionUpdate>,
}

#[derive(Debug, Deserialize)]
pub struct FuturesBalanceUpdate {
    #[serde(rename = "a")]
    pub asset: String,
    #[serde(rename = "wb")]
    pub wallet_balance: String,
}

#[derive(Debug, Deserialize)]
pub struct FuturesPositionUpdate {
    #[serde(rename = "s")]
    pub symbol: String,
    #[serde(rename = "pa")]
    pub position_amt: String,
    #[serde(rename = "ep", default)]
    pub entry_price: String,
    #[serde(rename = "up", default)]
    pub unrealized_profit: String,
}
