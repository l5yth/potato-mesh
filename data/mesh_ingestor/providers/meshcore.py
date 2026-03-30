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

"""MeshCore provider implementation (skeleton).

This module defines :class:`MeshcoreProvider`, which satisfies the
:class:`~data.mesh_ingestor.provider.Provider` protocol for MeshCore nodes
connected via serial port or BLE.  TCP/IP targets are not supported by
MeshCore and will be rejected at connect time.

The actual MeshCore protocol integration is not yet implemented.  For now
the provider reads messages from the node and, when ``DEBUG=1``, appends
them to ``ignored-meshcore.txt`` at the repository root.  Without
``DEBUG=1`` messages are silently dropped and no data is forwarded to the
web API.
"""

from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

from .. import config

# ---------------------------------------------------------------------------
# Debug log file
# ---------------------------------------------------------------------------

_IGNORED_MESSAGE_LOG_PATH = (
    Path(__file__).resolve().parents[3] / "ignored-meshcore.txt"
)
"""Filesystem path that stores raw MeshCore messages when ``DEBUG=1``."""

_IGNORED_MESSAGE_LOCK = threading.Lock()
"""Lock guarding writes to :data:`_IGNORED_MESSAGE_LOG_PATH`."""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TCP_TARGET_RE = re.compile(r":\d+$")
"""Pattern that matches a ``host:port`` style TCP target."""


def _is_tcp_target(target: str) -> bool:
    """Return ``True`` when *target* looks like a TCP ``host:port`` address."""
    return bool(_TCP_TARGET_RE.search(target))


def _record_meshcore_message(message: object, *, source: str) -> None:
    """Persist a MeshCore message to :data:`ignored-meshcore.txt` when ``DEBUG=1``.

    When ``DEBUG`` is not set the function returns immediately without any
    I/O so that production deployments are not burdened by file writes.

    Parameters:
        message: The raw message object received from the MeshCore node.
        source: A short label describing where the message originated (e.g.
            a serial port path or BLE address).
    """
    if not config.DEBUG:
        return

    timestamp = datetime.now(timezone.utc).isoformat()
    entry = {
        "message": str(message),
        "source": source,
        "timestamp": timestamp,
    }
    payload = json.dumps(entry, ensure_ascii=False, sort_keys=True)
    with _IGNORED_MESSAGE_LOCK:
        _IGNORED_MESSAGE_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with _IGNORED_MESSAGE_LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(f"{payload}\n")


# ---------------------------------------------------------------------------
# Interface stub
# ---------------------------------------------------------------------------


class _MeshcoreInterface:
    """Minimal interface object returned by :meth:`MeshcoreProvider.connect`.

    This class is a placeholder for the real MeshCore library interface that
    will be wired up once the protocol integration is implemented.
    """

    host_node_id: str | None = None

    def __init__(self, *, target: str | None) -> None:
        """Initialise the stub with the connection *target*."""
        self._target = target

    def close(self) -> None:
        """Close the MeshCore interface connection (no-op in skeleton)."""


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


class MeshcoreProvider:
    """MeshCore ingestion provider.

    Connects to a MeshCore node via serial port or BLE.  TCP/IP connections
    are not supported by the MeshCore protocol and will raise
    :exc:`ValueError`.

    Until the full protocol integration lands, all received messages are
    either appended to ``ignored-meshcore.txt`` (``DEBUG=1``) or silently
    dropped.  No data is forwarded to the web API in this skeleton phase.
    """

    name = "meshcore"

    def subscribe(self) -> list[str]:
        """Return subscribed topic names.

        MeshCore uses polling or direct callbacks rather than a pubsub bus,
        so there are no topics to register at startup.
        """
        return []

    def connect(
        self, *, active_candidate: str | None
    ) -> tuple[object, str | None, str | None]:
        """Connect to a MeshCore node via serial or BLE.

        Parameters:
            active_candidate: Previously resolved connection target, or
                ``None`` to fall back to :data:`~data.mesh_ingestor.config.CONNECTION`.

        Returns:
            ``(iface, resolved_target, next_active_candidate)`` matching the
            :class:`~data.mesh_ingestor.provider.Provider` contract.

        Raises:
            ValueError: When *target* looks like a TCP ``host:port`` address,
                since MeshCore does not support IP connections.
        """
        target = active_candidate or config.CONNECTION

        if target and _is_tcp_target(target):
            raise ValueError(
                f"MeshCore does not support TCP/IP targets: {target!r}. "
                "Provide a serial port (e.g. /dev/ttyUSB0) or BLE address."
            )

        config._debug_log(
            "Connecting to MeshCore node",
            context="meshcore.connect",
            target=target or "auto",
        )

        iface = _MeshcoreInterface(target=target)
        return iface, target, target

    def extract_host_node_id(self, iface: object) -> str | None:
        """Return the host node identifier from the MeshCore interface."""
        return getattr(iface, "host_node_id", None)

    def node_snapshot_items(self, iface: object) -> list[tuple[str, object]]:
        """Return an initial node snapshot.

        MeshCore node snapshots are not yet implemented; an empty list is
        returned until the protocol integration is complete.
        """
        return []


__all__ = ["MeshcoreProvider"]
