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

use clap::{ArgAction, Parser};

use crate::config::{ConfigInputs, ConfigOverrides};

/// CLI arguments for the Matrix bridge.
#[derive(Debug, Parser)]
#[command(name = "potatomesh-matrix-bridge", version, about = "PotatoMesh Matrix bridge")]
pub struct Cli {
    /// Path to the configuration TOML file.
    #[arg(long, value_name = "PATH")]
    pub config: Option<String>,
    /// Path to the bridge state file.
    #[arg(long, value_name = "PATH")]
    pub state_file: Option<String>,
    /// PotatoMesh base URL.
    #[arg(long, value_name = "URL")]
    pub potatomesh_base_url: Option<String>,
    /// Poll interval in seconds.
    #[arg(long, value_name = "SECS")]
    pub potatomesh_poll_interval_secs: Option<u64>,
    /// Matrix homeserver base URL.
    #[arg(long, value_name = "URL")]
    pub matrix_homeserver: Option<String>,
    /// Matrix appservice access token.
    #[arg(long, value_name = "TOKEN")]
    pub matrix_as_token: Option<String>,
    /// Path to a secret file containing the Matrix appservice access token.
    #[arg(long, value_name = "PATH")]
    pub matrix_as_token_file: Option<String>,
    /// Matrix homeserver token for inbound appservice requests.
    #[arg(long, value_name = "TOKEN")]
    pub matrix_hs_token: Option<String>,
    /// Path to a secret file containing the Matrix homeserver token.
    #[arg(long, value_name = "PATH")]
    pub matrix_hs_token_file: Option<String>,
    /// Matrix server name (domain).
    #[arg(long, value_name = "NAME")]
    pub matrix_server_name: Option<String>,
    /// Matrix room id to forward into.
    #[arg(long, value_name = "ROOM")]
    pub matrix_room_id: Option<String>,
    /// Force container defaults (overrides detection).
    #[arg(long, action = ArgAction::SetTrue)]
    pub container: bool,
    /// Disable container defaults (overrides detection).
    #[arg(long, action = ArgAction::SetTrue)]
    pub no_container: bool,
    /// Directory to search for default secret files.
    #[arg(long, value_name = "PATH")]
    pub secrets_dir: Option<String>,
}

impl Cli {
    /// Convert CLI args into configuration inputs.
    pub fn to_inputs(&self) -> ConfigInputs {
        ConfigInputs {
            config_path: self.config.clone(),
            secrets_dir: self.secrets_dir.clone(),
            container_override: resolve_container_override(self.container, self.no_container),
            container_hint: None,
            overrides: ConfigOverrides {
                potatomesh_base_url: self.potatomesh_base_url.clone(),
                potatomesh_poll_interval_secs: self.potatomesh_poll_interval_secs,
                matrix_homeserver: self.matrix_homeserver.clone(),
                matrix_as_token: self.matrix_as_token.clone(),
                matrix_as_token_file: self.matrix_as_token_file.clone(),
                matrix_hs_token: self.matrix_hs_token.clone(),
                matrix_hs_token_file: self.matrix_hs_token_file.clone(),
                matrix_server_name: self.matrix_server_name.clone(),
                matrix_room_id: self.matrix_room_id.clone(),
                state_file: self.state_file.clone(),
            },
        }
    }
}

/// Resolve container override flags into an optional boolean.
fn resolve_container_override(container: bool, no_container: bool) -> Option<bool> {
    match (container, no_container) {
        (true, false) => Some(true),
        (false, true) => Some(false),
        _ => None,
    }
}
