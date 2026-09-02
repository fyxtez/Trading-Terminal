use reqwest::header::{HeaderMap, HeaderValue};

use crate::{
    binance_stream::types::ListenKeyResponse,
    error::{AppError, AppResult},
};

fn api_headers(api_key: &str) -> AppResult<HeaderMap> {
    if api_key.trim().is_empty() {
        return Err(AppError::Config("Binance API key is empty".into()));
    }

    let mut headers = HeaderMap::new();
    let value = HeaderValue::from_str(api_key)
        .map_err(|_| AppError::Config("Binance API key is not a valid header value".into()))?;
    headers.insert("X-MBX-APIKEY", value);
    Ok(headers)
}

pub async fn create_listen_key(
    client: &reqwest::Client,
    rest_base: &str,
    api_key: &str,
) -> AppResult<String> {
    let response = client
        .post(format!("{rest_base}/fapi/v1/listenKey"))
        .headers(api_headers(api_key)?)
        .send()
        .await?;

    let status = response.status();
    let text = response.text().await?;
    if !status.is_success() {
        return Err(AppError::Binance {
            code: status.as_u16() as i64,
            message: format!("listenKey create failed: {text}"),
        });
    }

    Ok(serde_json::from_str::<ListenKeyResponse>(&text)?.listen_key)
}

pub async fn keepalive_listen_key(
    client: &reqwest::Client,
    rest_base: &str,
    api_key: &str,
    listen_key: &str,
) -> AppResult<()> {
    let response = client
        .put(format!("{rest_base}/fapi/v1/listenKey"))
        .headers(api_headers(api_key)?)
        .query(&[("listenKey", listen_key)])
        .send()
        .await?;

    let status = response.status();
    let text = response.text().await?;
    if !status.is_success() {
        return Err(AppError::Binance {
            code: status.as_u16() as i64,
            message: format!("listenKey keepalive failed: {text}"),
        });
    }

    Ok(())
}
