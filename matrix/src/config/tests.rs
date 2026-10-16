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

use super::*;
use serial_test::serial;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Load a full Config from a TOML file; only these tests read one directly.
fn load_from_file(path: &str) -> anyhow::Result<Config> {
    let contents = fs::read_to_string(path)?;
    let cfg = toml::from_str(&contents)?;
    Ok(cfg)
}

struct CwdGuard {
    original: PathBuf,
}

impl CwdGuard {
    /// Switch to the provided path and restore the original cwd on drop.
    fn enter(path: &Path) -> Self {
        let original = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        std::env::set_current_dir(path).unwrap();
        Self { original }
    }
}

impl Drop for CwdGuard {
    fn drop(&mut self) {
        if std::env::set_current_dir(&self.original).is_err() {
            let _ = std::env::set_current_dir("/");
        }
    }
}

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
    let result = load_from_file("file_that_does_not_exist.toml");
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
    let result = load_from_file(file.path().to_str().unwrap());
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
#[serial]
fn load_uses_container_secret_defaults() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let _guard = CwdGuard::enter(tmp_dir.path());
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
fn resolve_token_prefers_explicit_value() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let token_file = tmp_dir.path().join("token");
    fs::write(&token_file, "FROM_FILE").unwrap();

    let resolved = resolve_token(
        Some("FROM_BASE".to_string()),
        Some("FROM_EXPLICIT".to_string()),
        Some(token_file.to_str().unwrap()),
        Some(tmp_dir.path().to_str().unwrap()),
        "matrix_as_token",
    )
    .unwrap();

    assert_eq!(resolved, Some("FROM_EXPLICIT".to_string()));
}

#[test]
fn resolve_token_reads_explicit_file() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let token_file = tmp_dir.path().join("token");
    fs::write(&token_file, "FROM_FILE").unwrap();

    let resolved = resolve_token(
        None,
        None,
        Some(token_file.to_str().unwrap()),
        None,
        "matrix_as_token",
    )
    .unwrap();

    assert_eq!(resolved, Some("FROM_FILE".to_string()));
}

#[test]
fn resolve_token_reads_default_secret_file() {
    let tmp_dir = tempfile::tempdir().unwrap();
    fs::write(tmp_dir.path().join("matrix_hs_token"), "FROM_SECRET").unwrap();

    let resolved = resolve_token(
        None,
        None,
        None,
        Some(tmp_dir.path().to_str().unwrap()),
        "matrix_hs_token",
    )
    .unwrap();

    assert_eq!(resolved, Some("FROM_SECRET".to_string()));
}

#[test]
fn resolve_token_errors_on_empty_secret_file() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let token_file = tmp_dir.path().join("token");
    fs::write(&token_file, "   ").unwrap();

    let result = resolve_token(
        None,
        None,
        Some(token_file.to_str().unwrap()),
        None,
        "matrix_as_token",
    );

    assert!(result.is_err());
}

#[test]
fn resolve_secrets_dir_prefers_explicit() {
    let defaults = DefaultPaths {
        config_path: "Config.toml".to_string(),
        state_file: DEFAULT_STATE_FILE.to_string(),
        secrets_dir: "default".to_string(),
        poll_interval_secs: CONTAINER_POLL_INTERVAL_SECS,
    };
    let inputs = ConfigInputs {
        secrets_dir: Some("explicit".to_string()),
        ..ConfigInputs::default()
    };

    let resolved = resolve_secrets_dir(&inputs, true, &defaults);
    assert_eq!(resolved, Some("explicit".to_string()));
}

#[test]
fn resolve_secrets_dir_container_default() {
    let defaults = DefaultPaths {
        config_path: "Config.toml".to_string(),
        state_file: DEFAULT_STATE_FILE.to_string(),
        secrets_dir: "default".to_string(),
        poll_interval_secs: CONTAINER_POLL_INTERVAL_SECS,
    };
    let inputs = ConfigInputs::default();

    let resolved = resolve_secrets_dir(&inputs, true, &defaults);
    assert_eq!(resolved, Some("default".to_string()));
    assert_eq!(resolve_secrets_dir(&inputs, false, &defaults), None);
}

#[test]
#[serial]
fn resolve_base_config_prefers_explicit_path() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let _guard = CwdGuard::enter(tmp_dir.path());
    let config_path = tmp_dir.path().join("explicit.toml");
    fs::write(
        &config_path,
        r#"[potatomesh]
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
"#,
    )
    .unwrap();

    let defaults = default_paths(false);
    let inputs = ConfigInputs {
        config_path: Some(config_path.to_string_lossy().to_string()),
        ..ConfigInputs::default()
    };

    let resolved = resolve_base_config(&inputs, &defaults).unwrap();
    assert!(resolved.is_some());
}

#[test]
#[serial]
fn resolve_base_config_uses_container_path_when_present() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let _guard = CwdGuard::enter(tmp_dir.path());
    let config_path = tmp_dir.path().join("container.toml");
    fs::write(
        &config_path,
        r#"[potatomesh]
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
"#,
    )
    .unwrap();

    let defaults = DefaultPaths {
        config_path: config_path.to_string_lossy().to_string(),
        state_file: DEFAULT_STATE_FILE.to_string(),
        secrets_dir: DEFAULT_SECRETS_DIR.to_string(),
        poll_interval_secs: CONTAINER_POLL_INTERVAL_SECS,
    };

    let resolved = resolve_base_config(&ConfigInputs::default(), &defaults).unwrap();
    assert!(resolved.is_some());
}

#[test]
#[serial]
fn resolve_base_config_uses_host_path_when_present() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let _guard = CwdGuard::enter(tmp_dir.path());
    fs::write(
        "Config.toml",
        r#"[potatomesh]
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
"#,
    )
    .unwrap();

    let defaults = default_paths(false);
    let resolved = resolve_base_config(&ConfigInputs::default(), &defaults).unwrap();
    assert!(resolved.is_some());
}

#[test]
#[serial]
fn resolve_base_config_returns_none_when_missing() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let _guard = CwdGuard::enter(tmp_dir.path());
    let defaults = default_paths(false);
    let resolved = resolve_base_config(&ConfigInputs::default(), &defaults).unwrap();
    assert!(resolved.is_none());
}

#[test]
#[serial]
fn load_prefers_cli_token_file_over_env_value() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let _guard = CwdGuard::enter(tmp_dir.path());

    let token_file = tmp_dir.path().join("as_token");
    fs::write(&token_file, "CLI_SECRET").unwrap();

    let env_inputs = ConfigInputs {
        overrides: ConfigOverrides {
            potatomesh_base_url: Some("https://potatomesh.net/".to_string()),
            potatomesh_poll_interval_secs: Some(10),
            matrix_homeserver: Some("https://matrix.example.org".to_string()),
            matrix_as_token: Some("ENV_TOKEN".to_string()),
            matrix_hs_token: Some("HS_TOKEN".to_string()),
            matrix_server_name: Some("example.org".to_string()),
            matrix_room_id: Some("!roomid:example.org".to_string()),
            ..ConfigOverrides::default()
        },
        ..ConfigInputs::default()
    };
    let cli_inputs = ConfigInputs {
        overrides: ConfigOverrides {
            matrix_as_token_file: Some(token_file.to_string_lossy().to_string()),
            ..ConfigOverrides::default()
        },
        ..ConfigInputs::default()
    };

    let cfg = load_from_sources(cli_inputs, env_inputs, None).unwrap();
    assert_eq!(cfg.matrix.as_token, "CLI_SECRET");
}

#[test]
#[serial]
fn load_uses_container_default_poll_interval() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let _guard = CwdGuard::enter(tmp_dir.path());

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
}

#[test]
#[serial]
fn load_uses_default_state_path_when_missing() {
    let tmp_dir = tempfile::tempdir().unwrap();
    let _guard = CwdGuard::enter(tmp_dir.path());

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
}
