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
    // Only a listener still serving at abort time ends as cancelled. A
    // task that panicked while building the router, or returned early,
    // ended on its own before the abort.
    let err = handle
        .await
        .expect_err("listener returned before it was aborted");
    assert!(err.is_cancelled(), "listener ended before abort: {err}");
}

#[tokio::test]
async fn run_synapse_listener_returns_error_on_bind_failure() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let result = run_synapse_listener(addr, "HS_TOKEN".to_string()).await;
    assert!(result.is_err());
}
