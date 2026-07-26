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

"""Merged mesh-activity packet counter shared across the ingestor.

SPEC decision **MA1** (``## Feature: Mesh activity reporting & announcements``):
the ingestor counts **every** frame it handles — all received frames (including
ignored / errored / unimplemented) *plus* its own transmissions — as one merged
figure so the dashboard can report "what is in the air" without under-reporting.

This module owns that single counter so the receive seam
(:func:`data.mesh_ingestor.handlers._state._mark_packet_seen`), the transmit
sites (the MeshCore telemetry/status polls and, later, the activity
announcement), and the heartbeat sender
(:func:`data.mesh_ingestor.ingestors.queue_ingestor_heartbeat`) all share one
consistent view. It deliberately depends on nothing but :mod:`threading`, so it
can be imported from any layer (handlers, protocols, ingestors) without risking
an import cycle.

The counter is a *per-interval delta* (**MA2**): :func:`take_packet_count`
returns the running total and atomically resets it to zero, so each heartbeat
carries only the frames observed since the previous heartbeat. Access is
serialised by a lock because frames are recorded on the mesh library's receive
thread (or the MeshCore asyncio loop) while the daemon thread drains the count
on its heartbeat cycle.
"""

from __future__ import annotations

import threading

_lock = threading.Lock()
"""Serialises access to :data:`_packet_count` across the record/drain threads."""

_packet_count: int = 0
"""Merged count of frames handled (RX + TX) since the last :func:`take_packet_count`."""


def _add(count: int) -> None:
    """Add *count* to the merged activity counter under the shared lock.

    Parameters:
        count: Number of frames to add to the running total.
    """

    global _packet_count
    with _lock:
        _packet_count += count


def record_packet(count: int = 1) -> None:
    """Count received frame(s) toward the merged activity total (MA1).

    Invoked from the earliest common receive seam
    (:func:`~data.mesh_ingestor.handlers._state._mark_packet_seen`) so *every*
    received frame is counted before any dispatch, filter, or drop decision —
    including ignored, errored, and unimplemented packets.

    Parameters:
        count: Number of received frames to record; defaults to ``1``.
    """

    _add(count)


def record_tx(count: int = 1) -> None:
    """Count ingestor transmission(s) toward the merged activity total (MA1).

    Invoked at each transmit site (the MeshCore telemetry/status polls and the
    activity announcement) so the ingestor's own airtime is reflected in the
    reported figure, merged with the received count.

    Parameters:
        count: Number of transmitted frames to record; defaults to ``1``.
    """

    _add(count)


def take_packet_count() -> int:
    """Return the merged activity count and atomically reset it to zero.

    This yields the *per-interval delta* (MA2): the number of frames recorded
    since the previous call. The read and the reset happen under the shared
    lock so a frame recorded concurrently is never double-counted or lost.

    Returns:
        The number of frames (RX + TX) recorded since the last call.
    """

    global _packet_count
    with _lock:
        value = _packet_count
        _packet_count = 0
        return value


def reset() -> None:
    """Reset the merged activity counter to zero.

    Provided for test isolation and for any future "clear on reconnect" need;
    unlike :func:`take_packet_count` it discards the running total without
    returning it.
    """

    global _packet_count
    with _lock:
        _packet_count = 0


__all__ = [
    "record_packet",
    "record_tx",
    "take_packet_count",
    "reset",
]
