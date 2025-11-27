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
