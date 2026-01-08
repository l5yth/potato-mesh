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
use std::{fs, path::Path};

#[derive(Debug, Deserialize, Clone)]
pub struct PotatomeshConfig {
    pub base_url: String,
    pub poll_interval_secs: u64,
}

#[derive(Debug, Deserialize, Clone)]
pub struct MatrixConfig {
    pub homeserver: String,
    pub as_token: String,
    pub hs_token: String,
    pub server_name: String,
    pub room_id: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct StateConfig {
    pub state_file: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    pub potatomesh: PotatomeshConfig,
    pub matrix: MatrixConfig,
    pub state: StateConfig,
}

impl Config {
    pub fn load_from_file(path: &str) -> anyhow::Result<Self> {
        let contents = fs::read_to_string(path)?;
        let cfg = toml::from_str(&contents)?;
        Ok(cfg)
    }

    pub fn from_default_path() -> anyhow::Result<Self> {
        let path = "Config.toml";
        if !Path::new(path).exists() {
            anyhow::bail!("Config file {path} not found");
        }
        Self::load_from_file(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::io::Write;

    #[test]
    fn parse_minimal_config_from_toml_str() {
        let toml_str = r#"
            [potatomesh]
            base_url = "https://potatomesh.net/"
            poll_interval_secs = 10

            [matrix]
            homeserver = "https://matrix.example.org"
            as_token = "AS_TOKEN"
            hs_token = "HS_TOKEN"
            server_name = "example.org"
            room_id = "!roomid:example.org"

            [state]
            state_file = "bridge_state.json"
        "#;

        let cfg: Config = toml::from_str(toml_str).expect("toml should parse");
        assert_eq!(cfg.potatomesh.base_url, "https://potatomesh.net/");
        assert_eq!(cfg.potatomesh.poll_interval_secs, 10);

        assert_eq!(cfg.matrix.homeserver, "https://matrix.example.org");
        assert_eq!(cfg.matrix.as_token, "AS_TOKEN");
        assert_eq!(cfg.matrix.hs_token, "HS_TOKEN");
        assert_eq!(cfg.matrix.server_name, "example.org");
        assert_eq!(cfg.matrix.room_id, "!roomid:example.org");

        assert_eq!(cfg.state.state_file, "bridge_state.json");
    }

    #[test]
    fn load_from_file_not_found() {
        let result = Config::load_from_file("file_that_does_not_exist.toml");
        assert!(result.is_err());
    }

    #[test]
    fn load_from_file_valid_file() {
        let toml_str = r#"
            [potatomesh]
            base_url = "https://potatomesh.net/"
            poll_interval_secs = 10

            [matrix]
            homeserver = "https://matrix.example.org"
            as_token = "AS_TOKEN"
            hs_token = "HS_TOKEN"
            server_name = "example.org"
            room_id = "!roomid:example.org"

            [state]
            state_file = "bridge_state.json"
        "#;
        let mut file = tempfile::NamedTempFile::new().unwrap();
        write!(file, "{}", toml_str).unwrap();
        let result = Config::load_from_file(file.path().to_str().unwrap());
        assert!(result.is_ok());
    }

    #[test]
    #[serial]
    fn from_default_path_not_found() {
        let tmp_dir = tempfile::tempdir().unwrap();
        std::env::set_current_dir(tmp_dir.path()).unwrap();
        let result = Config::from_default_path();
        assert!(result.is_err());
    }

    #[test]
    #[serial]
    fn from_default_path_found() {
        let toml_str = r#"
            [potatomesh]
            base_url = "https://potatomesh.net/"
            poll_interval_secs = 10

            [matrix]
            homeserver = "https://matrix.example.org"
            as_token = "AS_TOKEN"
            hs_token = "HS_TOKEN"
            server_name = "example.org"
            room_id = "!roomid:example.org"

            [state]
            state_file = "bridge_state.json"
        "#;
        let tmp_dir = tempfile::tempdir().unwrap();
        let file_path = tmp_dir.path().join("Config.toml");
        let mut file = std::fs::File::create(file_path).unwrap();
        write!(file, "{}", toml_str).unwrap();
        std::env::set_current_dir(tmp_dir.path()).unwrap();
        let result = Config::from_default_path();
        assert!(result.is_ok());
    }
}
