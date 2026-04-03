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

"""Provider interface for ingestion sources.

The repo ships Meshtastic and MeshCore providers. This module defines the seam
so future providers (Reticulum, ...) can be added without changing the web app
ingest contract.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass(frozen=True)
class ConnectionCandidate:
    """One selectable connection target for :envvar:`CONNECTION` interactive mode."""

    target: str
    """Value passed to the provider as the connection string (e.g. ``/dev/ttyACM0``)."""

    label: str
    """Single-line description shown in the interactive menu."""

    kind: str
    """``\"serial\"``, ``\"ble\"``, or ``\"tcp\"`` (extensible for future kinds)."""


@runtime_checkable
class Provider(Protocol):
    """Abstract source of mesh observations."""

    name: str

    def subscribe(self) -> list[str]:
        """Subscribe to any async receive callbacks and return topic names."""

    def connect(
        self, *, active_candidate: str | None
    ) -> tuple[object, str | None, str | None]:
        """Create an interface connection.

        Returns:
            (iface, resolved_target, next_active_candidate)
        """

    def extract_host_node_id(self, iface: object) -> str | None:
        """Best-effort extraction of the connected host node id."""

    def node_snapshot_items(self, iface: object) -> Iterable[tuple[str, object]]:
        """Return iterable of (node_id, node_obj) for initial snapshot."""

    def list_connection_candidates(
        self, *, ble_scan_timeout_secs: float
    ) -> list[ConnectionCandidate]:
        """Enumerate serial and BLE targets compatible with this provider.

        Used when :envvar:`CONNECTION` is ``ask``. Implementations should not
        raise for missing hardware; return an empty list or skip BLE when
        dependencies are unavailable.

        Parameters:
            ble_scan_timeout_secs: Duration for BLE discovery.

        Returns:
            Candidates in display order; duplicates by ``target`` should be
            avoided.
        """


__all__ = [
    "ConnectionCandidate",
    "Provider",
]
