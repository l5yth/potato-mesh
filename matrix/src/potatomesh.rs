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
    /// `Some(false)` when the web app attributed the sender by the `Name:`
    /// prefix of `text` rather than by an id the packet carries: a MeshCore
    /// channel message (SPEC SV1/SV2). Absent on every other row, and from
    /// web apps that predate the field.
    #[serde(default)]
    pub sender_verified: Option<bool>,
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
mod tests;
