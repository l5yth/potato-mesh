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

const DEFAULT_CONFIG_PATH: &str = "Config.toml";
const CONTAINER_CONFIG_PATH: &str = "/app/Config.toml";
const DEFAULT_STATE_FILE: &str = "bridge_state.json";
const CONTAINER_STATE_FILE: &str = "/app/bridge_state.json";
const DEFAULT_SECRETS_DIR: &str = "/run/secrets";
const CONTAINER_POLL_INTERVAL_SECS: u64 = 15;

/// PotatoMesh API settings.
#[derive(Debug, Deserialize, Clone)]
pub struct PotatomeshConfig {
    pub base_url: String,
    pub poll_interval_secs: u64,
}

/// Matrix appservice settings for the bridge.
#[derive(Debug, Deserialize, Clone)]
pub struct MatrixConfig {
    pub homeserver: String,
    pub as_token: String,
    pub hs_token: String,
    pub server_name: String,
    pub room_id: String,
}

/// State file configuration for the bridge.
#[derive(Debug, Deserialize, Clone)]
pub struct StateConfig {
    pub state_file: String,
}

/// Full configuration loaded for the bridge runtime.
#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    pub potatomesh: PotatomeshConfig,
    pub matrix: MatrixConfig,
    pub state: StateConfig,
}

#[derive(Debug, Deserialize, Clone, Default)]
struct PartialPotatomeshConfig {
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    poll_interval_secs: Option<u64>,
}

#[derive(Debug, Deserialize, Clone, Default)]
struct PartialMatrixConfig {
    #[serde(default)]
    homeserver: Option<String>,
    #[serde(default)]
    as_token: Option<String>,
    #[serde(default)]
    hs_token: Option<String>,
    #[serde(default)]
    server_name: Option<String>,
    #[serde(default)]
    room_id: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
struct PartialStateConfig {
    #[serde(default)]
    state_file: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
struct PartialConfig {
    #[serde(default)]
    potatomesh: PartialPotatomeshConfig,
    #[serde(default)]
    matrix: PartialMatrixConfig,
    #[serde(default)]
    state: PartialStateConfig,
}

/// Overwrite an optional value when the incoming value is present.
fn merge_option<T>(target: &mut Option<T>, incoming: Option<T>) {
    if incoming.is_some() {
        *target = incoming;
    }
}

/// CLI or environment overrides for configuration fields.
#[derive(Debug, Clone, Default)]
pub struct ConfigOverrides {
    pub potatomesh_base_url: Option<String>,
    pub potatomesh_poll_interval_secs: Option<u64>,
    pub matrix_homeserver: Option<String>,
    pub matrix_as_token: Option<String>,
    pub matrix_as_token_file: Option<String>,
    pub matrix_hs_token: Option<String>,
    pub matrix_hs_token_file: Option<String>,
    pub matrix_server_name: Option<String>,
    pub matrix_room_id: Option<String>,
    pub state_file: Option<String>,
}

impl ConfigOverrides {
    fn apply_non_token_overrides(&self, cfg: &mut PartialConfig) {
        merge_option(
            &mut cfg.potatomesh.base_url,
            self.potatomesh_base_url.clone(),
        );
        merge_option(
            &mut cfg.potatomesh.poll_interval_secs,
            self.potatomesh_poll_interval_secs,
        );
        merge_option(&mut cfg.matrix.homeserver, self.matrix_homeserver.clone());
        merge_option(&mut cfg.matrix.server_name, self.matrix_server_name.clone());
        merge_option(&mut cfg.matrix.room_id, self.matrix_room_id.clone());
        merge_option(&mut cfg.state.state_file, self.state_file.clone());
    }

    fn merge(self, higher: ConfigOverrides) -> ConfigOverrides {
        ConfigOverrides {
            potatomesh_base_url: higher.potatomesh_base_url.or(self.potatomesh_base_url),
            potatomesh_poll_interval_secs: higher
                .potatomesh_poll_interval_secs
                .or(self.potatomesh_poll_interval_secs),
            matrix_homeserver: higher.matrix_homeserver.or(self.matrix_homeserver),
            matrix_as_token: higher.matrix_as_token.or(self.matrix_as_token),
            matrix_as_token_file: higher.matrix_as_token_file.or(self.matrix_as_token_file),
            matrix_hs_token: higher.matrix_hs_token.or(self.matrix_hs_token),
            matrix_hs_token_file: higher.matrix_hs_token_file.or(self.matrix_hs_token_file),
            matrix_server_name: higher.matrix_server_name.or(self.matrix_server_name),
            matrix_room_id: higher.matrix_room_id.or(self.matrix_room_id),
            state_file: higher.state_file.or(self.state_file),
        }
    }
}

/// Inputs gathered from CLI flags or environment variables.
#[derive(Debug, Clone, Default)]
pub struct ConfigInputs {
    pub config_path: Option<String>,
    pub secrets_dir: Option<String>,
    pub container_override: Option<bool>,
    pub container_hint: Option<String>,
    pub overrides: ConfigOverrides,
}

impl ConfigInputs {
    /// Merge two input sets, preferring values from `higher`.
    pub fn merge(self, higher: ConfigInputs) -> ConfigInputs {
        ConfigInputs {
            config_path: higher.config_path.or(self.config_path),
            secrets_dir: higher.secrets_dir.or(self.secrets_dir),
            container_override: higher.container_override.or(self.container_override),
            container_hint: higher.container_hint.or(self.container_hint),
            overrides: self.overrides.merge(higher.overrides),
        }
    }

    /// Load configuration inputs from the process environment.
    #[cfg(not(test))]
    pub fn from_env() -> anyhow::Result<Self> {
        let overrides = ConfigOverrides {
            potatomesh_base_url: env_var("POTATOMESH_BASE_URL"),
            potatomesh_poll_interval_secs: parse_u64_env("POTATOMESH_POLL_INTERVAL_SECS")?,
            matrix_homeserver: env_var("MATRIX_HOMESERVER"),
            matrix_as_token: env_var("MATRIX_AS_TOKEN"),
            matrix_as_token_file: env_var("MATRIX_AS_TOKEN_FILE"),
            matrix_hs_token: env_var("MATRIX_HS_TOKEN"),
            matrix_hs_token_file: env_var("MATRIX_HS_TOKEN_FILE"),
            matrix_server_name: env_var("MATRIX_SERVER_NAME"),
            matrix_room_id: env_var("MATRIX_ROOM_ID"),
            state_file: env_var("STATE_FILE"),
        };
        Ok(ConfigInputs {
            config_path: env_var("POTATOMESH_CONFIG"),
            secrets_dir: env_var("POTATOMESH_SECRETS_DIR"),
            container_override: parse_bool_env("POTATOMESH_CONTAINER")?,
            container_hint: env_var("CONTAINER"),
            overrides,
        })
    }
}

impl Config {
    /// Load a full Config from a TOML file.
    #[cfg(test)]
    pub fn load_from_file(path: &str) -> anyhow::Result<Self> {
        let contents = fs::read_to_string(path)?;
        let cfg = toml::from_str(&contents)?;
        Ok(cfg)
    }
}

/// Load a Config by merging CLI/env overrides with an optional TOML file.
#[cfg(not(test))]
pub fn load(cli_inputs: ConfigInputs) -> anyhow::Result<Config> {
    let env_inputs = ConfigInputs::from_env()?;
    let cgroup_hint = read_cgroup();
    load_from_sources(cli_inputs, env_inputs, cgroup_hint.as_deref())
}

/// Load configuration by merging CLI/env inputs and an optional config file.
fn load_from_sources(
    cli_inputs: ConfigInputs,
    env_inputs: ConfigInputs,
    cgroup_hint: Option<&str>,
) -> anyhow::Result<Config> {
    let merged_inputs = env_inputs.merge(cli_inputs);
    let container = detect_container(
        merged_inputs.container_override,
        merged_inputs.container_hint.as_deref(),
        cgroup_hint,
    );
    let defaults = default_paths(container);

    let base_cfg = resolve_base_config(&merged_inputs, &defaults)?;
    let mut cfg = base_cfg.unwrap_or_default();
    merged_inputs.overrides.apply_non_token_overrides(&mut cfg);

    let secrets_dir = resolve_secrets_dir(&merged_inputs, container, &defaults);
    let as_token = resolve_token(
        cfg.matrix.as_token.clone(),
        merged_inputs.overrides.matrix_as_token.clone(),
        merged_inputs.overrides.matrix_as_token_file.as_deref(),
        secrets_dir.as_deref(),
        "matrix_as_token",
    )?;
    let hs_token = resolve_token(
        cfg.matrix.hs_token.clone(),
        merged_inputs.overrides.matrix_hs_token.clone(),
        merged_inputs.overrides.matrix_hs_token_file.as_deref(),
        secrets_dir.as_deref(),
        "matrix_hs_token",
    )?;

    if cfg.potatomesh.poll_interval_secs.is_none() && container {
        cfg.potatomesh.poll_interval_secs = Some(defaults.poll_interval_secs);
    }

    if cfg.state.state_file.is_none() {
        cfg.state.state_file = Some(defaults.state_file);
    }

    let missing = collect_missing_fields(&cfg, &as_token, &hs_token);
    if !missing.is_empty() {
        anyhow::bail!(
            "Missing required configuration values: {}",
            missing.join(", ")
        );
    }

    Ok(Config {
        potatomesh: PotatomeshConfig {
            base_url: cfg.potatomesh.base_url.unwrap(),
            poll_interval_secs: cfg.potatomesh.poll_interval_secs.unwrap(),
        },
        matrix: MatrixConfig {
            homeserver: cfg.matrix.homeserver.unwrap(),
            as_token: as_token.unwrap(),
            hs_token: hs_token.unwrap(),
            server_name: cfg.matrix.server_name.unwrap(),
            room_id: cfg.matrix.room_id.unwrap(),
        },
        state: StateConfig {
            state_file: cfg.state.state_file.unwrap(),
        },
    })
}

/// Collect the missing required field identifiers for error reporting.
fn collect_missing_fields(
    cfg: &PartialConfig,
    as_token: &Option<String>,
    hs_token: &Option<String>,
) -> Vec<&'static str> {
    let mut missing = Vec::new();
    if cfg.potatomesh.base_url.is_none() {
        missing.push("potatomesh.base_url");
    }
    if cfg.potatomesh.poll_interval_secs.is_none() {
        missing.push("potatomesh.poll_interval_secs");
    }
    if cfg.matrix.homeserver.is_none() {
        missing.push("matrix.homeserver");
    }
    if as_token.is_none() {
        missing.push("matrix.as_token");
    }
    if hs_token.is_none() {
        missing.push("matrix.hs_token");
    }
    if cfg.matrix.server_name.is_none() {
        missing.push("matrix.server_name");
    }
    if cfg.matrix.room_id.is_none() {
        missing.push("matrix.room_id");
    }
    if cfg.state.state_file.is_none() {
        missing.push("state.state_file");
    }
    missing
}

/// Resolve the base TOML config file, honoring explicit config paths.
fn resolve_base_config(
    inputs: &ConfigInputs,
    defaults: &DefaultPaths,
) -> anyhow::Result<Option<PartialConfig>> {
    if let Some(path) = &inputs.config_path {
        return Ok(Some(load_partial_from_file(path)?));
    }
    let container_path = Path::new(&defaults.config_path);
    if container_path.exists() {
        return Ok(Some(load_partial_from_file(&defaults.config_path)?));
    }
    let host_path = Path::new(DEFAULT_CONFIG_PATH);
    if host_path.exists() {
        return Ok(Some(load_partial_from_file(DEFAULT_CONFIG_PATH)?));
    }
    Ok(None)
}

/// Decide which secrets directory to use based on inputs and defaults.
fn resolve_secrets_dir(
    inputs: &ConfigInputs,
    container: bool,
    defaults: &DefaultPaths,
) -> Option<String> {
    if let Some(explicit) = inputs.secrets_dir.clone() {
        return Some(explicit);
    }
    if container {
        return Some(defaults.secrets_dir.clone());
    }
    None
}

/// Resolve a token value from explicit values, secret files, or config file values.
fn resolve_token(
    base_value: Option<String>,
    explicit_value: Option<String>,
    explicit_file: Option<&str>,
    secrets_dir: Option<&str>,
    default_secret_name: &str,
) -> anyhow::Result<Option<String>> {
    if let Some(value) = explicit_value {
        return Ok(Some(value));
    }
    if let Some(path) = explicit_file {
        return Ok(Some(read_secret_file(path)?));
    }
    if let Some(dir) = secrets_dir {
        let default_path = Path::new(dir).join(default_secret_name);
        if default_path.exists() {
            return Ok(Some(read_secret_file(
                default_path
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("Invalid secret file path"))?,
            )?));
        }
    }
    Ok(base_value)
}

/// Read and trim a secret file from disk.
fn read_secret_file(path: &str) -> anyhow::Result<String> {
    let contents = fs::read_to_string(path)?;
    let trimmed = contents.trim();
    if trimmed.is_empty() {
        anyhow::bail!("Secret file {path} is empty");
    }
    Ok(trimmed.to_string())
}

/// Load a partial config from a TOML file.
fn load_partial_from_file(path: &str) -> anyhow::Result<PartialConfig> {
    let contents = fs::read_to_string(path)?;
    let cfg = toml::from_str(&contents)?;
    Ok(cfg)
}

/// Compute default paths and intervals based on container mode.
fn default_paths(container: bool) -> DefaultPaths {
    if container {
        DefaultPaths {
            config_path: CONTAINER_CONFIG_PATH.to_string(),
            state_file: CONTAINER_STATE_FILE.to_string(),
            secrets_dir: DEFAULT_SECRETS_DIR.to_string(),
            poll_interval_secs: CONTAINER_POLL_INTERVAL_SECS,
        }
    } else {
        DefaultPaths {
            config_path: DEFAULT_CONFIG_PATH.to_string(),
            state_file: DEFAULT_STATE_FILE.to_string(),
            secrets_dir: DEFAULT_SECRETS_DIR.to_string(),
            poll_interval_secs: CONTAINER_POLL_INTERVAL_SECS,
        }
    }
}

#[derive(Debug, Clone)]
struct DefaultPaths {
    config_path: String,
    state_file: String,
    secrets_dir: String,
    poll_interval_secs: u64,
}

/// Detect whether the bridge is running inside a container.
fn detect_container(
    override_value: Option<bool>,
    env_hint: Option<&str>,
    cgroup_hint: Option<&str>,
) -> bool {
    if let Some(value) = override_value {
        return value;
    }
    if let Some(hint) = env_hint {
        if !hint.trim().is_empty() {
            return true;
        }
    }
    if let Some(cgroup) = cgroup_hint {
        let haystack = cgroup.to_ascii_lowercase();
        return haystack.contains("docker")
            || haystack.contains("kubepods")
            || haystack.contains("containerd")
            || haystack.contains("podman");
    }
    false
}

/// Read the primary cgroup file for container detection.
#[cfg(not(test))]
fn read_cgroup() -> Option<String> {
    fs::read_to_string("/proc/1/cgroup").ok()
}

/// Read and trim an environment variable value.
#[cfg(not(test))]
fn env_var(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

/// Parse a u64 environment variable value.
#[cfg(not(test))]
fn parse_u64_env(key: &str) -> anyhow::Result<Option<u64>> {
    match env_var(key) {
        None => Ok(None),
        Some(value) => value
            .parse::<u64>()
            .map(Some)
            .map_err(|e| anyhow::anyhow!("Invalid {key} value: {e}")),
    }
}

/// Parse a boolean environment variable value.
#[cfg(not(test))]
fn parse_bool_env(key: &str) -> anyhow::Result<Option<bool>> {
    match env_var(key) {
        None => Ok(None),
        Some(value) => parse_bool_value(key, &value).map(Some),
    }
}

/// Parse a boolean string with standard truthy/falsy values.
#[cfg(not(test))]
fn parse_bool_value(key: &str, value: &str) -> anyhow::Result<bool> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => anyhow::bail!("Invalid {key} value: {value}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::io::Write;

    fn minimal_overrides() -> ConfigOverrides {
        ConfigOverrides {
            potatomesh_base_url: Some("https://potatomesh.net/".to_string()),
            potatomesh_poll_interval_secs: Some(10),
            matrix_homeserver: Some("https://matrix.example.org".to_string()),
            matrix_as_token: Some("AS_TOKEN".to_string()),
            matrix_hs_token: Some("HS_TOKEN".to_string()),
            matrix_server_name: Some("example.org".to_string()),
            matrix_room_id: Some("!roomid:example.org".to_string()),
            state_file: Some("bridge_state.json".to_string()),
            matrix_as_token_file: None,
            matrix_hs_token_file: None,
        }
    }

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
    fn detect_container_prefers_override() {
        assert!(detect_container(Some(true), None, None));
        assert!(!detect_container(
            Some(false),
            Some("docker"),
            Some("docker")
        ));
    }

    #[test]
    fn detect_container_from_hint_or_cgroup() {
        assert!(detect_container(None, Some("docker"), None));
        assert!(detect_container(None, None, Some("kubepods")));
        assert!(!detect_container(None, None, Some("")));
    }

    #[test]
    fn load_uses_cli_overrides_over_env() {
        let toml_str = r#"
            [potatomesh]
            base_url = "https://potatomesh.net/"
            poll_interval_secs = 5

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

        let env_inputs = ConfigInputs {
            config_path: Some(file.path().to_str().unwrap().to_string()),
            overrides: ConfigOverrides {
                potatomesh_base_url: Some("https://env.example/".to_string()),
                ..minimal_overrides()
            },
            ..ConfigInputs::default()
        };
        let cli_inputs = ConfigInputs {
            overrides: ConfigOverrides {
                potatomesh_base_url: Some("https://cli.example/".to_string()),
                ..ConfigOverrides::default()
            },
            ..ConfigInputs::default()
        };

        let cfg = load_from_sources(cli_inputs, env_inputs, None).unwrap();
        assert_eq!(cfg.potatomesh.base_url, "https://cli.example/");
    }

    #[test]
    fn load_uses_container_secret_defaults() {
        let tmp_dir = tempfile::tempdir().unwrap();
        let secrets_dir = tmp_dir.path();
        fs::write(secrets_dir.join("matrix_as_token"), "FROM_SECRET").unwrap();

        let cli_inputs = ConfigInputs {
            secrets_dir: Some(secrets_dir.to_string_lossy().to_string()),
            container_override: Some(true),
            overrides: ConfigOverrides {
                potatomesh_base_url: Some("https://potatomesh.net/".to_string()),
                potatomesh_poll_interval_secs: Some(10),
                matrix_homeserver: Some("https://matrix.example.org".to_string()),
                matrix_hs_token: Some("HS_TOKEN".to_string()),
                matrix_server_name: Some("example.org".to_string()),
                matrix_room_id: Some("!roomid:example.org".to_string()),
                state_file: Some("bridge_state.json".to_string()),
                ..ConfigOverrides::default()
            },
            ..ConfigInputs::default()
        };

        let cfg = load_from_sources(cli_inputs, ConfigInputs::default(), None).unwrap();
        assert_eq!(cfg.matrix.as_token, "FROM_SECRET");
    }

    #[test]
    fn load_uses_container_default_poll_interval() {
        let tmp_dir = tempfile::tempdir().unwrap();
        let original_dir = std::env::current_dir().unwrap();
        std::env::set_current_dir(tmp_dir.path()).unwrap();

        let cli_inputs = ConfigInputs {
            container_override: Some(true),
            overrides: ConfigOverrides {
                potatomesh_base_url: Some("https://potatomesh.net/".to_string()),
                matrix_homeserver: Some("https://matrix.example.org".to_string()),
                matrix_as_token: Some("AS_TOKEN".to_string()),
                matrix_hs_token: Some("HS_TOKEN".to_string()),
                matrix_server_name: Some("example.org".to_string()),
                matrix_room_id: Some("!roomid:example.org".to_string()),
                ..ConfigOverrides::default()
            },
            ..ConfigInputs::default()
        };

        let cfg = load_from_sources(cli_inputs, ConfigInputs::default(), None).unwrap();
        assert_eq!(
            cfg.potatomesh.poll_interval_secs,
            CONTAINER_POLL_INTERVAL_SECS
        );
        std::env::set_current_dir(original_dir).unwrap();
    }

    #[test]
    #[serial]
    fn load_uses_default_state_path_when_missing() {
        let tmp_dir = tempfile::tempdir().unwrap();
        let original_dir = std::env::current_dir().unwrap();
        std::env::set_current_dir(tmp_dir.path()).unwrap();

        let cli_inputs = ConfigInputs {
            overrides: ConfigOverrides {
                potatomesh_base_url: Some("https://potatomesh.net/".to_string()),
                potatomesh_poll_interval_secs: Some(10),
                matrix_homeserver: Some("https://matrix.example.org".to_string()),
                matrix_as_token: Some("AS_TOKEN".to_string()),
                matrix_hs_token: Some("HS_TOKEN".to_string()),
                matrix_server_name: Some("example.org".to_string()),
                matrix_room_id: Some("!roomid:example.org".to_string()),
                ..ConfigOverrides::default()
            },
            ..ConfigInputs::default()
        };

        let cfg = load_from_sources(cli_inputs, ConfigInputs::default(), None).unwrap();
        assert_eq!(cfg.state.state_file, DEFAULT_STATE_FILE);
        std::env::set_current_dir(original_dir).unwrap();
    }
}
