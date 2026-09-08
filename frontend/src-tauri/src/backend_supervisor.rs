use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_shell::{
    ShellExt,
    process::{CommandChild, CommandEvent},
};
use tokio::sync::{mpsc, oneshot, watch};

const SIDECAR_NAME: &str = "fyxtez-backend";
const MAX_AUTOMATIC_RESTARTS: usize = 3;
const STABLE_RUNTIME_RESET: Duration = Duration::from_secs(30);
pub(crate) const BROWSER_ACCESS_PORT: u16 = 8658;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeInfo {
    pub api_base_url: String,
    pub api_token: String,
    pub generation: u64,
}

#[derive(Clone, Debug)]
enum BackendStatus {
    Starting,
    Ready(DesktopRuntimeInfo),
    Paused,
    Failed(String),
    Stopped,
}

enum SupervisorCommand {
    Restart,
    Pause(oneshot::Sender<Result<(), String>>),
    Shutdown,
}

pub struct BackendSupervisor {
    status: watch::Receiver<BackendStatus>,
    commands: mpsc::UnboundedSender<SupervisorCommand>,
    browser_access_enabled: Arc<AtomicBool>,
}

impl BackendSupervisor {
    pub fn start<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("cannot resolve application data directory: {error}"))?;
        std::fs::create_dir_all(&data_dir)
            .map_err(|error| format!("cannot create application data directory: {error}"))?;

        let (status_tx, status) = watch::channel(BackendStatus::Starting);
        let (commands, command_rx) = mpsc::unbounded_channel();
        let browser_access_enabled = Arc::new(AtomicBool::new(false));
        let browser_ui_dir = resolve_browser_ui_dir(app);
        let app = app.clone();
        tauri::async_runtime::spawn(run_supervisor(
            app,
            data_dir,
            browser_ui_dir,
            Arc::clone(&browser_access_enabled),
            status_tx,
            command_rx,
        ));

        Ok(Self {
            status,
            commands,
            browser_access_enabled,
        })
    }

    pub async fn runtime_info(&self) -> Result<DesktopRuntimeInfo, String> {
        let mut status = self.status.clone();
        let wait = async move {
            loop {
                match status.borrow().clone() {
                    BackendStatus::Ready(info) => return Ok(info),
                    BackendStatus::Failed(error) => return Err(error),
                    BackendStatus::Stopped => return Err("local backend is stopped".into()),
                    BackendStatus::Paused => return Err("local backend is paused".into()),
                    BackendStatus::Starting => {}
                }
                status
                    .changed()
                    .await
                    .map_err(|_| "local backend supervisor stopped".to_string())?;
            }
        };

        tokio::time::timeout(Duration::from_secs(60), wait)
            .await
            .map_err(|_| "local backend did not become ready within 60 seconds".to_string())?
    }

    pub async fn restart(&self) -> Result<DesktopRuntimeInfo, String> {
        let previous_generation = match self.status.borrow().clone() {
            BackendStatus::Ready(info) => info.generation,
            _ => 0,
        };
        self.set_browser_access_enabled(false);
        self.commands
            .send(SupervisorCommand::Restart)
            .map_err(|_| "local backend supervisor is unavailable".to_string())?;

        let mut status = self.status.clone();
        let wait = async move {
            loop {
                match status.borrow().clone() {
                    BackendStatus::Ready(info) if info.generation > previous_generation => {
                        return Ok(info);
                    }
                    BackendStatus::Failed(error) => return Err(error),
                    BackendStatus::Stopped => return Err("local backend is stopped".into()),
                    _ => {}
                }
                status
                    .changed()
                    .await
                    .map_err(|_| "local backend supervisor stopped".to_string())?;
            }
        };

        tokio::time::timeout(Duration::from_secs(60), wait)
            .await
            .map_err(|_| "local backend restart timed out".to_string())?
    }

    /// Queue a restart without making the setup screen wait for the complete
    /// sidecar boot cycle. The API address and token remain stable across
    /// restarts, while the frontend's normal health/retry path covers the brief
    /// transition.
    pub fn request_restart(&self) -> Result<(), String> {
        self.set_browser_access_enabled(false);
        self.commands
            .send(SupervisorCommand::Restart)
            .map_err(|_| "local backend supervisor is unavailable".to_string())
    }

    pub async fn pause(&self) -> Result<(), String> {
        let (ack_tx, ack_rx) = oneshot::channel();
        self.set_browser_access_enabled(false);
        self.commands
            .send(SupervisorCommand::Pause(ack_tx))
            .map_err(|_| "local backend supervisor is unavailable".to_string())?;
        tokio::time::timeout(Duration::from_secs(10), ack_rx)
            .await
            .map_err(|_| "local backend pause timed out".to_string())?
            .map_err(|_| "local backend pause was interrupted".to_string())?
    }

    pub fn shutdown(&self) {
        self.set_browser_access_enabled(false);
        let _ = self.commands.send(SupervisorCommand::Shutdown);
    }

    pub fn set_browser_access_enabled(&self, enabled: bool) {
        self.browser_access_enabled
            .store(enabled, Ordering::Release);
    }
}

async fn run_supervisor<R: Runtime>(
    app: AppHandle<R>,
    data_dir: PathBuf,
    browser_ui_dir: Option<PathBuf>,
    browser_access_enabled: Arc<AtomicBool>,
    status_tx: watch::Sender<BackendStatus>,
    mut commands: mpsc::UnboundedReceiver<SupervisorCommand>,
) {
    let mut automatic_restarts = 0_usize;
    let mut generation = 0_u64;
    let port = match reserve_loopback_port() {
        Ok(port) => port,
        Err(error) => {
            let _ = status_tx.send(BackendStatus::Failed(error));
            return;
        }
    };
    let token = match generate_token() {
        Ok(token) => token,
        Err(error) => {
            let _ = status_tx.send(BackendStatus::Failed(error));
            return;
        }
    };

    'supervisor: loop {
        browser_access_enabled.store(false, Ordering::Release);
        let _ = status_tx.send(BackendStatus::Starting);
        generation += 1;
        let info = DesktopRuntimeInfo {
            api_base_url: format!("http://127.0.0.1:{port}"),
            api_token: token.clone(),
            generation,
        };

        let command = match app
            .shell()
            .sidecar(SIDECAR_NAME)
            .map(|command| command.env("FYXTEZ_DESKTOP_SIDECAR", "1"))
        {
            Ok(command) => command,
            Err(error) => {
                let _ = status_tx.send(BackendStatus::Failed(format!(
                    "cannot prepare local backend: {error}"
                )));
                if !wait_for_manual_restart(&mut commands).await {
                    break;
                }
                automatic_restarts = 0;
                continue;
            }
        };

        let (mut events, mut child) = match command.spawn() {
            Ok(spawned) => spawned,
            Err(error) => {
                let _ = status_tx.send(BackendStatus::Failed(format!(
                    "cannot start local backend: {error}"
                )));
                if !wait_for_manual_restart(&mut commands).await {
                    break;
                }
                automatic_restarts = 0;
                continue;
            }
        };

        let mut bootstrap = serde_json::json!({
            "port": port,
            "service_token": token.clone(),
            "data_dir": data_dir,
        });
        if let Some(browser_ui_dir) = browser_ui_dir.as_ref() {
            let object = bootstrap
                .as_object_mut()
                .expect("desktop sidecar bootstrap must be an object");
            object.insert("browser_port".into(), BROWSER_ACCESS_PORT.into());
            object.insert(
                "browser_ui_dir".into(),
                serde_json::Value::String(browser_ui_dir.to_string_lossy().into_owned()),
            );
        }
        if let Err(error) = child.write(format!("{bootstrap}\n").as_bytes()) {
            let termination = stop_child_and_confirm(child, &mut events).await;
            let message = match termination.as_ref() {
                Ok(()) => format!("cannot initialize local backend: {error}"),
                Err(stop_error) => {
                    format!("cannot initialize local backend: {error}; {stop_error}")
                }
            };
            let _ = status_tx.send(BackendStatus::Failed(message));
            if termination.is_err() {
                wait_after_unconfirmed_termination(&mut commands).await;
                break;
            }
            if !wait_for_manual_restart(&mut commands).await {
                break;
            }
            automatic_restarts = 0;
            continue;
        }

        let readiness = wait_until_ready(&info.api_base_url, &mut events, &mut commands).await;
        match readiness {
            StartupOutcome::Ready => {
                let _ = status_tx.send(BackendStatus::Ready(info));
            }
            StartupOutcome::Restart => {
                if let Err(error) = stop_child_and_confirm(child, &mut events).await {
                    browser_access_enabled.store(false, Ordering::Release);
                    let _ = status_tx.send(BackendStatus::Failed(format!(
                        "local backend restart was stopped: {error}"
                    )));
                    wait_after_unconfirmed_termination(&mut commands).await;
                    break;
                }
                automatic_restarts = 0;
                continue;
            }
            StartupOutcome::Pause(ack) => {
                if let Err(error) = stop_child_and_confirm(child, &mut events).await {
                    let error = format!(
                        "local backend could not be stopped safely for the data operation: {error}"
                    );
                    let _ = status_tx.send(BackendStatus::Failed(error.clone()));
                    let _ = ack.send(Err(error));
                    wait_after_unconfirmed_termination(&mut commands).await;
                    break;
                }
                let _ = status_tx.send(BackendStatus::Paused);
                let _ = ack.send(Ok(()));
                if wait_while_paused(&mut commands).await {
                    automatic_restarts = 0;
                    continue;
                }
                break;
            }
            StartupOutcome::Shutdown => {
                let _ = child.kill();
                break;
            }
            StartupOutcome::Failed {
                error,
                termination_confirmed,
            } => {
                if !termination_confirmed
                    && let Err(stop_error) = stop_child_and_confirm(child, &mut events).await
                {
                    browser_access_enabled.store(false, Ordering::Release);
                    let _ = status_tx.send(BackendStatus::Failed(format!(
                        "{error}; automatic restart was stopped: {stop_error}"
                    )));
                    wait_after_unconfirmed_termination(&mut commands).await;
                    break;
                }
                automatic_restarts += 1;
                if automatic_restarts > MAX_AUTOMATIC_RESTARTS {
                    let _ = status_tx.send(BackendStatus::Failed(error));
                    if !wait_for_manual_restart(&mut commands).await {
                        break;
                    }
                    automatic_restarts = 0;
                } else {
                    tokio::time::sleep(restart_delay(automatic_restarts)).await;
                }
                continue;
            }
        }

        let ready_since = tokio::time::Instant::now();
        loop {
            tokio::select! {
                command = commands.recv() => match command {
                    Some(SupervisorCommand::Restart) => {
                        if let Err(error) = stop_child_and_confirm(child, &mut events).await {
                            browser_access_enabled.store(false, Ordering::Release);
                            let _ = status_tx.send(BackendStatus::Failed(format!(
                                "local backend restart was stopped: {error}"
                            )));
                            wait_after_unconfirmed_termination(&mut commands).await;
                            break 'supervisor;
                        }
                        automatic_restarts = 0;
                        continue 'supervisor;
                    }
                    Some(SupervisorCommand::Pause(ack)) => {
                        if let Err(error) = stop_child_and_confirm(child, &mut events).await {
                            let error = format!(
                                "local backend could not be stopped safely for the data operation: {error}"
                            );
                            let _ = status_tx.send(BackendStatus::Failed(error.clone()));
                            let _ = ack.send(Err(error));
                            wait_after_unconfirmed_termination(&mut commands).await;
                            break 'supervisor;
                        }
                        let _ = status_tx.send(BackendStatus::Paused);
                        let _ = ack.send(Ok(()));
                        if wait_while_paused(&mut commands).await {
                            automatic_restarts = 0;
                            continue 'supervisor;
                        }
                        break 'supervisor;
                    }
                    Some(SupervisorCommand::Shutdown) | None => {
                        let _ = child.kill();
                        break 'supervisor;
                    }
                },
                event = events.recv() => match event {
                    Some(CommandEvent::Stdout(line)) => log_sidecar_line("stdout", &line),
                    Some(CommandEvent::Stderr(line)) => log_sidecar_line("stderr", &line),
                    Some(CommandEvent::Terminated(payload)) => {
                        browser_access_enabled.store(false, Ordering::Release);
                        if ready_since.elapsed() >= STABLE_RUNTIME_RESET {
                            automatic_restarts = 0;
                        }
                        automatic_restarts += 1;
                        if automatic_restarts > MAX_AUTOMATIC_RESTARTS {
                            let error = format!(
                                "local backend stopped after repeated crashes (exit {:?}, signal {:?})",
                                payload.code, payload.signal,
                            );
                            let _ = status_tx.send(BackendStatus::Failed(error));
                            if !wait_for_manual_restart(&mut commands).await {
                                break 'supervisor;
                            }
                            automatic_restarts = 0;
                        } else {
                            tokio::time::sleep(restart_delay(automatic_restarts)).await;
                        }
                        continue 'supervisor;
                    }
                    monitor_failure @ (Some(CommandEvent::Error(_)) | None) => {
                        browser_access_enabled.store(false, Ordering::Release);
                        let monitor_error = match monitor_failure {
                            Some(CommandEvent::Error(error)) => {
                                format!("local backend process monitoring failed: {error}")
                            }
                            None => "local backend output channel closed before process termination was confirmed".into(),
                            _ => unreachable!("monitor-failure pattern only accepts errors or a closed channel"),
                        };
                        eprintln!("[fyxtez-sidecar] {monitor_error}");

                        if let Err(stop_error) = stop_child_and_confirm(child, &mut events).await {
                            let _ = status_tx.send(BackendStatus::Failed(format!(
                                "{monitor_error}; automatic restart was stopped: {stop_error}"
                            )));
                            wait_after_unconfirmed_termination(&mut commands).await;
                            break 'supervisor;
                        }

                        if ready_since.elapsed() >= STABLE_RUNTIME_RESET {
                            automatic_restarts = 0;
                        }
                        automatic_restarts += 1;
                        if automatic_restarts > MAX_AUTOMATIC_RESTARTS {
                            let _ = status_tx.send(BackendStatus::Failed(format!(
                                "{monitor_error}; local backend stopped after repeated process-monitor failures"
                            )));
                            if !wait_for_manual_restart(&mut commands).await {
                                break 'supervisor;
                            }
                            automatic_restarts = 0;
                        } else {
                            tokio::time::sleep(restart_delay(automatic_restarts)).await;
                        }
                        continue 'supervisor;
                    }
                    _ => {}
                }
            }
        }
    }

    let _ = status_tx.send(BackendStatus::Stopped);
}

enum StartupOutcome {
    Ready,
    Restart,
    Pause(oneshot::Sender<Result<(), String>>),
    Shutdown,
    Failed {
        error: String,
        termination_confirmed: bool,
    },
}

async fn wait_until_ready(
    base_url: &str,
    events: &mut tauri::async_runtime::Receiver<CommandEvent>,
    commands: &mut mpsc::UnboundedReceiver<SupervisorCommand>,
) -> StartupOutcome {
    let client = reqwest::Client::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);

    loop {
        if tokio::time::Instant::now() >= deadline {
            return StartupOutcome::Failed {
                error: "local backend startup timed out".into(),
                termination_confirmed: false,
            };
        }

        tokio::select! {
            command = commands.recv() => return match command {
                Some(SupervisorCommand::Restart) => StartupOutcome::Restart,
                Some(SupervisorCommand::Pause(ack)) => StartupOutcome::Pause(ack),
                Some(SupervisorCommand::Shutdown) | None => StartupOutcome::Shutdown,
            },
            event = events.recv() => match event {
                Some(CommandEvent::Stdout(line)) => log_sidecar_line("stdout", &line),
                Some(CommandEvent::Stderr(line)) => log_sidecar_line("stderr", &line),
                Some(CommandEvent::Terminated(payload)) => return StartupOutcome::Failed {
                    error: format!(
                        "local backend exited during startup (exit {:?}, signal {:?})",
                        payload.code, payload.signal,
                    ),
                    termination_confirmed: true,
                },
                Some(CommandEvent::Error(error)) => return StartupOutcome::Failed {
                    error,
                    termination_confirmed: false,
                },
                None => return StartupOutcome::Failed {
                    error: "local backend output channel closed".into(),
                    termination_confirmed: false,
                },
                _ => {}
            },
            _ = tokio::time::sleep(Duration::from_millis(150)) => {
                let healthy = client
                    .get(format!("{base_url}/health"))
                    .timeout(Duration::from_secs(1))
                    .send()
                    .await
                    .is_ok_and(|response| response.status().is_success());
                if healthy {
                    return StartupOutcome::Ready;
                }
            }
        }
    }
}

async fn wait_for_manual_restart(
    commands: &mut mpsc::UnboundedReceiver<SupervisorCommand>,
) -> bool {
    loop {
        match commands.recv().await {
            Some(SupervisorCommand::Restart) => return true,
            Some(SupervisorCommand::Pause(ack)) => {
                let _ = ack.send(Ok(()));
            }
            Some(SupervisorCommand::Shutdown) | None => return false,
        }
    }
}

async fn wait_while_paused(commands: &mut mpsc::UnboundedReceiver<SupervisorCommand>) -> bool {
    loop {
        match commands.recv().await {
            Some(SupervisorCommand::Restart) => return true,
            Some(SupervisorCommand::Pause(ack)) => {
                let _ = ack.send(Ok(()));
            }
            Some(SupervisorCommand::Shutdown) | None => return false,
        }
    }
}

async fn wait_for_termination(
    events: &mut tauri::async_runtime::Receiver<CommandEvent>,
) -> Result<(), ()> {
    let wait = async {
        loop {
            match events.recv().await {
                Some(CommandEvent::Terminated(_)) => return Ok(()),
                Some(CommandEvent::Stdout(line)) => log_sidecar_line("stdout", &line),
                Some(CommandEvent::Stderr(line)) => log_sidecar_line("stderr", &line),
                Some(_) => {}
                None => return Err(()),
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(5), wait)
        .await
        .map_err(|_| ())?
}

async fn stop_child_and_confirm(
    child: CommandChild,
    events: &mut tauri::async_runtime::Receiver<CommandEvent>,
) -> Result<(), String> {
    let kill_error = child.kill().err();
    if wait_for_termination(events).await.is_ok() {
        return Ok(());
    }

    Err(kill_error
        .map(|error| {
            format!("shutdown could not be confirmed and the stop request failed: {error}")
        })
        .unwrap_or_else(|| "shutdown could not be confirmed".into()))
}

async fn wait_after_unconfirmed_termination(
    commands: &mut mpsc::UnboundedReceiver<SupervisorCommand>,
) {
    // Starting another sidecar after an unconfirmed stop could leave two local
    // trading processes alive. Keep the supervisor failed until the user exits
    // the application; a full app restart is the safe recovery boundary.
    loop {
        match commands.recv().await {
            Some(SupervisorCommand::Pause(ack)) => {
                let _ = ack.send(Err(
                    "local backend shutdown was not confirmed; close and reopen Fyxtez".into(),
                ));
            }
            Some(SupervisorCommand::Restart) => {}
            Some(SupervisorCommand::Shutdown) | None => break,
        }
    }
}

fn reserve_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .map_err(|error| format!("cannot reserve a loopback port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("cannot inspect reserved loopback port: {error}"))
}

#[cfg(target_os = "linux")]
fn resolve_browser_ui_dir<R: Runtime>(_app: &AppHandle<R>) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    let candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");

    #[cfg(not(debug_assertions))]
    let candidate = match _app.path().resource_dir() {
        Ok(resources) => resources.join("browser-ui"),
        Err(error) => {
            eprintln!("[fyxtez-browser] cannot resolve packaged UI directory: {error}");
            return None;
        }
    };

    if !candidate.join("index.html").is_file() {
        // Still pass the trusted expected path. The backend treats missing
        // browser files as an optional-listener failure and reports a useful
        // reinstall/development-build reason without stopping the native API.
        eprintln!(
            "[fyxtez-browser] browser UI snapshot is missing at {}",
            candidate.display()
        );
    }
    Some(candidate.canonicalize().unwrap_or(candidate))
}

#[cfg(not(target_os = "linux"))]
fn resolve_browser_ui_dir<R: Runtime>(_app: &AppHandle<R>) -> Option<PathBuf> {
    None
}

fn generate_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("cannot generate local backend capability: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn restart_delay(attempt: usize) -> Duration {
    Duration::from_millis(250 * 2_u64.pow(attempt.saturating_sub(1) as u32))
}

fn log_sidecar_line(stream: &str, line: &[u8]) {
    let line = String::from_utf8_lossy(line);
    eprintln!("[fyxtez-sidecar:{stream}] {}", line.trim_end());
}

#[cfg(test)]
mod tests {
    use super::{generate_token, wait_for_termination};
    use tauri_plugin_shell::process::{CommandEvent, TerminatedPayload};

    #[test]
    fn generated_capability_has_256_bits_encoded_as_hex() {
        let token = generate_token().expect("token generation");
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn termination_wait_requires_an_explicit_termination_event() {
        let (sender, mut events) = tauri::async_runtime::channel(1);
        drop(sender);

        assert!(wait_for_termination(&mut events).await.is_err());
    }

    #[tokio::test]
    async fn termination_wait_accepts_the_process_termination_event() {
        let (sender, mut events) = tauri::async_runtime::channel(1);
        sender
            .send(CommandEvent::Terminated(TerminatedPayload {
                code: Some(0),
                signal: None,
            }))
            .await
            .expect("termination event receiver");

        assert!(wait_for_termination(&mut events).await.is_ok());
    }
}
