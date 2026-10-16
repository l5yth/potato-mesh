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
            "/_matrix/appservice/v1/transactions/{txn_id}",
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
mod tests;
