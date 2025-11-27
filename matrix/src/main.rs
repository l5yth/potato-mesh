mod config;
mod matrix;
mod potatomesh;

use std::{fs, path::Path};

use anyhow::Result;
use tokio::time::{sleep, Duration};
use tracing::{error, info};

use crate::config::Config;
use crate::matrix::MatrixAppserviceClient;
use crate::potatomesh::{PotatoClient, PotatoMessage};

#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
struct BridgeState {
    last_message_id: Option<u64>,
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
    let matrix = MatrixAppserviceClient::new(http.clone(), cfg.matrix.clone());

    let state_path = &cfg.state.state_file;
    let mut state = BridgeState::load(state_path)?;
    info!("Loaded state: {:?}", state);

    let poll_interval = Duration::from_secs(cfg.potatomesh.poll_interval_secs);

    loop {
        match potato.fetch_messages().await {
            Ok(mut msgs) => {
                // sort by id ascending so we process in order
                msgs.sort_by_key(|m| m.id);

                for msg in msgs {
                    if !state.should_forward(&msg) {
                        continue;
                    }

                    // Filter to the ports you care about
                    if msg.portnum != "TEXT_MESSAGE_APP" {
                        state.update_with(&msg);
                        continue;
                    }

                    if let Err(e) = handle_message(&potato, &matrix, &mut state, &msg).await {
                        error!("Error handling message {}: {:?}", msg.id, e);
                    }

                    // persist after each processed message
                    if let Err(e) = state.save(state_path) {
                        error!("Error saving state: {:?}", e);
                    }
                }
            }
            Err(e) => {
                error!("Error fetching PotatoMesh messages: {:?}", e);
            }
        }

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
        "[{short}] {text}\n({from_id} → {to_id}, RSSI {rssi} dB, SNR {snr} dB, {chan}/{preset})",
        short = short,
        text = msg.text,
        from_id = msg.from_id,
        to_id = msg.to_id,
        rssi = msg.rssi,
        snr = msg.snr,
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
    use crate::potatomesh::PotatoMessage;

    fn sample_msg(id: u64) -> PotatoMessage {
        PotatoMessage {
            id,
            rx_time: 0,
            rx_iso: "2025-11-27T00:00:00Z".to_string(),
            from_id: "!abcd1234".to_string(),
            to_id: "^all".to_string(),
            channel: 1,
            portnum: "TEXT_MESSAGE_APP".to_string(),
            text: "Ping".to_string(),
            rssi: -100,
            hop_limit: 1,
            lora_freq: 868,
            modem_preset: "MediumFast".to_string(),
            channel_name: "TEST".to_string(),
            snr: 0.0,
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
        };
        let m = sample_msg(40);

        state.update_with(&m); // id is lower than current
                               // last_message_id must stay at 50
        assert_eq!(state.last_message_id, Some(50));
    }
}
