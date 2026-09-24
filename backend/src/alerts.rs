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
    diagnostics::DiagnosticsState,
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
    /// Supplies inert route state while alerts are disabled without opening,
    /// migrating, or reading the user's persisted alert database.
    pub fn disabled() -> Self {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_lazy("sqlite::memory:")
            .expect("the static in-memory SQLite URL must be valid");
        Self { pool }
    }

    pub async fn connect(path: impl AsRef<std::path::Path>) -> AppResult<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let url = format!("sqlite://{}?mode=rwc", path.display());
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

        // migrate existing alert databases in place. CREATE TABLE IF
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
        sqlx::query("CREATE TABLE IF NOT EXISTS alert_delivery (id TEXT PRIMARY KEY, payload TEXT NOT NULL, ntfy_pending INTEGER NOT NULL DEFAULT 1, telegram_pending INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0)")
            .execute(&pool).await.map_err(db_error)?;
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

    async fn consume_active(&self, alert: &PriceAlert) -> AppResult<bool> {
        // A market tick can race an API edit. Only consume the exact version
        // evaluated by the worker, never a newly moved or relabelled alert.
        let mut transaction = self.pool.begin().await.map_err(db_error)?;
        let result = sqlx::query("UPDATE price_alerts SET status='TRIGGERED', triggered_at=? WHERE id=? AND status='ACTIVE' AND price=? AND side=? AND crossing=? AND pattern IS ? AND additional_info IS ?")
            .bind(chrono::Utc::now().timestamp_millis())
            .bind(alert.id.to_string())
            .bind(alert.price)
            .bind(side_str(alert.side))
            .bind(crossing_str(alert.crossing))
            .bind(&alert.pattern)
            .bind(&alert.additional_info)
            .execute(&mut *transaction)
            .await
            .map_err(db_error)?;
        let consumed = result.rows_affected() == 1;
        if consumed {
            let payload =
                serde_json::to_string(alert).map_err(|e| AppError::Config(e.to_string()))?;
            sqlx::query("INSERT INTO alert_delivery(id, payload) VALUES(?, ?)")
                .bind(alert.id.to_string())
                .bind(payload)
                .execute(&mut *transaction)
                .await
                .map_err(db_error)?;
        }
        transaction.commit().await.map_err(db_error)?;
        Ok(consumed)
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
    /// Keeps alert route state constructible while the product feature is
    /// dormant, without starting the market websocket worker.
    pub fn disabled() -> Self {
        let (command_tx, command_rx) = mpsc::unbounded_channel();
        drop(command_rx);
        Self { command_tx }
    }

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
        match tokio::time::timeout(Duration::from_secs(20), connect_async(&url)).await {
            Err(_) => warn!(%url, "Timed out connecting price-alert market websocket"),
            Ok(Ok((socket, _))) => {
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
            Ok(Err(error)) => warn!(%error, %url, "Failed to connect price-alert market websocket"),
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
            message = tokio::time::timeout(Duration::from_secs(90), stream.next()) => {
                let message = message.map_err(|_| "price-alert market stream timed out".to_owned())?;
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

                            match store.consume_active(&alert).await {
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

                                    // Delivery is committed in the same transaction as the trigger.
                                    // A separate worker retries it even after a server restart.
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
    (price.is_finite() && price > 0.0).then_some((symbol, price))
}

fn reached(current: f64, target: f64, direction: CrossingDirection) -> bool {
    match direction {
        CrossingDirection::CrossUp => current >= target,
        CrossingDirection::CrossDown => current <= target,
    }
}

const DEFAULT_PUBLIC_TERMINAL_URL: &str = "https://terminal.fyxtez.com";

struct NotificationCredentials {
    ntfy_url: Result<Option<zeroize::Zeroizing<String>>, String>,
    telegram: Result<Option<crate::secure_store::SecretPair>, String>,
}

fn read_notification_credentials(
    reader: &impl crate::secure_store::SecretReader,
) -> NotificationCredentials {
    use crate::secure_store::{NTFY_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, read_pair_from};
    // A broken or incomplete channel must not prevent the other channel sending.
    let ntfy_url = reader.read(NTFY_URL);
    let telegram = read_pair_from(reader, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID).and_then(|pair| {
        if let Some((token, chat_id)) = pair.as_ref() {
            let valid_token = token.split_once(':').is_some_and(|(id, secret)| {
                !id.is_empty()
                    && id.bytes().all(|c| c.is_ascii_digit())
                    && !secret.is_empty()
                    && secret
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
            });
            let digits = chat_id.strip_prefix('-').unwrap_or(chat_id);
            if !valid_token || digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
                return Err("Telegram requires a valid bot token and numeric chat ID".into());
            }
        }
        Ok(pair)
    });
    NotificationCredentials { ntfy_url, telegram }
}

fn load_notification_credentials() -> Result<NotificationCredentials, String> {
    use crate::secure_store::{FileSecretReader, PlatformSecretReader};
    if let Some(path) = std::env::var_os("NOTIFICATION_CREDENTIALS_FILE") {
        Ok(read_notification_credentials(&FileSecretReader::load(
            std::path::Path::new(&path),
        )?))
    } else if std::env::var_os("BINANCE_CREDENTIALS_FILE").is_some() {
        Ok(NotificationCredentials {
            ntfy_url: Ok(None),
            telegram: Ok(None),
        })
    } else {
        Ok(read_notification_credentials(&PlatformSecretReader))
    }
}

async fn send_notifications(
    alert: &PriceAlert,
    trading_events: &broadcast::Sender<TradingEvent>,
    diagnostics: &DiagnosticsState,
    ntfy_pending: bool,
    telegram_pending: bool,
) -> (bool, bool) {
    let credentials = match tokio::task::spawn_blocking(load_notification_credentials).await {
        Ok(Ok(credentials)) => credentials,
        Ok(Err(error)) => {
            report_notification_failure(
                diagnostics,
                trading_events,
                "credential-store",
                alert,
                &error,
            );
            warn!(alert_id = %alert.id, %error, "Could not read notification credentials");
            return (!ntfy_pending, !telegram_pending);
        }
        Err(error) => {
            report_notification_failure(
                diagnostics,
                trading_events,
                "credential-store",
                alert,
                "Notification credential task failed",
            );
            warn!(alert_id = %alert.id, %error, "Notification credential task failed");
            return (!ntfy_pending, !telegram_pending);
        }
    };

    send_with_credentials(
        alert,
        trading_events,
        diagnostics,
        (ntfy_pending, telegram_pending),
        credentials,
        "https://api.telegram.org",
    )
    .await
}

async fn send_with_credentials(
    alert: &PriceAlert,
    trading_events: &broadcast::Sender<TradingEvent>,
    diagnostics: &DiagnosticsState,
    pending: (bool, bool),
    credentials: NotificationCredentials,
    telegram_base: &str,
) -> (bool, bool) {
    let (ntfy_pending, telegram_pending) = pending;
    let mut ntfy_sent = !ntfy_pending;
    let mut telegram_sent = !telegram_pending;
    for (channel, error, pending) in [
        ("ntfy", credentials.ntfy_url.as_ref().err(), ntfy_pending),
        (
            "telegram",
            credentials.telegram.as_ref().err(),
            telegram_pending,
        ),
    ] {
        if let Some(error) = error.filter(|_| pending) {
            report_notification_failure(diagnostics, trading_events, channel, alert, error);
        }
    }

    // derive the same base-ticker route used by the frontend so both
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
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            report_notification_failure(
                diagnostics,
                trading_events,
                "notification-client",
                alert,
                "Could not initialize notification delivery",
            );
            error!(%error, "Failed to build ntfy HTTP client");
            return (ntfy_sent, telegram_sent);
        }
    };

    let title = format!("{} {} alert", alert.symbol, side_str(alert.side));
    let pattern = alert
        .pattern
        .as_deref()
        .filter(|value| !value.is_empty() && *value != "none")
        .map(|value| format!("{} ", value.to_uppercase()))
        .unwrap_or_default();
    // omit the noisy trigger-market price, append optional user
    // context, then show the chart URL as a visible/copyable final line.
    let mut body = format!(
        "{symbol} {pattern}{side} alert reached {price}",
        symbol = alert.symbol,
        side = side_str(alert.side),
        price = alert.price,
    );
    if let Some(additional_info) = alert.additional_info.as_deref() {
        body.push('\n');
        body.push_str(additional_info);
    }
    body.push('\n');
    body.push_str(&chart_url);

    if let Some((bot_token, chat_id)) = credentials
        .telegram
        .ok()
        .flatten()
        .filter(|_| telegram_pending)
    {
        let telegram_url = format!("{telegram_base}/bot{}/sendMessage", bot_token.as_str());
        match client
            .post(telegram_url)
            .json(&serde_json::json!({
                "chat_id": chat_id.as_str(),
                "text": body.as_str(),
            }))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                telegram_sent = response
                    .json::<Value>()
                    .await
                    .ok()
                    .and_then(|body| body.get("ok").and_then(Value::as_bool))
                    == Some(true);
                if telegram_sent {
                    info!(id = %alert.id, "Telegram price-alert notification sent");
                } else {
                    report_notification_failure(
                        diagnostics,
                        trading_events,
                        "telegram",
                        alert,
                        "Telegram did not confirm delivery",
                    );
                }
            }
            Ok(response) => {
                let message = format!("Telegram rejected delivery ({})", response.status());
                report_notification_failure(
                    diagnostics,
                    trading_events,
                    "telegram",
                    alert,
                    &message,
                );
                warn!(
                    id = %alert.id,
                    status = %response.status(),
                    "Telegram rejected price-alert notification"
                );
            }
            Err(_) => {
                report_notification_failure(
                    diagnostics,
                    trading_events,
                    "telegram",
                    alert,
                    "Telegram request failed",
                );
                // Do not log reqwest's URL because Telegram embeds the bot token in it.
                warn!(id = %alert.id, "Failed to send Telegram price-alert notification");
            }
        }
    } else if telegram_pending {
        warn!(
            alert_id = %alert.id,
            "Telegram notification skipped because it is not configured"
        );
    }

    if !ntfy_pending {
        return (ntfy_sent, telegram_sent);
    }
    let Some(url) = credentials.ntfy_url.ok().flatten() else {
        warn!(
            alert_id = %alert.id,
            "ntfy notification skipped because it is not configured"
        );
        return (ntfy_sent, telegram_sent);
    };

    match client
        .post(url.as_str())
        .header("Title", title)
        .header("Tags", "chart_with_upwards_trend")
        // ntfy's Click header makes the entire notification actionable
        // instead of requiring the user to tap the visible URL in the body.
        .header("Click", &chart_url)
        .body(body)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            ntfy_sent = true;
            info!(id = %alert.id, status = %response.status(), "ntfy price-alert notification sent");
        }
        Ok(response) => {
            let status = response.status();
            let message = format!("ntfy rejected delivery ({status})");
            report_notification_failure(diagnostics, trading_events, "ntfy", alert, &message);
            warn!(id = %alert.id, %status, "ntfy rejected price-alert notification");
        }
        Err(_) => {
            report_notification_failure(
                diagnostics,
                trading_events,
                "ntfy",
                alert,
                "ntfy request failed",
            );
            // The topic is part of the private URL, so never include reqwest's URL in logs.
            warn!(id = %alert.id, "Failed to send ntfy price-alert notification");
        }
    }
    (ntfy_sent, telegram_sent)
}

/// Durable delivery is independent of price processing and client lifetimes.
/// Providers are at-least-once: a crash after HTTP success but before the local
/// acknowledgement can produce a duplicate, never silently discard the alert.
pub fn spawn_delivery_worker(
    store: AlertStore,
    events: broadcast::Sender<TradingEvent>,
    diagnostics: DiagnosticsState,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if let Err(error) = deliver_pending(&store, &events, &diagnostics).await {
                error!(%error, "Failed to process alert delivery queue");
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    })
}

async fn deliver_pending(
    store: &AlertStore,
    events: &broadcast::Sender<TradingEvent>,
    diagnostics: &DiagnosticsState,
) -> AppResult<()> {
    let rows = sqlx::query("SELECT id,payload,ntfy_pending,telegram_pending,attempts FROM alert_delivery WHERE (ntfy_pending=1 OR telegram_pending=1) AND retry_at<=? ORDER BY retry_at LIMIT 20")
        .bind(chrono::Utc::now().timestamp_millis()).fetch_all(&store.pool).await.map_err(db_error)?;
    for row in rows {
        let id: String = row.try_get("id").map_err(db_error)?;
        let payload: String = row.try_get("payload").map_err(db_error)?;
        let alert: PriceAlert =
            serde_json::from_str(&payload).map_err(|e| AppError::Config(e.to_string()))?;
        let attempts: i64 = row.try_get("attempts").map_err(db_error)?;
        let (ntfy_sent, telegram_sent) = send_notifications(
            &alert,
            events,
            diagnostics,
            row.try_get::<bool, _>("ntfy_pending").map_err(db_error)?,
            row.try_get::<bool, _>("telegram_pending")
                .map_err(db_error)?,
        )
        .await;
        record_delivery_attempt(store, &id, attempts, (ntfy_sent, telegram_sent)).await?;
    }
    Ok(())
}

async fn record_delivery_attempt(
    store: &AlertStore,
    id: &str,
    attempts: i64,
    sent: (bool, bool),
) -> AppResult<()> {
    let delay = 5_000_i64 * (1_i64 << attempts.clamp(0, 6));
    sqlx::query("UPDATE alert_delivery SET ntfy_pending=?,telegram_pending=?,attempts=attempts+1,retry_at=? WHERE id=?")
        .bind(!sent.0).bind(!sent.1)
        .bind(chrono::Utc::now().timestamp_millis() + delay).bind(id)
        .execute(&store.pool).await.map_err(db_error)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryStatus {
    ntfy_configured: bool,
    telegram_configured: bool,
    pending_deliveries: i64,
}

pub async fn delivery_status(store: &AlertStore) -> AppResult<DeliveryStatus> {
    let credentials = tokio::task::spawn_blocking(load_notification_credentials)
        .await
        .map_err(|_| AppError::Config("Notification credential task failed".into()))?
        .map_err(AppError::Config)?;
    let pending_deliveries = sqlx::query_scalar(
        "SELECT COUNT(*) FROM alert_delivery WHERE ntfy_pending=1 OR telegram_pending=1",
    )
    .fetch_one(&store.pool)
    .await
    .map_err(db_error)?;
    Ok(DeliveryStatus {
        ntfy_configured: credentials.ntfy_url.as_ref().is_ok_and(Option::is_some),
        telegram_configured: credentials.telegram.as_ref().is_ok_and(Option::is_some),
        pending_deliveries,
    })
}

fn report_notification_failure(
    diagnostics: &DiagnosticsState,
    trading_events: &broadcast::Sender<TradingEvent>,
    channel: &str,
    alert: &PriceAlert,
    message: &str,
) {
    diagnostics.notification_failure(channel, message);
    let _ = trading_events.send(TradingEvent::NotificationFailed {
        alert_id: alert.id.to_string(),
        symbol: alert.symbol.clone(),
        channel: channel.into(),
        context: format!("{} price alert", alert.symbol),
        message: message.into(),
        occurred_at: chrono::Utc::now().timestamp_millis(),
    });
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
// trim notes, store blank input as NULL, and bound notification text
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

#[cfg(test)]
mod tests {
    use super::*;

    fn create_request() -> CreatePriceAlert {
        CreatePriceAlert {
            symbol: "btcusdt".into(),
            price: 100.0,
            side: AlertSide::Short,
            crossing: Some(CrossingDirection::CrossUp),
            pattern: None,
            additional_info: Some("context".into()),
        }
    }

    #[tokio::test]
    async fn restart_retains_active_alerts_and_atomically_queues_each_trigger_once() {
        let path = std::env::temp_dir().join(format!("alert-test-{}.sqlite3", Uuid::new_v4()));
        let store = AlertStore::connect(&path).await.unwrap();
        let alert = store.create(create_request()).await.unwrap();
        store.pool.close().await;
        let store = AlertStore::connect(&path).await.unwrap();
        assert_eq!(store.list_active(None).await.unwrap()[0].id, alert.id);
        assert!(store.consume_active(&alert).await.unwrap());
        assert!(!store.consume_active(&alert).await.unwrap());
        assert!(store.list_active(None).await.unwrap().is_empty());
        store.pool.close().await;
        let store = AlertStore::connect(&path).await.unwrap();
        let row = sqlx::query("SELECT payload,ntfy_pending,telegram_pending FROM alert_delivery")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        let queued: PriceAlert = serde_json::from_str(&row.get::<String, _>("payload")).unwrap();
        assert_eq!(queued.id, alert.id);
        assert!(row.get::<bool, _>("ntfy_pending"));
        assert!(row.get::<bool, _>("telegram_pending"));
        assert!(store.list_active(None).await.unwrap().is_empty());
        store.pool.close().await;
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn stale_worker_cannot_trigger_a_moved_or_deleted_alert() {
        let store = AlertStore::connect(":memory:").await.unwrap();
        let old = store.create(create_request()).await.unwrap();
        let updated = store
            .update(
                old.id,
                UpdatePriceAlert {
                    price: 120.0,
                    side: old.side,
                    crossing: Some(old.crossing),
                    pattern: old.pattern.clone(),
                    additional_info: old.additional_info.clone(),
                },
            )
            .await
            .unwrap();
        assert!(!store.consume_active(&old).await.unwrap());
        assert_eq!(store.get(old.id).await.unwrap().price, 120.0);
        store.delete(old.id).await.unwrap();
        assert!(!store.consume_active(&updated).await.unwrap());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM alert_delivery")
                .fetch_one(&store.pool)
                .await
                .unwrap(),
            0
        );
    }

    struct NotificationReader {
        ntfy: String,
        token: Option<&'static str>,
        chat_id: Option<&'static str>,
    }

    impl crate::secure_store::SecretReader for NotificationReader {
        fn read(&self, name: &str) -> Result<Option<zeroize::Zeroizing<String>>, String> {
            use crate::secure_store::{NTFY_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID};
            Ok(match name {
                NTFY_URL => Some(self.ntfy.as_str()),
                TELEGRAM_BOT_TOKEN => self.token,
                TELEGRAM_CHAT_ID => self.chat_id,
                _ => None,
            }
            .map(|value| zeroize::Zeroizing::new(value.to_owned())))
        }
    }

    #[tokio::test]
    async fn retries_only_failed_channels_after_restart_and_isolates_bad_credentials() {
        use axum::{http::StatusCode, routing::post};
        use std::sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        };
        let ntfy_count = Arc::new(AtomicUsize::new(0));
        let telegram_count = Arc::new(AtomicUsize::new(0));
        let messages = Arc::new(Mutex::new(Vec::<String>::new()));
        let app = axum::Router::new()
            .route(
                "/ntfy",
                post({
                    let count = ntfy_count.clone();
                    let messages = messages.clone();
                    move |body: String| {
                        count.fetch_add(1, Ordering::SeqCst);
                        messages.lock().unwrap().push(body);
                        async { StatusCode::OK }
                    }
                }),
            )
            .route(
                "/telegram/{*path}",
                post({
                    let count = telegram_count.clone();
                    move || {
                        let attempt = count.fetch_add(1, Ordering::SeqCst);
                        async move {
                            let status = if attempt == 0 {
                                StatusCode::SERVICE_UNAVAILABLE
                            } else {
                                StatusCode::OK
                            };
                            (
                                status,
                                axum::Json(serde_json::json!({ "ok": attempt >= 2 })),
                            )
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let reader = NotificationReader {
            ntfy: format!("{base}/ntfy"),
            token: Some("123:test"),
            chat_id: Some("42"),
        };
        let path =
            std::env::temp_dir().join(format!("alert-delivery-test-{}.sqlite3", Uuid::new_v4()));
        let store = AlertStore::connect(&path).await.unwrap();
        let mut request = create_request();
        request.price = 0.00000123;
        let alert = store.create(request).await.unwrap();
        assert!(store.consume_active(&alert).await.unwrap());
        let (events, _) = broadcast::channel(16);
        let diagnostics = DiagnosticsState::new(false);
        let sent = send_with_credentials(
            &alert,
            &events,
            &diagnostics,
            (true, true),
            read_notification_credentials(&reader),
            &format!("{base}/telegram"),
        )
        .await;
        assert_eq!(sent, (true, false));
        record_delivery_attempt(&store, &alert.id.to_string(), 0, sent)
            .await
            .unwrap();
        store.pool.close().await;
        let store = AlertStore::connect(&path).await.unwrap();
        for attempt in 1..=2 {
            let row =
                sqlx::query("SELECT ntfy_pending,telegram_pending FROM alert_delivery WHERE id=?")
                    .bind(alert.id.to_string())
                    .fetch_one(&store.pool)
                    .await
                    .unwrap();
            let pending = (
                row.get::<bool, _>("ntfy_pending"),
                row.get::<bool, _>("telegram_pending"),
            );
            assert_eq!(pending, (false, true));
            let sent = send_with_credentials(
                &alert,
                &events,
                &diagnostics,
                pending,
                read_notification_credentials(&reader),
                &format!("{base}/telegram"),
            )
            .await;
            assert_eq!(sent, (true, attempt == 2));
            record_delivery_attempt(&store, &alert.id.to_string(), attempt, sent)
                .await
                .unwrap();
        }
        assert_eq!(ntfy_count.load(Ordering::SeqCst), 1);
        assert_eq!(telegram_count.load(Ordering::SeqCst), 3);
        assert!(messages.lock().unwrap()[0].contains("BTCUSDT SHORT alert reached 0.00000123"));
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM alert_delivery WHERE ntfy_pending=1 OR telegram_pending=1"
            )
            .fetch_one(&store.pool)
            .await
            .unwrap(),
            0
        );

        // Half-configured and invalid Telegram values must not prevent ntfy delivery.
        for (token, chat_id) in [(Some("123:test"), None), (Some("invalid"), Some("invalid"))] {
            let credentials = read_notification_credentials(&NotificationReader {
                ntfy: format!("{base}/ntfy"),
                token,
                chat_id,
            });
            assert!(credentials.telegram.is_err());
            let sent = send_with_credentials(
                &alert,
                &events,
                &diagnostics,
                (true, true),
                credentials,
                &format!("{base}/telegram"),
            )
            .await;
            assert_eq!(sent, (true, false));
        }
        assert_eq!(ntfy_count.load(Ordering::SeqCst), 3);
        assert_eq!(telegram_count.load(Ordering::SeqCst), 3);
        store.pool.close().await;
        std::fs::remove_file(path).unwrap();
        server.abort();
    }

    #[test]
    fn reconnect_uses_reached_level_and_rejects_invalid_prices() {
        assert!(reached(105.0, 100.0, CrossingDirection::CrossUp));
        assert!(reached(95.0, 100.0, CrossingDirection::CrossDown));
        assert!(!reached(95.0, 100.0, CrossingDirection::CrossUp));
        assert!(parse_agg_trade(r#"{"e":"aggTrade","s":"BTCUSDT","p":"NaN"}"#).is_none());
        assert_eq!(
            parse_agg_trade(r#"{"data":{"e":"aggTrade","s":"BTCUSDT","p":"100"}}"#),
            Some(("BTCUSDT".into(), 100.0))
        );
    }
}
