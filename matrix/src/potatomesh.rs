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

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::config::PotatomeshConfig;

/// One row of `GET /api/messages`.
///
/// Only `id`, `rx_time`, and `rx_iso` are required by the API contract
/// (`data/mesh_ingestor/CONTRACTS.md`). Every other column is conditionally
/// present: the web app compacts NULL/empty values *out* of each row
/// (`compact_api_row`), so a conformant row may omit any of them entirely —
/// e.g. `channel_name` is emitted "only when not encrypted and known", and an
/// emoji-reaction row carries no `text`. Modeling such fields as required
/// made serde reject the whole batch on one compacted row (ACCEPTANCE MB-A1),
/// which is why everything conditional is an `Option` with a serde default.
#[allow(dead_code)]
#[derive(Debug, Deserialize, Clone)]
pub struct PotatoMessage {
    /// Stable message id (contract-required, dedup key).
    pub id: u64,
    /// Receive time in unix seconds (contract-required).
    pub rx_time: u64,
    /// Receive time as ISO-8601 (contract-required).
    pub rx_iso: String,
    /// Sender id; absent when the sender never resolved.
    #[serde(default)]
    pub from_id: Option<String>,
    /// Destination id; absent on the rare senderless/DM fallback rows.
    #[serde(default)]
    pub to_id: Option<String>,
    /// Local channel slot index; absent e.g. on direct messages.
    #[serde(default)]
    pub channel: Option<u8>,
    /// Meshtastic port name; absent for encrypted or non-app payloads.
    #[serde(default)]
    pub portnum: Option<String>,
    /// Message text; absent on reaction-only rows (`reply_id`/`emoji`).
    #[serde(default)]
    pub text: Option<String>,
    /// Receive RSSI in dBm when the ingestor reported one.
    #[serde(default)]
    pub rssi: Option<i16>,
    /// Remaining hop budget when the ingestor reported one.
    #[serde(default)]
    pub hop_limit: Option<u8>,
    /// LoRa frequency in MHz; absent when the ingestor did not report it.
    #[serde(default)]
    pub lora_freq: Option<u32>,
    /// Modem preset label; absent when the ingestor did not report it.
    #[serde(default)]
    pub modem_preset: Option<String>,
    /// Resolved channel name; only present when not encrypted and known.
    #[serde(default)]
    pub channel_name: Option<String>,
    /// Receive SNR in dB when the ingestor reported one.
    #[serde(default)]
    pub snr: Option<f32>,
    /// Id of the message this row reacts/replies to, when any.
    #[serde(default)]
    pub reply_id: Option<u64>,
    /// Canonical sender node id; absent when the sender never resolved.
    #[serde(default)]
    pub node_id: Option<String>,
    /// Mesh backend that produced this message, e.g. "meshtastic" or
    /// "meshcore". Optional because historical payloads predate the field.
    #[serde(default)]
    pub protocol: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct FetchParams {
    pub limit: Option<u32>,
    pub since: Option<u64>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, Clone)]
pub struct PotatoNode {
    pub node_id: String,
    #[serde(default)]
    pub short_name: Option<String>,
    pub long_name: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub hw_model: Option<String>,
    #[serde(default)]
    pub last_heard: Option<u64>,
    #[serde(default)]
    pub first_heard: Option<u64>,
    #[serde(default)]
    pub latitude: Option<f64>,
    #[serde(default)]
    pub longitude: Option<f64>,
    #[serde(default)]
    pub altitude: Option<f64>,
}

#[derive(Clone)]
pub struct PotatoClient {
    http: reqwest::Client,
    cfg: PotatomeshConfig,
    // simple in-memory cache for node metadata
    nodes_cache: Arc<RwLock<HashMap<String, PotatoNode>>>,
}

impl PotatoClient {
    pub fn new(http: reqwest::Client, cfg: PotatomeshConfig) -> Self {
        Self {
            http,
            cfg,
            nodes_cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Build the API root; accept either a bare domain or one already ending in `/api`.
    fn api_base(&self) -> String {
        let trimmed = self.cfg.base_url.trim_end_matches('/');
        if trimmed.ends_with("/api") {
            trimmed.to_string()
        } else {
            format!("{}/api", trimmed)
        }
    }

    fn messages_url(&self) -> String {
        format!("{}/messages", self.api_base())
    }

    fn node_url(&self, hex_id: &str) -> String {
        // Request the CANONICAL bang-prefixed id, percent-encoded as "%21".
        // A bare all-decimal hex id (e.g. "27336717") is resolved by the web
        // API as a Meshtastic node *num* and 404s (ACCEPTANCE NL-A1); the
        // bang disambiguates per the canonical `!%08x` form (SPEC D8).
        // e.g. https://potatomesh.net/api/nodes/%2167fc83cb
        format!("{}/nodes/%21{}", self.api_base(), hex_id)
    }

    /// Basic liveness check against the PotatoMesh API.
    pub async fn health_check(&self) -> anyhow::Result<()> {
        let base = self
            .cfg
            .base_url
            .trim_end_matches('/')
            .trim_end_matches("/api");
        let url = format!("{}/version", base);
        let resp = self.http.get(&url).send().await?;
        if resp.status().is_success() {
            tracing::info!("PotatoMesh API healthy at {}", self.cfg.base_url);
            Ok(())
        } else {
            Err(anyhow::anyhow!(
                "PotatoMesh health check failed with status {}",
                resp.status()
            ))
        }
    }

    pub async fn fetch_messages(&self, params: FetchParams) -> anyhow::Result<Vec<PotatoMessage>> {
        let mut req = self.http.get(self.messages_url());
        if let Some(limit) = params.limit {
            req = req.query(&[("limit", limit)]);
        }
        if let Some(since) = params.since {
            req = req.query(&[("since", since)]);
        }

        let resp = req.send().await?.error_for_status()?;

        let msgs: Vec<PotatoMessage> = resp.json().await?;
        Ok(msgs)
    }

    pub async fn get_node(&self, node_id_with_bang: &str) -> anyhow::Result<PotatoNode> {
        // node_id is like "!67fc83cb" → we need "67fc83cb"
        let hex = node_id_with_bang.trim_start_matches('!').to_string();

        {
            let cache = self.nodes_cache.read().await;
            if let Some(n) = cache.get(&hex) {
                return Ok(n.clone());
            }
        }

        let url = self.node_url(&hex);
        let resp = self.http.get(url).send().await?.error_for_status()?;
        let node: PotatoNode = resp.json().await?;

        {
            let mut cache = self.nodes_cache.write().await;
            cache.insert(hex, node.clone());
        }

        Ok(node)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_sample_message_array() {
        let json = r#"
        [
          {
            "id": 2947676906,
            "rx_time": 1764241436,
            "rx_iso": "2025-11-27T11:03:56Z",
            "from_id": "!da6556d4",
            "to_id": "^all",
            "channel": 1,
            "portnum": "TEXT_MESSAGE_APP",
            "text": "Ping",
            "rssi": -111,
            "hop_limit": 1,
            "lora_freq": 868,
            "modem_preset": "MediumFast",
            "channel_name": "TEST",
            "snr": -9.0,
            "node_id": "!06871773"
          }
        ]
        "#;

        let msgs: Vec<PotatoMessage> = serde_json::from_str(json).expect("valid message json");
        assert_eq!(msgs.len(), 1);
        let m = &msgs[0];
        assert_eq!(m.id, 2947676906);
        assert_eq!(m.from_id.as_deref(), Some("!da6556d4"));
        assert_eq!(m.node_id.as_deref(), Some("!06871773"));
        assert_eq!(m.portnum.as_deref(), Some("TEXT_MESSAGE_APP"));
        assert_eq!(m.lora_freq, Some(868));
        assert!((m.snr.unwrap() - (-9.0)).abs() < f32::EPSILON);
    }

    #[test]
    fn deserialize_message_with_missing_optional_fields() {
        let json = r#"
        [
          {
            "id": 1,
            "rx_time": 0,
            "rx_iso": "2025-11-27T11:03:56Z",
            "from_id": "!abcd1234",
            "to_id": "^all",
            "channel": 1,
            "text": "Ping",
            "lora_freq": 868,
            "modem_preset": "MediumFast",
            "channel_name": "TEST",
            "node_id": "!abcd1234"
          }
        ]
        "#;

        let msgs: Vec<PotatoMessage> = serde_json::from_str(json).expect("valid message json");
        assert_eq!(msgs.len(), 1);
        let m = &msgs[0];
        assert!(m.portnum.is_none());
        assert!(m.rssi.is_none());
        assert!(m.hop_limit.is_none());
        assert!(m.snr.is_none());
        assert!(m.protocol.is_none());
    }

    #[test]
    fn deserialize_message_with_meshcore_protocol() {
        let json = r#"
        [
          {
            "id": 42,
            "rx_time": 1764241436,
            "rx_iso": "2025-11-27T11:03:56Z",
            "from_id": "!da6556d4",
            "to_id": "^all",
            "channel": 0,
            "portnum": "TEXT_MESSAGE_APP",
            "text": "Hi from meshcore",
            "lora_freq": 868,
            "modem_preset": "MediumFast",
            "channel_name": "General",
            "node_id": "!da6556d4",
            "protocol": "meshcore"
          }
        ]
        "#;

        let msgs: Vec<PotatoMessage> = serde_json::from_str(json).expect("valid message json");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].protocol.as_deref(), Some("meshcore"));
    }

    /// Regression (live outage 2026-07-26, ACCEPTANCE MB-A1): the web API
    /// compacts NULL/empty columns *out* of each row (`compact_api_row`), and
    /// `CONTRACTS.md` declares `channel_name` present "only when not encrypted
    /// and known" — so a row without the key is contract-conformant. The
    /// bridge modeled the field as required, and serde failed the ENTIRE
    /// batch on the one such row (`missing field \`channel_name\``), leaving
    /// the bridge unable to fetch any messages at all. The second row below is
    /// the offending production row verbatim.
    #[test]
    fn deserialize_batch_with_row_missing_channel_name() {
        let json = r#"
        [
          {
            "id": 2947676906,
            "rx_time": 1764241436,
            "rx_iso": "2025-11-27T11:03:56Z",
            "from_id": "!da6556d4",
            "to_id": "^all",
            "channel": 1,
            "portnum": "TEXT_MESSAGE_APP",
            "text": "Ping",
            "rssi": -111,
            "hop_limit": 1,
            "lora_freq": 868,
            "modem_preset": "MediumFast",
            "channel_name": "TEST",
            "snr": -9.0,
            "node_id": "!06871773"
          },
          {
            "id": 2810844287777950,
            "rx_time": 1785090651,
            "rx_iso": "2026-07-26T18:30:51Z",
            "from_id": "!88e00b48",
            "to_id": "^all",
            "channel": 24,
            "portnum": "TEXT_MESSAGE_APP",
            "text": "lilygo: moin moin",
            "lora_freq": 869,
            "modem_preset": "SF8/BW62/CR5",
            "snr": -5.25,
            "ingestor": "!930d4a21",
            "protocol": "meshcore",
            "node_id": "!88e00b48"
          }
        ]
        "#;

        let msgs: Vec<PotatoMessage> =
            serde_json::from_str(json).expect("row without channel_name must parse");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].id, 2947676906);
        assert_eq!(msgs[1].id, 2810844287777950);
    }

    /// Regression companion to `deserialize_batch_with_row_missing_channel_name`
    /// (ACCEPTANCE MB-A1): `compact_api_row` may strip EVERY conditional field,
    /// leaving only the contract-required `id` / `rx_time` / `rx_iso` (e.g. an
    /// emoji-reaction row whose `text` is empty and whose sender never
    /// resolved). Such a row must parse rather than poison the batch.
    #[test]
    fn deserialize_maximally_compacted_row() {
        let json = r#"
        [
          {
            "id": 7,
            "rx_time": 1785090000,
            "rx_iso": "2026-07-26T18:20:00Z",
            "reply_id": 42,
            "emoji": "1"
          }
        ]
        "#;

        let msgs: Vec<PotatoMessage> =
            serde_json::from_str(json).expect("maximally compacted row must parse");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id, 7);
        assert_eq!(msgs[0].rx_time, 1785090000);
    }

    #[test]
    fn deserialize_sample_node() {
        let json = r#"
        {
          "node_id": "!67fc83cb",
          "short_name": "83CB",
          "long_name": "Meshtastic 83CB",
          "role": "CLIENT_HIDDEN",
          "last_heard": 1764250515,
          "first_heard": 1758993817,
          "last_seen_iso": "2025-11-27T13:35:15Z"
        }
        "#;

        let node: PotatoNode = serde_json::from_str(json).expect("valid node json");
        assert_eq!(node.node_id, "!67fc83cb");
        assert_eq!(node.short_name.as_deref(), Some("83CB"));
        assert_eq!(node.long_name, "Meshtastic 83CB");
        assert_eq!(node.role.as_deref(), Some("CLIENT_HIDDEN"));
        assert_eq!(node.last_heard, Some(1764250515));
        assert_eq!(node.first_heard, Some(1758993817));
        assert!(node.latitude.is_none());
    }

    #[test]
    fn node_hex_id_is_stripped_correctly() {
        let with_bang = "!deadbeef";
        let hex = with_bang.trim_start_matches('!');
        assert_eq!(hex, "deadbeef");

        let already_hex = "cafebabe";
        let hex2 = already_hex.trim_start_matches('!');
        assert_eq!(hex2, "cafebabe");
    }

    #[test]
    fn test_new_potato_client() {
        let http_client = reqwest::Client::new();
        let config = PotatomeshConfig {
            base_url: "http://localhost:8080".to_string(),
            poll_interval_secs: 60,
        };
        let client = PotatoClient::new(http_client, config);
        assert_eq!(client.cfg.base_url, "http://localhost:8080");
        assert_eq!(client.cfg.poll_interval_secs, 60);
    }

    #[test]
    fn test_messages_url() {
        let http_client = reqwest::Client::new();
        let config = PotatomeshConfig {
            base_url: "http://localhost:8080".to_string(),
            poll_interval_secs: 60,
        };
        let client = PotatoClient::new(http_client, config);
        assert_eq!(client.messages_url(), "http://localhost:8080/api/messages");
    }

    #[test]
    fn test_messages_url_with_trailing_slash() {
        let http_client = reqwest::Client::new();
        let config = PotatomeshConfig {
            base_url: "http://localhost:8080/".to_string(),
            poll_interval_secs: 60,
        };
        let client = PotatoClient::new(http_client, config);
        assert_eq!(client.messages_url(), "http://localhost:8080/api/messages");
    }

    #[test]
    fn test_messages_url_with_existing_api_suffix() {
        let http_client = reqwest::Client::new();
        let config = PotatomeshConfig {
            base_url: "http://localhost:8080/api/".to_string(),
            poll_interval_secs: 60,
        };
        let client = PotatoClient::new(http_client, config);
        assert_eq!(client.messages_url(), "http://localhost:8080/api/messages");
    }

    #[test]
    fn test_node_url() {
        let http_client = reqwest::Client::new();
        let config = PotatomeshConfig {
            base_url: "http://localhost:8080".to_string(),
            poll_interval_secs: 60,
        };
        let client = PotatoClient::new(http_client, config);
        assert_eq!(
            client.node_url("1234"),
            "http://localhost:8080/api/nodes/%211234"
        );
    }

    #[tokio::test]
    async fn test_fetch_messages_success() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/api/messages")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"
                [
                  {
                    "id": 2947676906, "rx_time": 1764241436, "rx_iso": "2025-11-27T11:03:56Z",
                    "from_id": "!da6556d4", "to_id": "^all", "channel": 1,
                    "portnum": "TEXT_MESSAGE_APP", "text": "Ping", "rssi": -111,
                    "hop_limit": 1, "lora_freq": 868, "modem_preset": "MediumFast",
                    "channel_name": "TEST", "snr": -9.0, "node_id": "!06871773"
                  }
                ]
                "#,
            )
            .create();

        let http_client = reqwest::Client::new();
        let config = PotatomeshConfig {
            base_url: server.url(),
            poll_interval_secs: 60,
        };
        let client = PotatoClient::new(http_client, config);
        let result = client.fetch_messages(FetchParams::default()).await;

        mock.assert();
        assert!(result.is_ok());
        let messages = result.unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, 2947676906);
    }

    #[tokio::test]
    async fn test_health_check_success() {
        let mut server = mockito::Server::new_async().await;
        let mock = server.mock("GET", "/version").with_status(200).create();

        let http_client = reqwest::Client::new();
        let config = PotatomeshConfig {
            base_url: server.url(),
            poll_interval_secs: 60,
        };
        let client = PotatoClient::new(http_client, config);
        let result = client.health_check().await;

        mock.assert();
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_health_check_strips_api_suffix() {
        let mut server = mockito::Server::new_async().await;
        let mock = server.mock("GET", "/version").with_status(200).create();

        let http_client = reqwest::Client::new();
        let mut base = server.url();
        base.push_str("/api");
        let config = PotatomeshConfig {
            base_url: base,
            poll_interval_secs: 60,
        };
        let client = PotatoClient::new(http_client, config);
        let result = client.health_check().await;

        mock.assert();
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_health_check_failure() {
        let mut server = mockito::Server::new_async().await;
        let mock = server.mock("GET", "/version").with_status(500).create();

        let http_client = reqwest::Client::new();
        let config = PotatomeshConfig {
            base_url: server.url(),
            poll_interval_secs: 60,
        };
        let client = PotatoClient::new(http_client, config);
        let result = client.health_check().await;

        mock.assert();
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_fetch_messages_error() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/api/messages")
            .with_status(500)
            .create();

        let http_client = reqwest::Client::new();
        let config = PotatomeshConfig {
            base_url: server.url(),
            poll_interval_secs: 60,
        };
        let client = PotatoClient::new(http_client, config);
        let result = client.fetch_messages(FetchParams::default()).await;

        mock.assert();
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_fetch_messages_with_limit_and_since() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/api/messages")
            .match_query(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("limit".into(), "10".into()),
                mockito::Matcher::UrlEncoded("since".into(), "123".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body("[]")
            .create();

        let http_client = reqwest::Client::new();
        let config = PotatomeshConfig {
            base_url: server.url(),
            poll_interval_secs: 60,
        };
        let client = PotatoClient::new(http_client, config);
        let params = FetchParams {
            limit: Some(10),
            since: Some(123),
        };
        let result = client.fetch_messages(params).await;

        mock.assert();
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    /// Regression (live 2026-07-27, ACCEPTANCE NL-A1): node lookups must
    /// request the CANONICAL bang-prefixed id (percent-encoded `%21`), never
    /// the bare hex. The web API resolves a bare all-decimal-digit ref (e.g.
    /// `27336717`, a valid 8-hex id) as a Meshtastic node *num* and 404s,
    /// which cost the bridge five failed polls and a dropped message. Only
    /// the canonical path is mounted here — a bare-hex request hits no mock
    /// and fails the lookup.
    #[tokio::test]
    async fn get_node_requests_canonical_bang_id() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/api/nodes/%2127336717")
            .match_query(mockito::Matcher::Any)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"node_id":"!27336717","long_name":"🦅 Birdperson/portable/pocket","short_name":"🦅"}"#,
            )
            .create();

        let http_client = reqwest::Client::new();
        let config = PotatomeshConfig {
            base_url: server.url(),
            poll_interval_secs: 60,
        };
        let client = PotatoClient::new(http_client, config);
        let result = client.get_node("!27336717").await;

        mock.assert();
        let node = result.expect("canonical bang-id lookup must succeed");
        assert_eq!(node.node_id, "!27336717");
    }

    #[tokio::test]
    async fn test_get_node_cache_hit() {
        let http_client = reqwest::Client::new();
        let config = PotatomeshConfig {
            base_url: "http://localhost:8080".to_string(),
            poll_interval_secs: 60,
        };
        let client = PotatoClient::new(http_client, config);
        let node = PotatoNode {
            node_id: "!1234".to_string(),
            short_name: Some("test".to_string()),
            long_name: "test node".to_string(),
            role: None,
            hw_model: None,
            last_heard: None,
            first_heard: None,
            latitude: None,
            longitude: None,
            altitude: None,
        };
        client
            .nodes_cache
            .write()
            .await
            .insert("1234".to_string(), node.clone());
        let result = client.get_node("!1234").await;
        assert!(result.is_ok());
        let got = result.unwrap();
        assert_eq!(got.node_id, "!1234");
        assert_eq!(got.short_name.unwrap(), "test");
    }

    #[tokio::test]
    async fn test_get_node_cache_miss() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/api/nodes/%211234")
            .match_query(mockito::Matcher::Any)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"
                {
                  "node_id": "!1234", "short_name": "test", "long_name": "test node",
                  "role": "test", "hw_model": "test", "last_heard": 1, "first_heard": 1,
                  "latitude": 1.0, "longitude": 1.0, "altitude": 1.0
                }
                "#,
            )
            .create();

        let http_client = reqwest::Client::new();
        let config = PotatomeshConfig {
            base_url: server.url(),
            poll_interval_secs: 60,
        };
        let client = PotatoClient::new(http_client, config);

        // first call, should miss cache and hit the server
        let result = client.get_node("!1234").await;
        mock.assert();
        assert!(result.is_ok());

        // second call, should hit cache
        let result2 = client.get_node("!1234").await;
        assert!(result2.is_ok());
        // mockito would panic here if we made a second request
    }

    #[tokio::test]
    async fn test_get_node_error() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/api/nodes/%211234")
            .with_status(500)
            .create();

        let http_client = reqwest::Client::new();
        let config = PotatomeshConfig {
            base_url: server.url(),
            poll_interval_secs: 60,
        };
        let client = PotatoClient::new(http_client, config);
        let result = client.get_node("!1234").await;
        mock.assert();
        assert!(result.is_err());
    }
}
