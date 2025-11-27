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

    #[test]
    fn parse_minimal_config_from_toml_str() {
        let toml_str = r#"
            [potatomesh]
            base_url = "https://potatomesh.net/api"
            poll_interval_secs = 10

            [matrix]
            homeserver = "https://matrix.example.org"
            as_token = "AS_TOKEN"
            server_name = "example.org"
            room_id = "!roomid:example.org"

            [state]
            state_file = "bridge_state.json"
        "#;

        let cfg: Config = toml::from_str(toml_str).expect("toml should parse");
        assert_eq!(cfg.potatomesh.base_url, "https://potatomesh.net/api");
        assert_eq!(cfg.potatomesh.poll_interval_secs, 10);

        assert_eq!(cfg.matrix.homeserver, "https://matrix.example.org");
        assert_eq!(cfg.matrix.as_token, "AS_TOKEN");
        assert_eq!(cfg.matrix.server_name, "example.org");
        assert_eq!(cfg.matrix.room_id, "!roomid:example.org");

        assert_eq!(cfg.state.state_file, "bridge_state.json");
    }
}
