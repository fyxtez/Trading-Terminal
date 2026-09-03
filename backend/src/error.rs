use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Binance HTTP error: {0}")]
    Http(String),

    #[error("Binance JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Binance API error {code}: {message}")]
    Binance { code: i64, message: String },

    #[error("Invalid request: {0}")]
    Invalid(String),

    #[error("Duplicate or conflicting request: {0}")]
    Conflict(String),

    #[error("Unauthorized")]
    Unauthorized,

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Configuration error: {0}")]
    Config(String),
}

#[derive(Debug, Clone, Copy)]
pub struct ErrorClassification {
    pub duplicate_request: bool,
    pub exchange_unavailable: bool,
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let classification = ErrorClassification {
            duplicate_request: matches!(&self, Self::Conflict(_))
                || matches!(
                    &self,
                    Self::Binance { message, .. }
                        if message.to_ascii_lowercase().contains("duplicate")
                ),
            exchange_unavailable: matches!(&self, Self::Http(_) | Self::Json(_)),
        };
        let status = match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Invalid(_) => StatusCode::BAD_REQUEST,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            // this used to be StatusCode::BAD_GATEWAY, same as the
            // genuine network-failure variants below (Http/Json). But
            // AppError::Binance means we successfully reached Binance
            // and it sent back a well-formed, documented rejection (bad
            // quantity, notional too small, insufficient margin, etc.) -
            // that's a client-side request problem, not a gateway/
            // upstream-connectivity failure. Logging every one of these
            // as "502 Bad Gateway" (as tower_http's trace layer does)
            // reads exactly like an infrastructure outage even when the
            // backend and Binance are both working correctly and the
            // order was just invalid as submitted. 422 Unprocessable
            // Entity is the accurate status: well-formed request,
            // semantically rejected by the exchange. The response body's
            // `error` message is unchanged either way - existing callers
            // that only read the body (see parseTradingResponse on the
            // frontend) are unaffected by this status code change.
            Self::Binance { .. } => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Http(_) | Self::Json(_) => StatusCode::BAD_GATEWAY,
            Self::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::Config(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };

        let mut response = (
            status,
            Json(ErrorBody {
                error: self.to_string(),
            }),
        )
            .into_response();
        response.extensions_mut().insert(classification);
        response
    }
}

pub type AppResult<T> = Result<T, AppError>;

impl From<reqwest::Error> for AppError {
    fn from(error: reqwest::Error) -> Self {
        // reqwest's normal Display includes the complete request URL. Signed
        // Binance URLs carry the signature in their query string, while a
        // Telegram URL can carry the bot token in its path. Error responses,
        // diagnostics and logs therefore retain only the failure category and
        // the URL-free underlying transport cause.
        let category = if error.is_timeout() {
            "request timed out"
        } else if error.is_connect() {
            "connection failed"
        } else if error.is_request() {
            "request failed"
        } else if error.is_body() {
            "response body failed"
        } else if error.is_decode() {
            "response decode failed"
        } else {
            "HTTP transport failed"
        };

        let cause = std::error::Error::source(&error)
            .map(ToString::to_string)
            .filter(|message| !message.trim().is_empty());
        Self::Http(match cause {
            Some(cause) => format!("{category}: {cause}"),
            None => category.to_string(),
        })
    }
}
