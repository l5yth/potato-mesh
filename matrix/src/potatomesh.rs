use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::config::PotatomeshConfig;

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
