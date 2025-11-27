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
