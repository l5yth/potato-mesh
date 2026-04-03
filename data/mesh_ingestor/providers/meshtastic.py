# Copyright © 2025-26 l5yth & contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Meshtastic provider implementation.

When :envvar:`CONNECTION` is unset, USB serial candidates are collected from
:func:`~data.mesh_ingestor.connection.default_serial_targets`. On an interactive
TTY, a BLE scan adds devices whose advertised name suggests Meshtastic; then a
numeric menu is shown. Without a TTY, the first USB candidate is used. BLE scan
duration uses :envvar:`BLE_SCAN_SECS` (default ``5``).
"""

from __future__ import annotations

import time

from pubsub import pub

from .. import config, daemon as _daemon, handlers, interfaces
from ..target_selection import (
    meshtastic_ble_advertisement_match,
    resolve_connection_target_when_unset,
)


class MeshtasticProvider:
    """Meshtastic ingestion provider (current default)."""

    name = "meshtastic"

    def __init__(self):
        self._subscribed: list[str] = []

    def subscribe(self) -> list[str]:
        """Subscribe Meshtastic pubsub receive topics."""

        if self._subscribed:
            return list(self._subscribed)

        subscribed = []
        for topic in _daemon._RECEIVE_TOPICS:
            try:
                pub.subscribe(handlers.on_receive, topic)
                subscribed.append(topic)
            except Exception as exc:  # pragma: no cover
                config._debug_log(f"failed to subscribe to {topic!r}: {exc}")
        self._subscribed = subscribed
        return list(subscribed)

    def connect(
        self, *, active_candidate: str | None
    ) -> tuple[object, str | None, str | None]:
        """Create a Meshtastic interface using the existing interface helpers."""

        raw = (active_candidate or config.CONNECTION or "").strip()
        if not raw:
            raw = resolve_connection_target_when_unset(
                provider_label="Meshtastic",
                log_context="meshtastic.pick",
                ble_match_fn=meshtastic_ble_advertisement_match,
                ble_context="meshtastic.ble_scan",
                ble_thread_name="meshtastic-ble-scan",
            )

        iface, resolved_target = interfaces._create_serial_interface(raw)

        interfaces._ensure_radio_metadata(iface)
        interfaces._ensure_channel_metadata(iface)

        return iface, resolved_target, resolved_target

    def extract_host_node_id(self, iface: object) -> str | None:
        return interfaces._extract_host_node_id(iface)

    def node_snapshot_items(self, iface: object) -> list[tuple[str, object]]:
        nodes = getattr(iface, "nodes", {}) or {}
        for _ in range(3):
            try:
                return list(nodes.items())
            except RuntimeError as err:
                if "dictionary changed size during iteration" not in str(err):
                    raise
                time.sleep(0)
        config._debug_log(
            "Skipping node snapshot due to concurrent modification",
            context="meshtastic.snapshot",
        )
        return []


__all__ = ["MeshtasticProvider"]
