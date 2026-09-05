use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener},
    path::PathBuf,
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_shell::{ShellExt, process::CommandEvent};
use tokio::sync::{mpsc, oneshot, watch};

const SIDECAR_NAME: &str = "fyxtez-backend";
const MAX_AUTOMATIC_RESTARTS: usize = 3;
const STABLE_RUNTIME_RESET: Duration = Duration::from_secs(30);

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
        let app = app.clone();
        tauri::async_runtime::spawn(run_supervisor(app, data_dir, status_tx, command_rx));

        Ok(Self { status, commands })
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

    pub async fn pause(&self) -> Result<(), String> {
        let (ack_tx, ack_rx) = oneshot::channel();
        self.commands
            .send(SupervisorCommand::Pause(ack_tx))
            .map_err(|_| "local backend supervisor is unavailable".to_string())?;
        tokio::time::timeout(Duration::from_secs(10), ack_rx)
            .await
            .map_err(|_| "local backend pause timed out".to_string())?
            .map_err(|_| "local backend pause was interrupted".to_string())?
    }

    pub fn shutdown(&self) {
        let _ = self.commands.send(SupervisorCommand::Shutdown);
    }
}

async fn run_supervisor<R: Runtime>(
    app: AppHandle<R>,
    data_dir: PathBuf,
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

        let bootstrap = serde_json::json!({
            "port": port,
            "service_token": token.clone(),
            "data_dir": data_dir,
        });
        if let Err(error) = child.write(format!("{bootstrap}\n").as_bytes()) {
            let _ = child.kill();
            let _ = status_tx.send(BackendStatus::Failed(format!(
                "cannot initialize local backend: {error}"
            )));
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
                let _ = child.kill();
                automatic_restarts = 0;
                continue;
            }
            StartupOutcome::Pause(ack) => {
                if child.kill().is_err() {
                    let _ = ack.send(Err(
                        "local backend could not be stopped safely for the data operation".into(),
                    ));
                    continue;
                }
                if wait_for_termination(&mut events).await.is_err() {
                    let error =
                        "local backend shutdown could not be confirmed for the data operation";
                    let _ = status_tx.send(BackendStatus::Failed(error.into()));
                    let _ = ack.send(Err(error.into()));
                    automatic_restarts = 0;
                    continue;
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
            StartupOutcome::Failed(error) => {
                let _ = child.kill();
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
                        let _ = child.kill();
                        automatic_restarts = 0;
                        continue 'supervisor;
                    }
                    Some(SupervisorCommand::Pause(ack)) => {
                        if child.kill().is_err() {
                            let _ = ack.send(Err(
                                "local backend could not be stopped safely for the data operation".into(),
                            ));
                            continue 'supervisor;
                        }
                        if wait_for_termination(&mut events).await.is_err() {
                            let error =
                                "local backend shutdown could not be confirmed for the data operation";
                            let _ = status_tx.send(BackendStatus::Failed(error.into()));
                            let _ = ack.send(Err(error.into()));
                            automatic_restarts = 0;
                            continue 'supervisor;
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
                    Some(CommandEvent::Error(error)) => {
                        eprintln!("[fyxtez-sidecar] process error: {error}");
                    }
                    None => {
                        if ready_since.elapsed() >= STABLE_RUNTIME_RESET {
                            automatic_restarts = 0;
                        }
                        automatic_restarts += 1;
                        if automatic_restarts > MAX_AUTOMATIC_RESTARTS {
                            let _ = status_tx.send(BackendStatus::Failed(
                                "local backend stopped after repeated output-channel failures"
                                    .into(),
                            ));
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
    Failed(String),
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
            return StartupOutcome::Failed("local backend startup timed out".into());
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
                Some(CommandEvent::Terminated(payload)) => return StartupOutcome::Failed(format!(
                    "local backend exited during startup (exit {:?}, signal {:?})",
                    payload.code, payload.signal,
                )),
                Some(CommandEvent::Error(error)) => return StartupOutcome::Failed(error),
                None => return StartupOutcome::Failed("local backend output channel closed".into()),
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
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Terminated(_) => return,
                CommandEvent::Stdout(line) => log_sidecar_line("stdout", &line),
                CommandEvent::Stderr(line) => log_sidecar_line("stderr", &line),
                _ => {}
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(5), wait)
        .await
        .map_err(|_| ())
}

fn reserve_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .map_err(|error| format!("cannot reserve a loopback port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("cannot inspect reserved loopback port: {error}"))
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
    use super::generate_token;

    #[test]
    fn generated_capability_has_256_bits_encoded_as_hex() {
        let token = generate_token().expect("token generation");
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
}
