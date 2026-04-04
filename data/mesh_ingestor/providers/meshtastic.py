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

from pubsub import pub

from .. import config, daemon as _daemon, handlers, interfaces
from ..utils import _retry_dict_snapshot


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

        iface = None
        resolved_target = None
        next_candidate = active_candidate

        if active_candidate:
            iface, resolved_target = interfaces._create_serial_interface(
                active_candidate
            )
        else:
            iface, resolved_target = interfaces._create_default_interface()
            next_candidate = resolved_target

        interfaces._ensure_radio_metadata(iface)
        interfaces._ensure_channel_metadata(iface)

        return iface, resolved_target, next_candidate

    def extract_host_node_id(self, iface: object) -> str | None:
        return interfaces._extract_host_node_id(iface)

    def node_snapshot_items(self, iface: object) -> list[tuple[str, object]]:
        """Return a stable snapshot of all known nodes from ``iface``.

        Uses :func:`~data.mesh_ingestor.utils._retry_dict_snapshot` to
        tolerate concurrent modifications from the Meshtastic background
        thread.

        Parameters:
            iface: Live Meshtastic interface whose ``nodes`` dict to snapshot.

        Returns:
            List of ``(node_id, node_dict)`` tuples, or an empty list when
            the snapshot fails after retries.
        """

        nodes = getattr(iface, "nodes", {}) or {}
        result = _retry_dict_snapshot(lambda: list(nodes.items()))
        if result is None:
            config._debug_log(
                "Skipping node snapshot due to concurrent modification",
                context="meshtastic.snapshot",
            )
            return []
        return result


__all__ = ["MeshtasticProvider"]
