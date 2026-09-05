use std::{fmt, future::Future, path::PathBuf, time::Duration};

use chrono::Utc;
use serde::Serialize;
use serde_json::Value;
use tokio::{sync::broadcast, task::JoinHandle, time::Instant};
use uuid::Uuid;

use crate::{
    account_state::{AccountState, spawn_refresh_worker as spawn_account_refresh_worker},
    binance::{BinanceClient, round_to_tick},
    binance_stream,
    diagnostics::DiagnosticsState,
    error::{AppError, AppResult},
    models::{FuturesAccountInfo, OrderSide, SymbolFilters},
    operation_safety::{IntentDecision, OperationSafety},
    position_risk_state::{
        PositionRiskState, spawn_refresh_worker as spawn_position_risk_refresh_worker,
    },
    trading_events::TradingEvent,
};

const MAX_SOAK_SECONDS: u64 = 60 * 60;
const STREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(25);
const STREAM_DROP_TIMEOUT: Duration = Duration::from_secs(5);
const STREAM_RECONNECT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct DrillConfig {
    pub execute: bool,
    pub confirm_testnet_mutations: bool,
    pub symbol: String,
    pub soak_seconds: u64,
    pub report_path: Option<PathBuf>,
}

impl Default for DrillConfig {
    fn default() -> Self {
        Self {
            execute: false,
            confirm_testnet_mutations: false,
            symbol: "BTCUSDT".into(),
            soak_seconds: 0,
            report_path: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum StepStatus {
    Pass,
    Fail,
    Skip,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillStep {
    name: String,
    status: StepStatus,
    detail: String,
    duration_ms: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillReport {
    started_at: String,
    finished_at: String,
    network: &'static str,
    mode: &'static str,
    symbol: String,
    steps: Vec<DrillStep>,
}

impl DrillReport {
    pub fn passed(&self) -> bool {
        self.steps
            .iter()
            .all(|step| step.status != StepStatus::Fail)
    }
}

impl fmt::Display for DrillReport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(
            formatter,
            "\nBinance Testnet failure drill — {} ({})",
            self.symbol, self.mode
        )?;
        for step in &self.steps {
            writeln!(
                formatter,
                "[{:<4}] {:<34} {} ({} ms)",
                match step.status {
                    StepStatus::Pass => "PASS",
                    StepStatus::Fail => "FAIL",
                    StepStatus::Skip => "SKIP",
                },
                step.name,
                step.detail,
                step.duration_ms
            )?;
        }
        write!(
            formatter,
            "Result: {}",
            if self.passed() { "PASS" } else { "FAIL" }
        )
    }
}

pub async fn run(config: DrillConfig) -> AppResult<DrillReport> {
    validate_config(&config)?;
    let report_path = config.report_path.clone();
    let started_at = Utc::now().to_rfc3339();
    let mut report = DrillReport {
        started_at,
        finished_at: String::new(),
        network: "testnet",
        mode: if config.execute {
            "execute"
        } else {
            "preflight"
        },
        symbol: config.symbol.trim().to_ascii_uppercase(),
        steps: Vec::new(),
    };

    let client = BinanceClient::from_secure_store(true)?;
    if !client.is_testnet() {
        return Err(AppError::Config(
            "drill refused: desktop Binance network is not DEMO/Testnet".into(),
        ));
    }
    if !client.is_configured() {
        return Err(AppError::Config(
            "drill refused: configure DEMO/Testnet Binance credentials in desktop Settings first"
                .into(),
        ));
    }
    pass(
        &mut report,
        "hard Mainnet gate",
        "stored desktop network is DEMO/Testnet",
        0,
    );

    let symbol = report.symbol.clone();
    let (elapsed, connectivity) = timed(async {
        client.sync_server_time().await?;
        client.initialize_reference_data().await?;
        let price = client.price(&symbol).await?;
        let filters = client.symbol_filters(&symbol).await?;
        let account = client.account_info().await?;
        let risks = client.position_risk().await?;
        let orders = client.open_orders(&symbol).await?;
        Ok::<_, AppError>((price, filters, account, risks, orders))
    })
    .await;

    let (market_price, filters, baseline_account, baseline_risks, initial_orders) =
        match connectivity {
            Ok(snapshot) => {
                pass(
                    &mut report,
                    "authoritative preflight",
                    "time, filters, account, position risk and open orders loaded",
                    elapsed,
                );
                snapshot
            }
            Err(error) => {
                fail(
                    &mut report,
                    "authoritative preflight",
                    error.to_string(),
                    elapsed,
                );
                return finish(report, report_path).await;
            }
        };

    let baseline_position = position_amount(&baseline_account, &symbol)?;
    let initial_order_count = order_array(&initial_orders)?.len();
    if has_any_position(&baseline_account, &symbol)? || initial_order_count != 0 {
        fail(
            &mut report,
            "clean-symbol safety gate",
            format!(
                "refused: position={baseline_position}, open_orders={initial_order_count}; use a flat symbol with no orders"
            ),
            0,
        );
        return finish(report, report_path).await;
    }
    pass(
        &mut report,
        "clean-symbol safety gate",
        "no position and no open orders on the drill symbol",
        0,
    );

    if !config.execute {
        skip(
            &mut report,
            "mutating failure scenarios",
            "rerun with --execute --confirm-testnet-mutations",
        );
        return finish(report, report_path).await;
    }

    let uncertain_intent = drill_uncertain_intent().await;
    record_result(
        &mut report,
        "uncertain intent fails closed",
        uncertain_intent,
    );

    let (elapsed, isolated) = timed(client.ensure_isolated_margin(&symbol)).await;
    match isolated {
        Ok(()) => pass(
            &mut report,
            "isolated-margin safety gate",
            "drill symbol is configured for ISOLATED margin",
            elapsed,
        ),
        Err(error) => {
            fail(
                &mut report,
                "isolated-margin safety gate",
                error.to_string(),
                elapsed,
            );
            return finish(report, report_path).await;
        }
    }

    let rejected = drill_rejected_order(&client, &symbol, market_price, &filters).await;
    record_result(&mut report, "exchange rejection", rejected);

    let limit_price = resting_limit_price(market_price, filters.tick_size)?;
    let quantity = minimum_limit_quantity(limit_price, &filters)?;
    let client_order_id = drill_client_id("ftd-");
    // Once the submit call starts, a local error cannot prove that Binance did
    // not accept it. Keep cleanup armed until a terminal status is confirmed.
    let mut order_may_exist = true;
    let mut confirmed_order_id = None;

    let (elapsed, lost_submit) = timed(inject_lost_limit_response(
        &client,
        &symbol,
        quantity,
        limit_price,
        &client_order_id,
    ))
    .await;
    match lost_submit {
        Err(AppError::Http(message)) if message.contains("injected") => pass(
            &mut report,
            "lost REST submit response",
            "injected after Binance accepted the LIMIT order",
            elapsed,
        ),
        Ok(()) => fail(
            &mut report,
            "lost REST submit response",
            "fault injector unexpectedly returned success",
            elapsed,
        ),
        Err(error) => fail(
            &mut report,
            "lost REST submit response",
            error.to_string(),
            elapsed,
        ),
    }

    let (elapsed, query) = timed(client.query_order_by_client_id(&symbol, &client_order_id)).await;
    match query {
        Ok(order) if order.order_id.is_some() => {
            confirmed_order_id = order.order_id;
            pass(
                &mut report,
                "client-ID submit reconciliation",
                format!(
                    "accepted order recovered as {}",
                    order.status.as_deref().unwrap_or("UNKNOWN")
                ),
                elapsed,
            );
        }
        Ok(_) => fail(
            &mut report,
            "client-ID submit reconciliation",
            "Binance response had no order ID",
            elapsed,
        ),
        Err(error) => fail(
            &mut report,
            "client-ID submit reconciliation",
            error.to_string(),
            elapsed,
        ),
    }

    let restart = drill_restart_reconciliation(&symbol, &client_order_id).await;
    record_result(&mut report, "backend restart reconciliation", restart);

    let drift = drill_time_drift(&client, &symbol, &client_order_id).await;
    record_result(&mut report, "timestamp drift auto-recovery", drift);

    let stream =
        drill_user_stream_reconnect(client.clone(), baseline_account.clone(), baseline_risks).await;
    record_result(&mut report, "user-stream reconnect", stream);

    if let Some(order_id) = confirmed_order_id {
        let (elapsed, lost_cancel) =
            timed(inject_lost_cancel_response(&client, &symbol, order_id)).await;
        match lost_cancel {
            Err(AppError::Http(message)) if message.contains("injected") => pass(
                &mut report,
                "lost REST cancel response",
                "injected after Binance accepted the cancellation",
                elapsed,
            ),
            Ok(()) => fail(
                &mut report,
                "lost REST cancel response",
                "fault injector unexpectedly returned success",
                elapsed,
            ),
            Err(error) => fail(
                &mut report,
                "lost REST cancel response",
                error.to_string(),
                elapsed,
            ),
        }

        let (elapsed, query) =
            timed(client.query_order_by_client_id(&symbol, &client_order_id)).await;
        match query {
            Ok(order) if is_terminal_status(order.status.as_deref()) => {
                order_may_exist = false;
                pass(
                    &mut report,
                    "cancel reconciliation",
                    format!(
                        "authoritative status is {}",
                        order.status.as_deref().unwrap_or("UNKNOWN")
                    ),
                    elapsed,
                );
            }
            Ok(order) => fail(
                &mut report,
                "cancel reconciliation",
                format!(
                    "order is still {}",
                    order.status.as_deref().unwrap_or("UNKNOWN")
                ),
                elapsed,
            ),
            Err(error) => fail(
                &mut report,
                "cancel reconciliation",
                error.to_string(),
                elapsed,
            ),
        }
    } else {
        skip(
            &mut report,
            "lost REST cancel response",
            "submit reconciliation did not provide an order ID",
        );
        skip(
            &mut report,
            "cancel reconciliation",
            "submit reconciliation did not provide an order ID",
        );
    }

    let cleanup = cleanup_drill_state(&client, &symbol, baseline_position, order_may_exist).await;
    record_result(&mut report, "final cleanup and reconciliation", cleanup);

    if config.soak_seconds > 0 {
        let soak =
            soak_authoritative_state(&client, &symbol, baseline_position, config.soak_seconds)
                .await;
        record_result(&mut report, "authoritative-state soak", soak);
    } else {
        skip(
            &mut report,
            "authoritative-state soak",
            "enable with --soak-seconds N",
        );
    }

    finish(report, report_path).await
}

fn validate_config(config: &DrillConfig) -> AppResult<()> {
    let symbol = config.symbol.trim();
    if symbol.is_empty()
        || symbol.len() > 20
        || !symbol
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err(AppError::Invalid(
            "--symbol must contain 1..=20 ASCII letters/digits".into(),
        ));
    }
    if config.execute && !config.confirm_testnet_mutations {
        return Err(AppError::Config(
            "--execute requires --confirm-testnet-mutations".into(),
        ));
    }
    if config.soak_seconds > MAX_SOAK_SECONDS {
        return Err(AppError::Invalid(format!(
            "--soak-seconds cannot exceed {MAX_SOAK_SECONDS}"
        )));
    }
    Ok(())
}

async fn drill_uncertain_intent() -> TimedResult {
    let started = Instant::now();
    let path = std::env::temp_dir().join(format!("fyxtez-drill-{}.sqlite3", Uuid::new_v4()));
    let result = async {
        let safety = OperationSafety::connect(&path).await?;
        let intent = Uuid::new_v4().to_string();
        let fingerprint = OperationSafety::fingerprint("POST", "/api/orders/limit", b"drill");
        if !matches!(
            safety
                .begin(&intent, "POST", "/api/orders/limit", &fingerprint)
                .await?,
            IntentDecision::Execute
        ) {
            return Err(AppError::Config(
                "fresh drill intent was not executable".into(),
            ));
        }
        match safety
            .begin(&intent, "POST", "/api/orders/limit", &fingerprint)
            .await
        {
            Err(AppError::Conflict(message)) if message.contains("uncertain") => {
                Ok("retry of in-progress intent was rejected without replay".to_owned())
            }
            Err(error) => Err(AppError::Config(format!(
                "unexpected retry result: {error}"
            ))),
            Ok(_) => Err(AppError::Config(
                "uncertain intent was incorrectly accepted".into(),
            )),
        }
    }
    .await;

    // This database is created under the process temp directory and contains
    // only synthetic IDs. Cleanup is best-effort and never touches app data.
    for candidate in [
        path.clone(),
        PathBuf::from(format!("{}-wal", path.display())),
        PathBuf::from(format!("{}-shm", path.display())),
    ] {
        let _ = tokio::fs::remove_file(candidate).await;
    }

    (started.elapsed().as_millis(), result)
}

async fn drill_rejected_order(
    client: &BinanceClient,
    symbol: &str,
    market_price: f64,
    filters: &SymbolFilters,
) -> TimedResult {
    let started = Instant::now();
    let result = async {
        let invalid_quantity = filters.step_size / 2.0;
        let price = resting_limit_price(market_price, filters.tick_size)?;
        let id = drill_client_id("ftr-");
        match client
            .limit_order(
                symbol,
                OrderSide::Buy,
                invalid_quantity,
                price,
                "GTX",
                false,
                Some(&id),
            )
            .await
        {
            Err(AppError::Binance { code, .. }) => Ok(format!(
                "Binance rejected invalid quantity with code {code}"
            )),
            Err(error) => Err(AppError::Config(format!(
                "expected a Binance validation rejection, got: {error}"
            ))),
            Ok(order) => {
                if let Some(order_id) = order.order_id {
                    let _ = client.cancel_order(symbol, order_id).await;
                }
                Err(AppError::Config(
                    "Binance unexpectedly accepted the deliberately invalid order".into(),
                ))
            }
        }
    }
    .await;
    (started.elapsed().as_millis(), result)
}

async fn inject_lost_limit_response(
    client: &BinanceClient,
    symbol: &str,
    quantity: f64,
    price: f64,
    client_order_id: &str,
) -> AppResult<()> {
    client
        .limit_order(
            symbol,
            OrderSide::Buy,
            quantity,
            price,
            "GTX",
            false,
            Some(client_order_id),
        )
        .await?;
    Err(AppError::Http(
        "injected lost response after accepted Testnet LIMIT submit".into(),
    ))
}

async fn inject_lost_cancel_response(
    client: &BinanceClient,
    symbol: &str,
    order_id: i64,
) -> AppResult<()> {
    client.cancel_order(symbol, order_id).await?;
    Err(AppError::Http(
        "injected lost response after accepted Testnet cancellation".into(),
    ))
}

async fn drill_restart_reconciliation(symbol: &str, client_order_id: &str) -> TimedResult {
    let started = Instant::now();
    let result = async {
        let restarted = BinanceClient::from_secure_store(true)?;
        if !restarted.is_testnet() || !restarted.is_configured() {
            return Err(AppError::Config(
                "restarted client did not preserve Testnet credential selection".into(),
            ));
        }
        restarted.sync_server_time().await?;
        let (_, _, order) = tokio::try_join!(
            restarted.account_info(),
            restarted.position_risk(),
            restarted.query_order_by_client_id(symbol, client_order_id),
        )?;
        if order.order_id.is_none() {
            return Err(AppError::Config(
                "restarted client could not recover the resting order".into(),
            ));
        }
        Ok("fresh client recovered account, risk and order state".to_owned())
    }
    .await;
    (started.elapsed().as_millis(), result)
}

async fn drill_time_drift(
    client: &BinanceClient,
    symbol: &str,
    client_order_id: &str,
) -> TimedResult {
    let started = Instant::now();
    let result = async {
        client.force_time_drift_for_drill(24 * 60 * 60 * 1_000)?;
        let order = client
            .query_order_by_client_id(symbol, client_order_id)
            .await?;
        if order.order_id.is_none() {
            return Err(AppError::Config(
                "signed request recovered but returned no order ID".into(),
            ));
        }
        Ok("-1021 path resynchronized time and retried once".to_owned())
    }
    .await;
    (started.elapsed().as_millis(), result)
}

async fn drill_user_stream_reconnect(
    client: BinanceClient,
    account: FuturesAccountInfo,
    risks: Vec<Value>,
) -> TimedResult {
    let started = Instant::now();
    let diagnostics = DiagnosticsState::new(true);
    let (account_state, account_rx) = AccountState::new(account);
    let (risk_state, risk_rx) = PositionRiskState::new(risks);
    let account_task = spawn_account_refresh_worker(
        client.clone(),
        account_state.clone(),
        account_rx,
        diagnostics.clone(),
    );
    let risk_task = spawn_position_risk_refresh_worker(
        client.clone(),
        risk_state.clone(),
        risk_rx,
        diagnostics.clone(),
    );
    let (events, _) = broadcast::channel::<TradingEvent>(32);
    let stream_task = binance_stream::spawn_user_stream(
        client.clone(),
        account_state,
        risk_state,
        events,
        diagnostics.clone(),
    );

    let result = async {
        wait_for_status(
            &diagnostics,
            "connected",
            STREAM_CONNECT_TIMEOUT,
            "initial user-stream connection",
        )
        .await?;
        let first_connected_at = diagnostics.snapshot().user_stream.last_success_at_ms;

        client.force_user_stream_reconnect_for_drill()?;
        wait_for_status(
            &diagnostics,
            "degraded",
            STREAM_DROP_TIMEOUT,
            "injected user-stream disconnect",
        )
        .await?;
        wait_for_status(
            &diagnostics,
            "connected",
            STREAM_RECONNECT_TIMEOUT,
            "user-stream reconnect",
        )
        .await?;

        let snapshot = diagnostics.snapshot();
        if snapshot.user_stream.last_success_at_ms < first_connected_at {
            return Err(AppError::Config(
                "reconnected stream did not update its success timestamp".into(),
            ));
        }
        if snapshot.reconciliation.last_success_at_ms.is_none() {
            return Err(AppError::Config(
                "stream reconnect did not trigger authoritative reconciliation".into(),
            ));
        }
        Ok("production loop reconnected and refreshed authoritative state".to_owned())
    }
    .await;

    abort_all([stream_task, account_task, risk_task]);
    (started.elapsed().as_millis(), result)
}

async fn wait_for_status(
    diagnostics: &DiagnosticsState,
    expected: &str,
    timeout: Duration,
    context: &str,
) -> AppResult<()> {
    tokio::time::timeout(timeout, async {
        loop {
            if diagnostics.snapshot().user_stream.status == expected {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .map_err(|_| AppError::Config(format!("timed out waiting for {context}")))?;
    Ok(())
}

fn abort_all<const N: usize>(tasks: [JoinHandle<()>; N]) {
    for task in tasks {
        task.abort();
    }
}

async fn cleanup_drill_state(
    client: &BinanceClient,
    symbol: &str,
    baseline_position: f64,
    order_may_exist: bool,
) -> TimedResult {
    let started = Instant::now();
    let result = async {
        if order_may_exist || !order_array(&client.open_orders(symbol).await?)?.is_empty() {
            // The clean-symbol gate proved there were no user orders before the
            // drill, so cancel-all here is scoped exclusively to drill residue.
            client.cancel_all_orders(symbol).await?;
        }

        let account = client.account_info().await?;
        let current_position = position_amount(&account, symbol)?;
        let delta = current_position - baseline_position;
        if delta.abs() > f64::EPSILON {
            let side = if delta > 0.0 {
                OrderSide::Sell
            } else {
                OrderSide::Buy
            };
            let cleanup_id = drill_client_id("ftc-");
            client
                .market_order(symbol, side, delta.abs(), true, Some(&cleanup_id))
                .await?;
        }

        let (account, risks, orders) = tokio::try_join!(
            client.account_info(),
            client.position_risk(),
            client.open_orders(symbol),
        )?;
        let final_position = position_amount(&account, symbol)?;
        if (final_position - baseline_position).abs() > f64::EPSILON {
            return Err(AppError::Config(format!(
                "cleanup left position {final_position}; baseline was {baseline_position}"
            )));
        }
        if !order_array(&orders)?.is_empty() {
            return Err(AppError::Config(
                "cleanup left one or more open orders".into(),
            ));
        }
        let risk_position = risk_position_amount(&risks, symbol)?;
        if (risk_position - baseline_position).abs() > f64::EPSILON {
            return Err(AppError::Config(format!(
                "position-risk snapshot is {risk_position}; baseline was {baseline_position}"
            )));
        }
        Ok("no drill orders or exposure remain on Binance".to_owned())
    }
    .await;
    (started.elapsed().as_millis(), result)
}

async fn soak_authoritative_state(
    client: &BinanceClient,
    symbol: &str,
    baseline_position: f64,
    seconds: u64,
) -> TimedResult {
    let started = Instant::now();
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut checks = 0_u64;
    let result = async {
        loop {
            let (account, risks, orders) = tokio::try_join!(
                client.account_info(),
                client.position_risk(),
                client.open_orders(symbol),
            )?;
            let account_amount = position_amount(&account, symbol)?;
            let risk_amount = risk_position_amount(&risks, symbol)?;
            if (account_amount - baseline_position).abs() > f64::EPSILON
                || (risk_amount - baseline_position).abs() > f64::EPSILON
                || !order_array(&orders)?.is_empty()
            {
                return Err(AppError::Config(format!(
                    "authoritative drift detected: account={account_amount}, risk={risk_amount}, open_orders={}",
                    order_array(&orders)?.len()
                )));
            }
            checks += 1;
            if Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        Ok(format!("{checks} clean authoritative snapshot(s)"))
    }
    .await;
    (started.elapsed().as_millis(), result)
}

fn resting_limit_price(market_price: f64, tick_size: f64) -> AppResult<f64> {
    if !market_price.is_finite() || market_price <= 0.0 {
        return Err(AppError::Invalid("invalid market price for drill".into()));
    }
    // Binance Futures rejects prices outside its moving percent-price band.
    // Four percent below the snapshot normally stays inside that band while
    // GTX also guarantees the order cannot immediately cross as a taker.
    let price = round_to_tick(market_price * 0.96, tick_size);
    if !price.is_finite() || price <= 0.0 || price >= market_price * 0.985 {
        return Err(AppError::Invalid(
            "could not derive a safely distant drill LIMIT price".into(),
        ));
    }
    Ok(price)
}

fn minimum_limit_quantity(price: f64, filters: &SymbolFilters) -> AppResult<f64> {
    if filters.step_size <= 0.0 || filters.min_qty <= 0.0 || filters.min_notional <= 0.0 {
        return Err(AppError::Invalid(
            "Binance returned invalid drill symbol filters".into(),
        ));
    }
    let raw = filters.min_qty.max(filters.min_notional * 1.05 / price);
    let steps = (raw / filters.step_size).ceil();
    let quantity = steps * filters.step_size;
    if !quantity.is_finite() || quantity <= 0.0 {
        return Err(AppError::Invalid(
            "could not derive a valid drill quantity".into(),
        ));
    }
    Ok(quantity)
}

fn drill_client_id(prefix: &str) -> String {
    format!("{prefix}{}", Uuid::new_v4().simple())
}

fn position_amount(account: &FuturesAccountInfo, symbol: &str) -> AppResult<f64> {
    account
        .positions
        .iter()
        .filter(|position| position.symbol == symbol)
        .map(|position| parse_amount("account position", &position.position_amt))
        .try_fold(0.0, |total, amount| amount.map(|amount| total + amount))
}

fn has_any_position(account: &FuturesAccountInfo, symbol: &str) -> AppResult<bool> {
    for position in account
        .positions
        .iter()
        .filter(|position| position.symbol == symbol)
    {
        if parse_amount("account position", &position.position_amt)?.abs() > f64::EPSILON {
            return Ok(true);
        }
    }
    Ok(false)
}

fn risk_position_amount(risks: &[Value], symbol: &str) -> AppResult<f64> {
    risks
        .iter()
        .filter(|risk| risk.get("symbol").and_then(Value::as_str) == Some(symbol))
        .map(|risk| {
            risk.get("positionAmt")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::Invalid("positionRisk is missing positionAmt".into()))
                .and_then(|amount| parse_amount("position risk", amount))
        })
        .try_fold(0.0, |total, amount| amount.map(|amount| total + amount))
}

fn parse_amount(name: &str, amount: &str) -> AppResult<f64> {
    amount
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
        .ok_or_else(|| AppError::Invalid(format!("invalid {name} amount: {amount}")))
}

fn order_array(value: &Value) -> AppResult<&Vec<Value>> {
    value
        .as_array()
        .ok_or_else(|| AppError::Invalid("Binance open-orders response is not an array".into()))
}

fn is_terminal_status(status: Option<&str>) -> bool {
    status.is_some_and(|status| {
        matches!(
            status.to_ascii_uppercase().as_str(),
            "CANCELED" | "CANCELLED" | "FILLED" | "EXPIRED" | "REJECTED"
        )
    })
}

type TimedResult = (u128, AppResult<String>);

async fn timed<T>(future: impl Future<Output = AppResult<T>>) -> (u128, AppResult<T>) {
    let started = Instant::now();
    let result = future.await;
    (started.elapsed().as_millis(), result)
}

fn record_result(report: &mut DrillReport, name: &str, result: TimedResult) {
    let (duration_ms, result) = result;
    match result {
        Ok(detail) => pass(report, name, detail, duration_ms),
        Err(error) => fail(report, name, error.to_string(), duration_ms),
    }
}

fn pass(
    report: &mut DrillReport,
    name: impl Into<String>,
    detail: impl Into<String>,
    duration_ms: u128,
) {
    report.steps.push(DrillStep {
        name: name.into(),
        status: StepStatus::Pass,
        detail: detail.into(),
        duration_ms,
    });
}

fn fail(
    report: &mut DrillReport,
    name: impl Into<String>,
    detail: impl Into<String>,
    duration_ms: u128,
) {
    report.steps.push(DrillStep {
        name: name.into(),
        status: StepStatus::Fail,
        detail: detail.into(),
        duration_ms,
    });
}

fn skip(report: &mut DrillReport, name: impl Into<String>, detail: impl Into<String>) {
    report.steps.push(DrillStep {
        name: name.into(),
        status: StepStatus::Skip,
        detail: detail.into(),
        duration_ms: 0,
    });
}

async fn finish(mut report: DrillReport, report_path: Option<PathBuf>) -> AppResult<DrillReport> {
    report.finished_at = Utc::now().to_rfc3339();
    if let Some(path) = report_path {
        let json = serde_json::to_vec_pretty(&report)?;
        tokio::fs::write(path, json).await?;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filters() -> SymbolFilters {
        SymbolFilters {
            step_size: 0.001,
            min_qty: 0.001,
            min_notional: 100.0,
            tick_size: 0.1,
        }
    }

    #[test]
    fn execute_requires_explicit_mutation_confirmation() {
        let config = DrillConfig {
            execute: true,
            ..DrillConfig::default()
        };
        assert!(validate_config(&config).is_err());
    }

    #[test]
    fn drill_symbol_is_strictly_bounded() {
        for invalid in ["", "BTC/USDT", "BTC-USDT", "a_symbol_that_is_far_too_long"] {
            let config = DrillConfig {
                symbol: invalid.into(),
                ..DrillConfig::default()
            };
            assert!(validate_config(&config).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn resting_price_is_inside_exchange_band_but_below_market() {
        assert_eq!(resting_limit_price(80_000.0, 0.1).unwrap(), 76_800.0);
    }

    #[test]
    fn minimum_quantity_clears_notional_and_step() {
        let quantity = minimum_limit_quantity(76_800.0, &filters()).unwrap();
        assert_eq!(quantity, 0.002);
        assert!(quantity * 76_800.0 >= 100.0);
    }

    #[test]
    fn generated_client_ids_fit_binance_limit() {
        let id = drill_client_id("ftd-");
        assert_eq!(id.len(), 36);
        assert!(id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
        }));
    }
}
