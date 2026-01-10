// Copyright © 2025-26 l5yth & contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use axum::{
    extract::{Path, Query, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::put,
    Json, Router,
};
use serde_json::Value;
use std::net::SocketAddr;
use tracing::info;

#[derive(Clone)]
struct SynapseState {
    hs_token: String,
}

#[derive(serde::Deserialize)]
struct AuthQuery {
    access_token: Option<String>,
}

/// Pull access tokens from supported auth headers.
fn extract_access_token(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers.get(AUTHORIZATION) {
        if let Ok(raw) = value.to_str() {
            if let Some(token) = raw.strip_prefix("Bearer ") {
                return Some(token.trim().to_string());
            }
            if let Some(token) = raw.strip_prefix("bearer ") {
                return Some(token.trim().to_string());
            }
        }
    }
    if let Some(value) = headers.get("x-access-token") {
        if let Ok(raw) = value.to_str() {
            return Some(raw.trim().to_string());
        }
    }
    None
}

/// Compare tokens in constant time to avoid timing leakage.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    let max_len = std::cmp::max(a_bytes.len(), b_bytes.len());
    let mut diff = (a_bytes.len() ^ b_bytes.len()) as u8;

    for idx in 0..max_len {
        let left = *a_bytes.get(idx).unwrap_or(&0);
        let right = *b_bytes.get(idx).unwrap_or(&0);
        diff |= left ^ right;
    }

    diff == 0
}

/// Captures inbound Synapse transaction payloads for logging.
#[derive(Debug)]
struct SynapseResponse {
    txn_id: String,
    payload: Value,
}

/// Build the router that handles Synapse appservice transactions.
fn build_router(state: SynapseState) -> Router {
    Router::new()
        .route(
            "/_matrix/appservice/v1/transactions/:txn_id",
            put(handle_transaction),
        )
        .with_state(state)
}

/// Handle inbound transaction callbacks from Synapse.
async fn handle_transaction(
    Path(txn_id): Path<String>,
    State(state): State<SynapseState>,
    Query(auth): Query<AuthQuery>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let header_token = extract_access_token(&headers);
    let token_matches = if let Some(token) = header_token.as_deref() {
        constant_time_eq(token, &state.hs_token)
    } else {
        auth.access_token
            .as_deref()
            .is_some_and(|token| constant_time_eq(token, &state.hs_token))
    };
    if !token_matches {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({})));
    }
    let response = SynapseResponse { txn_id, payload };
    info!(
        "Status response: SynapseResponse {{ txn_id: {}, payload: {:?} }}",
        response.txn_id, response.payload
    );
    (StatusCode::OK, Json(serde_json::json!({})))
}

/// Listen for Synapse callbacks on the configured address.
pub async fn run_synapse_listener(addr: SocketAddr, hs_token: String) -> anyhow::Result<()> {
    let app = build_router(SynapseState { hs_token });
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!("Synapse listener bound on {}", addr);
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tokio::time::{sleep, Duration};
    use tower::ServiceExt;

    #[tokio::test]
    async fn transactions_endpoint_accepts_payloads() {
        let app = build_router(SynapseState {
            hs_token: "HS_TOKEN".to_string(),
        });
        let payload = serde_json::json!({
            "events": [],
            "txn_id": "123"
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/_matrix/appservice/v1/transactions/123")
                    .header("authorization", "Bearer HS_TOKEN")
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(body.as_ref(), b"{}");
    }

    #[tokio::test]
    async fn transactions_endpoint_rejects_missing_token() {
        let app = build_router(SynapseState {
            hs_token: "HS_TOKEN".to_string(),
        });
        let payload = serde_json::json!({
            "events": [],
            "txn_id": "123"
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/_matrix/appservice/v1/transactions/123")
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(body.as_ref(), b"{}");
    }

    #[tokio::test]
    async fn transactions_endpoint_rejects_wrong_token() {
        let app = build_router(SynapseState {
            hs_token: "HS_TOKEN".to_string(),
        });
        let payload = serde_json::json!({
            "events": [],
            "txn_id": "123"
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/_matrix/appservice/v1/transactions/123")
                    .header("authorization", "Bearer NOPE")
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(body.as_ref(), b"{}");
    }

    #[tokio::test]
    async fn transactions_endpoint_accepts_legacy_query_token() {
        let app = build_router(SynapseState {
            hs_token: "HS_TOKEN".to_string(),
        });
        let payload = serde_json::json!({
            "events": [],
            "txn_id": "125"
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/_matrix/appservice/v1/transactions/125?access_token=HS_TOKEN")
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn transactions_endpoint_accepts_x_access_token_header() {
        let app = build_router(SynapseState {
            hs_token: "HS_TOKEN".to_string(),
        });
        let payload = serde_json::json!({
            "events": [],
            "txn_id": "126"
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/_matrix/appservice/v1/transactions/126")
                    .header("x-access-token", "HS_TOKEN")
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn run_synapse_listener_starts_and_can_abort() {
        let addr = SocketAddr::from(([127, 0, 0, 1], 0));
        let handle =
            tokio::spawn(async move { run_synapse_listener(addr, "HS_TOKEN".to_string()).await });
        sleep(Duration::from_millis(10)).await;
        handle.abort();
    }

    #[tokio::test]
    async fn run_synapse_listener_returns_error_on_bind_failure() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let result = run_synapse_listener(addr, "HS_TOKEN".to_string()).await;
        assert!(result.is_err());
    }
}
