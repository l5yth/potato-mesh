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

Today the repo ships a Meshtastic provider only. This module defines the seam so
future providers (MeshCore, Reticulum, ...) can be added without changing the
web app ingest contract.
"""

from __future__ import annotations

import enum
from collections.abc import Iterable
from typing import Protocol, runtime_checkable


class ProviderCapability(enum.Flag):
    """Feature flags describing what a provider can supply."""

    NONE = 0
    NODE_SNAPSHOT = enum.auto()
    HEARTBEATS = enum.auto()


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


__all__ = [
    "Provider",
    "ProviderCapability",
]
