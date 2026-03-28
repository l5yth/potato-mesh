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

"""Meshtastic provider implementation."""

from __future__ import annotations

from collections.abc import Iterable

from .. import daemon as _daemon, interfaces


class MeshtasticProvider:
    """Meshtastic ingestion provider (current default)."""

    name = "meshtastic"

    def __init__(self):
        self._subscribed: list[str] = []

    def subscribe(self) -> list[str]:
        """Subscribe Meshtastic pubsub receive topics."""

        if self._subscribed:
            return list(self._subscribed)

        topics = _daemon._subscribe_receive_topics()
        self._subscribed = topics
        return list(topics)

    def connect(
        self, *, active_candidate: str | None
    ) -> tuple[object, str | None, str | None]:
        """Create a Meshtastic interface using the existing interface helpers."""

        iface = None
        resolved_target = None
        next_candidate = active_candidate

        if active_candidate:
            iface, resolved_target = interfaces._create_serial_interface(active_candidate)
        else:
            iface, resolved_target = interfaces._create_default_interface()
            next_candidate = resolved_target

        interfaces._ensure_radio_metadata(iface)
        interfaces._ensure_channel_metadata(iface)

        return iface, resolved_target, next_candidate

    def extract_host_node_id(self, iface: object) -> str | None:
        return interfaces._extract_host_node_id(iface)

    def node_snapshot_items(self, iface: object) -> Iterable[tuple[str, object]]:
        nodes = getattr(iface, "nodes", {}) or {}
        return list(nodes.items())


__all__ = ["MeshtasticProvider"]

