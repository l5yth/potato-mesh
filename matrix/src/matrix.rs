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

    /// Ensure the puppet user exists (register via appservice registration).
    pub async fn ensure_user_registered(&self, localpart: &str) -> anyhow::Result<()> {
        #[derive(Serialize)]
        struct RegisterReq<'a> {
            #[serde(rename = "type")]
            typ: &'a str,
            username: &'a str,
        }

        let url = format!(
            "{}/_matrix/client/v3/register?kind=user",
            self.cfg.homeserver
        );

        let body = RegisterReq {
            typ: "m.login.application_service",
            username: localpart,
        };

        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.cfg.as_token)
            .json(&body)
            .send()
            .await?;
        if resp.status().is_success() {
            Ok(())
        } else {
            // If the puppet already exists, Synapse / HS returns 400 M_USER_IN_USE,
            // which is expected and safely ignored. Anything else (e.g. 401/403 from
            // a misconfigured `as_token`) is surfaced with the status and the Matrix
            // error body so the failure is diagnosable instead of being swallowed
            // here and only manifesting as a downstream error.
            let status = resp.status();
            let body_snip = resp.text().await.unwrap_or_default();
            // Only the specific M_USER_IN_USE errcode means "puppet already
            // exists" -- keying off the bare 400 status would also swallow real
            // failures returned as 400 (malformed request, config issues) and
            // skip the diagnostic warning below.
            let already_registered = body_snip.contains("M_USER_IN_USE");
            if !already_registered {
                tracing::warn!(
                    "Unexpected response registering puppet user {}: status {}, body: {}",
                    localpart,
                    status,
                    body_snip
                );
            }
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
            "{}/_matrix/client/v3/profile/{}/displayname?user_id={}",
            self.cfg.homeserver, encoded_user, encoded_user
        );

        let body = DisplayNameReq {
            displayname: display_name,
        };

        let resp = self
            .http
            .put(&url)
            .bearer_auth(&self.cfg.as_token)
            .json(&body)
            .send()
            .await?;
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

    /// Query string that makes an appservice request act as `user_id`, or an
    /// empty one, which acts as the appservice user itself (the
    /// registration's `sender_localpart`).
    fn user_id_query(user_id: Option<&str>) -> String {
        user_id
            .map(|user_id| format!("?user_id={}", urlencoding::encode(user_id)))
            .unwrap_or_default()
    }

    /// Who a request acts as, for logs and errors.
    fn acting_user(user_id: Option<&str>) -> &str {
        user_id.unwrap_or("the appservice user")
    }

    /// Ensure the puppet user is joined to the configured room.
    pub async fn ensure_user_joined_room(&self, user_id: &str) -> anyhow::Result<()> {
        self.join_room_as(Some(user_id)).await
    }

    /// Ensure the appservice user itself is joined to the configured room. It
    /// posts the messages whose sender is not verified (SPEC SV4).
    pub async fn ensure_appservice_joined_room(&self) -> anyhow::Result<()> {
        self.join_room_as(None).await
    }

    /// Join the configured room as `user_id`, or as the appservice user when
    /// `None`.
    async fn join_room_as(&self, user_id: Option<&str>) -> anyhow::Result<()> {
        #[derive(Serialize)]
        struct JoinReq {}

        let encoded_room = urlencoding::encode(&self.cfg.room_id);
        let url = format!(
            "{}/_matrix/client/v3/rooms/{}/join{}",
            self.cfg.homeserver,
            encoded_room,
            Self::user_id_query(user_id)
        );

        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.cfg.as_token)
            .json(&JoinReq {})
            .send()
            .await?;
        if resp.status().is_success() {
            Ok(())
        } else {
            let status = resp.status();
            let body_snip = resp.text().await.unwrap_or_default();
            Err(anyhow::anyhow!(
                "Matrix join failed for {} in {} with status {} ({})",
                Self::acting_user(user_id),
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
        self.send_formatted(Some(user_id), body_text, formatted_body)
            .await
    }

    /// Send a text message with HTML formatting into the configured room as
    /// the appservice user itself (SPEC SV4).
    pub async fn send_formatted_message_as_appservice(
        &self,
        body_text: &str,
        formatted_body: &str,
    ) -> anyhow::Result<()> {
        self.send_formatted(None, body_text, formatted_body).await
    }

    /// Send a formatted text message as `user_id`, or as the appservice user
    /// when `None`.
    async fn send_formatted(
        &self,
        user_id: Option<&str>,
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

        let url = format!(
            "{}/_matrix/client/v3/rooms/{}/send/m.room.message/{}{}",
            self.cfg.homeserver,
            encoded_room,
            txn_id,
            Self::user_id_query(user_id)
        );

        let content = MsgContent {
            msgtype: "m.text",
            body: body_text,
            format: "org.matrix.custom.html",
            formatted_body,
        };

        let resp = self
            .http
            .put(&url)
            .bearer_auth(&self.cfg.as_token)
            .json(&content)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body_snip = resp.text().await.unwrap_or_default();
            let user_id = Self::acting_user(user_id);

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
mod tests;
