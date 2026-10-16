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

mod cli;
mod config;
mod matrix;
mod matrix_server;
mod potatomesh;
mod preset;

use std::{fs, net::SocketAddr, path::Path};

use anyhow::Result;
#[cfg(not(test))]
use clap::Parser;
use tokio::time::Duration;
use tracing::{error, info, warn};

#[cfg(not(test))]
use crate::cli::Cli;
#[cfg(not(test))]
use crate::config::Config;
use crate::matrix::MatrixAppserviceClient;
use crate::matrix_server::run_synapse_listener;
use crate::potatomesh::{FetchParams, PotatoClient, PotatoMessage, PotatoNode};
#[cfg(not(test))]
use tokio::time::sleep;

/// Consecutive poll attempts a single message may fail before it is skipped
/// (advanced past, with a warning) so it cannot block every message queued
/// behind it forever. Transient failures (a brief homeserver/API hiccup)
/// recover well within this bound; a message still failing after this many
/// polls is treated as poison and dropped — a far better outcome than silently
/// losing everything queued behind it.
const MAX_FORWARD_ATTEMPTS: u32 = 5;

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
    /// Id of the message currently blocking the batch, and how many consecutive
    /// polls it has failed to forward. In-memory only (never persisted — a
    /// restart is itself a fresh attempt); used to skip a poison message after
    /// [`MAX_FORWARD_ATTEMPTS`] instead of retrying it forever.
    #[serde(skip)]
    failing_msg_id: Option<u64>,
    #[serde(skip)]
    failing_msg_attempts: u32,
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

/// Emit a sanitized config log without sensitive tokens.
#[cfg(not(test))]
fn log_config(cfg: &Config) {
    info!(
        potatomesh_base_url = cfg.potatomesh.base_url.as_str(),
        matrix_homeserver = cfg.matrix.homeserver.as_str(),
        matrix_server_name = cfg.matrix.server_name.as_str(),
        matrix_room_id = cfg.matrix.room_id.as_str(),
        state_file = cfg.state.state_file.as_str(),
        "Loaded config"
    );
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

                // Contract-conformant rows may arrive with conditional fields
                // compacted away entirely (ACCEPTANCE MB-A1). A row without
                // text (e.g. an emoji reaction) or without a resolved sender
                // can never be forwarded — treat it like a non-text port:
                // advance the watermark and move on rather than retrying it.
                if !is_forwardable(msg) {
                    state.update_with(msg);
                    log_state_update(state);
                    persist_state(state, state_path);
                    continue;
                }

                if let Err(e) = handle_message(potato, matrix, state, msg).await {
                    error!("Error handling message {}: {:?}", msg.id, e);
                    // Track consecutive failures of THIS specific message across
                    // polls (the batch is refetched each poll while the
                    // watermark is stuck, so the same id reappears at the head).
                    if state.failing_msg_id == Some(msg.id) {
                        state.failing_msg_attempts += 1;
                    } else {
                        state.failing_msg_id = Some(msg.id);
                        state.failing_msg_attempts = 1;
                    }

                    if state.failing_msg_attempts >= MAX_FORWARD_ATTEMPTS {
                        // Poison message: it has failed too many polls in a row,
                        // so skip it rather than block the whole batch behind it
                        // indefinitely. Advance the watermark past it (as if
                        // processed) and continue with the rest. Dropping this
                        // one message is the lesser evil versus stalling forever.
                        warn!(
                            "Skipping message {} after {} failed forward attempts; advancing past it",
                            msg.id, state.failing_msg_attempts
                        );
                        state.failing_msg_id = None;
                        state.failing_msg_attempts = 0;
                        state.update_with(msg);
                        persist_state(state, state_path);
                        continue;
                    }

                    // Below the skip threshold: stop the batch here. The failed
                    // message and everything after it stay uncommitted and are
                    // retried, in order, on the next poll — so a *transient*
                    // failure never loses, reorders, or duplicates anything. (The
                    // watermark advances only on success, so a later success can
                    // never jump past this failure — the silent-loss bug.)
                    break;
                }

                // Success clears any failure tracking for this message.
                if state.failing_msg_id == Some(msg.id) {
                    state.failing_msg_id = None;
                    state.failing_msg_attempts = 0;
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

    let cli = Cli::parse();
    let cfg = config::load(cli.to_inputs())?;
    log_config(&cfg);

    // Bound every HTTP request so a hung homeserver or PotatoMesh API cannot
    // stall the single-threaded poll loop indefinitely. `timeout` caps the
    // whole request/response; `connect_timeout` caps TCP/TLS establishment.
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .build()?;
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

/// Whether `poll_once` can bridge this message at all: it needs a resolved
/// sender (`node_id`, to puppet the Matrix user) and non-blank text (the
/// Matrix body). Compacted rows lacking either — emoji reactions, unresolved
/// senders (ACCEPTANCE MB-A1) — are skipped with the watermark advanced. A
/// row with `sender_verified: false` always has a `node_id` (SPEC SV2), even
/// though it is posted as the appservice user ([`posts_as_puppet`]).
fn is_forwardable(msg: &PotatoMessage) -> bool {
    let has_text = msg
        .text
        .as_deref()
        .map(|text| !text.trim().is_empty())
        .unwrap_or(false);
    has_text && msg.node_id.is_some()
}

/// Whether a message goes out as the puppet of its `node_id`. A row the web
/// app serves with `sender_verified: false` names its sender only in its text
/// (a MeshCore channel message, SPEC SV1), which no key backs: it is posted as
/// the appservice user instead, its body unchanged, and no puppet speaks for
/// the named node (SPEC SV4). Every other row keeps its puppet.
fn posts_as_puppet(msg: &PotatoMessage) -> bool {
    msg.sender_verified != Some(false)
}

/// Post one message to Matrix. A row [`posts_as_puppet`] accepts goes out as
/// the puppet of its `node_id`; a row the web app serves with
/// `sender_verified: false` goes out as the appservice user, its body
/// unchanged (SPEC SV4).
async fn handle_message(
    potato: &PotatoClient,
    matrix: &MatrixAppserviceClient,
    state: &mut BridgeState,
    msg: &PotatoMessage,
) -> Result<()> {
    // `poll_once` gates on `is_forwardable`, so a missing sender is
    // unreachable from the poll loop; the early return keeps the function
    // total for direct callers.
    let Some(node_id) = msg.node_id.as_deref() else {
        return Ok(());
    };
    let text = msg.text.as_deref().unwrap_or("");

    // The puppet that posts the message, or `None` for the appservice user.
    let puppet = if posts_as_puppet(msg) {
        let node = potato.get_node(node_id).await?;
        let localpart = MatrixAppserviceClient::localpart_from_node_id(node_id);
        let user_id = matrix.user_id(&localpart);

        // Ensure puppet exists & has display name
        matrix.ensure_user_registered(&localpart).await?;
        matrix.ensure_user_joined_room(&user_id).await?;
        let display_name = display_name_for_node(&node);
        matrix.set_display_name(&user_id, &display_name).await?;
        Some(user_id)
    } else {
        matrix.ensure_appservice_joined_room().await?;
        None
    };

    // Format the bridged message. A compacted-away `lora_freq` renders as the
    // existing `0` "unknown" sentinel — collapse that to `None` to match the
    // JS pipeline (which runs `normalizeFrequency` and discards 0/non-finite
    // before reaching the preset lookup). A missing `modem_preset` falls
    // through to the `??` slot and a missing `channel_name` renders empty
    // brackets, mirroring the web frontend's unknown-metadata convention.
    let lora_freq = msg.lora_freq.unwrap_or(0);
    let freq_mhz = if lora_freq > 0 {
        Some(lora_freq as f64)
    } else {
        None
    };
    let abbr = preset::abbreviate_preset(msg.modem_preset.as_deref().unwrap_or(""), freq_mhz);
    let preset_short = preset::normalize_preset_slot(abbr.as_deref());
    let tag = protocol_tag(msg.protocol.as_deref());
    let prefix = format!(
        "{tag}[{freq}][{preset_short}][{channel}]",
        freq = lora_freq,
        preset_short = preset_short,
        channel = msg.channel_name.as_deref().unwrap_or(""),
    );
    let (body, formatted_body) = format_message_bodies(&prefix, text);

    match puppet.as_deref() {
        Some(user_id) => {
            matrix
                .send_formatted_message_as(user_id, &body, &formatted_body)
                .await?
        }
        None => {
            matrix
                .send_formatted_message_as_appservice(&body, &formatted_body)
                .await?
        }
    }

    info!("Bridged message: {:?}", msg);
    state.update_with(msg);
    log_state_update(state);
    Ok(())
}

/// Short tag prepended to the message prefix so readers can tell the source
/// mesh protocol apart at a glance. `"[MT]"` identifies Meshtastic (also the
/// default when the protocol field is missing, since the full stack treats a
/// missing protocol as Meshtastic), `"[MC]"` identifies MeshCore and `"[RT]"`
/// identifies Reticulum, the three protocols the web knows (SPEC S6, RL8). Any
/// other value renders as `"[??]"` so unknown protocols surface visibly instead
/// of being silently relabeled as Meshtastic.
fn protocol_tag(protocol: Option<&str>) -> &'static str {
    match protocol {
        Some("meshcore") => "[MC]",
        Some("meshtastic") | None => "[MT]",
        Some("reticulum") => "[RT]",
        Some(_) => "[??]",
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
mod tests;
