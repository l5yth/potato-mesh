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

"""Shared mutable state and state accessors for the handlers subpackage.

All mutable globals that span multiple handler modules live here so that each
handler submodule can import this module and get a consistent view of state
without risking stale references from bare ``from ... import`` bindings.
"""

from __future__ import annotations

import math
import time

from .. import config
from ..serialization import _canonical_node_id

# ---------------------------------------------------------------------------
# Host device identity
# ---------------------------------------------------------------------------

_host_node_id: str | None = None
"""Canonical ``!xxxxxxxx`` identifier for the connected host device."""

_host_telemetry_last_rx: int | None = None
"""Receive timestamp of the last accepted host telemetry packet."""

_HOST_TELEMETRY_INTERVAL_SECS: int = 60 * 60
"""Minimum interval (seconds) between accepted host telemetry packets.

Meshtastic devices report their own telemetry at regular intervals. Accepting
every packet would overwrite the host's profile too aggressively; this window
throttles updates to at most once per hour.
"""

# ---------------------------------------------------------------------------
# Packet receipt tracking
# ---------------------------------------------------------------------------

_last_packet_monotonic: float | None = None
"""Monotonic timestamp of the most recently processed packet."""


# ---------------------------------------------------------------------------
# Public accessors
# ---------------------------------------------------------------------------


def register_host_node_id(node_id: str | None) -> None:
    """Record the canonical identifier for the connected host device.

    Resetting the host node also clears the telemetry suppression window so
    the first telemetry packet from the new host is always accepted.

    Parameters:
        node_id: Identifier reported by the connected device. ``None`` clears
            the current host assignment.
    """

    global _host_node_id, _host_telemetry_last_rx
    canonical = _canonical_node_id(node_id)
    _host_node_id = canonical
    _host_telemetry_last_rx = None
    if canonical:
        config._debug_log(
            "Registered host device node id",
            context="handlers.host_device",
            host_node_id=canonical,
        )


def host_node_id() -> str | None:
    """Return the canonical identifier for the connected host device.

    Returns:
        The canonical ``!xxxxxxxx`` node identifier, or ``None`` when no host
        has been registered yet.
    """

    return _host_node_id


def _mark_host_telemetry_seen(rx_time: int) -> None:
    """Update the last receive timestamp for the host telemetry window.

    Parameters:
        rx_time: Unix timestamp of the accepted host telemetry packet.
    """

    global _host_telemetry_last_rx
    _host_telemetry_last_rx = rx_time


def _host_telemetry_suppressed(rx_time: int) -> tuple[bool, int]:
    """Return suppression state and minutes remaining for host telemetry.

    Host telemetry is suppressed when it arrives within
    :data:`_HOST_TELEMETRY_INTERVAL_SECS` of the previous accepted packet.
    This avoids flooding the API with high-frequency device metrics from the
    locally connected node.

    Parameters:
        rx_time: Unix timestamp of the candidate telemetry packet.

    Returns:
        A ``(suppressed, minutes_remaining)`` tuple.  ``suppressed`` is
        ``True`` when the packet should be dropped; ``minutes_remaining``
        is the whole number of minutes until the next packet will be accepted.
    """

    if _host_telemetry_last_rx is None:
        return False, 0
    remaining_secs = (_host_telemetry_last_rx + _HOST_TELEMETRY_INTERVAL_SECS) - rx_time
    if remaining_secs <= 0:
        return False, 0
    return True, int(math.ceil(remaining_secs / 60.0))


def last_packet_monotonic() -> float | None:
    """Return the monotonic timestamp of the most recently processed packet.

    Returns:
        A :func:`time.monotonic` value, or ``None`` before any packet has been
        received.
    """

    return _last_packet_monotonic


def _mark_packet_seen() -> None:
    """Record that a packet has been processed by updating the monotonic clock."""

    global _last_packet_monotonic
    _last_packet_monotonic = time.monotonic()


__all__ = [
    "_HOST_TELEMETRY_INTERVAL_SECS",
    "_host_telemetry_suppressed",
    "_mark_host_telemetry_seen",
    "_mark_packet_seen",
    "host_node_id",
    "last_packet_monotonic",
    "register_host_node_id",
]
