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

use serde::Serialize;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

use crate::config::MatrixConfig;

#[derive(Clone)]
pub struct MatrixAppserviceClient {
    http: reqwest::Client,
    pub cfg: MatrixConfig,
    pub txn_counter: Arc<AtomicU64>,
}

impl MatrixAppserviceClient {
    pub fn new(http: reqwest::Client, cfg: MatrixConfig) -> Self {
        let start = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        Self {
            http,
            cfg,
            txn_counter: Arc::new(AtomicU64::new(start)),
        }
    }

    /// Basic liveness check against the homeserver.
    pub async fn health_check(&self) -> anyhow::Result<()> {
        let url = format!("{}/_matrix/client/versions", self.cfg.homeserver);
        let resp = self.http.get(&url).send().await?;
        if resp.status().is_success() {
            tracing::info!("Matrix homeserver healthy at {}", self.cfg.homeserver);
            Ok(())
        } else {
            Err(anyhow::anyhow!(
                "Matrix homeserver versions check failed with status {}",
                resp.status()
            ))
        }
    }

    /// Convert a node_id like "!deadbeef" into Matrix localpart "potato_deadbeef".
    pub fn localpart_from_node_id(node_id: &str) -> String {
        format!("potato_{}", node_id.trim_start_matches('!'))
    }

    /// Build a full Matrix user_id from localpart.
    pub fn user_id(&self, localpart: &str) -> String {
        format!("@{}:{}", localpart, self.cfg.server_name)
    }

    fn auth_query(&self) -> String {
        format!("access_token={}", urlencoding::encode(&self.cfg.as_token))
    }

    /// Ensure the puppet user exists (register via appservice registration).
    pub async fn ensure_user_registered(&self, localpart: &str) -> anyhow::Result<()> {
        #[derive(Serialize)]
        struct RegisterReq<'a> {
            #[serde(rename = "type")]
            typ: &'a str,
            username: &'a str,
        }

        let url = format!(
            "{}/_matrix/client/v3/register?kind=user&{}",
            self.cfg.homeserver,
            self.auth_query()
        );

        let body = RegisterReq {
            typ: "m.login.application_service",
            username: localpart,
        };

        let resp = self.http.post(&url).json(&body).send().await?;
        if resp.status().is_success() {
            Ok(())
        } else {
            // If user already exists, Synapse / HS usually returns 400 M_USER_IN_USE.
            // We'll just ignore non-success and hope it's that case.
            Ok(())
        }
    }

    /// Set display name for puppet user.
    pub async fn set_display_name(&self, user_id: &str, display_name: &str) -> anyhow::Result<()> {
        #[derive(Serialize)]
        struct DisplayNameReq<'a> {
            displayname: &'a str,
        }

        let encoded_user = urlencoding::encode(user_id);
        let url = format!(
            "{}/_matrix/client/v3/profile/{}/displayname?user_id={}&{}",
            self.cfg.homeserver,
            encoded_user,
            encoded_user,
            self.auth_query()
        );

        let body = DisplayNameReq {
            displayname: display_name,
        };

        let resp = self.http.put(&url).json(&body).send().await?;
        if resp.status().is_success() {
            Ok(())
        } else {
            // Non-fatal.
            tracing::warn!(
                "Failed to set display name for {}: {}",
                user_id,
                resp.status()
            );
            Ok(())
        }
    }

    /// Ensure the puppet user is joined to the configured room.
    pub async fn ensure_user_joined_room(&self, user_id: &str) -> anyhow::Result<()> {
        #[derive(Serialize)]
        struct JoinReq {}

        let encoded_room = urlencoding::encode(&self.cfg.room_id);
        let encoded_user = urlencoding::encode(user_id);
        let url = format!(
            "{}/_matrix/client/v3/rooms/{}/join?user_id={}&{}",
            self.cfg.homeserver,
            encoded_room,
            encoded_user,
            self.auth_query()
        );

        let resp = self.http.post(&url).json(&JoinReq {}).send().await?;
        if resp.status().is_success() {
            Ok(())
        } else {
            let status = resp.status();
            let body_snip = resp.text().await.unwrap_or_default();
            Err(anyhow::anyhow!(
                "Matrix join failed for {} in {} with status {} ({})",
                user_id,
                self.cfg.room_id,
                status,
                body_snip
            ))
        }
    }

    /// Send a text message with HTML formatting into the configured room as puppet user_id.
    pub async fn send_formatted_message_as(
        &self,
        user_id: &str,
        body_text: &str,
        formatted_body: &str,
    ) -> anyhow::Result<()> {
        #[derive(Serialize)]
        struct MsgContent<'a> {
            msgtype: &'a str,
            body: &'a str,
            format: &'a str,
            formatted_body: &'a str,
        }

        let txn_id = self.txn_counter.fetch_add(1, Ordering::SeqCst);
        let encoded_room = urlencoding::encode(&self.cfg.room_id);
        let encoded_user = urlencoding::encode(user_id);

        let url = format!(
            "{}/_matrix/client/v3/rooms/{}/send/m.room.message/{}?user_id={}&{}",
            self.cfg.homeserver,
            encoded_room,
            txn_id,
            encoded_user,
            self.auth_query()
        );

        let content = MsgContent {
            msgtype: "m.text",
            body: body_text,
            format: "org.matrix.custom.html",
            formatted_body,
        };

        let resp = self.http.put(&url).json(&content).send().await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body_snip = resp.text().await.unwrap_or_default();

            tracing::warn!(
                "Failed to send formatted message as {}: status {}, body: {}",
                user_id,
                status,
                body_snip
            );

            return Err(anyhow::anyhow!(
                "Matrix send failed for {} with status {}",
                user_id,
                status
            ));
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_cfg() -> MatrixConfig {
        MatrixConfig {
            homeserver: "https://matrix.example.org".to_string(),
            as_token: "AS_TOKEN".to_string(),
            hs_token: "HS_TOKEN".to_string(),
            server_name: "example.org".to_string(),
            room_id: "!roomid:example.org".to_string(),
        }
    }

    #[test]
    fn localpart_strips_bang_correctly() {
        assert_eq!(
            MatrixAppserviceClient::localpart_from_node_id("!deadbeef"),
            "potato_deadbeef"
        );
        assert_eq!(
            MatrixAppserviceClient::localpart_from_node_id("cafebabe"),
            "potato_cafebabe"
        );
    }

    #[test]
    fn user_id_builds_from_localpart_and_server_name() {
        let http = reqwest::Client::builder().build().unwrap();
        let client = MatrixAppserviceClient::new(http, dummy_cfg());

        let uid = client.user_id("potato_deadbeef");
        assert_eq!(uid, "@potato_deadbeef:example.org");
    }

    #[tokio::test]
    async fn health_check_success() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/_matrix/client/versions")
            .with_status(200)
            .create();

        let mut cfg = dummy_cfg();
        cfg.homeserver = server.url();
        let client = MatrixAppserviceClient::new(reqwest::Client::new(), cfg);
        let result = client.health_check().await;

        mock.assert();
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn health_check_failure() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/_matrix/client/versions")
            .with_status(500)
            .create();

        let mut cfg = dummy_cfg();
        cfg.homeserver = server.url();
        let client = MatrixAppserviceClient::new(reqwest::Client::new(), cfg);
        let result = client.health_check().await;

        mock.assert();
        assert!(result.is_err());
    }

    #[test]
    fn auth_query_contains_access_token() {
        let http = reqwest::Client::builder().build().unwrap();
        let client = MatrixAppserviceClient::new(http, dummy_cfg());

        let q = client.auth_query();
        assert!(q.starts_with("access_token="));
        assert!(q.contains("AS_TOKEN"));
    }

    #[test]
    fn test_new_matrix_client() {
        let http_client = reqwest::Client::new();
        let config = dummy_cfg();
        let client = MatrixAppserviceClient::new(http_client, config);
        assert_eq!(client.cfg.homeserver, "https://matrix.example.org");
        assert_eq!(client.cfg.as_token, "AS_TOKEN");
        assert!(client.txn_counter.load(Ordering::SeqCst) > 0);
    }

    #[tokio::test]
    async fn test_ensure_user_registered_success() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/_matrix/client/v3/register")
            .match_query("kind=user&access_token=AS_TOKEN")
            .with_status(200)
            .create();

        let mut cfg = dummy_cfg();
        cfg.homeserver = server.url();
        let client = MatrixAppserviceClient::new(reqwest::Client::new(), cfg);
        let result = client.ensure_user_registered("testuser").await;

        mock.assert();
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_ensure_user_registered_user_in_use() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/_matrix/client/v3/register")
            .match_query("kind=user&access_token=AS_TOKEN")
            .with_status(400) // M_USER_IN_USE
            .create();

        let mut cfg = dummy_cfg();
        cfg.homeserver = server.url();
        let client = MatrixAppserviceClient::new(reqwest::Client::new(), cfg);
        let result = client.ensure_user_registered("testuser").await;

        mock.assert();
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_set_display_name_success() {
        let mut server = mockito::Server::new_async().await;
        let user_id = "@test:example.org";
        let encoded_user = urlencoding::encode(user_id);
        let query = format!("user_id={}&access_token=AS_TOKEN", encoded_user);
        let path = format!("/_matrix/client/v3/profile/{}/displayname", encoded_user);

        let mock = server
            .mock("PUT", path.as_str())
            .match_query(query.as_str())
            .with_status(200)
            .create();

        let mut cfg = dummy_cfg();
        cfg.homeserver = server.url();
        let client = MatrixAppserviceClient::new(reqwest::Client::new(), cfg);
        let result = client.set_display_name(user_id, "Test Name").await;

        mock.assert();
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_set_display_name_fail_is_ok() {
        let mut server = mockito::Server::new_async().await;
        let user_id = "@test:example.org";
        let encoded_user = urlencoding::encode(user_id);
        let query = format!("user_id={}&access_token=AS_TOKEN", encoded_user);
        let path = format!("/_matrix/client/v3/profile/{}/displayname", encoded_user);

        let mock = server
            .mock("PUT", path.as_str())
            .match_query(query.as_str())
            .with_status(500)
            .create();

        let mut cfg = dummy_cfg();
        cfg.homeserver = server.url();
        let client = MatrixAppserviceClient::new(reqwest::Client::new(), cfg);
        let result = client.set_display_name(user_id, "Test Name").await;

        mock.assert();
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_ensure_user_joined_room_success() {
        let mut server = mockito::Server::new_async().await;
        let user_id = "@test:example.org";
        let room_id = "!roomid:example.org";
        let encoded_user = urlencoding::encode(user_id);
        let encoded_room = urlencoding::encode(room_id);
        let query = format!("user_id={}&access_token=AS_TOKEN", encoded_user);
        let path = format!("/_matrix/client/v3/rooms/{}/join", encoded_room);

        let mock = server
            .mock("POST", path.as_str())
            .match_query(query.as_str())
            .with_status(200)
            .create();

        let mut cfg = dummy_cfg();
        cfg.homeserver = server.url();
        cfg.room_id = room_id.to_string();
        let client = MatrixAppserviceClient::new(reqwest::Client::new(), cfg);
        let result = client.ensure_user_joined_room(user_id).await;

        mock.assert();
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_ensure_user_joined_room_fail() {
        let mut server = mockito::Server::new_async().await;
        let user_id = "@test:example.org";
        let room_id = "!roomid:example.org";
        let encoded_user = urlencoding::encode(user_id);
        let encoded_room = urlencoding::encode(room_id);
        let query = format!("user_id={}&access_token=AS_TOKEN", encoded_user);
        let path = format!("/_matrix/client/v3/rooms/{}/join", encoded_room);

        let mock = server
            .mock("POST", path.as_str())
            .match_query(query.as_str())
            .with_status(403)
            .create();

        let mut cfg = dummy_cfg();
        cfg.homeserver = server.url();
        cfg.room_id = room_id.to_string();
        let client = MatrixAppserviceClient::new(reqwest::Client::new(), cfg);
        let result = client.ensure_user_joined_room(user_id).await;

        mock.assert();
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_send_formatted_message_as_success() {
        let mut server = mockito::Server::new_async().await;
        let user_id = "@test:example.org";
        let room_id = "!roomid:example.org";
        let encoded_user = urlencoding::encode(user_id);
        let encoded_room = urlencoding::encode(room_id);

        let client = {
            let mut cfg = dummy_cfg();
            cfg.homeserver = server.url();
            cfg.room_id = room_id.to_string();
            MatrixAppserviceClient::new(reqwest::Client::new(), cfg)
        };
        let txn_id = client.txn_counter.load(Ordering::SeqCst);
        let query = format!("user_id={}&access_token=AS_TOKEN", encoded_user);
        let path = format!(
            "/_matrix/client/v3/rooms/{}/send/m.room.message/{}",
            encoded_room, txn_id
        );

        let mock = server
            .mock("PUT", path.as_str())
            .match_query(query.as_str())
            .match_body(mockito::Matcher::PartialJson(serde_json::json!({
                "msgtype": "m.text",
                "body": "`[meta]` hello",
                "format": "org.matrix.custom.html",
                "formatted_body": "<code>[meta]</code> hello",
            })))
            .with_status(200)
            .create();

        let result = client
            .send_formatted_message_as(user_id, "`[meta]` hello", "<code>[meta]</code> hello")
            .await;

        mock.assert();
        assert!(result.is_ok());
    }
}
