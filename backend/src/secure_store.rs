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
