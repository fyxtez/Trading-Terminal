use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener},
    path::PathBuf,
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::{mpsc, oneshot, watch};

const MAX_AUTOMATIC_RESTARTS: usize = 3;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
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
        tauri::async_runtime::spawn(run_supervisor(data_dir, status_tx, command_rx));

        Ok(Self { status, commands })
    }

    pub async fn runtime_info(&self) -> Result<DesktopRuntimeInfo, String> {
        wait_for_ready(self.status.clone(), 0).await
    }

    pub async fn restart(&self) -> Result<DesktopRuntimeInfo, String> {
        let previous_generation = match self.status.borrow().clone() {
            BackendStatus::Ready(info) => info.generation,
            _ => 0,
        };
        self.commands
            .send(SupervisorCommand::Restart)
            .map_err(|_| "embedded backend supervisor is unavailable".to_string())?;
        wait_for_ready(self.status.clone(), previous_generation).await
    }

    pub async fn pause(&self) -> Result<(), String> {
        let (ack_tx, ack_rx) = oneshot::channel();
        self.commands
            .send(SupervisorCommand::Pause(ack_tx))
            .map_err(|_| "embedded backend supervisor is unavailable".to_string())?;
        tokio::time::timeout(Duration::from_secs(10), ack_rx)
            .await
            .map_err(|_| "embedded backend pause timed out".to_string())?
            .map_err(|_| "embedded backend pause was interrupted".to_string())?
    }

    pub fn shutdown(&self) {
        let _ = self.commands.send(SupervisorCommand::Shutdown);
    }
}

async fn wait_for_ready(
    mut status: watch::Receiver<BackendStatus>,
    after_generation: u64,
) -> Result<DesktopRuntimeInfo, String> {
    let wait = async move {
        loop {
            match status.borrow().clone() {
                BackendStatus::Ready(info) if info.generation > after_generation => {
                    return Ok(info);
                }
                BackendStatus::Failed(error) => return Err(error),
                BackendStatus::Stopped => return Err("embedded backend is stopped".into()),
                BackendStatus::Paused => return Err("embedded backend is paused".into()),
                BackendStatus::Starting | BackendStatus::Ready(_) => {}
            }
            status
                .changed()
                .await
                .map_err(|_| "embedded backend supervisor stopped".to_string())?;
        }
    };

    tokio::time::timeout(STARTUP_TIMEOUT, wait)
        .await
        .map_err(|_| "embedded backend did not become ready within 60 seconds".to_string())?
}

async fn run_supervisor(
    data_dir: PathBuf,
    status_tx: watch::Sender<BackendStatus>,
    mut commands: mpsc::UnboundedReceiver<SupervisorCommand>,
) {
    let address = match reserve_loopback_address() {
        Ok(address) => address,
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

    let mut automatic_restarts = 0_usize;
    let mut generation = 0_u64;

    'supervisor: loop {
        generation += 1;
        let _ = status_tx.send(BackendStatus::Starting);
        let info = DesktopRuntimeInfo {
            api_base_url: format!("http://{address}"),
            api_token: token.clone(),
            generation,
        };
        let runtime =
            match fyxtez_backend::RuntimeConfig::embedded(address, token.clone(), data_dir.clone())
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = status_tx.send(BackendStatus::Failed(error.to_string()));
                    return;
                }
            };

        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let mut server_task = tauri::async_runtime::spawn(fyxtez_backend::serve(runtime, async {
            let _ = shutdown_rx.await;
        }));
        let started_at = tokio::time::Instant::now();
        let mut ready_since = None;
        let client = reqwest::Client::new();

        loop {
            tokio::select! {
                command = commands.recv() => match command {
                    Some(SupervisorCommand::Restart) => {
                        let _ = shutdown_tx.send(());
                        let _ = tokio::time::timeout(Duration::from_secs(5), &mut server_task).await;
                        server_task.abort();
                        automatic_restarts = 0;
                        continue 'supervisor;
                    }
                    Some(SupervisorCommand::Pause(ack)) => {
                        let _ = shutdown_tx.send(());
                        if tokio::time::timeout(Duration::from_secs(5), &mut server_task)
                            .await
                            .is_err()
                        {
                            server_task.abort();
                            let _ = server_task.await;
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
                        let _ = shutdown_tx.send(());
                        let _ = tokio::time::timeout(Duration::from_secs(5), &mut server_task).await;
                        server_task.abort();
                        break 'supervisor;
                    }
                },
                result = &mut server_task => {
                    let error = match result {
                        Ok(Ok(())) => "embedded backend stopped unexpectedly".to_string(),
                        Ok(Err(error)) => error.to_string(),
                        Err(error) => format!("embedded backend task failed: {error}"),
                    };
                    eprintln!(
                        "Embedded backend stopped unexpectedly (automatic restart {}): {}",
                        automatic_restarts + 1,
                        error
                    );
                    if ready_since.is_some_and(|ready: tokio::time::Instant| {
                        ready.elapsed() >= STABLE_RUNTIME_RESET
                    }) {
                        automatic_restarts = 0;
                    }
                    automatic_restarts += 1;
                    if automatic_restarts > MAX_AUTOMATIC_RESTARTS {
                        let _ = status_tx.send(BackendStatus::Failed(format!(
                            "embedded backend stopped after repeated failures: {error}"
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
                _ = tokio::time::sleep(Duration::from_millis(150)) => {
                    if ready_since.is_none() {
                        let healthy = client
                            .get(format!("{}/health", info.api_base_url))
                            .timeout(Duration::from_secs(1))
                            .send()
                            .await
                            .is_ok_and(|response| response.status().is_success());
                        if healthy {
                            ready_since = Some(tokio::time::Instant::now());
                            let _ = status_tx.send(BackendStatus::Ready(info.clone()));
                        } else if started_at.elapsed() >= STARTUP_TIMEOUT {
                            let _ = shutdown_tx.send(());
                            let _ = tokio::time::timeout(Duration::from_secs(5), &mut server_task).await;
                            server_task.abort();
                            automatic_restarts += 1;
                            if automatic_restarts > MAX_AUTOMATIC_RESTARTS {
                                let _ = status_tx.send(BackendStatus::Failed(
                                    "embedded backend startup timed out after repeated attempts".into(),
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
                    }
                }
            }
        }
    }

    let _ = status_tx.send(BackendStatus::Stopped);
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

fn reserve_loopback_address() -> Result<SocketAddr, String> {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .map_err(|error| format!("cannot reserve embedded backend port: {error}"))?;
    listener
        .local_addr()
        .map_err(|error| format!("cannot inspect embedded backend port: {error}"))
}

fn generate_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("cannot generate embedded backend capability: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn restart_delay(attempt: usize) -> Duration {
    Duration::from_millis(250 * 2_u64.pow(attempt.saturating_sub(1) as u32))
}

#[cfg(test)]
mod tests {
    use super::{generate_token, reserve_loopback_address};

    #[test]
    fn generated_capability_has_256_bits_encoded_as_hex() {
        let token = generate_token().expect("token generation");
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn embedded_address_is_loopback_and_non_zero() {
        let address = reserve_loopback_address().expect("loopback address");
        assert!(address.ip().is_loopback());
        assert_ne!(address.port(), 0);
    }
}
