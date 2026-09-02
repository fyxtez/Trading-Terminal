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
    Http(#[from] reqwest::Error),

    #[error("Binance JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Binance API error {code}: {message}")]
    Binance { code: i64, message: String },

    #[error("Invalid request: {0}")]
    Invalid(String),

    #[error("Unauthorized")]
    Unauthorized,

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Configuration error: {0}")]
    Config(String),
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Invalid(_) => StatusCode::BAD_REQUEST,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            // FIX: this used to be StatusCode::BAD_GATEWAY, same as the
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

        (
            status,
            Json(ErrorBody {
                error: self.to_string(),
            }),
        )
            .into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
