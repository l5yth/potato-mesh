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

use clap::Parser;

use crate::config::{
    BootstrapOverrides, ConfigOverrides, MatrixOverrides, PotatomeshOverrides, StateOverrides,
};

/// Command-line overrides for the Matrix bridge.
#[derive(Debug, Parser)]
#[command(name = "potatomesh-matrix-bridge", version)]
pub struct Cli {
    /// TOML config path (optional, defaults to Config.toml or /app/Config.toml in containers).
    #[arg(long = "config", alias = "config-path")]
    pub config_path: Option<String>,

    /// Override the state file path.
    #[arg(long)]
    pub state_file: Option<String>,

    /// Override the PotatoMesh base URL.
    #[arg(long)]
    pub potatomesh_base_url: Option<String>,

    /// Override the PotatoMesh poll interval in seconds.
    #[arg(long)]
    pub potatomesh_poll_interval_secs: Option<u64>,

    /// Override the Matrix homeserver URL.
    #[arg(long)]
    pub matrix_homeserver: Option<String>,

    /// Override the Matrix appservice access token.
    #[arg(long)]
    pub matrix_as_token: Option<String>,

    /// Override the Matrix server name.
    #[arg(long)]
    pub matrix_server_name: Option<String>,

    /// Override the Matrix room ID.
    #[arg(long)]
    pub matrix_room_id: Option<String>,

    /// Force container defaults on even if container detection is false.
    #[arg(long, conflicts_with = "no_container_defaults")]
    pub container_defaults: bool,

    /// Disable container defaults even if a container is detected.
    #[arg(long, conflicts_with = "container_defaults")]
    pub no_container_defaults: bool,
}

impl Cli {
    /// Convert CLI flags to bootstrap overrides for config loading.
    pub fn into_overrides(self) -> BootstrapOverrides {
        let container_defaults = if self.container_defaults {
            Some(true)
        } else if self.no_container_defaults {
            Some(false)
        } else {
            None
        };

        BootstrapOverrides {
            config_path: self.config_path,
            container_defaults,
            values: ConfigOverrides {
                potatomesh: PotatomeshOverrides {
                    base_url: self.potatomesh_base_url,
                    poll_interval_secs: self.potatomesh_poll_interval_secs,
                },
                matrix: MatrixOverrides {
                    homeserver: self.matrix_homeserver,
                    as_token: self.matrix_as_token,
                    server_name: self.matrix_server_name,
                    room_id: self.matrix_room_id,
                },
                state: StateOverrides {
                    state_file: self.state_file,
                },
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_overrides_map_to_config() {
        let cli = Cli::parse_from([
            "bridge",
            "--config",
            "/tmp/Config.toml",
            "--state-file",
            "/tmp/state.json",
            "--potatomesh-base-url",
            "https://potato.example/",
            "--potatomesh-poll-interval-secs",
            "15",
            "--matrix-homeserver",
            "https://matrix.example.org",
            "--matrix-as-token",
            "token",
            "--matrix-server-name",
            "example.org",
            "--matrix-room-id",
            "!room:example.org",
            "--container-defaults",
        ]);

        let overrides = cli.into_overrides();
        assert_eq!(overrides.config_path.as_deref(), Some("/tmp/Config.toml"));
        assert_eq!(overrides.container_defaults, Some(true));
        assert_eq!(
            overrides.values.potatomesh.base_url.as_deref(),
            Some("https://potato.example/")
        );
        assert_eq!(overrides.values.potatomesh.poll_interval_secs, Some(15));
        assert_eq!(
            overrides.values.matrix.homeserver.as_deref(),
            Some("https://matrix.example.org")
        );
        assert_eq!(overrides.values.matrix.as_token.as_deref(), Some("token"));
        assert_eq!(
            overrides.values.matrix.server_name.as_deref(),
            Some("example.org")
        );
        assert_eq!(
            overrides.values.matrix.room_id.as_deref(),
            Some("!room:example.org")
        );
        assert_eq!(
            overrides.values.state.state_file.as_deref(),
            Some("/tmp/state.json")
        );
    }

    #[test]
    fn cli_can_disable_container_defaults() {
        let cli = Cli::parse_from(["bridge", "--no-container-defaults"]);
        let overrides = cli.into_overrides();
        assert_eq!(overrides.container_defaults, Some(false));
    }
}
