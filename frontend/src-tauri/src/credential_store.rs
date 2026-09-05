#[cfg(not(target_os = "android"))]
use keyring::{Entry, Error as KeyringError};
#[cfg(target_os = "android")]
use keyring_core::{Entry, Error as KeyringError};
use zeroize::Zeroizing;

const SERVICE: &str = "com.fyxtez.terminal";

pub(crate) trait CredentialStore {
    fn read(&self, name: &str) -> Result<Option<Zeroizing<String>>, String>;
    fn write(&self, name: &str, value: &str) -> Result<(), String>;
    fn delete(&self, name: &str) -> Result<(), String>;
}

pub(crate) struct PlatformCredentialStore;

pub(crate) type CredentialSnapshot = Vec<(String, Option<Zeroizing<String>>)>;

impl PlatformCredentialStore {
    fn entry(name: &str) -> Result<Entry, String> {
        Entry::new(SERVICE, name)
            .map_err(|error| format!("credential store unavailable for {name}: {error}"))
    }
}

impl CredentialStore for PlatformCredentialStore {
    fn read(&self, name: &str) -> Result<Option<Zeroizing<String>>, String> {
        match Self::entry(name)?.get_password() {
            Ok(value) if value.trim().is_empty() => Ok(None),
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(format!("cannot read {name} from credential store: {error}")),
        }
    }

    fn write(&self, name: &str, value: &str) -> Result<(), String> {
        Self::entry(name)?
            .set_password(value)
            .map_err(|error| format!("cannot store {name} in credential store: {error}"))
    }

    fn delete(&self, name: &str) -> Result<(), String> {
        match Self::entry(name)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(format!(
                "cannot delete {name} from credential store: {error}"
            )),
        }
    }
}

/// Apply a multi-value credential update with best-effort rollback.
///
/// Keyring APIs do not expose transactions. Snapshot every target before the
/// first mutation, then restore that exact snapshot if any write/delete fails.
/// Neither the primary error nor rollback diagnostics include secret values.
pub(crate) fn replace_values<S: CredentialStore>(
    store: &S,
    updates: &[(&str, Option<&str>)],
) -> Result<(), String> {
    let names = updates.iter().map(|(name, _)| *name).collect::<Vec<_>>();
    let snapshot = snapshot_values(store, &names)?;

    for (name, value) in updates {
        let result = match value {
            Some(value) => store.write(name, value),
            None => store.delete(name),
        };
        if let Err(error) = result {
            return match restore_values(store, &snapshot) {
                Ok(()) => Err(format!(
                    "credential update failed and previous values were restored: {error}"
                )),
                Err(rollback_error) => Err(format!(
                    "CRITICAL: credential update failed ({error}); rollback also failed ({rollback_error}). Reopen Settings and replace the complete credential set"
                )),
            };
        }
    }

    Ok(())
}

pub(crate) fn snapshot_values<S: CredentialStore>(
    store: &S,
    names: &[&str],
) -> Result<CredentialSnapshot, String> {
    names
        .iter()
        .map(|name| store.read(name).map(|value| ((*name).to_owned(), value)))
        .collect()
}

pub(crate) fn restore_values<S: CredentialStore>(
    store: &S,
    snapshot: &CredentialSnapshot,
) -> Result<(), String> {
    let mut errors = Vec::new();
    for (name, value) in snapshot {
        let result = match value {
            Some(value) => store.write(name, value),
            None => store.delete(name),
        };
        if let Err(error) = result {
            errors.push(error);
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    use super::*;

    #[derive(Clone, Default)]
    pub(crate) struct MemoryCredentialStore {
        values: Arc<Mutex<HashMap<String, String>>>,
        read_failure: Arc<Mutex<Option<String>>>,
        write_failure_once: Arc<Mutex<Option<String>>>,
        delete_failure_once: Arc<Mutex<Option<String>>>,
    }

    impl MemoryCredentialStore {
        pub(crate) fn with_values(values: &[(&str, &str)]) -> Self {
            let store = Self::default();
            {
                let mut current = store.values.lock().expect("value lock");
                current.extend(
                    values
                        .iter()
                        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned())),
                );
            }
            store
        }

        pub(crate) fn fail_reads(&self, message: &str) {
            *self.read_failure.lock().expect("read failure lock") = Some(message.into());
        }

        pub(crate) fn recover_reads(&self) {
            *self.read_failure.lock().expect("read failure lock") = None;
        }

        pub(crate) fn fail_next_write(&self, name: &str) {
            *self.write_failure_once.lock().expect("write failure lock") = Some(name.into());
        }

        pub(crate) fn fail_next_delete(&self, name: &str) {
            *self
                .delete_failure_once
                .lock()
                .expect("delete failure lock") = Some(name.into());
        }

        pub(crate) fn value(&self, name: &str) -> Option<String> {
            self.values.lock().expect("value lock").get(name).cloned()
        }
    }

    impl CredentialStore for MemoryCredentialStore {
        fn read(&self, name: &str) -> Result<Option<Zeroizing<String>>, String> {
            if let Some(message) = self.read_failure.lock().expect("read failure lock").clone() {
                return Err(message);
            }
            Ok(self
                .values
                .lock()
                .expect("value lock")
                .get(name)
                .cloned()
                .map(Zeroizing::new))
        }

        fn write(&self, name: &str, value: &str) -> Result<(), String> {
            let mut failure = self.write_failure_once.lock().expect("write failure lock");
            if failure.as_deref() == Some(name) {
                *failure = None;
                return Err(format!("injected write failure for {name}"));
            }
            drop(failure);
            self.values
                .lock()
                .expect("value lock")
                .insert(name.into(), value.into());
            Ok(())
        }

        fn delete(&self, name: &str) -> Result<(), String> {
            let mut failure = self
                .delete_failure_once
                .lock()
                .expect("delete failure lock");
            if failure.as_deref() == Some(name) {
                *failure = None;
                return Err(format!("injected delete failure for {name}"));
            }
            drop(failure);
            self.values.lock().expect("value lock").remove(name);
            Ok(())
        }
    }

    #[test]
    fn complete_multi_value_update_replaces_the_whole_set() {
        let store = MemoryCredentialStore::with_values(&[
            ("key", "old-key"),
            ("secret", "old-secret"),
            ("network", "testnet"),
        ]);

        replace_values(
            &store,
            &[
                ("key", Some("new-key")),
                ("secret", Some("new-secret")),
                ("network", Some("mainnet")),
            ],
        )
        .expect("complete update");

        assert_eq!(store.value("key").as_deref(), Some("new-key"));
        assert_eq!(store.value("secret").as_deref(), Some("new-secret"));
        assert_eq!(store.value("network").as_deref(), Some("mainnet"));
    }

    #[test]
    fn failed_multi_value_write_restores_every_previous_value() {
        let store = MemoryCredentialStore::with_values(&[
            ("key", "old-key"),
            ("secret", "old-secret"),
            ("network", "testnet"),
        ]);
        store.fail_next_write("secret");

        let error = replace_values(
            &store,
            &[
                ("key", Some("new-key")),
                ("secret", Some("new-secret")),
                ("network", Some("mainnet")),
            ],
        )
        .expect_err("second write must fail");

        assert!(error.contains("previous values were restored"));
        assert_eq!(store.value("key").as_deref(), Some("old-key"));
        assert_eq!(store.value("secret").as_deref(), Some("old-secret"));
        assert_eq!(store.value("network").as_deref(), Some("testnet"));
        assert!(!error.contains("old-key"));
        assert!(!error.contains("new-secret"));
    }

    #[test]
    fn failed_clear_restores_deleted_values() {
        let store =
            MemoryCredentialStore::with_values(&[("key", "old-key"), ("secret", "old-secret")]);
        store.fail_next_delete("secret");

        assert!(
            replace_values(&store, &[("key", None), ("secret", None)]).is_err(),
            "injected delete must fail"
        );
        assert_eq!(store.value("key").as_deref(), Some("old-key"));
        assert_eq!(store.value("secret").as_deref(), Some("old-secret"));
    }

    #[test]
    fn unavailable_snapshot_prevents_every_write() {
        let store = MemoryCredentialStore::with_values(&[("key", "old-key")]);
        store.fail_reads("credential store locked");

        assert!(replace_values(&store, &[("key", Some("new-key"))]).is_err());
        store.recover_reads();
        assert_eq!(store.value("key").as_deref(), Some("old-key"));
    }
}
