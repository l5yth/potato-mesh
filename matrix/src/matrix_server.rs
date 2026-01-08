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
    extract::Path,
    http::StatusCode,
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use serde_json::Value;
use std::net::SocketAddr;
use tracing::info;

/// Captures inbound Synapse transaction payloads for logging.
#[derive(Debug)]
struct SynapseResponse {
    txn_id: String,
    payload: Value,
}

/// Build the router that handles Synapse appservice transactions.
fn build_router() -> Router {
    Router::new().route(
        "/_matrix/appservice/v1/transactions/:txn_id",
        post(handle_transaction),
    )
}

/// Handle inbound transaction callbacks from Synapse.
async fn handle_transaction(
    Path(txn_id): Path<String>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    info!(
        "Status response: {:?}",
        SynapseResponse {
            txn_id,
            payload
        }
    );
    StatusCode::OK
}

/// Listen for Synapse callbacks on the configured address.
pub async fn run_synapse_listener(addr: SocketAddr) -> anyhow::Result<()> {
    let app = build_router();
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
    use tower::ServiceExt;

    #[tokio::test]
    async fn transactions_endpoint_accepts_payloads() {
        let app = build_router();
        let payload = serde_json::json!({
            "events": [],
            "txn_id": "123"
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/_matrix/appservice/v1/transactions/123")
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }
}
