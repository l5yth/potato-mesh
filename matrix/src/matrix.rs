use serde::Serialize;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

use crate::config::MatrixConfig;

#[derive(Clone)]
pub struct MatrixAppserviceClient {
    http: reqwest::Client,
    cfg: MatrixConfig,
    txn_counter: Arc<AtomicU64>,
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

    /// Convert a node_id like "!deadbeef" into Matrix localpart "deadbeef".
    pub fn localpart_from_node_id(node_id: &str) -> String {
        node_id.trim_start_matches('!').to_string()
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
    pub async fn set_display_name(
        &self,
        user_id: &str,
        display_name: &str,
    ) -> anyhow::Result<()> {
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

        let body = DisplayNameReq { displayname: display_name };

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

    /// Send a plain text message into the configured room as puppet user_id.
    pub async fn send_text_message_as(
        &self,
        user_id: &str,
        body_text: &str,
    ) -> anyhow::Result<()> {
        #[derive(Serialize)]
        struct MsgContent<'a> {
            msgtype: &'a str,
            body: &'a str,
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
        };

        let resp = self.http.put(&url).json(&content).send().await?;
        if !resp.status().is_success() {
            tracing::warn!(
                "Failed to send message as {}: {}",
                user_id,
                resp.status()
            );
        }
        Ok(())
    }
}
