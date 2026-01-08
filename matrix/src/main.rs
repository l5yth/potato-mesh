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

mod config;
mod matrix;
mod matrix_server;
mod potatomesh;

use std::{fs, net::SocketAddr, path::Path};

use anyhow::Result;
use tokio::time::Duration;
use tracing::{error, info};

#[cfg(not(test))]
use crate::config::Config;
use crate::matrix::MatrixAppserviceClient;
use crate::matrix_server::run_synapse_listener;
use crate::potatomesh::{FetchParams, PotatoClient, PotatoMessage, PotatoNode};
#[cfg(not(test))]
use tokio::time::sleep;

#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
pub struct BridgeState {
    /// Highest message id processed by the bridge.
    last_message_id: Option<u64>,
    /// Highest rx_time observed; used to build incremental fetch queries.
    #[serde(default)]
    last_rx_time: Option<u64>,
    /// Message ids seen at the current last_rx_time for de-duplication.
    #[serde(default)]
    last_rx_time_ids: Vec<u64>,
    /// Legacy checkpoint timestamp used before last_rx_time was added.
    #[serde(default, skip_serializing)]
    last_checked_at: Option<u64>,
}

impl BridgeState {
    fn load(path: &str) -> Result<Self> {
        if !Path::new(path).exists() {
            return Ok(Self::default());
        }
        let data = fs::read_to_string(path)?;
        // Treat empty/whitespace-only files as a fresh state.
        if data.trim().is_empty() {
            return Ok(Self::default());
        }
        let mut s: Self = serde_json::from_str(&data)?;
        if s.last_rx_time.is_none() {
            s.last_rx_time = s.last_checked_at;
        }
        s.last_checked_at = None;
        Ok(s)
    }

    fn save(&self, path: &str) -> Result<()> {
        let data = serde_json::to_string_pretty(self)?;
        fs::write(path, data)?;
        Ok(())
    }

    fn should_forward(&self, msg: &PotatoMessage) -> bool {
        match self.last_rx_time {
            None => match self.last_message_id {
                None => true,
                Some(last_id) => msg.id > last_id,
            },
            Some(last_ts) => {
                if msg.rx_time > last_ts {
                    true
                } else if msg.rx_time < last_ts {
                    false
                } else {
                    !self.last_rx_time_ids.contains(&msg.id)
                }
            }
        }
    }

    fn update_with(&mut self, msg: &PotatoMessage) {
        self.last_message_id = Some(msg.id);
        if self.last_rx_time.is_none() || Some(msg.rx_time) > self.last_rx_time {
            self.last_rx_time = Some(msg.rx_time);
            self.last_rx_time_ids = vec![msg.id];
        } else if Some(msg.rx_time) == self.last_rx_time && !self.last_rx_time_ids.contains(&msg.id)
        {
            self.last_rx_time_ids.push(msg.id);
        }
    }
}

fn build_fetch_params(state: &BridgeState) -> FetchParams {
    if state.last_message_id.is_none() {
        FetchParams {
            limit: None,
            since: None,
        }
    } else if let Some(ts) = state.last_rx_time {
        FetchParams {
            limit: None,
            since: Some(ts),
        }
    } else {
        FetchParams {
            limit: Some(10),
            since: None,
        }
    }
}

/// Persist the bridge state and log any write errors.
fn persist_state(state: &BridgeState, state_path: &str) {
    if let Err(e) = state.save(state_path) {
        error!("Error saving state: {:?}", e);
    }
}

/// Emit an info log for the latest bridge state snapshot.
fn log_state_update(state: &BridgeState) {
    info!("Updated state: {:?}", state);
}

async fn poll_once(
    potato: &PotatoClient,
    matrix: &MatrixAppserviceClient,
    state: &mut BridgeState,
    state_path: &str,
) {
    let params = build_fetch_params(state);

    match potato.fetch_messages(params).await {
        Ok(mut msgs) => {
            // sort by rx_time so we process by actual receipt time
            msgs.sort_by_key(|m| m.rx_time);

            for msg in &msgs {
                if !state.should_forward(msg) {
                    continue;
                }

                // Filter to the ports you care about
                if let Some(port) = &msg.portnum {
                    if port != "TEXT_MESSAGE_APP" {
                        state.update_with(msg);
                        log_state_update(state);
                        persist_state(state, state_path);
                        continue;
                    }
                }

                if let Err(e) = handle_message(potato, matrix, state, msg).await {
                    error!("Error handling message {}: {:?}", msg.id, e);
                    continue;
                }

                // persist after each processed message
                persist_state(state, state_path);
            }
        }
        Err(e) => {
            error!("Error fetching PotatoMesh messages: {:?}", e);
        }
    }
}

fn spawn_synapse_listener(addr: SocketAddr, token: String) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if let Err(e) = run_synapse_listener(addr, token).await {
            error!("Synapse listener failed: {:?}", e);
        }
    })
}

#[cfg(not(test))]
#[tokio::main]
async fn main() -> Result<()> {
    // Logging: RUST_LOG=info,bridge=debug,reqwest=warn ...
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("potatomesh_matrix_bridge=info".parse().unwrap_or_default())
                .add_directive("reqwest=warn".parse().unwrap_or_default()),
        )
        .init();

    let cfg = Config::from_default_path()?;
    info!("Loaded config: {:?}", cfg);

    let http = reqwest::Client::builder().build()?;
    let potato = PotatoClient::new(http.clone(), cfg.potatomesh.clone());
    potato.health_check().await?;
    let matrix = MatrixAppserviceClient::new(http.clone(), cfg.matrix.clone());
    matrix.health_check().await?;

    let synapse_addr = SocketAddr::from(([0, 0, 0, 0], 41448));
    let synapse_token = cfg.matrix.hs_token.clone();
    let _synapse_handle = spawn_synapse_listener(synapse_addr, synapse_token);

    let state_path = &cfg.state.state_file;
    let mut state = BridgeState::load(state_path)?;
    info!("Loaded state: {:?}", state);

    let poll_interval = Duration::from_secs(cfg.potatomesh.poll_interval_secs);

    loop {
        poll_once(&potato, &matrix, &mut state, state_path).await;

        sleep(poll_interval).await;
    }
}

async fn handle_message(
    potato: &PotatoClient,
    matrix: &MatrixAppserviceClient,
    state: &mut BridgeState,
    msg: &PotatoMessage,
) -> Result<()> {
    let node = potato.get_node(&msg.node_id).await?;
    let localpart = MatrixAppserviceClient::localpart_from_node_id(&msg.node_id);
    let user_id = matrix.user_id(&localpart);

    // Ensure puppet exists & has display name
    matrix.ensure_user_registered(&localpart).await?;
    matrix.ensure_user_joined_room(&user_id).await?;
    let display_name = display_name_for_node(&node);
    matrix.set_display_name(&user_id, &display_name).await?;

    // Format the bridged message
    let preset_short = modem_preset_short(&msg.modem_preset);
    let prefix = format!(
        "[{freq}][{preset_short}][{channel}]",
        freq = msg.lora_freq,
        preset_short = preset_short,
        channel = msg.channel_name,
    );
    let (body, formatted_body) = format_message_bodies(&prefix, &msg.text);

    matrix
        .send_formatted_message_as(&user_id, &body, &formatted_body)
        .await?;

    info!("Bridged message: {:?}", msg);
    state.update_with(msg);
    log_state_update(state);
    Ok(())
}

/// Build a compact modem preset label like "LF" for "LongFast".
fn modem_preset_short(preset: &str) -> String {
    let letters: String = preset
        .chars()
        .filter(|ch| ch.is_ascii_uppercase())
        .collect();
    if letters.is_empty() {
        preset.chars().take(2).collect()
    } else {
        letters
    }
}

/// Build plain text + HTML message bodies with inline-code metadata.
fn format_message_bodies(prefix: &str, text: &str) -> (String, String) {
    let body = format!("`{}` {}", prefix, text);
    let formatted_body = format!("<code>{}</code> {}", escape_html(prefix), escape_html(text));
    (body, formatted_body)
}

/// Build the Matrix display name from a node's long/short names.
fn display_name_for_node(node: &PotatoNode) -> String {
    match node
        .short_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(short) if short != node.long_name => format!("{} ({})", node.long_name, short),
        _ => node.long_name.clone(),
    }
}

/// Minimal HTML escaping for Matrix formatted_body payloads.
fn escape_html(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{MatrixConfig, PotatomeshConfig};
    use crate::matrix::MatrixAppserviceClient;
    use crate::potatomesh::PotatoClient;

    fn sample_msg(id: u64) -> PotatoMessage {
        PotatoMessage {
            id,
            rx_time: 0,
            rx_iso: "2025-11-27T00:00:00Z".to_string(),
            from_id: "!abcd1234".to_string(),
            to_id: "^all".to_string(),
            channel: 1,
            portnum: Some("TEXT_MESSAGE_APP".to_string()),
            text: "Ping".to_string(),
            rssi: Some(-100),
            hop_limit: Some(1),
            lora_freq: 868,
            modem_preset: "MediumFast".to_string(),
            channel_name: "TEST".to_string(),
            snr: Some(0.0),
            reply_id: None,
            node_id: "!abcd1234".to_string(),
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
    fn modem_preset_short_handles_camelcase() {
        assert_eq!(modem_preset_short("LongFast"), "LF");
        assert_eq!(modem_preset_short("MediumFast"), "MF");
    }

    #[test]
    fn format_message_bodies_escape_html() {
        let (body, formatted) = format_message_bodies("[868][LF]", "Hello <&>");
        assert_eq!(body, "`[868][LF]` Hello <&>");
        assert_eq!(formatted, "<code>[868][LF]</code> Hello &lt;&amp;&gt;");
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
    }

    #[tokio::test]
    async fn spawn_synapse_listener_logs_error_on_bind_failure() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = spawn_synapse_listener(addr, "HS_TOKEN".to_string());
        let _ = handle.await;
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

    #[tokio::test]
    async fn test_handle_message() {
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
            .mock("GET", "/api/nodes/abcd1234")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"node_id": "!abcd1234", "long_name": "Test Node", "short_name": "TN"}"#)
            .create();

        let mock_register = server
            .mock("POST", "/_matrix/client/v3/register")
            .match_query("kind=user&access_token=AS_TOKEN")
            .with_status(200)
            .create();

        let mock_join = server
            .mock(
                "POST",
                format!("/_matrix/client/v3/rooms/{}/join", encoded_room).as_str(),
            )
            .match_query(format!("user_id={}&access_token=AS_TOKEN", encoded_user).as_str())
            .with_status(200)
            .create();

        let mock_display_name = server
            .mock(
                "PUT",
                format!("/_matrix/client/v3/profile/{}/displayname", encoded_user).as_str(),
            )
            .match_query(format!("user_id={}&access_token=AS_TOKEN", encoded_user).as_str())
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

        let mock_send = server
            .mock(
                "PUT",
                format!(
                    "/_matrix/client/v3/rooms/{}/send/m.room.message/{}",
                    encoded_room, txn_id
                )
                .as_str(),
            )
            .match_query(format!("user_id={}&access_token=AS_TOKEN", encoded_user).as_str())
            .match_body(mockito::Matcher::PartialJson(serde_json::json!({
                "msgtype": "m.text",
                "body": "`[868][MF][TEST]` Ping",
                "format": "org.matrix.custom.html",
                "formatted_body": "<code>[868][MF][TEST]</code> Ping",
            })))
            .with_status(200)
            .create();

        let potato_client = PotatoClient::new(http_client.clone(), potatomesh_cfg);
        let mut state = BridgeState::default();
        let msg = sample_msg(100);

        let result = handle_message(&potato_client, &matrix_client, &mut state, &msg).await;

        assert!(result.is_ok());
        mock_get_node.assert();
        mock_register.assert();
        mock_join.assert();
        mock_display_name.assert();
        mock_send.assert();

        assert_eq!(state.last_message_id, Some(100));
    }
}
