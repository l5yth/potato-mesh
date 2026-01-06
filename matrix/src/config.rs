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
use std::{
    env, fs,
    path::{Path, PathBuf},
};

const DEFAULT_CONFIG_PATH: &str = "Config.toml";
const DEFAULT_CONTAINER_CONFIG_PATH: &str = "/app/Config.toml";
const DEFAULT_STATE_FILE: &str = "bridge_state.json";
const DEFAULT_CONTAINER_STATE_FILE: &str = "/app/bridge_state.json";
const DEFAULT_POLL_INTERVAL_SECS: u64 = 60;
const DEFAULT_CONTAINER_POLL_INTERVAL_SECS: u64 = 120;
const DEFAULT_SECRETS_DIR: &str = "/run/secrets";

const ENV_CONTAINER: &str = "CONTAINER";
const ENV_CONTAINER_DEFAULTS: &str = "POTATOMESH_CONTAINER_DEFAULTS";
const ENV_CONFIG_PATH: &str = "POTATOMESH_CONFIG_PATH";
const ENV_SECRETS_DIR: &str = "POTATOMESH_SECRETS_DIR";

const ENV_POTATOMESH_BASE_URL: &str = "POTATOMESH_BASE_URL";
const ENV_POTATOMESH_POLL_INTERVAL: &str = "POTATOMESH_POLL_INTERVAL_SECS";
const ENV_MATRIX_HOMESERVER: &str = "MATRIX_HOMESERVER";
const ENV_MATRIX_AS_TOKEN: &str = "MATRIX_AS_TOKEN";
const ENV_MATRIX_SERVER_NAME: &str = "MATRIX_SERVER_NAME";
const ENV_MATRIX_ROOM_ID: &str = "MATRIX_ROOM_ID";
const ENV_STATE_FILE: &str = "STATE_FILE";

/// Configuration for the PotatoMesh API access.
#[derive(Debug, Deserialize, Clone)]
pub struct PotatomeshConfig {
    pub base_url: String,
    pub poll_interval_secs: u64,
}

/// Configuration for Matrix appservice access.
#[derive(Debug, Deserialize, Clone)]
pub struct MatrixConfig {
    pub homeserver: String,
    pub as_token: String,
    pub server_name: String,
    pub room_id: String,
}

/// Configuration for persisted bridge state.
#[derive(Debug, Deserialize, Clone)]
pub struct StateConfig {
    pub state_file: String,
}

/// Complete bridge configuration, merged from file and overrides.
#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    pub potatomesh: PotatomeshConfig,
    pub matrix: MatrixConfig,
    pub state: StateConfig,
}

/// Optional configuration overrides for a single section.
#[derive(Debug, Clone, Default)]
pub struct PotatomeshOverrides {
    pub base_url: Option<String>,
    pub poll_interval_secs: Option<u64>,
}

/// Optional Matrix overrides.
#[derive(Debug, Clone, Default)]
pub struct MatrixOverrides {
    pub homeserver: Option<String>,
    pub as_token: Option<String>,
    pub server_name: Option<String>,
    pub room_id: Option<String>,
}

/// Optional state overrides.
#[derive(Debug, Clone, Default)]
pub struct StateOverrides {
    pub state_file: Option<String>,
}

/// Override bundle merged from TOML, CLI, env, and secret files.
#[derive(Debug, Clone, Default)]
pub struct ConfigOverrides {
    pub potatomesh: PotatomeshOverrides,
    pub matrix: MatrixOverrides,
    pub state: StateOverrides,
}

/// Runtime context discovered while bootstrapping configuration.
#[derive(Debug, Clone)]
pub struct RuntimeContext {
    pub in_container: bool,
    pub container_defaults: bool,
    pub config_path: String,
    pub secrets_dir: Option<PathBuf>,
}

/// Bootstrapped configuration and runtime context.
#[derive(Debug, Clone)]
pub struct ConfigBootstrap {
    pub config: Config,
    pub context: RuntimeContext,
}

/// CLI-provided override bundle with container defaults toggles.
#[derive(Debug, Clone, Default)]
pub struct BootstrapOverrides {
    pub config_path: Option<String>,
    pub container_defaults: Option<bool>,
    pub values: ConfigOverrides,
}

#[derive(Debug, Deserialize, Clone, Default)]
struct PotatomeshFileOverrides {
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    poll_interval_secs: Option<u64>,
}

#[derive(Debug, Deserialize, Clone, Default)]
struct MatrixFileOverrides {
    #[serde(default)]
    homeserver: Option<String>,
    #[serde(default)]
    as_token: Option<String>,
    #[serde(default)]
    server_name: Option<String>,
    #[serde(default)]
    room_id: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
struct StateFileOverrides {
    #[serde(default)]
    state_file: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
struct ConfigFileOverrides {
    #[serde(default)]
    potatomesh: PotatomeshFileOverrides,
    #[serde(default)]
    matrix: MatrixFileOverrides,
    #[serde(default)]
    state: StateFileOverrides,
}

impl ConfigOverrides {
    /// Merge another override set, replacing only fields present in `other`.
    pub fn merge(&mut self, other: ConfigOverrides) {
        self.potatomesh.merge(other.potatomesh);
        self.matrix.merge(other.matrix);
        self.state.merge(other.state);
    }
}

impl PotatomeshOverrides {
    /// Merge optional fields, keeping existing values when the override is empty.
    fn merge(&mut self, other: PotatomeshOverrides) {
        if other.base_url.is_some() {
            self.base_url = other.base_url;
        }
        if other.poll_interval_secs.is_some() {
            self.poll_interval_secs = other.poll_interval_secs;
        }
    }
}

impl MatrixOverrides {
    /// Merge optional fields, keeping existing values when the override is empty.
    fn merge(&mut self, other: MatrixOverrides) {
        if other.homeserver.is_some() {
            self.homeserver = other.homeserver;
        }
        if other.as_token.is_some() {
            self.as_token = other.as_token;
        }
        if other.server_name.is_some() {
            self.server_name = other.server_name;
        }
        if other.room_id.is_some() {
            self.room_id = other.room_id;
        }
    }
}

impl StateOverrides {
    /// Merge optional fields, keeping existing values when the override is empty.
    fn merge(&mut self, other: StateOverrides) {
        if other.state_file.is_some() {
            self.state_file = other.state_file;
        }
    }
}

impl From<ConfigFileOverrides> for ConfigOverrides {
    fn from(value: ConfigFileOverrides) -> Self {
        Self {
            potatomesh: PotatomeshOverrides {
                base_url: value.potatomesh.base_url,
                poll_interval_secs: value.potatomesh.poll_interval_secs,
            },
            matrix: MatrixOverrides {
                homeserver: value.matrix.homeserver,
                as_token: value.matrix.as_token,
                server_name: value.matrix.server_name,
                room_id: value.matrix.room_id,
            },
            state: StateOverrides {
                state_file: value.state.state_file,
            },
        }
    }
}

/// Detect container context from env or cgroup hints.
fn detect_container() -> bool {
    let env_value = env::var(ENV_CONTAINER).ok();
    let cgroup_contents = fs::read_to_string("/proc/1/cgroup").ok();
    detect_container_from(env_value.as_deref(), cgroup_contents.as_deref())
}

/// Detect container context from provided inputs (used for testing).
fn detect_container_from(env_value: Option<&str>, cgroup_contents: Option<&str>) -> bool {
    if let Some(value) = env_value.map(str::trim).filter(|v| !v.is_empty()) {
        let normalized = value.to_ascii_lowercase();
        return normalized != "0" && normalized != "false";
    }

    if let Some(cgroup) = cgroup_contents {
        let haystack = cgroup.to_lowercase();
        return haystack.contains("docker")
            || haystack.contains("containerd")
            || haystack.contains("kubepods")
            || haystack.contains("podman")
            || haystack.contains("lxc");
    }

    false
}

/// Read an environment variable, trimming whitespace and ignoring empty values.
fn read_env_string(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Parse a boolean env var, accepting common truthy/falsey values.
fn read_env_bool(key: &str) -> anyhow::Result<Option<bool>> {
    let raw = match read_env_string(key) {
        Some(value) => value,
        None => return Ok(None),
    };

    let normalized = raw.to_ascii_lowercase();
    let parsed = match normalized.as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => {
            return Err(anyhow::anyhow!(
                "Invalid boolean value for {}: {}",
                key,
                raw
            ))
        }
    };

    Ok(Some(parsed))
}

/// Parse a u64 env var with context in error messages.
fn read_env_u64(key: &str) -> anyhow::Result<Option<u64>> {
    let raw = match read_env_string(key) {
        Some(value) => value,
        None => return Ok(None),
    };
    let parsed = raw
        .parse::<u64>()
        .map_err(|err| anyhow::anyhow!("Invalid integer value for {}: {} ({})", key, raw, err))?;
    Ok(Some(parsed))
}

/// Load a secret value from a file path and trim trailing whitespace.
fn read_secret_file(path: &Path) -> anyhow::Result<String> {
    let raw = fs::read_to_string(path)?;
    let trimmed = raw.trim().to_string();
    if trimmed.is_empty() {
        anyhow::bail!("Secret file {} is empty", path.display());
    }
    Ok(trimmed)
}

/// Resolve a *_FILE env var or default secrets file.
fn read_secret_value(var_name: &str, secrets_dir: Option<&Path>) -> anyhow::Result<Option<String>> {
    let file_env = format!("{}_FILE", var_name);
    if let Some(path) = read_env_string(&file_env) {
        return Ok(Some(read_secret_file(Path::new(&path))?));
    }

    if let Some(dir) = secrets_dir {
        let path = dir.join(var_name);
        if path.exists() {
            return Ok(Some(read_secret_file(&path)?));
        }
    }

    Ok(None)
}

/// Load a config file if it exists, returning overrides for present fields.
fn load_optional_config(path: &str) -> anyhow::Result<Option<ConfigOverrides>> {
    if !Path::new(path).exists() {
        return Ok(None);
    }
    let contents = fs::read_to_string(path)?;
    let cfg: ConfigFileOverrides = toml::from_str(&contents)?;
    Ok(Some(cfg.into()))
}

/// Build overrides from environment variables (non-secret values).
fn env_overrides() -> anyhow::Result<ConfigOverrides> {
    Ok(ConfigOverrides {
        potatomesh: PotatomeshOverrides {
            base_url: read_env_string(ENV_POTATOMESH_BASE_URL),
            poll_interval_secs: read_env_u64(ENV_POTATOMESH_POLL_INTERVAL)?,
        },
        matrix: MatrixOverrides {
            homeserver: read_env_string(ENV_MATRIX_HOMESERVER),
            as_token: read_env_string(ENV_MATRIX_AS_TOKEN),
            server_name: read_env_string(ENV_MATRIX_SERVER_NAME),
            room_id: read_env_string(ENV_MATRIX_ROOM_ID),
        },
        state: StateOverrides {
            state_file: read_env_string(ENV_STATE_FILE),
        },
    })
}

/// Build overrides from secret files.
fn secret_overrides(secrets_dir: Option<&Path>) -> anyhow::Result<ConfigOverrides> {
    let poll_interval = match read_secret_value(ENV_POTATOMESH_POLL_INTERVAL, secrets_dir)? {
        Some(value) => Some(value.parse::<u64>().map_err(|err| {
            anyhow::anyhow!(
                "Invalid integer value for {} in secret file: {}",
                ENV_POTATOMESH_POLL_INTERVAL,
                err
            )
        })?),
        None => None,
    };

    Ok(ConfigOverrides {
        potatomesh: PotatomeshOverrides {
            base_url: read_secret_value(ENV_POTATOMESH_BASE_URL, secrets_dir)?,
            poll_interval_secs: poll_interval,
        },
        matrix: MatrixOverrides {
            homeserver: read_secret_value(ENV_MATRIX_HOMESERVER, secrets_dir)?,
            as_token: read_secret_value(ENV_MATRIX_AS_TOKEN, secrets_dir)?,
            server_name: read_secret_value(ENV_MATRIX_SERVER_NAME, secrets_dir)?,
            room_id: read_secret_value(ENV_MATRIX_ROOM_ID, secrets_dir)?,
        },
        state: StateOverrides {
            state_file: read_secret_value(ENV_STATE_FILE, secrets_dir)?,
        },
    })
}

/// Resolve the effective secrets directory for default *_FILE lookups.
fn resolve_secrets_dir(container_defaults: bool) -> Option<PathBuf> {
    if let Some(dir) = read_env_string(ENV_SECRETS_DIR) {
        return Some(PathBuf::from(dir));
    }

    if container_defaults {
        return Some(PathBuf::from(DEFAULT_SECRETS_DIR));
    }

    None
}

/// Resolve the config path, honoring env and CLI overrides.
fn resolve_config_path(container_defaults: bool, overrides: &BootstrapOverrides) -> String {
    if let Some(path) = read_env_string(ENV_CONFIG_PATH) {
        return path;
    }
    if let Some(path) = &overrides.config_path {
        return path.clone();
    }

    if container_defaults {
        DEFAULT_CONTAINER_CONFIG_PATH.to_string()
    } else {
        DEFAULT_CONFIG_PATH.to_string()
    }
}

/// Resolve whether container defaults should be active.
fn resolve_container_defaults(
    in_container: bool,
    overrides: &BootstrapOverrides,
) -> anyhow::Result<bool> {
    if let Some(env_value) = read_env_bool(ENV_CONTAINER_DEFAULTS)? {
        return Ok(env_value);
    }
    if let Some(cli_value) = overrides.container_defaults {
        return Ok(cli_value);
    }
    Ok(in_container)
}

/// Apply default values and return a fully populated config.
fn finalize_config(overrides: ConfigOverrides, container_defaults: bool) -> anyhow::Result<Config> {
    let base_url = overrides
        .potatomesh
        .base_url
        .ok_or_else(|| anyhow::anyhow!("potatomesh.base_url is required"))?;
    let poll_interval_secs = overrides.potatomesh.poll_interval_secs.unwrap_or({
        if container_defaults {
            DEFAULT_CONTAINER_POLL_INTERVAL_SECS
        } else {
            DEFAULT_POLL_INTERVAL_SECS
        }
    });

    let homeserver = overrides
        .matrix
        .homeserver
        .ok_or_else(|| anyhow::anyhow!("matrix.homeserver is required"))?;
    let as_token = overrides
        .matrix
        .as_token
        .ok_or_else(|| anyhow::anyhow!("matrix.as_token is required"))?;
    let server_name = overrides
        .matrix
        .server_name
        .ok_or_else(|| anyhow::anyhow!("matrix.server_name is required"))?;
    let room_id = overrides
        .matrix
        .room_id
        .ok_or_else(|| anyhow::anyhow!("matrix.room_id is required"))?;

    let state_file = overrides.state.state_file.unwrap_or_else(|| {
        if container_defaults {
            DEFAULT_CONTAINER_STATE_FILE.to_string()
        } else {
            DEFAULT_STATE_FILE.to_string()
        }
    });

    Ok(Config {
        potatomesh: PotatomeshConfig {
            base_url,
            poll_interval_secs,
        },
        matrix: MatrixConfig {
            homeserver,
            as_token,
            server_name,
            room_id,
        },
        state: StateConfig { state_file },
    })
}

impl Config {
    /// Load config from a specific path.
    #[allow(dead_code)]
    pub fn load_from_file(path: &str) -> anyhow::Result<Self> {
        let contents = fs::read_to_string(path)?;
        let cfg = toml::from_str(&contents)?;
        Ok(cfg)
    }

    /// Load config from the default path in the working directory.
    #[allow(dead_code)]
    pub fn from_default_path() -> anyhow::Result<Self> {
        let path = DEFAULT_CONFIG_PATH;
        if !Path::new(path).exists() {
            anyhow::bail!("Config file {path} not found");
        }
        Self::load_from_file(path)
    }

    /// Load configuration by merging TOML, CLI, env, and secret values.
    pub fn load_with_overrides(overrides: BootstrapOverrides) -> anyhow::Result<ConfigBootstrap> {
        let in_container = detect_container();
        let container_defaults = resolve_container_defaults(in_container, &overrides)?;
        let config_path = resolve_config_path(container_defaults, &overrides);
        let secrets_dir = resolve_secrets_dir(container_defaults);

        let mut merged = ConfigOverrides::default();
        if let Some(file_overrides) = load_optional_config(&config_path)? {
            merged.merge(file_overrides);
        } else {
            tracing::warn!(
                "Config file {} not found; continuing with overrides",
                config_path
            );
        }

        merged.merge(overrides.values);
        merged.merge(env_overrides()?);
        merged.merge(secret_overrides(secrets_dir.as_deref())?);

        let config = finalize_config(merged, container_defaults)?;
        let context = RuntimeContext {
            in_container,
            container_defaults,
            config_path,
            secrets_dir,
        };

        Ok(ConfigBootstrap { config, context })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::io::Write;
    use std::{env, path::PathBuf};

    struct EnvGuard {
        key: String,
        value: Option<String>,
    }

    impl EnvGuard {
        fn set<K: Into<String>>(key: K, value: &str) -> Self {
            let key = key.into();
            let previous = env::var(&key).ok();
            env::set_var(&key, value);
            Self {
                key,
                value: previous,
            }
        }

        fn unset<K: Into<String>>(key: K) -> Self {
            let key = key.into();
            let previous = env::var(&key).ok();
            env::remove_var(&key);
            Self {
                key,
                value: previous,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.value {
                env::set_var(&self.key, value);
            } else {
                env::remove_var(&self.key);
            }
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

    #[test]
    fn detect_container_from_env_values() {
        assert!(detect_container_from(Some("1"), None));
        assert!(detect_container_from(Some("true"), None));
        assert!(!detect_container_from(Some("0"), None));
        assert!(!detect_container_from(Some("false"), None));
        assert!(!detect_container_from(Some("FALSE"), None));
    }

    #[test]
    fn detect_container_from_cgroup_markers() {
        let cgroup = "12:memory:/docker/abcd\n11:pids:/kubepods.slice";
        assert!(detect_container_from(None, Some(cgroup)));

        let host_cgroup = "0::/user.slice/user-1000.slice";
        assert!(!detect_container_from(None, Some(host_cgroup)));
    }

    #[test]
    #[serial]
    fn env_overrides_cli_and_toml() {
        let _guard_env = EnvGuard::set(ENV_POTATOMESH_BASE_URL, "https://env.example/");
        let _guard_token = EnvGuard::set(ENV_MATRIX_AS_TOKEN, "env-token");
        let _guard_poll = EnvGuard::set(ENV_POTATOMESH_POLL_INTERVAL, "25");
        let _guard_container = EnvGuard::set(ENV_CONTAINER_DEFAULTS, "0");

        let toml_str = r#"
            [potatomesh]
            base_url = "https://toml.example/"
            poll_interval_secs = 10

            [matrix]
            homeserver = "https://matrix.example.org"
            as_token = "toml-token"
            server_name = "example.org"
            room_id = "!roomid:example.org"

            [state]
            state_file = "toml_state.json"
        "#;
        let mut file = tempfile::NamedTempFile::new().unwrap();
        write!(file, "{}", toml_str).unwrap();

        let overrides = BootstrapOverrides {
            config_path: Some(file.path().to_str().unwrap().to_string()),
            container_defaults: Some(false),
            values: ConfigOverrides {
                potatomesh: PotatomeshOverrides {
                    base_url: Some("https://cli.example/".to_string()),
                    poll_interval_secs: Some(15),
                },
                matrix: MatrixOverrides {
                    as_token: Some("cli-token".to_string()),
                    ..Default::default()
                },
                state: StateOverrides {
                    state_file: Some("cli_state.json".to_string()),
                },
            },
        };

        let result = Config::load_with_overrides(overrides).unwrap();
        assert_eq!(result.config.potatomesh.base_url, "https://env.example/");
        assert_eq!(result.config.potatomesh.poll_interval_secs, 25);
        assert_eq!(result.config.matrix.as_token, "env-token");
        assert_eq!(result.config.state.state_file, "cli_state.json");
    }

    #[test]
    #[serial]
    fn secret_file_overrides_env_values() {
        let _guard_env = EnvGuard::set(ENV_POTATOMESH_BASE_URL, "https://env.example/");
        let _guard_homeserver = EnvGuard::set(ENV_MATRIX_HOMESERVER, "https://matrix.example.org");
        let _guard_server = EnvGuard::set(ENV_MATRIX_SERVER_NAME, "example.org");
        let _guard_room = EnvGuard::set(ENV_MATRIX_ROOM_ID, "!roomid:example.org");
        let _guard_env_token = EnvGuard::set(ENV_MATRIX_AS_TOKEN, "env-token");
        let _guard_container = EnvGuard::set(ENV_CONTAINER_DEFAULTS, "0");

        let secret_file = tempfile::NamedTempFile::new().unwrap();
        fs::write(secret_file.path(), "secret-token").unwrap();
        let _guard_secret = EnvGuard::set(
            format!("{}_FILE", ENV_MATRIX_AS_TOKEN),
            secret_file.path().to_str().unwrap(),
        );

        let overrides = BootstrapOverrides::default();
        let result = Config::load_with_overrides(overrides).unwrap();
        assert_eq!(result.config.matrix.as_token, "secret-token");
    }

    #[test]
    #[serial]
    fn container_defaults_change_paths_and_intervals() {
        let _guard_container = EnvGuard::set(ENV_CONTAINER, "1");
        let _guard_defaults = EnvGuard::unset(ENV_CONTAINER_DEFAULTS);
        let _guard_base = EnvGuard::set(ENV_POTATOMESH_BASE_URL, "https://env.example/");
        let _guard_home = EnvGuard::set(ENV_MATRIX_HOMESERVER, "https://matrix.example.org");
        let _guard_token = EnvGuard::set(ENV_MATRIX_AS_TOKEN, "env-token");
        let _guard_server = EnvGuard::set(ENV_MATRIX_SERVER_NAME, "example.org");
        let _guard_room = EnvGuard::set(ENV_MATRIX_ROOM_ID, "!roomid:example.org");

        let overrides = BootstrapOverrides::default();
        let result = Config::load_with_overrides(overrides).unwrap();

        assert!(result.context.in_container);
        assert!(result.context.container_defaults);
        assert_eq!(result.context.config_path, DEFAULT_CONTAINER_CONFIG_PATH);
        assert_eq!(result.config.state.state_file, DEFAULT_CONTAINER_STATE_FILE);
        assert_eq!(
            result.config.potatomesh.poll_interval_secs,
            DEFAULT_CONTAINER_POLL_INTERVAL_SECS
        );
    }

    #[test]
    #[serial]
    fn container_defaults_can_be_disabled() {
        let _guard_container = EnvGuard::set(ENV_CONTAINER, "1");
        let _guard_defaults = EnvGuard::set(ENV_CONTAINER_DEFAULTS, "0");
        let _guard_base = EnvGuard::set(ENV_POTATOMESH_BASE_URL, "https://env.example/");
        let _guard_home = EnvGuard::set(ENV_MATRIX_HOMESERVER, "https://matrix.example.org");
        let _guard_token = EnvGuard::set(ENV_MATRIX_AS_TOKEN, "env-token");
        let _guard_server = EnvGuard::set(ENV_MATRIX_SERVER_NAME, "example.org");
        let _guard_room = EnvGuard::set(ENV_MATRIX_ROOM_ID, "!roomid:example.org");

        let overrides = BootstrapOverrides::default();
        let result = Config::load_with_overrides(overrides).unwrap();

        assert!(result.context.in_container);
        assert!(!result.context.container_defaults);
        assert_eq!(result.context.config_path, DEFAULT_CONFIG_PATH);
        assert_eq!(result.config.state.state_file, DEFAULT_STATE_FILE);
        assert_eq!(
            result.config.potatomesh.poll_interval_secs,
            DEFAULT_POLL_INTERVAL_SECS
        );
    }

    #[test]
    #[serial]
    fn secrets_dir_defaults_are_used_when_present() {
        let _guard_container = EnvGuard::set(ENV_CONTAINER, "1");
        let _guard_defaults = EnvGuard::set(ENV_CONTAINER_DEFAULTS, "1");
        let _guard_base = EnvGuard::set(ENV_POTATOMESH_BASE_URL, "https://env.example/");
        let _guard_home = EnvGuard::set(ENV_MATRIX_HOMESERVER, "https://matrix.example.org");
        let _guard_server = EnvGuard::set(ENV_MATRIX_SERVER_NAME, "example.org");
        let _guard_room = EnvGuard::set(ENV_MATRIX_ROOM_ID, "!roomid:example.org");

        let temp_dir = tempfile::tempdir().unwrap();
        let secret_path = temp_dir.path().join(ENV_MATRIX_AS_TOKEN);
        fs::write(&secret_path, "dir-token").unwrap();
        let _guard_dir = EnvGuard::set(ENV_SECRETS_DIR, temp_dir.path().to_str().unwrap());

        let overrides = BootstrapOverrides::default();
        let result = Config::load_with_overrides(overrides).unwrap();
        assert_eq!(result.config.matrix.as_token, "dir-token");
        assert_eq!(
            result.context.secrets_dir,
            Some(PathBuf::from(temp_dir.path()))
        );
    }

    #[test]
    #[serial]
    fn read_env_bool_rejects_invalid_values() {
        let _guard = EnvGuard::set("POTATOMESH_TEST_BOOL", "maybe");
        let result = read_env_bool("POTATOMESH_TEST_BOOL");
        assert!(result.is_err());
    }

    #[test]
    #[serial]
    fn read_env_u64_rejects_invalid_values() {
        let _guard = EnvGuard::set("POTATOMESH_TEST_U64", "not-a-number");
        let result = read_env_u64("POTATOMESH_TEST_U64");
        assert!(result.is_err());
    }

    #[test]
    fn read_secret_file_rejects_empty_contents() {
        let file = tempfile::NamedTempFile::new().unwrap();
        fs::write(file.path(), "   ").unwrap();
        let result = read_secret_file(file.path());
        assert!(result.is_err());
    }
}
