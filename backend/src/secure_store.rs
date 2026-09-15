#[cfg(not(target_os = "android"))]
use keyring::{Entry, Error as KeyringError};
#[cfg(target_os = "android")]
use keyring_core::{Entry, Error as KeyringError};
use zeroize::Zeroizing;

pub const SERVICE: &str = "com.fyxtez.terminal";
pub const BINANCE_API_KEY: &str = "binance-api-key";
pub const BINANCE_API_SECRET: &str = "binance-api-secret";
pub const BINANCE_NETWORK: &str = "binance-network";
pub const NTFY_URL: &str = "ntfy-url";
pub const TELEGRAM_BOT_TOKEN: &str = "telegram-bot-token";
pub const TELEGRAM_CHAT_ID: &str = "telegram-chat-id";

pub type SecretPair = (Zeroizing<String>, Zeroizing<String>);

pub(crate) trait SecretReader {
    fn read(&self, name: &str) -> Result<Option<Zeroizing<String>>, String>;
}

pub(crate) struct PlatformSecretReader;

/// A headless host supplies a private JSON file instead of a desktop keyring.
pub(crate) struct FileSecretReader(std::collections::HashMap<String, Zeroizing<String>>);

impl FileSecretReader {
    pub(crate) fn load(path: &std::path::Path) -> Result<Self, String> {
        let metadata =
            std::fs::metadata(path).map_err(|_| "Cannot read server credentials file")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err("Server credentials file must be accessible only to its owner".into());
            }
        }
        if !metadata.is_file() || metadata.len() > 16 * 1024 {
            return Err("Invalid server credentials file".into());
        }
        let bytes =
            Zeroizing::new(std::fs::read(path).map_err(|_| "Cannot read server credentials file")?);
        let values: std::collections::HashMap<String, String> = serde_json::from_slice(&bytes)
            .map_err(|_| "Server credentials file must contain a JSON object of strings")?;
        Ok(Self(
            values
                .into_iter()
                .map(|(key, value)| (key, Zeroizing::new(value)))
                .collect(),
        ))
    }
}

impl SecretReader for FileSecretReader {
    fn read(&self, name: &str) -> Result<Option<Zeroizing<String>>, String> {
        Ok(self
            .0
            .get(name)
            .filter(|value| !value.trim().is_empty())
            .cloned())
    }
}

impl SecretReader for PlatformSecretReader {
    fn read(&self, name: &str) -> Result<Option<Zeroizing<String>>, String> {
        read_platform(name)
    }
}

pub fn read(name: &str) -> Result<Option<Zeroizing<String>>, String> {
    PlatformSecretReader.read(name)
}

fn read_platform(name: &str) -> Result<Option<Zeroizing<String>>, String> {
    let entry = Entry::new(SERVICE, name)
        .map_err(|error| format!("credential store unavailable for {name}: {error}"))?;

    match entry.get_password() {
        Ok(value) => {
            let value = Zeroizing::new(value);
            if value.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(value))
            }
        }
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!("cannot read {name} from credential store: {error}")),
    }
}

pub fn read_pair(first_name: &str, second_name: &str) -> Result<Option<SecretPair>, String> {
    read_pair_from(&PlatformSecretReader, first_name, second_name)
}

pub(crate) fn read_pair_from<R: SecretReader>(
    reader: &R,
    first_name: &str,
    second_name: &str,
) -> Result<Option<SecretPair>, String> {
    match (reader.read(first_name)?, reader.read(second_name)?) {
        (Some(first), Some(second)) => Ok(Some((first, second))),
        (None, None) => Ok(None),
        _ => Err(format!(
            "{first_name} and {second_name} must both be configured"
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Mutex};

    use super::*;

    #[test]
    fn server_file_reads_a_complete_pair_and_rejects_exposed_permissions() {
        use std::io::Write;
        let path =
            std::env::temp_dir().join(format!("fyxtez-secret-reader-{}", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).unwrap();
        file.write_all(br#"{"binance-api-key":"example-key","binance-api-secret":"example-secret","binance-network":"testnet"}"#).unwrap();
        let reader = FileSecretReader::load(&path).unwrap();
        assert!(
            read_pair_from(&reader, BINANCE_API_KEY, BINANCE_API_SECRET)
                .unwrap()
                .is_some()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(FileSecretReader::load(&path).is_err());
        }
        std::fs::remove_file(path).unwrap();
    }

    struct MockReader {
        values: Mutex<HashMap<String, Option<String>>>,
        failure: Mutex<Option<String>>,
    }

    impl MockReader {
        fn new(values: &[(&str, Option<&str>)]) -> Self {
            Self {
                values: Mutex::new(
                    values
                        .iter()
                        .map(|(name, value)| ((*name).to_owned(), value.map(ToOwned::to_owned)))
                        .collect(),
                ),
                failure: Mutex::new(None),
            }
        }
    }

    impl SecretReader for MockReader {
        fn read(&self, name: &str) -> Result<Option<Zeroizing<String>>, String> {
            if let Some(error) = self.failure.lock().expect("failure lock").clone() {
                return Err(error);
            }
            Ok(self
                .values
                .lock()
                .expect("values lock")
                .get(name)
                .cloned()
                .flatten()
                .map(Zeroizing::new))
        }
    }

    #[test]
    fn complete_pair_is_returned_without_exposing_values_in_errors() {
        let reader = MockReader::new(&[("key", Some("secret-key")), ("secret", None)]);
        let error = read_pair_from(&reader, "key", "secret").expect_err("pair is incomplete");
        assert!(error.contains("must both be configured"));
        assert!(!error.contains("secret-key"));
    }

    #[test]
    fn locked_store_error_propagates_and_recovery_is_not_sticky() {
        let reader = MockReader::new(&[("key", Some("key-value")), ("secret", Some("secret"))]);
        *reader.failure.lock().expect("failure lock") = Some("credential store locked".into());
        assert_eq!(
            read_pair_from(&reader, "key", "secret").unwrap_err(),
            "credential store locked"
        );

        *reader.failure.lock().expect("failure lock") = None;
        assert!(
            read_pair_from(&reader, "key", "secret")
                .expect("store recovered")
                .is_some()
        );
    }
}
