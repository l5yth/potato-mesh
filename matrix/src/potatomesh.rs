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

#[allow(dead_code)]
#[derive(Debug, Deserialize, Clone)]
pub struct PotatoMessage {
    pub id: u64,
    pub rx_time: u64,
    pub rx_iso: String,
    pub from_id: String,
    pub to_id: String,
    pub channel: u8,
    #[serde(default)]
    pub portnum: Option<String>,
    pub text: String,
    #[serde(default)]
    pub rssi: Option<i16>,
    #[serde(default)]
    pub hop_limit: Option<u8>,
    pub lora_freq: u32,
    pub modem_preset: String,
    pub channel_name: String,
    #[serde(default)]
    pub snr: Option<f32>,
    #[serde(default)]
    pub reply_id: Option<u64>,
    pub node_id: String,
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
        // e.g. https://potatomesh.net/api/nodes/67fc83cb
        format!("{}/nodes/{}", self.api_base(), hex_id)
    }

    /// Basic liveness check against the PotatoMesh API.
    pub async fn health_check(&self) -> anyhow::Result<()> {
        let base = self.cfg.base_url.trim_end_matches('/');
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
        assert_eq!(m.from_id, "!da6556d4");
        assert_eq!(m.node_id, "!06871773");
        assert_eq!(m.portnum.as_deref(), Some("TEXT_MESSAGE_APP"));
        assert_eq!(m.lora_freq, 868);
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
            client.node_url("!1234"),
            "http://localhost:8080/api/nodes/!1234"
        );
    }

    #[tokio::test]
    async fn test_fetch_messages_success() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/api/messages")
            .match_query(mockito::Matcher::Any) // allow optional query params
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
            .match_query(mockito::Matcher::Any)
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
            .match_query("limit=10&since=123")
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
            .mock("GET", "/api/nodes/1234")
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
            .mock("GET", "/api/nodes/1234")
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
