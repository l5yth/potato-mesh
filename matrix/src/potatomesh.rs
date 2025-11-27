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
    pub portnum: String,
    pub text: String,
    pub rssi: i16,
    pub hop_limit: u8,
    pub lora_freq: u32,
    pub modem_preset: String,
    pub channel_name: String,
    pub snr: f32,
    #[serde(default)]
    pub reply_id: Option<u64>,
    pub node_id: String,
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

    fn messages_url(&self) -> String {
        format!("{}/messages", self.cfg.base_url)
    }

    fn node_url(&self, hex_id: &str) -> String {
        // e.g. https://potatomesh.net/api/nodes/67fc83cb
        format!("{}/nodes/{}", self.cfg.base_url, hex_id)
    }

    pub async fn fetch_messages(&self) -> anyhow::Result<Vec<PotatoMessage>> {
        let resp = self
            .http
            .get(self.messages_url())
            .send()
            .await?
            .error_for_status()?;

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
        assert_eq!(m.portnum, "TEXT_MESSAGE_APP");
        assert_eq!(m.lora_freq, 868);
        assert!((m.snr - (-9.0)).abs() < f32::EPSILON);
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
}
