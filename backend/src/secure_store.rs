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

pub fn read(name: &str) -> Result<Option<Zeroizing<String>>, String> {
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
    match (read(first_name)?, read(second_name)?) {
        (Some(first), Some(second)) => Ok(Some((first, second))),
        (None, None) => Ok(None),
        _ => Err(format!(
            "{first_name} and {second_name} must both be configured"
        )),
    }
}
