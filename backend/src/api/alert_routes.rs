use axum::{
    Json,
    extract::{Path, Query, State},
};

use crate::{
    alerts::{AlertListQuery, CreatePriceAlert, PriceAlert, UpdatePriceAlert},
    error::{AppError, AppResult},
};

use super::AppState;

pub(super) async fn list_alerts(
    State(state): State<AppState>,
    Query(query): Query<AlertListQuery>,
) -> AppResult<Json<Vec<PriceAlert>>> {
    let symbol = query
        .symbol
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let normalized = symbol.map(|value| value.to_uppercase());
    Ok(Json(
        state.alert_store.list_active(normalized.as_deref()).await?,
    ))
}

pub(super) async fn create_alert(
    State(state): State<AppState>,
    Json(request): Json<CreatePriceAlert>,
) -> AppResult<(axum::http::StatusCode, Json<PriceAlert>)> {
    let alert = state.alert_store.create(request).await?;
    state.alert_runtime.refresh();
    Ok((axum::http::StatusCode::CREATED, Json(alert)))
}

pub(super) async fn update_alert(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(request): Json<UpdatePriceAlert>,
) -> AppResult<Json<PriceAlert>> {
    let id = uuid::Uuid::parse_str(&id)
        .map_err(|_| AppError::Invalid("alert id must be a valid UUID".into()))?;
    let alert = state.alert_store.update(id, request).await?;
    state.alert_runtime.refresh();
    Ok(Json(alert))
}

pub(super) async fn delete_alert(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<axum::http::StatusCode> {
    let id = uuid::Uuid::parse_str(&id)
        .map_err(|_| AppError::Invalid("alert id must be a valid UUID".into()))?;
    state.alert_store.delete(id).await?;
    state.alert_runtime.refresh();
    Ok(axum::http::StatusCode::NO_CONTENT)
}
