use hmac::{Hmac, Mac};
use reqwest::StatusCode;
use serde::Deserialize;
use sha2::Sha256;
use std::fmt::Write;
use std::time::Duration;

const BINANCE_MAINNET_API: &str = "https://api.binance.com";
const BINANCE_TESTNET_FUTURES_API: &str = "https://demo-fapi.binance.com";
const RECV_WINDOW_MS: &str = "10000";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BinanceServerTime {
    server_time: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BinanceApiPermissions {
    enable_reading: bool,
    enable_futures: bool,
    enable_withdrawals: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BinanceFuturesAccount {
    can_trade: bool,
}

#[derive(Debug, Deserialize)]
struct BinanceErrorBody {
    code: Option<i64>,
}

fn sign_query(query: &str, secret: &str) -> Result<String, String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| "Could not validate the Binance API secret".to_string())?;
    mac.update(query.as_bytes());

    let bytes = mac.finalize().into_bytes();
    let mut signature = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut signature, "{byte:02x}")
            .map_err(|_| "Could not validate the Binance API secret".to_string())?;
    }
    Ok(signature)
}

fn validate_permission_policy(permissions: &BinanceApiPermissions) -> Result<(), String> {
    if permissions.enable_withdrawals {
        return Err(
            "This Binance Mainnet API key has withdrawals enabled. It was not saved. Disable this key and create a new Futures-only key with withdrawals disabled."
                .into(),
        );
    }
    if !permissions.enable_reading {
        return Err(
            "This Binance Mainnet API key does not allow account reading. It was not saved. Create a Futures key with reading enabled."
                .into(),
        );
    }
    if !permissions.enable_futures {
        return Err(
            "This Binance Mainnet API key does not allow Futures trading. It was not saved. Create a Futures-only key with withdrawals disabled."
                .into(),
        );
    }
    Ok(())
}

fn validate_testnet_account(account: &BinanceFuturesAccount) -> Result<(), String> {
    if !account.can_trade {
        return Err(
            "This Binance Testnet key cannot trade Futures. It was not saved. Enable Futures trading for the key or create a new Testnet key."
                .into(),
        );
    }
    Ok(())
}

async fn rejection_message(
    status: StatusCode,
    response: reqwest::Response,
    network: &str,
) -> String {
    let code = response
        .json::<BinanceErrorBody>()
        .await
        .ok()
        .and_then(|body| body.code);

    match code {
        Some(-2014 | -2015) => format!(
            "Binance rejected these keys. Check the key, secret, IP restriction, and {} selection; nothing was saved.",
            if network == "mainnet" {
                "Live"
            } else {
                "Practice"
            }
        ),
        Some(code) => format!(
            "Binance could not verify the API-key permissions (code {code}, HTTP {}). Nothing was saved.",
            status.as_u16()
        ),
        None => format!(
            "Binance could not verify the API-key permissions (HTTP {}). Nothing was saved.",
            status.as_u16()
        ),
    }
}

/// Mainnet credentials are checked against Binance's signed API-key-permission
/// endpoint before any value is written to the platform credential store.
/// Testnet has no real withdrawals, but its credentials are still verified by
/// calling the signed Futures account endpoint and requiring trading access.
pub async fn validate_binance_credentials(
    api_key: &str,
    api_secret: &str,
    network: &str,
) -> Result<(), String> {
    if !matches!(network, "mainnet" | "testnet") {
        return Err("Binance network must be mainnet or testnet".into());
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not initialize Binance credential validation".to_string())?;

    let (api_base, time_path) = if network == "testnet" {
        (BINANCE_TESTNET_FUTURES_API, "/fapi/v1/time")
    } else {
        (BINANCE_MAINNET_API, "/api/v3/time")
    };
    let time_response = client
        .get(format!("{api_base}{time_path}"))
        .send()
        .await
        .map_err(|_| {
            "Could not reach Binance to verify API-key permissions. Nothing was saved.".to_string()
        })?;
    let time_status = time_response.status();
    if !time_status.is_success() {
        return Err(rejection_message(time_status, time_response, network).await);
    }
    let server_time = time_response
        .json::<BinanceServerTime>()
        .await
        .map_err(|_| "Binance returned an invalid server-time response. Nothing was saved.")?
        .server_time;

    let query = format!("recvWindow={RECV_WINDOW_MS}&timestamp={server_time}");
    let signature = sign_query(&query, api_secret)?;

    if network == "testnet" {
        let account_response = client
            .get(format!(
                "{BINANCE_TESTNET_FUTURES_API}/fapi/v3/account?{query}&signature={signature}"
            ))
            .header("X-MBX-APIKEY", api_key)
            .send()
            .await
            .map_err(|_| {
                "Could not reach Binance Testnet to verify these keys. Nothing was saved."
                    .to_string()
            })?;
        let account_status = account_response.status();
        if !account_status.is_success() {
            return Err(rejection_message(account_status, account_response, network).await);
        }
        let account = account_response
            .json::<BinanceFuturesAccount>()
            .await
            .map_err(|_| {
                "Binance Testnet returned an invalid account response. Nothing was saved."
                    .to_string()
            })?;
        return validate_testnet_account(&account);
    }

    let permission_response = client
        .get(format!(
            "{BINANCE_MAINNET_API}/sapi/v1/account/apiRestrictions?{query}&signature={signature}"
        ))
        .header("X-MBX-APIKEY", api_key)
        .send()
        .await
        .map_err(|_| {
            "Could not reach Binance to verify API-key permissions. Nothing was saved.".to_string()
        })?;
    let permission_status = permission_response.status();
    if !permission_status.is_success() {
        return Err(rejection_message(permission_status, permission_response, network).await);
    }

    let permissions = permission_response
        .json::<BinanceApiPermissions>()
        .await
        .map_err(|_| {
            "Binance returned an invalid API-permission response. Nothing was saved.".to_string()
        })?;

    validate_permission_policy(&permissions)
}

#[cfg(test)]
mod tests {
    use super::{
        BinanceApiPermissions, BinanceFuturesAccount, sign_query, validate_permission_policy,
        validate_testnet_account,
    };

    fn permissions() -> BinanceApiPermissions {
        BinanceApiPermissions {
            enable_reading: true,
            enable_futures: true,
            enable_withdrawals: false,
        }
    }

    #[test]
    fn accepts_a_futures_key_without_withdrawals() {
        assert!(validate_permission_policy(&permissions()).is_ok());
    }

    #[test]
    fn testnet_requires_futures_trading_access() {
        assert!(validate_testnet_account(&BinanceFuturesAccount { can_trade: true }).is_ok());
        assert!(validate_testnet_account(&BinanceFuturesAccount { can_trade: false }).is_err());
    }

    #[test]
    fn rejects_a_key_that_can_withdraw() {
        let mut candidate = permissions();
        candidate.enable_withdrawals = true;
        let error =
            validate_permission_policy(&candidate).expect_err("withdrawals must fail closed");
        assert!(error.contains("withdrawals enabled"));
        assert!(error.contains("not saved"));
    }

    #[test]
    fn rejects_keys_without_required_read_and_futures_permissions() {
        let mut no_read = permissions();
        no_read.enable_reading = false;
        assert!(validate_permission_policy(&no_read).is_err());

        let mut no_futures = permissions();
        no_futures.enable_futures = false;
        assert!(validate_permission_policy(&no_futures).is_err());
    }

    #[test]
    fn signs_with_binance_hmac_sha256_format() {
        assert_eq!(
            sign_query(
                "timestamp=1578963600000",
                "NhqPtmdSJYdKjVHn7QK1A4DrMzfa0Q6J"
            )
            .as_deref(),
            Ok("19bcdff61946bd4fd8fe5986b96bb3ff43b2312937291fffbc68f0b609449f7a")
        );
    }
}
