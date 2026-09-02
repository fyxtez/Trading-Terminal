use std::{collections::HashMap, time::Duration};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, SqlitePool, sqlite::SqlitePoolOptions};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    trading_events::TradingEvent,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum AlertSide {
    Long,
    Short,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CrossingDirection {
    CrossUp,
    CrossDown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceAlert {
    pub id: Uuid,
    pub symbol: String,
    pub price: f64,
    pub side: AlertSide,
    pub pattern: Option<String>,
    pub additional_info: Option<String>,
    pub crossing: CrossingDirection,
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePriceAlert {
    pub symbol: String,
    pub price: f64,
    pub side: AlertSide,
    pub pattern: Option<String>,
    pub additional_info: Option<String>,
    pub crossing: Option<CrossingDirection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePriceAlert {
    pub price: f64,
    pub side: AlertSide,
    pub pattern: Option<String>,
    pub additional_info: Option<String>,
    pub crossing: Option<CrossingDirection>,
}

#[derive(Clone)]
pub struct AlertStore {
    pool: SqlitePool,
}

impl AlertStore {
    pub async fn connect(path: &str) -> AppResult<Self> {
        if let Some(parent) = std::path::Path::new(path).parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let url = format!("sqlite://{path}?mode=rwc");
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .map_err(|e| AppError::Config(format!("failed to open alerts database: {e}")))?;
        sqlx::query("PRAGMA journal_mode=WAL")
            .execute(&pool)
            .await
            .map_err(db_error)?;
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS price_alerts (
                id TEXT PRIMARY KEY,
                symbol TEXT NOT NULL,
                price REAL NOT NULL,
                side TEXT NOT NULL,
                pattern TEXT,
                additional_info TEXT,
                crossing TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'ACTIVE',
                created_at INTEGER NOT NULL,
                triggered_at INTEGER
            )
        "#,
        )
        .execute(&pool)
        .await
        .map_err(db_error)?;

        // FEATURE: migrate existing alert databases in place. CREATE TABLE IF
        // NOT EXISTS cannot add the new optional note column to old installs.
        let columns = sqlx::query("PRAGMA table_info(price_alerts)")
            .fetch_all(&pool)
            .await
            .map_err(db_error)?;
        let has_additional_info = columns
            .iter()
            .any(|row| row.try_get::<String, _>("name").ok().as_deref() == Some("additional_info"));
        if !has_additional_info {
            sqlx::query("ALTER TABLE price_alerts ADD COLUMN additional_info TEXT")
                .execute(&pool)
                .await
                .map_err(db_error)?;
        }
        Ok(Self { pool })
    }

    pub async fn list_active(&self, symbol: Option<&str>) -> AppResult<Vec<PriceAlert>> {
        let rows = if let Some(symbol) = symbol {
            sqlx::query("SELECT id,symbol,price,side,pattern,additional_info,crossing,created_at FROM price_alerts WHERE status='ACTIVE' AND symbol=? ORDER BY created_at")
                .bind(symbol).fetch_all(&self.pool).await
        } else {
            sqlx::query("SELECT id,symbol,price,side,pattern,additional_info,crossing,created_at FROM price_alerts WHERE status='ACTIVE' ORDER BY created_at")
                .fetch_all(&self.pool).await
        }.map_err(db_error)?;
        rows.into_iter().map(row_to_alert).collect()
    }

    pub async fn create(&self, req: CreatePriceAlert) -> AppResult<PriceAlert> {
        validate_price(req.price)?;
        let symbol = normalize_symbol(&req.symbol)?;
        let additional_info = normalize_additional_info(req.additional_info)?;
        let alert = PriceAlert {
            id: Uuid::new_v4(),
            symbol,
            price: req.price,
            side: req.side,
            pattern: normalize_pattern(req.pattern),
            additional_info,
            crossing: req.crossing.unwrap_or_else(|| default_crossing(req.side)),
            created_at: chrono::Utc::now().timestamp_millis(),
        };
        sqlx::query("INSERT INTO price_alerts(id,symbol,price,side,pattern,additional_info,crossing,status,created_at) VALUES(?,?,?,?,?,?,?,'ACTIVE',?)")
            .bind(alert.id.to_string()).bind(&alert.symbol).bind(alert.price)
            .bind(side_str(alert.side)).bind(&alert.pattern).bind(&alert.additional_info).bind(crossing_str(alert.crossing))
            .bind(alert.created_at).execute(&self.pool).await.map_err(db_error)?;
        Ok(alert)
    }

    pub async fn update(&self, id: Uuid, req: UpdatePriceAlert) -> AppResult<PriceAlert> {
        validate_price(req.price)?;
        let crossing = req.crossing.unwrap_or_else(|| default_crossing(req.side));
        let pattern = normalize_pattern(req.pattern);
        let additional_info = normalize_additional_info(req.additional_info)?;
        let result = sqlx::query("UPDATE price_alerts SET price=?,side=?,pattern=?,additional_info=?,crossing=? WHERE id=? AND status='ACTIVE'")
            .bind(req.price).bind(side_str(req.side)).bind(&pattern).bind(&additional_info).bind(crossing_str(crossing))
            .bind(id.to_string()).execute(&self.pool).await.map_err(db_error)?;
        if result.rows_affected() == 0 {
            return Err(AppError::NotFound("price alert not found".into()));
        }
        self.get(id).await
    }

    pub async fn get(&self, id: Uuid) -> AppResult<PriceAlert> {
        let row = sqlx::query("SELECT id,symbol,price,side,pattern,additional_info,crossing,created_at FROM price_alerts WHERE id=? AND status='ACTIVE'")
            .bind(id.to_string()).fetch_optional(&self.pool).await.map_err(db_error)?
            .ok_or_else(|| AppError::NotFound("price alert not found".into()))?;
        row_to_alert(row)
    }

    pub async fn delete(&self, id: Uuid) -> AppResult<()> {
        let result = sqlx::query("DELETE FROM price_alerts WHERE id=?")
            .bind(id.to_string())
            .execute(&self.pool)
            .await
            .map_err(db_error)?;
        if result.rows_affected() == 0 {
            return Err(AppError::NotFound("price alert not found".into()));
        }
        Ok(())
    }

    async fn consume_active(&self, id: Uuid) -> AppResult<bool> {
        let result = sqlx::query("DELETE FROM price_alerts WHERE id=? AND status='ACTIVE'")
            .bind(id.to_string())
            .execute(&self.pool)
            .await
            .map_err(db_error)?;
        Ok(result.rows_affected() == 1)
    }
}

#[derive(Debug, Deserialize)]
pub struct AlertListQuery {
    pub symbol: Option<String>,
}

#[derive(Clone)]
pub struct AlertRuntime {
    command_tx: mpsc::UnboundedSender<AlertCommand>,
}

#[derive(Debug)]
enum AlertCommand {
    Refresh,
}

impl AlertRuntime {
    pub fn refresh(&self) {
        let _ = self.command_tx.send(AlertCommand::Refresh);
    }
}

pub fn spawn_alert_worker(
    store: AlertStore,
    ws_base: String,
    trading_events: broadcast::Sender<TradingEvent>,
) -> (AlertRuntime, tokio::task::JoinHandle<()>) {
    let (command_tx, command_rx) = mpsc::unbounded_channel();
    let runtime = AlertRuntime { command_tx };
    let task = tokio::spawn(run_alert_worker(store, ws_base, trading_events, command_rx));
    (runtime, task)
}

async fn run_alert_worker(
    store: AlertStore,
    ws_base: String,
    trading_events: broadcast::Sender<TradingEvent>,
    mut command_rx: mpsc::UnboundedReceiver<AlertCommand>,
) {
    let mut retry = Duration::from_secs(1);

    loop {
        let alerts = match load_alert_map(&store).await {
            Ok(alerts) => alerts,
            Err(error) => {
                error!(%error, "Failed to load active price alerts");
                tokio::time::sleep(retry).await;
                retry = (retry * 2).min(Duration::from_secs(30));
                continue;
            }
        };

        if alerts.is_empty() {
            info!("No active price alerts; market stream is idle");
            if command_rx.recv().await.is_none() {
                return;
            }
            retry = Duration::from_secs(1);
            continue;
        }

        let url = build_agg_trade_url(&ws_base, alerts.keys());
        match connect_async(&url).await {
            Ok((socket, _)) => {
                info!(%url, symbols = alerts.len(), "Connected Binance aggTrade stream for price alerts");
                retry = Duration::from_secs(1);
                match run_connected(&store, socket, &trading_events, &mut command_rx, alerts).await
                {
                    Ok(ConnectedExit::Refresh) => {
                        info!("Price-alert subscriptions changed; reconnecting market stream");
                        continue;
                    }
                    Ok(ConnectedExit::CommandChannelClosed) => return,
                    Err(error) => warn!(%error, "Price-alert market websocket disconnected"),
                }
            }
            Err(error) => warn!(%error, %url, "Failed to connect price-alert market websocket"),
        }

        tokio::select! {
            _ = tokio::time::sleep(retry) => {}
            command = command_rx.recv() => {
                if command.is_none() { return; }
            }
        }
        retry = (retry * 2).min(Duration::from_secs(30));
    }
}

#[derive(Debug)]
enum ConnectedExit {
    Refresh,
    CommandChannelClosed,
}

async fn run_connected(
    store: &AlertStore,
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    trading_events: &broadcast::Sender<TradingEvent>,
    command_rx: &mut mpsc::UnboundedReceiver<AlertCommand>,
    mut alerts: HashMap<String, Vec<PriceAlert>>,
) -> Result<ConnectedExit, String> {
    let (mut sink, mut stream) = socket.split();
    let mut logged_first_market_event = false;

    loop {
        tokio::select! {
            command = command_rx.recv() => {
                return Ok(if command.is_some() {
                    ConnectedExit::Refresh
                } else {
                    ConnectedExit::CommandChannelClosed
                });
            }
            message = stream.next() => {
                let Some(message) = message else { return Err("websocket stream ended".into()); };
                match message.map_err(|e| e.to_string())? {
                    Message::Text(text) => {
                        let Some((symbol, price)) = parse_agg_trade(&text) else {
                            continue;
                        };

                        if !logged_first_market_event {
                            logged_first_market_event = true;
                            info!(%symbol, price, "Receiving Binance aggTrade prices for alerts");
                        }

                        let candidates = alerts.get(&symbol).cloned().unwrap_or_default();
                        if candidates.is_empty() {
                            continue;
                        }

                        let mut triggered_any = false;
                        for alert in candidates {
                            if !reached(price, alert.price, alert.crossing) {
                                continue;
                            }

                            match store.consume_active(alert.id).await {
                                Ok(true) => {
                                    triggered_any = true;
                                    info!(
                                        id = %alert.id,
                                        symbol = %alert.symbol,
                                        alert_price = alert.price,
                                        trigger_price = price,
                                        crossing = crossing_str(alert.crossing),
                                        "Price alert reached; removed from active alerts"
                                    );

                                    let _ = trading_events.send(TradingEvent::AlertTriggered {
                                        id: alert.id.to_string(),
                                        symbol: alert.symbol.clone(),
                                        price: alert.price,
                                        trigger_price: price,
                                        side: side_str(alert.side).into(),
                                        pattern: alert.pattern.clone(),
                                        triggered_at: chrono::Utc::now().timestamp_millis(),
                                    });

                                    // Notification delivery must not block processing the next
                                    // real-time trade event or another alert trigger.
                                    let notification_alert = alert.clone();
                                    tokio::spawn(async move {
                                        send_ntfy(&notification_alert).await;
                                    });
                                }
                                Ok(false) => {}
                                Err(error) => error!(%error, id=%alert.id, "Failed to remove triggered alert"),
                            }
                        }

                        if triggered_any {
                            alerts = load_alert_map(store).await.map_err(|e| e.to_string())?;
                            if alerts.is_empty() {
                                return Ok(ConnectedExit::Refresh);
                            }
                        }
                    }
                    Message::Ping(payload) => sink.send(Message::Pong(payload)).await.map_err(|e| e.to_string())?,
                    Message::Close(_) => return Err("websocket closed".into()),
                    _ => {}
                }
            }
        }
    }
}

async fn load_alert_map(store: &AlertStore) -> AppResult<HashMap<String, Vec<PriceAlert>>> {
    let mut map: HashMap<String, Vec<PriceAlert>> = HashMap::new();
    for alert in store.list_active(None).await? {
        map.entry(alert.symbol.clone()).or_default().push(alert);
    }
    Ok(map)
}

fn build_agg_trade_url<'a>(ws_base: &str, symbols: impl Iterator<Item = &'a String>) -> String {
    let base = ws_base
        .trim_end_matches('/')
        .trim_end_matches("/ws")
        .trim_end_matches("/stream")
        .trim_end_matches("/public")
        .trim_end_matches("/market")
        .trim_end_matches("/private");

    let streams = symbols
        .map(|symbol| format!("{}@aggTrade", symbol.to_ascii_lowercase()))
        .collect::<Vec<_>>()
        .join("/");

    format!("{base}/market/stream?streams={streams}")
}

fn parse_agg_trade(text: &str) -> Option<(String, f64)> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    let payload = value.get("data").unwrap_or(&value);
    if payload.get("e")?.as_str()? != "aggTrade" {
        return None;
    }

    let symbol = payload.get("s")?.as_str()?.to_owned();
    let price = payload.get("p")?.as_str()?.parse::<f64>().ok()?;
    Some((symbol, price))
}

fn reached(current: f64, target: f64, direction: CrossingDirection) -> bool {
    match direction {
        CrossingDirection::CrossUp => current >= target,
        CrossingDirection::CrossDown => current <= target,
    }
}

const DEFAULT_PUBLIC_TERMINAL_URL: &str = "https://demo.terminal.fyxtez.com";

async fn send_ntfy(alert: &PriceAlert) {
    let url = std::env::var("NTFY_URL").unwrap_or_default();
    // FEATURE: derive the same base-ticker route used by the frontend so both
    // persistent and browser-owned alerts deep-link to one consistent chart.
    let public_terminal_url = std::env::var("PUBLIC_TERMINAL_URL")
        .unwrap_or_else(|_| DEFAULT_PUBLIC_TERMINAL_URL.to_owned());
    let route_symbol = alert.symbol.strip_suffix("USDT").unwrap_or(&alert.symbol);
    let chart_url = format!(
        "{}/{}",
        public_terminal_url.trim_end_matches('/'),
        route_symbol,
    );

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            error!(%error, "Failed to build ntfy HTTP client");
            return;
        }
    };

    let title = format!("{} {} alert", alert.symbol, side_str(alert.side));
    let pattern = alert
        .pattern
        .as_deref()
        .filter(|value| !value.is_empty() && *value != "none")
        .map(|value| format!("{} ", value.to_uppercase()))
        .unwrap_or_default();
    // FEATURE: omit the noisy trigger-market price, append optional user
    // context, then show the chart URL as a visible/copyable final line.
    let mut body = format!(
        "{}{side} alert reached {price:.4}",
        pattern,
        side = side_str(alert.side),
        price = alert.price,
    );
    if let Some(additional_info) = alert.additional_info.as_deref() {
        body.push('\n');
        body.push_str(additional_info);
    }
    body.push('\n');
    body.push_str(&chart_url);

    let mut request = client
        .post(&url)
        .header("Title", title)
        .header("Tags", "chart_with_upwards_trend")
        // FEATURE: ntfy's Click header makes the entire notification actionable
        // instead of requiring the user to tap the visible URL in the body.
        .header("Click", &chart_url)
        .body(body.clone());

    // TODO: Use tokio::join! to send both Telegram and ntfy notifications concurrently instead of sequentially.
    if let Err(error) = telegram_notify::send(&body).await {
        warn!(
            alert_id = %alert.id,
            %error,
            "Failed to send Telegram price-alert notification"
        );
    }

    if url.trim().is_empty() {
        warn!(
            alert_id = %alert.id,
            "ntfy notification skipped because NTFY_URL is not configured"
        );
        return;
    }

    if let Ok(token) = std::env::var("NTFY_TOKEN")
        && !token.trim().is_empty()
    {
        request = request.bearer_auth(token.trim());
    }

    match request.send().await {
        Ok(response) if response.status().is_success() => {
            info!(id = %alert.id, status = %response.status(), "ntfy price-alert notification sent");
        }
        Ok(response) => {
            let status = response.status();
            let response_body = response.text().await.unwrap_or_default();
            warn!(id = %alert.id, %status, body = %response_body, "ntfy rejected price-alert notification");
        }
        Err(error) => {
            warn!(id = %alert.id, %error, "Failed to send ntfy price-alert notification");
        }
    }
}

fn row_to_alert(row: sqlx::sqlite::SqliteRow) -> AppResult<PriceAlert> {
    let id: String = row.try_get("id").map_err(db_error)?;
    Ok(PriceAlert {
        id: Uuid::parse_str(&id)
            .map_err(|e| AppError::Config(format!("invalid alert id in database: {e}")))?,
        symbol: row.try_get("symbol").map_err(db_error)?,
        price: row.try_get("price").map_err(db_error)?,
        side: parse_side(row.try_get::<String, _>("side").map_err(db_error)?.as_str())?,
        pattern: row.try_get("pattern").map_err(db_error)?,
        additional_info: row.try_get("additional_info").map_err(db_error)?,
        crossing: parse_crossing(
            row.try_get::<String, _>("crossing")
                .map_err(db_error)?
                .as_str(),
        )?,
        created_at: row.try_get("created_at").map_err(db_error)?,
    })
}
fn db_error(error: sqlx::Error) -> AppError {
    AppError::Config(format!("alerts database error: {error}"))
}
fn validate_price(price: f64) -> AppResult<()> {
    if price.is_finite() && price > 0.0 {
        Ok(())
    } else {
        Err(AppError::Invalid(
            "alert price must be finite and greater than zero".into(),
        ))
    }
}
fn normalize_symbol(value: &str) -> AppResult<String> {
    let s = value.trim().to_uppercase();
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_alphanumeric()) {
        Err(AppError::Invalid("invalid alert symbol".into()))
    } else {
        Ok(s)
    }
}
fn normalize_pattern(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty())
}
// FEATURE: trim notes, store blank input as NULL, and bound notification text
// so a frontend or direct API client cannot persist an unreasonably large body.
fn normalize_additional_info(value: Option<String>) -> AppResult<Option<String>> {
    let normalized = value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    if normalized.as_ref().is_some_and(|v| v.chars().count() > 500) {
        return Err(AppError::Invalid(
            "additional alert info cannot exceed 500 characters".into(),
        ));
    }
    Ok(normalized)
}
fn default_crossing(side: AlertSide) -> CrossingDirection {
    match side {
        AlertSide::Long => CrossingDirection::CrossDown,
        AlertSide::Short => CrossingDirection::CrossUp,
    }
}
fn side_str(side: AlertSide) -> &'static str {
    match side {
        AlertSide::Long => "LONG",
        AlertSide::Short => "SHORT",
    }
}
fn crossing_str(value: CrossingDirection) -> &'static str {
    match value {
        CrossingDirection::CrossUp => "CROSS_UP",
        CrossingDirection::CrossDown => "CROSS_DOWN",
    }
}
fn parse_side(value: &str) -> AppResult<AlertSide> {
    match value {
        "LONG" => Ok(AlertSide::Long),
        "SHORT" => Ok(AlertSide::Short),
        _ => Err(AppError::Config(format!(
            "invalid alert side in database: {value}"
        ))),
    }
}
fn parse_crossing(value: &str) -> AppResult<CrossingDirection> {
    match value {
        "CROSS_UP" => Ok(CrossingDirection::CrossUp),
        "CROSS_DOWN" => Ok(CrossingDirection::CrossDown),
        _ => Err(AppError::Config(format!(
            "invalid crossing in database: {value}"
        ))),
    }
}
