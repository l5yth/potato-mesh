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

"""Receive-time check for Meshtastic packets (SPEC RK1-RK3).

A Meshtastic packet's ``rxTime`` comes from the clock of a radio, not from the
ingestor host.  A radio whose clock is wrong stamps every packet it hears
wrong, and the web app stores ``rx_time`` as posted: it clamps only times in
the future, and every read window filters on ``rx_time``.  A record stamped
weeks in the past is therefore stored but never shown, while the node row
still takes the record's battery and uptime.

``rx_time`` is the ingestor's receive time (SPEC RK1).
:func:`replace_skewed_rx_time` keeps a radio receive time that lies within
:data:`RX_TIME_TOLERANCE_SECS` of the host clock, in either direction, and
replaces any other with the host clock (SPEC RK2).  Its only caller is
:func:`~data.mesh_ingestor.handlers.generic.on_receive`, the seam both
Meshtastic transports feed: the pubsub callback of the serial, TCP and BLE
interfaces and the UDP transport's receive thread.  MeshCore hands its
packets to :func:`~data.mesh_ingestor.handlers.generic.store_packet_dict`
directly and posts roster positions itself, and Reticulum builds no packets,
so both keep the times their providers assign (SPEC RK3, RS1).

Each replacement is logged as a warning that names the sender and the offset,
at most once per :data:`RX_TIME_WARNING_INTERVAL_SECS` for the whole process,
whatever the sender: the clock at fault belongs to the receiving radio, so
every packet it stamps is off by the same amount.  The next warning carries
the number of replacements that went unlogged in between, so a radio whose
clock stays wrong cannot flood the log.  The warning state is
module-global and unlocked: one transport feeds ``on_receive`` from one
thread, and concurrent callers could at worst log one extra warning.
"""

from __future__ import annotations

import time
from collections.abc import Mapping

from .. import config
from ..serialization import _canonical_node_id, _coerce_int, _first
from . import _state

RX_TIME_TOLERANCE_SECS: int = 60 * 60
"""Largest offset from the host clock at which a radio ``rxTime`` is kept.

Applies in both directions (SPEC RK2).  A radio time further off is replaced
with the host clock; one exactly this far off is kept.
"""

RX_TIME_WARNING_INTERVAL_SECS: int = 10 * 60
"""Minimum interval, process-wide, between two receive-time warnings."""

_RX_TIME_KEYS: tuple[str, ...] = ("rxTime", "rx_time")
"""Packet keys that carry a radio receive time.

``rxTime`` is the meshtastic library's camelCase key; ``rx_time`` is the
proto field name :func:`~data.mesh_ingestor.serialization._pkt_to_dict`
emits for a protobuf message.  The handlers read them in this order.
"""

_last_warning_monotonic: float | None = None
""":func:`time.monotonic` value of the last warning, ``None`` before the first."""

_unlogged_replacements: int = 0
"""Replacements made since the last warning that were not logged on their own."""


def replace_skewed_rx_time(packet: object) -> object:
    """Return ``packet`` with a radio receive time far off the host clock replaced.

    Every key in :data:`_RX_TIME_KEYS` whose value parses as an integer and
    lies more than :data:`RX_TIME_TOLERANCE_SECS` from the host clock, in
    either direction, is set to the host clock.  The replacement is made on a
    shallow copy, so the meshtastic library's own packet dict is left as it
    was.  A packet without a receive time, or with one that does not parse,
    is returned unchanged: the handlers stamp the host clock on the first and
    treat the second as they did before.

    Parameters:
        packet: Packet as normalised by
            :func:`~data.mesh_ingestor.serialization._pkt_to_dict`.  Anything
            other than a mapping is returned as is.

    Returns:
        ``packet`` itself when nothing was replaced, otherwise a shallow copy
        that carries the host clock, in whole seconds, under each replaced key.
    """

    if not isinstance(packet, Mapping):
        return packet
    now = int(time.time())
    corrected: dict | None = None
    offset_secs = 0
    for key in _RX_TIME_KEYS:
        radio_time = _coerce_int(packet.get(key))
        if radio_time is None or abs(radio_time - now) <= RX_TIME_TOLERANCE_SECS:
            continue
        if corrected is None:
            corrected = dict(packet)
            # Logged once per packet, with the offset of the first key replaced.
            offset_secs = radio_time - now
        corrected[key] = now
    if corrected is None:
        return packet
    _warn_replaced(packet, offset_secs)
    return corrected


def _warn_replaced(packet: Mapping, offset_secs: int) -> None:
    """Log a receive-time replacement, at most once per warning interval.

    A replacement inside :data:`RX_TIME_WARNING_INTERVAL_SECS` of the last
    warning is only counted; the next warning reports that count.

    Parameters:
        packet: The packet as received, before the replacement.
        offset_secs: Radio receive time minus host clock, in seconds.
            Negative when the radio clock runs behind.
    """

    global _last_warning_monotonic, _unlogged_replacements
    now = time.monotonic()
    if (
        _last_warning_monotonic is not None
        and now - _last_warning_monotonic < RX_TIME_WARNING_INTERVAL_SECS
    ):
        _unlogged_replacements += 1
        return
    config._debug_log(
        "Radio clock is off; posting the ingestor receive time instead of rxTime",
        context="handlers.receive_time",
        severity="warn",
        from_id=_canonical_node_id(
            _first(packet, "fromId", "from_id", "from", default=None)
        ),
        host_node_id=_state.host_node_id(),
        offset_secs=offset_secs,
        offset_hours=round(offset_secs / 3600, 1),
        tolerance_secs=RX_TIME_TOLERANCE_SECS,
        unlogged_replacements=_unlogged_replacements,
    )
    _last_warning_monotonic = now
    _unlogged_replacements = 0


__all__ = [
    "RX_TIME_TOLERANCE_SECS",
    "RX_TIME_WARNING_INTERVAL_SECS",
    "replace_skewed_rx_time",
]
