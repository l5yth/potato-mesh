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
use crate::config::{MatrixConfig, PotatomeshConfig};
use crate::matrix::MatrixAppserviceClient;
use crate::potatomesh::PotatoClient;

fn sample_msg(id: u64) -> PotatoMessage {
    PotatoMessage {
        id,
        rx_time: 0,
        rx_iso: "2025-11-27T00:00:00Z".to_string(),
        from_id: Some("!abcd1234".to_string()),
        to_id: Some("^all".to_string()),
        channel: Some(1),
        portnum: Some("TEXT_MESSAGE_APP".to_string()),
        text: Some("Ping".to_string()),
        rssi: Some(-100),
        hop_limit: Some(1),
        lora_freq: Some(868),
        modem_preset: Some("MediumFast".to_string()),
        channel_name: Some("TEST".to_string()),
        snr: Some(0.0),
        reply_id: None,
        node_id: Some("!abcd1234".to_string()),
        protocol: Some("meshtastic".to_string()),
        sender_verified: None,
    }
}

fn sample_node(short_name: Option<&str>, long_name: &str) -> PotatoNode {
    PotatoNode {
        node_id: "!abcd1234".to_string(),
        short_name: short_name.map(str::to_string),
        long_name: long_name.to_string(),
        role: None,
        hw_model: None,
        last_heard: None,
        first_heard: None,
        latitude: None,
        longitude: None,
        altitude: None,
    }
}

#[test]
fn is_forwardable_requires_text_and_node_id() {
    // Fully populated sample: forwardable.
    assert!(is_forwardable(&sample_msg(1)));
    // Compacted-away text (emoji reaction row): not forwardable.
    assert!(!is_forwardable(&PotatoMessage {
        text: None,
        ..sample_msg(1)
    }));
    // Blank text is as unforwardable as absent text.
    assert!(!is_forwardable(&PotatoMessage {
        text: Some("   ".to_string()),
        ..sample_msg(1)
    }));
    // Unresolved sender (no node_id): not forwardable.
    assert!(!is_forwardable(&PotatoMessage {
        node_id: None,
        ..sample_msg(1)
    }));
}

#[test]
fn posts_as_puppet_unless_the_sender_is_not_verified() {
    // No flag (every Meshtastic row, older web apps): the puppet posts.
    assert!(posts_as_puppet(&sample_msg(1)));
    assert!(posts_as_puppet(&PotatoMessage {
        sender_verified: Some(true),
        ..sample_msg(1)
    }));
    // Named only in its text (SPEC SV2): the appservice user posts.
    assert!(!posts_as_puppet(&PotatoMessage {
        sender_verified: Some(false),
        ..sample_msg(1)
    }));
}

/// The `poll_once` gate makes a sender-less message unreachable from the
/// poll loop, but `handle_message` stays total: called directly with no
/// `node_id` it returns `Ok` without touching any endpoint (no mock
/// server is even running here — an HTTP call would error the test).
#[tokio::test]
async fn handle_message_returns_ok_without_node_id() {
    let http_client = reqwest::Client::new();
    let potato_client = PotatoClient::new(
        http_client.clone(),
        PotatomeshConfig {
            base_url: "http://127.0.0.1:9".to_string(),
            poll_interval_secs: 1,
        },
    );
    let matrix_client = MatrixAppserviceClient::new(
        http_client,
        MatrixConfig {
            homeserver: "http://127.0.0.1:9".to_string(),
            as_token: "AS_TOKEN".to_string(),
            hs_token: "HS_TOKEN".to_string(),
            server_name: "example.org".to_string(),
            room_id: "!roomid:example.org".to_string(),
        },
    );
    let mut state = BridgeState::default();
    let msg = PotatoMessage {
        node_id: None,
        ..sample_msg(7)
    };

    let result = handle_message(&potato_client, &matrix_client, &mut state, &msg).await;

    assert!(result.is_ok());
    // The message was not marked processed — the caller decides that.
    assert_eq!(state.last_message_id, None);
}

/// A line the web app serves with `sender_verified: false` names its
/// sender only in its text (SPEC SV1/SV2). `handle_message` posts it as
/// the appservice user, after joining that user to the room, with the body
/// unchanged; it neither looks the node up nor registers, joins or names a
/// puppet (SPEC SV4).
#[tokio::test]
async fn handle_message_posts_unverified_sender_as_appservice_user() {
    let mut server = mockito::Server::new_async().await;
    let join_path = r"/_matrix/client/v3/rooms/.+/join";

    let mock_get_node = server
        .mock("GET", mockito::Matcher::Regex(r"/api/nodes/.+".to_string()))
        .expect(0)
        .create();
    let mock_register = server
        .mock("POST", "/_matrix/client/v3/register")
        .match_query(mockito::Matcher::Any)
        .expect(0)
        .create();
    let mock_display = server
        .mock(
            "PUT",
            mockito::Matcher::Regex(r"/_matrix/client/v3/profile/.+/displayname".to_string()),
        )
        .match_query(mockito::Matcher::Any)
        .expect(0)
        .create();
    let mock_join_puppet = server
        .mock("POST", mockito::Matcher::Regex(join_path.to_string()))
        .match_query(mockito::Matcher::Regex("user_id=".to_string()))
        .expect(0)
        .create();
    let mock_join = server
        .mock("POST", mockito::Matcher::Regex(join_path.to_string()))
        .match_query(mockito::Matcher::Missing)
        .match_header("authorization", "Bearer AS_TOKEN")
        .with_status(200)
        .expect(1)
        .create();
    let mock_send = server
        .mock(
            "PUT",
            mockito::Matcher::Regex(
                r"/_matrix/client/v3/rooms/.+/send/m.room.message/.+".to_string(),
            ),
        )
        .match_query(mockito::Matcher::Missing)
        .match_header("authorization", "Bearer AS_TOKEN")
        .match_body(mockito::Matcher::PartialJson(serde_json::json!({
            "msgtype": "m.text",
            "body": "`[MC][869][NA][Public]` Alice: Ping",
            "format": "org.matrix.custom.html",
            "formatted_body": "<code>[MC][869][NA][Public]</code> Alice: Ping",
        })))
        .with_status(200)
        .expect(1)
        .create();

    let http_client = reqwest::Client::new();
    let potato_client = PotatoClient::new(
        http_client.clone(),
        PotatomeshConfig {
            base_url: server.url(),
            poll_interval_secs: 1,
        },
    );
    let matrix_client = MatrixAppserviceClient::new(
        http_client,
        MatrixConfig {
            homeserver: server.url(),
            as_token: "AS_TOKEN".to_string(),
            hs_token: "HS_TOKEN".to_string(),
            server_name: "example.org".to_string(),
            room_id: "!roomid:example.org".to_string(),
        },
    );
    let mut state = BridgeState::default();
    // The row exactly as `GET /api/messages` serves it.
    let msg: PotatoMessage = serde_json::from_value(serde_json::json!({
        "id": 77,
        "rx_time": 1785090651,
        "rx_iso": "2026-07-26T18:30:51Z",
        "from_id": "!a11ce001",
        "to_id": "^all",
        "channel": 0,
        "portnum": "TEXT_MESSAGE_APP",
        "text": "Alice: Ping",
        "lora_freq": 869,
        "modem_preset": "SF8/BW62/CR5",
        "channel_name": "Public",
        "protocol": "meshcore",
        "node_id": "!a11ce001",
        "sender_verified": false,
    }))
    .expect("flagged row parses");

    let result = handle_message(&potato_client, &matrix_client, &mut state, &msg).await;

    assert!(result.is_ok(), "{result:?}");
    mock_get_node.assert();
    mock_register.assert();
    mock_display.assert();
    mock_join_puppet.assert();
    mock_join.assert();
    mock_send.assert();
    assert_eq!(state.last_message_id, Some(77));
}

#[test]
fn format_message_bodies_escape_html() {
    let (body, formatted) = format_message_bodies("[868][LF]", "Hello <&>");
    assert_eq!(body, "`[868][LF]` Hello <&>");
    assert_eq!(formatted, "<code>[868][LF]</code> Hello &lt;&amp;&gt;");
}

#[test]
fn protocol_tag_returns_expected_label() {
    assert_eq!(protocol_tag(Some("meshcore")), "[MC]");
    assert_eq!(protocol_tag(Some("meshtastic")), "[MT]");
    // Missing protocol keeps the Meshtastic default for legacy payloads.
    assert_eq!(protocol_tag(None), "[MT]");
    // Unknown protocols surface as "[??]" rather than silently claiming Meshtastic.
    assert_eq!(protocol_tag(Some("")), "[??]");
}

/// Reticulum is a known protocol (SPEC S6), so it gets its own tag; `[??]`
/// stays the placeholder for protocols the web does not know.
#[test]
fn protocol_tag_labels_reticulum() {
    assert_eq!(protocol_tag(Some("reticulum")), "[RT]");
    assert_eq!(protocol_tag(Some("lxmf")), "[??]");
}

#[test]
fn escape_html_escapes_quotes() {
    assert_eq!(escape_html("a\"b'c"), "a&quot;b&#39;c");
}

#[test]
fn display_name_for_node_includes_short_when_present() {
    let node = sample_node(Some("TN"), "Test Node");
    assert_eq!(display_name_for_node(&node), "Test Node (TN)");
}

#[test]
fn display_name_for_node_ignores_empty_or_duplicate_short() {
    let empty_short = sample_node(Some(""), "Test Node");
    assert_eq!(display_name_for_node(&empty_short), "Test Node");

    let duplicate_short = sample_node(Some("Test Node"), "Test Node");
    assert_eq!(display_name_for_node(&duplicate_short), "Test Node");
}

#[test]
fn bridge_state_initially_forwards_all() {
    let state = BridgeState::default();
    let msg = sample_msg(42);

    assert!(state.should_forward(&msg));
}

#[test]
fn bridge_state_tracks_latest_rx_time_and_skips_older() {
    let mut state = BridgeState::default();
    let m1 = sample_msg(10);
    let m2 = sample_msg(20);
    let m3 = sample_msg(15);
    let m1 = PotatoMessage { rx_time: 10, ..m1 };
    let m2 = PotatoMessage { rx_time: 20, ..m2 };
    let m3 = PotatoMessage { rx_time: 15, ..m3 };

    // First message, should forward
    assert!(state.should_forward(&m1));
    state.update_with(&m1);
    assert_eq!(state.last_message_id, Some(10));
    assert_eq!(state.last_rx_time, Some(10));

    // Second message, higher id, should forward
    assert!(state.should_forward(&m2));
    state.update_with(&m2);
    assert_eq!(state.last_message_id, Some(20));
    assert_eq!(state.last_rx_time, Some(20));

    // Third message, lower than last, should NOT forward
    assert!(!state.should_forward(&m3));
    // state remains unchanged
    assert_eq!(state.last_message_id, Some(20));
    assert_eq!(state.last_rx_time, Some(20));
}

#[test]
fn bridge_state_uses_legacy_id_filter_when_rx_time_missing() {
    let state = BridgeState {
        last_message_id: Some(10),
        last_rx_time: None,
        last_rx_time_ids: vec![],
        last_checked_at: None,
        ..Default::default()
    };
    let older = sample_msg(9);
    let newer = sample_msg(11);

    assert!(!state.should_forward(&older));
    assert!(state.should_forward(&newer));
}

#[test]
fn bridge_state_dedupes_same_timestamp() {
    let mut state = BridgeState::default();
    let m1 = PotatoMessage {
        rx_time: 100,
        ..sample_msg(10)
    };
    let m2 = PotatoMessage {
        rx_time: 100,
        ..sample_msg(9)
    };
    let dup = PotatoMessage {
        rx_time: 100,
        ..sample_msg(10)
    };

    assert!(state.should_forward(&m1));
    state.update_with(&m1);
    assert!(state.should_forward(&m2));
    state.update_with(&m2);
    assert!(!state.should_forward(&dup));
    assert_eq!(state.last_rx_time, Some(100));
    assert_eq!(state.last_rx_time_ids, vec![10, 9]);
}

#[test]
fn bridge_state_load_save_roundtrip() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let file_path = tmp_dir.path().join("state.json");
    let path_str = file_path.to_str().unwrap();

    let state = BridgeState {
        last_message_id: Some(12345),
        last_rx_time: Some(99),
        last_rx_time_ids: vec![123],
        last_checked_at: Some(77),
        ..Default::default()
    };
    state.save(path_str).unwrap();

    let loaded_state = BridgeState::load(path_str).unwrap();
    assert_eq!(loaded_state.last_message_id, Some(12345));
    assert_eq!(loaded_state.last_rx_time, Some(99));
    assert_eq!(loaded_state.last_rx_time_ids, vec![123]);
    assert_eq!(loaded_state.last_checked_at, None);
}

#[test]
fn bridge_state_load_nonexistent() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let file_path = tmp_dir.path().join("nonexistent.json");
    let path_str = file_path.to_str().unwrap();

    let state = BridgeState::load(path_str).unwrap();
    assert_eq!(state.last_message_id, None);
    assert_eq!(state.last_rx_time, None);
    assert!(state.last_rx_time_ids.is_empty());
}

#[test]
fn bridge_state_load_empty_file() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let file_path = tmp_dir.path().join("empty.json");
    let path_str = file_path.to_str().unwrap();

    fs::write(path_str, "").unwrap();

    let state = BridgeState::load(path_str).unwrap();
    assert_eq!(state.last_message_id, None);
    assert_eq!(state.last_rx_time, None);
    assert!(state.last_rx_time_ids.is_empty());
    assert_eq!(state.last_checked_at, None);
}

#[test]
fn bridge_state_migrates_legacy_checkpoint() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let file_path = tmp_dir.path().join("legacy_state.json");
    let path_str = file_path.to_str().unwrap();

    fs::write(
        path_str,
        r#"{"last_message_id":42,"last_checked_at":1710000000}"#,
    )
    .unwrap();

    let state = BridgeState::load(path_str).unwrap();
    assert_eq!(state.last_message_id, Some(42));
    assert_eq!(state.last_rx_time, Some(1_710_000_000));
    assert!(state.last_rx_time_ids.is_empty());
}

#[test]
fn fetch_params_respects_missing_last_message_id() {
    let state = BridgeState {
        last_message_id: None,
        last_rx_time: Some(123),
        last_rx_time_ids: vec![],
        last_checked_at: None,
        ..Default::default()
    };

    let params = build_fetch_params(&state);
    assert_eq!(params.limit, None);
    assert_eq!(params.since, None);
}

#[test]
fn fetch_params_uses_since_when_safe() {
    let state = BridgeState {
        last_message_id: Some(1),
        last_rx_time: Some(123),
        last_rx_time_ids: vec![],
        last_checked_at: None,
        ..Default::default()
    };

    let params = build_fetch_params(&state);
    assert_eq!(params.limit, None);
    assert_eq!(params.since, Some(123));
}

#[test]
fn fetch_params_defaults_to_small_window() {
    let state = BridgeState {
        last_message_id: Some(1),
        last_rx_time: None,
        last_rx_time_ids: vec![],
        last_checked_at: None,
        ..Default::default()
    };

    let params = build_fetch_params(&state);
    assert_eq!(params.limit, Some(10));
    assert_eq!(params.since, None);
}

#[test]
fn log_state_update_emits_info() {
    let state = BridgeState::default();
    log_state_update(&state);
}

#[test]
fn persist_state_writes_file() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let file_path = tmp_dir.path().join("state.json");
    let path_str = file_path.to_str().unwrap();

    let state = BridgeState {
        last_message_id: Some(42),
        last_rx_time: Some(123),
        last_rx_time_ids: vec![42],
        last_checked_at: None,
        ..Default::default()
    };

    persist_state(&state, path_str);

    let loaded = BridgeState::load(path_str).unwrap();
    assert_eq!(loaded.last_message_id, Some(42));
}

#[test]
fn persist_state_logs_on_error() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let dir_path = tmp_dir.path().to_str().unwrap();
    let state = BridgeState::default();

    // Writing to a directory path should trigger the error branch.
    persist_state(&state, dir_path);
}

#[tokio::test]
async fn spawn_synapse_listener_starts_task() {
    let addr = SocketAddr::from(([127, 0, 0, 1], 0));
    let handle = spawn_synapse_listener(addr, "HS_TOKEN".to_string());
    tokio::time::sleep(Duration::from_millis(10)).await;
    handle.abort();
    // Only a listener still serving at abort time ends as cancelled. A
    // task that panicked while building the router, or returned early,
    // ended on its own before the abort.
    let err = handle
        .await
        .expect_err("listener task returned before it was aborted");
    assert!(
        err.is_cancelled(),
        "listener task ended before abort: {err}"
    );
}

#[tokio::test]
async fn spawn_synapse_listener_logs_error_on_bind_failure() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = spawn_synapse_listener(addr, "HS_TOKEN".to_string());
    // The bind error is logged and the task returns normally. A panic,
    // for example from building the router, surfaces here as a JoinError.
    handle
        .await
        .expect("listener task panicked instead of logging the bind error");
}

#[tokio::test]
async fn poll_once_leaves_state_unchanged_without_messages() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let state_path = tmp_dir.path().join("state.json");
    let state_str = state_path.to_str().unwrap();

    let mut server = mockito::Server::new_async().await;
    let mock_msgs = server
        .mock("GET", "/api/messages")
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body("[]")
        .create();

    let http_client = reqwest::Client::new();
    let potatomesh_cfg = PotatomeshConfig {
        base_url: server.url(),
        poll_interval_secs: 1,
    };
    let matrix_cfg = MatrixConfig {
        homeserver: server.url(),
        as_token: "AS_TOKEN".to_string(),
        hs_token: "HS_TOKEN".to_string(),
        server_name: "example.org".to_string(),
        room_id: "!roomid:example.org".to_string(),
    };

    let potato = PotatoClient::new(http_client.clone(), potatomesh_cfg);
    let matrix = MatrixAppserviceClient::new(http_client, matrix_cfg);

    let mut state = BridgeState {
        last_message_id: Some(1),
        last_rx_time: Some(100),
        last_rx_time_ids: vec![1],
        last_checked_at: None,
        ..Default::default()
    };

    poll_once(&potato, &matrix, &mut state, state_str).await;

    mock_msgs.assert();

    // No new data means state remains unchanged and is not persisted.
    assert_eq!(state.last_rx_time, Some(100));
    assert_eq!(state.last_rx_time_ids, vec![1]);
    assert!(!state_path.exists());
}

#[tokio::test]
async fn poll_once_persists_state_for_non_text_messages() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let state_path = tmp_dir.path().join("state.json");
    let state_str = state_path.to_str().unwrap();

    let mut server = mockito::Server::new_async().await;
    let mock_msgs = server
            .mock("GET", "/api/messages")
            .match_query(mockito::Matcher::Any)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"[{"id":1,"rx_time":100,"rx_iso":"2025-11-27T00:00:00Z","from_id":"!abcd1234","to_id":"^all","channel":1,"portnum":"POSITION_APP","text":"","rssi":-100,"hop_limit":1,"lora_freq":868,"modem_preset":"MediumFast","channel_name":"TEST","snr":0.0,"node_id":"!abcd1234"}]"#,
            )
            .create();

    let http_client = reqwest::Client::new();
    let potatomesh_cfg = PotatomeshConfig {
        base_url: server.url(),
        poll_interval_secs: 1,
    };
    let matrix_cfg = MatrixConfig {
        homeserver: server.url(),
        as_token: "AS_TOKEN".to_string(),
        hs_token: "HS_TOKEN".to_string(),
        server_name: "example.org".to_string(),
        room_id: "!roomid:example.org".to_string(),
    };

    let potato = PotatoClient::new(http_client.clone(), potatomesh_cfg);
    let matrix = MatrixAppserviceClient::new(http_client, matrix_cfg);
    let mut state = BridgeState::default();

    poll_once(&potato, &matrix, &mut state, state_str).await;

    mock_msgs.assert();
    assert!(state_path.exists());
    let loaded = BridgeState::load(state_str).unwrap();
    assert_eq!(loaded.last_message_id, Some(1));
    assert_eq!(loaded.last_rx_time, Some(100));
    assert_eq!(loaded.last_rx_time_ids, vec![1]);
}

/// Regression test for the watermark-advance bug: within a single batch,
/// an *earlier* message (lower `rx_time`) that fails to forward must not be
/// silently skipped forever just because a *later* message would succeed.
///
/// The batch is `[A(rx_time=10, fails), B(rx_time=20, would succeed)]`.
/// `A` fails because its node lookup returns 500; `B`'s full forward chain
/// is mocked to succeed. With the fix, `poll_once` stops at the first
/// failure, so the watermark never advances past `A` and `A` stays eligible
/// for retry. Under the old code, `B` succeeded and pushed `last_rx_time` to
/// 20, permanently stranding `A` — which this test would catch.
#[tokio::test]
async fn poll_once_does_not_advance_watermark_past_failed_message() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let state_path = tmp_dir.path().join("state.json");
    let state_str = state_path.to_str().unwrap();

    let mut server = mockito::Server::new_async().await;

    // Batch of two TEXT messages; poll_once sorts ascending by rx_time so A
    // (rx_time=10) is processed before B (rx_time=20) regardless of order.
    let mock_msgs = server
            .mock("GET", "/api/messages")
            .match_query(mockito::Matcher::Any)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"[
                    {"id":1,"rx_time":10,"rx_iso":"2025-11-27T00:00:00Z","from_id":"!aaaaaaaa","to_id":"^all","channel":1,"portnum":"TEXT_MESSAGE_APP","text":"Ping","lora_freq":868,"modem_preset":"MediumFast","channel_name":"TEST","node_id":"!aaaaaaaa"},
                    {"id":2,"rx_time":20,"rx_iso":"2025-11-27T00:00:00Z","from_id":"!bbbbbbbb","to_id":"^all","channel":1,"portnum":"TEXT_MESSAGE_APP","text":"Ping","lora_freq":868,"modem_preset":"MediumFast","channel_name":"TEST","node_id":"!bbbbbbbb"}
                ]"#,
            )
            .create();

    // Earlier message A fails: its node lookup returns 500.
    let mock_node_a = server
        .mock("GET", "/api/nodes/%21aaaaaaaa")
        .match_query(mockito::Matcher::Any)
        .with_status(500)
        .create();

    // Later message B would fully succeed (node + register + join +
    // displayname + send). These stay unused under the fix, but make the
    // test a true regression: under the buggy code B forwards and advances
    // the watermark to 20.
    let _mock_node_b = server
        .mock("GET", "/api/nodes/%21bbbbbbbb")
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"node_id":"!bbbbbbbb","long_name":"Node B","short_name":"NB"}"#)
        .create();
    let _mock_register = server
        .mock("POST", "/_matrix/client/v3/register")
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .create();
    let _mock_join = server
        .mock(
            "POST",
            mockito::Matcher::Regex(r"/_matrix/client/v3/rooms/.+/join".to_string()),
        )
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .create();
    let _mock_display = server
        .mock(
            "PUT",
            mockito::Matcher::Regex(r"/_matrix/client/v3/profile/.+/displayname".to_string()),
        )
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .create();
    let _mock_send = server
        .mock(
            "PUT",
            mockito::Matcher::Regex(r"/_matrix/client/v3/rooms/.+/send/.+".to_string()),
        )
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .create();

    let http_client = reqwest::Client::new();
    let potatomesh_cfg = PotatomeshConfig {
        base_url: server.url(),
        poll_interval_secs: 1,
    };
    let matrix_cfg = MatrixConfig {
        homeserver: server.url(),
        as_token: "AS_TOKEN".to_string(),
        hs_token: "HS_TOKEN".to_string(),
        server_name: "example.org".to_string(),
        room_id: "!roomid:example.org".to_string(),
    };

    let potato = PotatoClient::new(http_client.clone(), potatomesh_cfg);
    let matrix = MatrixAppserviceClient::new(http_client, matrix_cfg);
    let mut state = BridgeState::default();

    poll_once(&potato, &matrix, &mut state, state_str).await;

    // A's node lookup was attempted and failed.
    mock_msgs.assert();
    mock_node_a.assert();

    // The watermark must NOT have advanced past the failed message, so A
    // remains eligible to be refetched and retried on the next poll.
    let msg_a = PotatoMessage {
        id: 1,
        rx_time: 10,
        node_id: Some("!aaaaaaaa".to_string()),
        ..sample_msg(1)
    };
    assert_eq!(
        state.last_rx_time, None,
        "watermark advanced despite a failed earlier message"
    );
    assert_ne!(
        state.last_rx_time,
        Some(20),
        "watermark jumped past the failed message to the later success"
    );
    assert!(
        state.should_forward(&msg_a),
        "failed message must remain eligible for retry"
    );
}

/// Regression (live outage 2026-07-26, ACCEPTANCE MB-A1): one
/// contract-conformant row missing `channel_name` (the API compacts NULL
/// columns away) poisoned the WHOLE fetch — serde failed the entire batch,
/// `poll_once` logged "Error fetching PotatoMesh messages: … missing field
/// `channel_name`" every poll, and nothing was ever bridged again. The
/// batch below is [full row, row without `channel_name`]; both must
/// forward, the nameless one rendering empty channel brackets `[]` in the
/// prefix (mirroring the web frontend's empty-bracket convention).
#[tokio::test]
async fn poll_once_bridges_batch_containing_row_without_channel_name() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let state_path = tmp_dir.path().join("state.json");
    let state_str = state_path.to_str().unwrap();

    let mut server = mockito::Server::new_async().await;

    // The second row is the production row of the outage, as the web app
    // serves it since SPEC SV2: a MeshCore channel line names its sender
    // only in its text, so it carries `sender_verified: false`.
    let mock_msgs = server
            .mock("GET", "/api/messages")
            .match_query(mockito::Matcher::Any)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"[
                    {"id":1,"rx_time":10,"rx_iso":"2026-07-26T00:00:00Z","from_id":"!aaaaaaaa","to_id":"^all","channel":1,"portnum":"TEXT_MESSAGE_APP","text":"Ping","lora_freq":868,"modem_preset":"MediumFast","channel_name":"TEST","node_id":"!aaaaaaaa"},
                    {"id":2,"rx_time":20,"rx_iso":"2026-07-26T18:30:51Z","from_id":"!88e00b48","to_id":"^all","channel":24,"portnum":"TEXT_MESSAGE_APP","text":"lilygo: moin moin","lora_freq":869,"modem_preset":"SF8/BW62/CR5","snr":-5.25,"ingestor":"!930d4a21","protocol":"meshcore","node_id":"!88e00b48","sender_verified":false}
                ]"#,
            )
            .create();

    let mock_node_a = server
        .mock("GET", "/api/nodes/%21aaaaaaaa")
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"node_id":"!aaaaaaaa","long_name":"Node A","short_name":"NA"}"#)
        .create();
    // The flagged row gets no puppet (SPEC SV4): no node lookup, and only
    // the first row's puppet is registered, joined and named.
    let mock_node_b = server
        .mock("GET", "/api/nodes/%2188e00b48")
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"node_id":"!88e00b48","long_name":"lilygo","short_name":"LG"}"#)
        .expect(0)
        .create();
    let puppet_a = mockito::Matcher::UrlEncoded(
        "user_id".to_string(),
        "@potato_aaaaaaaa:example.org".to_string(),
    );
    let mock_register = server
        .mock("POST", "/_matrix/client/v3/register")
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .expect(1)
        .create();
    let mock_join_puppet = server
        .mock(
            "POST",
            mockito::Matcher::Regex(r"/_matrix/client/v3/rooms/.+/join".to_string()),
        )
        .match_query(puppet_a.clone())
        .with_status(200)
        .expect(1)
        .create();
    let mock_join_appservice = server
        .mock(
            "POST",
            mockito::Matcher::Regex(r"/_matrix/client/v3/rooms/.+/join".to_string()),
        )
        .match_query(mockito::Matcher::Missing)
        .with_status(200)
        .expect(1)
        .create();
    let mock_display = server
        .mock(
            "PUT",
            mockito::Matcher::Regex(r"/_matrix/client/v3/profile/.+/displayname".to_string()),
        )
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .expect(1)
        .create();
    // The compacted row must render EMPTY channel brackets — the trailing
    // `[]` — exactly like the web frontend renders unknown metadata. Being
    // flagged, it goes out as the appservice user (no `user_id`), its body
    // unchanged.
    let mock_send_compacted = server
        .mock(
            "PUT",
            mockito::Matcher::Regex(r"/_matrix/client/v3/rooms/.+/send/.+".to_string()),
        )
        .match_query(mockito::Matcher::Missing)
        .match_body(mockito::Matcher::PartialJson(serde_json::json!({
            "body": "`[MC][869][NA][]` lilygo: moin moin",
        })))
        .with_status(200)
        .create();
    let mock_send_puppet = server
        .mock(
            "PUT",
            mockito::Matcher::Regex(r"/_matrix/client/v3/rooms/.+/send/.+".to_string()),
        )
        .match_query(puppet_a)
        .with_status(200)
        .create();

    let http_client = reqwest::Client::new();
    let potatomesh_cfg = PotatomeshConfig {
        base_url: server.url(),
        poll_interval_secs: 1,
    };
    let matrix_cfg = MatrixConfig {
        homeserver: server.url(),
        as_token: "AS_TOKEN".to_string(),
        hs_token: "HS_TOKEN".to_string(),
        server_name: "example.org".to_string(),
        room_id: "!roomid:example.org".to_string(),
    };

    let potato = PotatoClient::new(http_client.clone(), potatomesh_cfg);
    let matrix = MatrixAppserviceClient::new(http_client, matrix_cfg);
    let mut state = BridgeState::default();

    poll_once(&potato, &matrix, &mut state, state_str).await;

    mock_msgs.assert();
    mock_node_a.assert();
    mock_node_b.assert();
    mock_register.assert();
    mock_join_puppet.assert();
    mock_join_appservice.assert();
    mock_display.assert();
    mock_send_compacted.assert();
    mock_send_puppet.assert();

    // Both messages forwarded: the watermark reached the compacted row.
    assert_eq!(
        state.last_rx_time,
        Some(20),
        "batch was poisoned instead of bridging past the compacted row"
    );
    assert_eq!(state.last_message_id, Some(2));
    assert_eq!(state.last_rx_time_ids, vec![2]);
}

/// Companion to the compacted-row regression (ACCEPTANCE MB-A1): rows the
/// bridge cannot forward at all — no `text` (e.g. an emoji reaction) or no
/// resolvable sender (`node_id` absent) — must be SKIPPED with the
/// watermark advanced, like non-text ports, instead of poisoning the batch
/// or being retried forever. Batch: [textless reaction, senderless text,
/// normal text]; only the normal row reaches Matrix.
#[tokio::test]
async fn poll_once_advances_watermark_past_unforwardable_rows() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let state_path = tmp_dir.path().join("state.json");
    let state_str = state_path.to_str().unwrap();

    let mut server = mockito::Server::new_async().await;

    let mock_msgs = server
            .mock("GET", "/api/messages")
            .match_query(mockito::Matcher::Any)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"[
                    {"id":1,"rx_time":10,"rx_iso":"2026-07-26T00:00:00Z","from_id":"!aaaaaaaa","to_id":"^all","channel":1,"portnum":"TEXT_MESSAGE_APP","reply_id":99,"emoji":"1","lora_freq":868,"modem_preset":"MediumFast","channel_name":"TEST","node_id":"!aaaaaaaa"},
                    {"id":2,"rx_time":20,"rx_iso":"2026-07-26T00:00:01Z","to_id":"^all","channel":1,"portnum":"TEXT_MESSAGE_APP","text":"anonymous","lora_freq":868,"modem_preset":"MediumFast","channel_name":"TEST"},
                    {"id":3,"rx_time":30,"rx_iso":"2026-07-26T00:00:02Z","from_id":"!cccccccc","to_id":"^all","channel":1,"portnum":"TEXT_MESSAGE_APP","text":"Ping","lora_freq":868,"modem_preset":"MediumFast","channel_name":"TEST","node_id":"!cccccccc"}
                ]"#,
            )
            .create();

    // Only the normal row may touch the node API / Matrix at all.
    let mock_node_c = server
        .mock("GET", "/api/nodes/%21cccccccc")
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"node_id":"!cccccccc","long_name":"Node C","short_name":"NC"}"#)
        .create();
    let _mock_register = server
        .mock("POST", "/_matrix/client/v3/register")
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .expect(1)
        .create();
    let _mock_join = server
        .mock(
            "POST",
            mockito::Matcher::Regex(r"/_matrix/client/v3/rooms/.+/join".to_string()),
        )
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .expect(1)
        .create();
    let _mock_display = server
        .mock(
            "PUT",
            mockito::Matcher::Regex(r"/_matrix/client/v3/profile/.+/displayname".to_string()),
        )
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .expect(1)
        .create();
    let mock_send = server
        .mock(
            "PUT",
            mockito::Matcher::Regex(r"/_matrix/client/v3/rooms/.+/send/.+".to_string()),
        )
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .expect(1)
        .create();

    let http_client = reqwest::Client::new();
    let potatomesh_cfg = PotatomeshConfig {
        base_url: server.url(),
        poll_interval_secs: 1,
    };
    let matrix_cfg = MatrixConfig {
        homeserver: server.url(),
        as_token: "AS_TOKEN".to_string(),
        hs_token: "HS_TOKEN".to_string(),
        server_name: "example.org".to_string(),
        room_id: "!roomid:example.org".to_string(),
    };

    let potato = PotatoClient::new(http_client.clone(), potatomesh_cfg);
    let matrix = MatrixAppserviceClient::new(http_client, matrix_cfg);
    let mut state = BridgeState::default();

    poll_once(&potato, &matrix, &mut state, state_str).await;

    mock_msgs.assert();
    mock_node_c.assert();
    mock_send.assert();

    // The unforwardable rows were skipped, not retried: the watermark
    // covers the whole batch and the state file reflects it.
    assert_eq!(state.last_rx_time, Some(30));
    assert_eq!(state.last_message_id, Some(3));
    assert_eq!(state.last_rx_time_ids, vec![3]);
    assert!(state_path.exists());
}

#[tokio::test]
async fn poll_once_skips_poison_message_after_max_attempts() {
    // A permanently-failing message must not block the batch forever. A
    // (rx_time=10) always fails (node lookup 500); B (rx_time=20) succeeds.
    // After MAX_FORWARD_ATTEMPTS polls the bridge skips A (advances past it)
    // and then forwards B, so the watermark reaches 20 — progress is made
    // while earlier polls still refused to jump past the failure.
    let tmp_dir = tempfile::tempdir().unwrap();
    let state_path = tmp_dir.path().join("state.json");
    let state_str = state_path.to_str().unwrap();

    let mut server = mockito::Server::new_async().await;

    let _mock_msgs = server
            .mock("GET", "/api/messages")
            .match_query(mockito::Matcher::Any)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"[
                    {"id":1,"rx_time":10,"rx_iso":"2025-11-27T00:00:00Z","from_id":"!aaaaaaaa","to_id":"^all","channel":1,"portnum":"TEXT_MESSAGE_APP","text":"Ping","lora_freq":868,"modem_preset":"MediumFast","channel_name":"TEST","node_id":"!aaaaaaaa"},
                    {"id":2,"rx_time":20,"rx_iso":"2025-11-27T00:00:00Z","from_id":"!bbbbbbbb","to_id":"^all","channel":1,"portnum":"TEXT_MESSAGE_APP","text":"Ping","lora_freq":868,"modem_preset":"MediumFast","channel_name":"TEST","node_id":"!bbbbbbbb"}
                ]"#,
            )
            .create();

    // A always fails; B's full forward chain always succeeds.
    let _mock_node_a = server
        .mock("GET", "/api/nodes/%21aaaaaaaa")
        .match_query(mockito::Matcher::Any)
        .with_status(500)
        .create();
    let _mock_node_b = server
        .mock("GET", "/api/nodes/%21bbbbbbbb")
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"node_id":"!bbbbbbbb","long_name":"Node B","short_name":"NB"}"#)
        .create();
    let _mock_register = server
        .mock("POST", "/_matrix/client/v3/register")
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .create();
    let _mock_join = server
        .mock(
            "POST",
            mockito::Matcher::Regex(r"/_matrix/client/v3/rooms/.+/join".to_string()),
        )
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .create();
    let _mock_display = server
        .mock(
            "PUT",
            mockito::Matcher::Regex(r"/_matrix/client/v3/profile/.+/displayname".to_string()),
        )
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .create();
    let _mock_send = server
        .mock(
            "PUT",
            mockito::Matcher::Regex(r"/_matrix/client/v3/rooms/.+/send/.+".to_string()),
        )
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .create();

    let http_client = reqwest::Client::new();
    let potato = PotatoClient::new(
        http_client.clone(),
        PotatomeshConfig {
            base_url: server.url(),
            poll_interval_secs: 1,
        },
    );
    let matrix = MatrixAppserviceClient::new(
        http_client,
        MatrixConfig {
            homeserver: server.url(),
            as_token: "AS_TOKEN".to_string(),
            hs_token: "HS_TOKEN".to_string(),
            server_name: "example.org".to_string(),
            room_id: "!roomid:example.org".to_string(),
        },
    );
    let mut state = BridgeState::default();

    // Poll up to (and including) the skip threshold.
    for _ in 0..MAX_FORWARD_ATTEMPTS {
        poll_once(&potato, &matrix, &mut state, state_str).await;
    }

    // A was skipped on the final poll and B then forwarded, so the watermark
    // advanced to B's rx_time. A is no longer eligible (it is behind the
    // watermark), and the failure tracker was cleared.
    assert_eq!(
        state.last_rx_time,
        Some(20),
        "poison message should have been skipped and the later message forwarded"
    );
    let msg_a = PotatoMessage {
        id: 1,
        rx_time: 10,
        node_id: Some("!aaaaaaaa".to_string()),
        ..sample_msg(1)
    };
    assert!(
        !state.should_forward(&msg_a),
        "skipped message must not be reprocessed"
    );
}

/// Companion to the two failure-path tests above, covering the
/// success-path tracker reset (the `if state.failing_msg_id == Some(msg.id)`
/// clear after a successful `handle_message`): a message that failed
/// transiently and then succeeds on a later poll must clear the tracker
/// and let the watermark advance. Neither prior test executes that reset —
/// the watermark test stops at the first failure and never re-polls, and
/// in the poison test the tracker is already cleared by the skip before
/// the next message succeeds. Without this test a regression in the reset
/// (not clearing, or clearing the wrong id) would pass CI, and the stale
/// attempt count would let a single later transient failure of the same
/// message hit `MAX_FORWARD_ATTEMPTS` and drop it.
#[tokio::test]
async fn poll_once_clears_failure_tracker_when_failed_message_recovers() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let state_path = tmp_dir.path().join("state.json");
    let state_str = state_path.to_str().unwrap();

    let mut server = mockito::Server::new_async().await;

    // Batch of two TEXT messages, refetched on every poll while the
    // watermark is stuck (same shape as the watermark/poison tests).
    let _mock_msgs = server
            .mock("GET", "/api/messages")
            .match_query(mockito::Matcher::Any)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"[
                    {"id":1,"rx_time":10,"rx_iso":"2025-11-27T00:00:00Z","from_id":"!aaaaaaaa","to_id":"^all","channel":1,"portnum":"TEXT_MESSAGE_APP","text":"Ping","lora_freq":868,"modem_preset":"MediumFast","channel_name":"TEST","node_id":"!aaaaaaaa"},
                    {"id":2,"rx_time":20,"rx_iso":"2025-11-27T00:00:00Z","from_id":"!bbbbbbbb","to_id":"^all","channel":1,"portnum":"TEXT_MESSAGE_APP","text":"Ping","lora_freq":868,"modem_preset":"MediumFast","channel_name":"TEST","node_id":"!bbbbbbbb"}
                ]"#,
            )
            .create();

    // Poll 1: A's node lookup fails transiently (500), arming the tracker.
    let mock_node_a_fail = server
        .mock("GET", "/api/nodes/%21aaaaaaaa")
        .match_query(mockito::Matcher::Any)
        .with_status(500)
        .create();

    // B's node lookup and the Matrix forward chain (shared by A once its
    // node lookup recovers) always succeed.
    let _mock_node_b = server
        .mock("GET", "/api/nodes/%21bbbbbbbb")
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"node_id":"!bbbbbbbb","long_name":"Node B","short_name":"NB"}"#)
        .create();
    let _mock_register = server
        .mock("POST", "/_matrix/client/v3/register")
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .create();
    let _mock_join = server
        .mock(
            "POST",
            mockito::Matcher::Regex(r"/_matrix/client/v3/rooms/.+/join".to_string()),
        )
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .create();
    let _mock_display = server
        .mock(
            "PUT",
            mockito::Matcher::Regex(r"/_matrix/client/v3/profile/.+/displayname".to_string()),
        )
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .create();
    let _mock_send = server
        .mock(
            "PUT",
            mockito::Matcher::Regex(r"/_matrix/client/v3/rooms/.+/send/.+".to_string()),
        )
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .create();

    let http_client = reqwest::Client::new();
    let potato = PotatoClient::new(
        http_client.clone(),
        PotatomeshConfig {
            base_url: server.url(),
            poll_interval_secs: 1,
        },
    );
    let matrix = MatrixAppserviceClient::new(
        http_client,
        MatrixConfig {
            homeserver: server.url(),
            as_token: "AS_TOKEN".to_string(),
            hs_token: "HS_TOKEN".to_string(),
            server_name: "example.org".to_string(),
            room_id: "!roomid:example.org".to_string(),
        },
    );
    let mut state = BridgeState::default();

    poll_once(&potato, &matrix, &mut state, state_str).await;

    // The transient failure armed the tracker and stalled the watermark.
    assert_eq!(state.failing_msg_id, Some(1));
    assert_eq!(state.failing_msg_attempts, 1);
    assert_eq!(state.last_rx_time, None);

    // Poll 2: A's node lookup now succeeds, like B's.
    mock_node_a_fail.remove_async().await;
    let _mock_node_a_ok = server
        .mock("GET", "/api/nodes/%21aaaaaaaa")
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"node_id":"!aaaaaaaa","long_name":"Node A","short_name":"NA"}"#)
        .create();

    poll_once(&potato, &matrix, &mut state, state_str).await;

    // The success-path reset cleared the tracker for the recovered id...
    assert_eq!(
        state.failing_msg_id, None,
        "tracker id must be cleared when the failing message finally forwards"
    );
    assert_eq!(
        state.failing_msg_attempts, 0,
        "attempt count must be reset when the failing message finally forwards"
    );
    // ...and the watermark advanced through A to B.
    assert_eq!(
        state.last_rx_time,
        Some(20),
        "watermark should advance once the transient failure recovers"
    );
    let msg_a = PotatoMessage {
        id: 1,
        rx_time: 10,
        node_id: Some("!aaaaaaaa".to_string()),
        ..sample_msg(1)
    };
    assert!(
        !state.should_forward(&msg_a),
        "recovered message must not be reprocessed"
    );
}

/// Drive `handle_message` end-to-end against a mocked Matrix homeserver
/// and PotatoMesh API, asserting that the bridged message body carries
/// `expected_prefix` followed by `expected_text`. Core harness shared by
/// the per-protocol tag cases and the compacted-metadata fallback case;
/// the message must name node `!abcd1234` (the mocked node lookup).
async fn assert_handle_message_emits_body(
    msg: PotatoMessage,
    expected_prefix: &str,
    expected_text: &str,
) {
    let mut server = mockito::Server::new_async().await;

    let potatomesh_cfg = PotatomeshConfig {
        base_url: server.url(),
        poll_interval_secs: 1,
    };
    let matrix_cfg = MatrixConfig {
        homeserver: server.url(),
        as_token: "AS_TOKEN".to_string(),
        hs_token: "HS_TOKEN".to_string(),
        server_name: "example.org".to_string(),
        room_id: "!roomid:example.org".to_string(),
    };

    let node_id = "abcd1234";
    let user_id = format!("@potato_{}:{}", node_id, matrix_cfg.server_name);
    let encoded_user = urlencoding::encode(&user_id);
    let room_id = matrix_cfg.room_id.clone();
    let encoded_room = urlencoding::encode(&room_id);

    let mock_get_node = server
        .mock("GET", "/api/nodes/%21abcd1234")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"node_id": "!abcd1234", "long_name": "Test Node", "short_name": "TN"}"#)
        .create();

    let mock_register = server
        .mock("POST", "/_matrix/client/v3/register")
        .match_query("kind=user")
        .match_header("authorization", "Bearer AS_TOKEN")
        .with_status(200)
        .create();

    let mock_join = server
        .mock(
            "POST",
            format!("/_matrix/client/v3/rooms/{}/join", encoded_room).as_str(),
        )
        .match_query(format!("user_id={}", encoded_user).as_str())
        .match_header("authorization", "Bearer AS_TOKEN")
        .with_status(200)
        .create();

    let mock_display_name = server
        .mock(
            "PUT",
            format!("/_matrix/client/v3/profile/{}/displayname", encoded_user).as_str(),
        )
        .match_query(format!("user_id={}", encoded_user).as_str())
        .match_header("authorization", "Bearer AS_TOKEN")
        .match_body(mockito::Matcher::PartialJson(serde_json::json!({
            "displayname": "Test Node (TN)"
        })))
        .with_status(200)
        .create();

    let http_client = reqwest::Client::new();
    let matrix_client = MatrixAppserviceClient::new(http_client.clone(), matrix_cfg);
    let txn_id = matrix_client
        .txn_counter
        .load(std::sync::atomic::Ordering::SeqCst);

    let expected_body = format!("`{expected_prefix}` {expected_text}");
    let expected_formatted = format!("<code>{expected_prefix}</code> {expected_text}");

    let mock_send = server
        .mock(
            "PUT",
            format!(
                "/_matrix/client/v3/rooms/{}/send/m.room.message/{}",
                encoded_room, txn_id
            )
            .as_str(),
        )
        .match_query(format!("user_id={}", encoded_user).as_str())
        .match_header("authorization", "Bearer AS_TOKEN")
        .match_body(mockito::Matcher::PartialJson(serde_json::json!({
            "msgtype": "m.text",
            "body": expected_body,
            "format": "org.matrix.custom.html",
            "formatted_body": expected_formatted,
        })))
        .with_status(200)
        .create();

    let potato_client = PotatoClient::new(http_client.clone(), potatomesh_cfg);
    let mut state = BridgeState::default();
    let msg_id = msg.id;

    let result = handle_message(&potato_client, &matrix_client, &mut state, &msg).await;

    assert!(result.is_ok());
    mock_get_node.assert();
    mock_register.assert();
    mock_join.assert();
    mock_display_name.assert();
    mock_send.assert();

    assert_eq!(state.last_message_id, Some(msg_id));
}

/// Tag-focused wrapper over [`assert_handle_message_emits_body`].
/// `lora_freq` is plumbed through both the input message and the expected
/// body so the missing-freq path (`lora_freq = 0`) can be exercised
/// alongside the populated cases.
async fn assert_handle_message_emits_tag(
    protocol: Option<&str>,
    expected_tag: &str,
    modem_preset: &str,
    lora_freq: u32,
    expected_preset_slot: &str,
) {
    let msg = PotatoMessage {
        protocol: protocol.map(str::to_string),
        modem_preset: Some(modem_preset.to_string()),
        lora_freq: Some(lora_freq),
        ..sample_msg(100)
    };
    assert_handle_message_emits_body(
        msg,
        &format!("{expected_tag}[{lora_freq}][{expected_preset_slot}][TEST]"),
        "Ping",
    )
    .await;
}

/// A forwardable row with ALL conditional metadata compacted away
/// (ACCEPTANCE MB-A1) renders every established fallback at once: `[MT]`
/// (absent protocol defaults to Meshtastic), the `0` frequency sentinel,
/// the `??` preset slot, and empty channel brackets `[]`.
#[tokio::test]
async fn handle_message_renders_fallbacks_for_compacted_metadata() {
    let msg = PotatoMessage {
        id: 4242,
        rx_time: 0,
        rx_iso: "2026-07-26T18:30:51Z".to_string(),
        from_id: None,
        to_id: None,
        channel: None,
        portnum: Some("TEXT_MESSAGE_APP".to_string()),
        text: Some("Hi".to_string()),
        rssi: None,
        hop_limit: None,
        lora_freq: None,
        modem_preset: None,
        channel_name: None,
        snr: None,
        reply_id: None,
        node_id: Some("!abcd1234".to_string()),
        protocol: None,
        sender_verified: None,
    };
    assert_handle_message_emits_body(msg, "[MT][0][??][]", "Hi").await;
}

#[tokio::test]
async fn handle_message_tags_meshtastic_in_body() {
    assert_handle_message_emits_tag(Some("meshtastic"), "[MT]", "MediumFast", 868, "MF").await;
}

#[tokio::test]
async fn handle_message_defaults_missing_protocol_to_meshtastic_tag() {
    assert_handle_message_emits_tag(None, "[MT]", "MediumFast", 868, "MF").await;
}

#[tokio::test]
async fn handle_message_tags_meshcore_in_body() {
    // SF8/BW62/CR8 is EU/UK Narrow → bandwidth-driven short code "Na"
    // → uppercased "NA" in the bracket slot. Exercises the bug fix.
    assert_handle_message_emits_tag(Some("meshcore"), "[MC]", "SF8/BW62/CR8", 868, "NA").await;
}

#[tokio::test]
async fn handle_message_tags_unknown_protocol_as_placeholder() {
    assert_handle_message_emits_tag(Some("lxmf"), "[??]", "MediumFast", 868, "MF").await;
}

#[tokio::test]
async fn handle_message_tags_reticulum_in_body() {
    assert_handle_message_emits_tag(Some("reticulum"), "[RT]", "MediumFast", 868, "MF").await;
}

#[tokio::test]
async fn handle_message_treats_zero_lora_freq_as_unknown_freq() {
    // `lora_freq = 0` stands in for "unknown frequency" — the call
    // site collapses it to `None` so frequency-gated named-preset
    // lookups are skipped (matching JS `normalizeFrequency`). The
    // BW-derived short code still resolves, so SF7/BW62/CR5 renders
    // as `[NA]` even without a frequency to disambiguate the region.
    assert_handle_message_emits_tag(Some("meshcore"), "[MC]", "SF7/BW62/CR5", 0, "NA").await;
}
