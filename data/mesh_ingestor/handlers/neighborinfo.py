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

"""Handler for neighbour-information packets."""

from __future__ import annotations

import time
from collections.abc import Mapping

from .. import config, queue
from ..serialization import (
    _canonical_node_id,
    _coerce_float,
    _coerce_int,
    _first,
    _iso,
    _node_num_from_id,
)
from . import _state
from .radio import _apply_radio_metadata


def store_neighborinfo_packet(packet: Mapping, decoded: Mapping) -> None:
    """Persist neighbour information gathered from a packet.

    Meshtastic nodes periodically broadcast the set of nodes they can hear
    directly along with the observed signal quality.  This handler serialises
    that snapshot so the web dashboard can render a live RF topology graph.

    Parameters:
        packet: Raw Meshtastic packet metadata.
        decoded: Decoded view containing the ``neighborinfo`` section.

    Returns:
        ``None``. The neighbour snapshot is queued for HTTP submission.
    """

    neighbor_section = (
        decoded.get("neighborinfo") if isinstance(decoded, Mapping) else None
    )
    if not isinstance(neighbor_section, Mapping):
        return

    node_ref = _first(
        neighbor_section,
        "nodeId",
        "node_id",
        default=_first(packet, "fromId", "from_id", "from", default=None),
    )
    node_id = _canonical_node_id(node_ref)
    if node_id is None:
        return

    node_num = _coerce_int(_first(neighbor_section, "nodeId", "node_id", default=None))
    if node_num is None:
        node_num = _node_num_from_id(node_id)

    node_broadcast_interval = _coerce_int(
        _first(
            neighbor_section,
            "nodeBroadcastIntervalSecs",
            "node_broadcast_interval_secs",
            default=None,
        )
    )

    last_sent_by_ref = _first(
        neighbor_section,
        "lastSentById",
        "last_sent_by_id",
        default=None,
    )
    last_sent_by_id = _canonical_node_id(last_sent_by_ref)

    rx_time = _coerce_int(_first(packet, "rxTime", "rx_time", default=time.time()))
    if rx_time is None:
        rx_time = int(time.time())

    neighbors_payload = neighbor_section.get("neighbors")
    neighbors_iterable = (
        neighbors_payload if isinstance(neighbors_payload, list) else []
    )

    neighbor_entries: list[dict] = []
    for entry in neighbors_iterable:
        if not isinstance(entry, Mapping):
            continue
        neighbor_ref = _first(entry, "nodeId", "node_id", default=None)
        neighbor_id = _canonical_node_id(neighbor_ref)
        if neighbor_id is None:
            continue
        neighbor_num = _coerce_int(_first(entry, "nodeId", "node_id", default=None))
        if neighbor_num is None:
            neighbor_num = _node_num_from_id(neighbor_id)
        snr = _coerce_float(_first(entry, "snr", default=None))
        entry_rx_time = _coerce_int(_first(entry, "rxTime", "rx_time", default=None))
        if entry_rx_time is None:
            entry_rx_time = rx_time
        neighbor_entries.append(
            {
                "neighbor_id": neighbor_id,
                "neighbor_num": neighbor_num,
                "snr": snr,
                "rx_time": entry_rx_time,
                "rx_iso": _iso(entry_rx_time),
            }
        )

    payload = {
        "node_id": node_id,
        "node_num": node_num,
        "neighbors": neighbor_entries,
        "rx_time": rx_time,
        "rx_iso": _iso(rx_time),
        "ingestor": _state.host_node_id(),
    }

    if node_broadcast_interval is not None:
        payload["node_broadcast_interval_secs"] = node_broadcast_interval
    if last_sent_by_id is not None:
        payload["last_sent_by_id"] = last_sent_by_id

    queue._queue_post_json(
        "/api/neighbors",
        _apply_radio_metadata(payload),
        priority=queue._NEIGHBOR_POST_PRIORITY,
    )

    if config.DEBUG:
        config._debug_log(
            "Queued neighborinfo payload",
            context="handlers.store_neighborinfo",
            node_id=node_id,
            neighbors=len(neighbor_entries),
        )


__all__ = ["store_neighborinfo_packet"]
