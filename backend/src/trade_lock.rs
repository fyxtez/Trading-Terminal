use std::sync::Arc;

use tokio::sync::{Mutex, OwnedMutexGuard};

/// Process-local coordinator for every Binance account mutation.
///
/// Holding one guard across the authoritative reads and writes of a workflow
/// prevents another HTTP request from interleaving an order mutation with it.
/// This is especially important for multi-step actions such as close-everything,
/// chase, and cancel-and-replace. It is deliberately not a distributed
/// lock: the desktop single-instance/sidecar policy guarantees one backend owner.
#[derive(Clone, Default)]
pub struct TradeLock {
    inner: Arc<Mutex<()>>,
}

impl TradeLock {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn lock(&self) -> OwnedMutexGuard<()> {
        Arc::clone(&self.inner).lock_owned().await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    use tokio::{sync::oneshot, time::Duration};

    use super::TradeLock;

    #[tokio::test]
    async fn a_second_sensitive_workflow_waits_for_the_first() {
        let lock = TradeLock::new();
        let first_guard = lock.lock().await;
        let entered_second = Arc::new(AtomicBool::new(false));
        let entered_second_task = Arc::clone(&entered_second);
        let (attempted_tx, attempted_rx) = oneshot::channel();

        let second = tokio::spawn(async move {
            let _ = attempted_tx.send(());
            let _guard = lock.lock().await;
            entered_second_task.store(true, Ordering::SeqCst);
        });

        attempted_rx.await.expect("second workflow should start");
        tokio::task::yield_now().await;
        assert!(
            !entered_second.load(Ordering::SeqCst),
            "two sensitive workflows entered the critical section together"
        );

        drop(first_guard);
        tokio::time::timeout(Duration::from_secs(1), second)
            .await
            .expect("second workflow should proceed after unlock")
            .expect("second workflow should not panic");
        assert!(entered_second.load(Ordering::SeqCst));
    }
}
