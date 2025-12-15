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
mod potatomesh;

use std::{fs, path::Path};

use anyhow::Result;
use tokio::time::{sleep, Duration};
use tracing::{error, info};

use crate::config::Config;
use crate::matrix::MatrixAppserviceClient;
use crate::potatomesh::{FetchParams, PotatoClient, PotatoMessage};

#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
pub struct BridgeState {
    last_message_id: Option<u64>,
    last_checked_at: Option<u64>,
}

impl BridgeState {
    fn load(path: &str) -> Result<Self> {
        if !Path::new(path).exists() {
            return Ok(Self::default());
        }
        let data = fs::read_to_string(path)?;
        let s: Self = serde_json::from_str(&data)?;
        Ok(s)
    }

    fn save(&self, path: &str) -> Result<()> {
        let data = serde_json::to_string_pretty(self)?;
        fs::write(path, data)?;
        Ok(())
    }

    fn should_forward(&self, msg: &PotatoMessage) -> bool {
        match self.last_message_id {
            None => true,
            Some(last) => msg.id > last,
        }
    }

    fn update_with(&mut self, msg: &PotatoMessage) {
        self.last_message_id = Some(match self.last_message_id {
            None => msg.id,
            Some(last) => last.max(msg.id),
        });
    }
}

fn build_fetch_params(state: &BridgeState) -> FetchParams {
    if state.last_message_id.is_none() {
        FetchParams {
            limit: None,
            since: None,
        }
    } else if let Some(ts) = state.last_checked_at {
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

fn update_checkpoint(state: &mut BridgeState, delivered_all: bool, now_secs: u64) -> bool {
    if !delivered_all {
        return false;
    }

    if state.last_message_id.is_some() {
        state.last_checked_at = Some(now_secs);
        true
    } else {
        false
    }
}

async fn poll_once(
    potato: &PotatoClient,
    matrix: &MatrixAppserviceClient,
    state: &mut BridgeState,
    state_path: &str,
    now_secs: u64,
) {
    let params = build_fetch_params(state);

    match potato.fetch_messages(params).await {
        Ok(mut msgs) => {
            // sort by id ascending so we process in order
            msgs.sort_by_key(|m| m.id);

            let mut delivered_all = true;

            for msg in &msgs {
                if !state.should_forward(msg) {
                    continue;
                }

                // Filter to the ports you care about
                if let Some(port) = &msg.portnum {
                    if port != "TEXT_MESSAGE_APP" {
                        state.update_with(msg);
                        continue;
                    }
                }

                if let Err(e) = handle_message(potato, matrix, state, msg).await {
                    error!("Error handling message {}: {:?}", msg.id, e);
                    delivered_all = false;
                    continue;
                }

                // persist after each processed message
                if let Err(e) = state.save(state_path) {
                    error!("Error saving state: {:?}", e);
                }
            }

            // Only advance checkpoint after successful delivery and a known last_message_id.
            if update_checkpoint(state, delivered_all, now_secs) {
                if let Err(e) = state.save(state_path) {
                    error!("Error saving state: {:?}", e);
                }
            }
        }
        Err(e) => {
            error!("Error fetching PotatoMesh messages: {:?}", e);
        }
    }
}

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

    let state_path = &cfg.state.state_file;
    let mut state = BridgeState::load(state_path)?;
    info!("Loaded state: {:?}", state);

    let poll_interval = Duration::from_secs(cfg.potatomesh.poll_interval_secs);

    loop {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        poll_once(&potato, &matrix, &mut state, state_path, now_secs).await;

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
    matrix.set_display_name(&user_id, &node.long_name).await?;

    // Format the bridged message
    let short = node
        .short_name
        .clone()
        .unwrap_or_else(|| node.long_name.clone());

    let body = format!(
        "[{short}] {text}\n({from_id} → {to_id}, {rssi}, {snr}, {chan}/{preset})",
        short = short,
        text = msg.text,
        from_id = msg.from_id,
        to_id = msg.to_id,
        rssi = msg
            .rssi
            .map(|v| format!("RSSI {v} dB"))
            .unwrap_or_else(|| "RSSI n/a".to_string()),
        snr = msg
            .snr
            .map(|v| format!("SNR {v} dB"))
            .unwrap_or_else(|| "SNR n/a".to_string()),
        chan = msg.channel_name,
        preset = msg.modem_preset,
    );

    matrix.send_text_message_as(&user_id, &body).await?;

    state.update_with(msg);
    Ok(())
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

    #[test]
    fn bridge_state_initially_forwards_all() {
        let state = BridgeState::default();
        let msg = sample_msg(42);

        assert!(state.should_forward(&msg));
    }

    #[test]
    fn bridge_state_tracks_highest_id_and_skips_older() {
        let mut state = BridgeState::default();
        let m1 = sample_msg(10);
        let m2 = sample_msg(20);
        let m3 = sample_msg(15);

        // First message, should forward
        assert!(state.should_forward(&m1));
        state.update_with(&m1);
        assert_eq!(state.last_message_id, Some(10));

        // Second message, higher id, should forward
        assert!(state.should_forward(&m2));
        state.update_with(&m2);
        assert_eq!(state.last_message_id, Some(20));

        // Third message, lower than last, should NOT forward
        assert!(!state.should_forward(&m3));
        // state remains unchanged
        assert_eq!(state.last_message_id, Some(20));
    }

    #[test]
    fn bridge_state_update_is_monotonic() {
        let mut state = BridgeState {
            last_message_id: Some(50),
            last_checked_at: None,
        };
        let m = sample_msg(40);

        state.update_with(&m); // id is lower than current
                               // last_message_id must stay at 50
        assert_eq!(state.last_message_id, Some(50));
    }

    #[test]
    fn bridge_state_load_save_roundtrip() {
        let tmp_dir = tempfile::tempdir().unwrap();
        let file_path = tmp_dir.path().join("state.json");
        let path_str = file_path.to_str().unwrap();

        let state = BridgeState {
            last_message_id: Some(12345),
            last_checked_at: Some(99),
        };
        state.save(path_str).unwrap();

        let loaded_state = BridgeState::load(path_str).unwrap();
        assert_eq!(loaded_state.last_message_id, Some(12345));
        assert_eq!(loaded_state.last_checked_at, Some(99));
    }

    #[test]
    fn bridge_state_load_nonexistent() {
        let tmp_dir = tempfile::tempdir().unwrap();
        let file_path = tmp_dir.path().join("nonexistent.json");
        let path_str = file_path.to_str().unwrap();

        let state = BridgeState::load(path_str).unwrap();
        assert_eq!(state.last_message_id, None);
        assert_eq!(state.last_checked_at, None);
    }

    #[test]
    fn update_checkpoint_requires_last_message_id() {
        let mut state = BridgeState {
            last_message_id: None,
            last_checked_at: Some(10),
        };

        let saved = update_checkpoint(&mut state, true, 123);
        assert!(!saved);
        assert_eq!(state.last_checked_at, Some(10));
    }

    #[test]
    fn update_checkpoint_skips_when_not_delivered() {
        let mut state = BridgeState {
            last_message_id: Some(5),
            last_checked_at: Some(10),
        };

        let saved = update_checkpoint(&mut state, false, 123);
        assert!(!saved);
        assert_eq!(state.last_checked_at, Some(10));
    }

    #[test]
    fn update_checkpoint_sets_when_safe() {
        let mut state = BridgeState {
            last_message_id: Some(5),
            last_checked_at: None,
        };

        let saved = update_checkpoint(&mut state, true, 123);
        assert!(saved);
        assert_eq!(state.last_checked_at, Some(123));
    }

    #[test]
    fn fetch_params_respects_missing_last_message_id() {
        let state = BridgeState {
            last_message_id: None,
            last_checked_at: Some(123),
        };

        let params = build_fetch_params(&state);
        assert_eq!(params.limit, None);
        assert_eq!(params.since, None);
    }

    #[test]
    fn fetch_params_uses_since_when_safe() {
        let state = BridgeState {
            last_message_id: Some(1),
            last_checked_at: Some(123),
        };

        let params = build_fetch_params(&state);
        assert_eq!(params.limit, None);
        assert_eq!(params.since, Some(123));
    }

    #[test]
    fn fetch_params_defaults_to_small_window() {
        let state = BridgeState {
            last_message_id: Some(1),
            last_checked_at: None,
        };

        let params = build_fetch_params(&state);
        assert_eq!(params.limit, Some(10));
        assert_eq!(params.since, None);
    }

    #[tokio::test]
    async fn poll_once_persists_checkpoint_without_messages() {
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
            server_name: "example.org".to_string(),
            room_id: "!roomid:example.org".to_string(),
        };

        let potato = PotatoClient::new(http_client.clone(), potatomesh_cfg);
        let matrix = MatrixAppserviceClient::new(http_client, matrix_cfg);

        let mut state = BridgeState {
            last_message_id: Some(1),
            last_checked_at: None,
        };

        poll_once(&potato, &matrix, &mut state, state_str, 123).await;

        mock_msgs.assert();

        // Should have advanced checkpoint and saved it.
        assert_eq!(state.last_checked_at, Some(123));
        let loaded = BridgeState::load(state_str).unwrap();
        assert_eq!(loaded.last_checked_at, Some(123));
        assert_eq!(loaded.last_message_id, Some(1));
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
            server_name: "example.org".to_string(),
            room_id: "!roomid:example.org".to_string(),
        };

        let node_id = "abcd1234";
        let user_id = format!("@potato_{}:{}", node_id, matrix_cfg.server_name);
        let encoded_user = urlencoding::encode(&user_id);

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

        let mock_display_name = server
            .mock(
                "PUT",
                format!("/_matrix/client/v3/profile/{}/displayname", encoded_user).as_str(),
            )
            .match_query(format!("user_id={}&access_token=AS_TOKEN", encoded_user).as_str())
            .with_status(200)
            .create();

        let http_client = reqwest::Client::new();
        let matrix_client = MatrixAppserviceClient::new(http_client.clone(), matrix_cfg);
        let room_id = &matrix_client.cfg.room_id;
        let encoded_room = urlencoding::encode(room_id);
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
            .with_status(200)
            .create();

        let potato_client = PotatoClient::new(http_client.clone(), potatomesh_cfg);
        let mut state = BridgeState::default();
        let msg = sample_msg(100);

        let result = handle_message(&potato_client, &matrix_client, &mut state, &msg).await;

        assert!(result.is_ok());
        mock_get_node.assert();
        mock_register.assert();
        mock_display_name.assert();
        mock_send.assert();

        assert_eq!(state.last_message_id, Some(100));
    }
}
