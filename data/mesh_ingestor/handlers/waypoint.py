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

"""Handler for Meshtastic ``WAYPOINT_APP`` packets (community POIs, SPEC W1).

A waypoint broadcast carries a sender-assigned waypoint id plus name,
description, icon codepoint, coordinates, an optional expiry timestamp, and an
optional lock-to node. The handler normalises the packet into the
protocol-neutral ``POST /api/waypoints`` contract shape (``CONTRACTS.md``) and
queues it for HTTP submission.
"""

from __future__ import annotations

import time
from collections.abc import Mapping

from .. import config, queue
from ..serialization import (
    _canonical_node_id,
    _coerce_float,
    _coerce_int,
    _extract_payload_bytes,
    _first,
    _iso,
    _node_num_from_id,
    _normalize_lat_lon,
)
from . import _state
from .ignored import _record_ignored_packet
from .position import base64_payload
from .radio import _apply_radio_metadata


def _canonical_locked_to(value: object) -> str | None:
    """Map a waypoint's ``locked_to`` reference onto the canonical id space.

    Meshtastic transmits ``locked_to`` as a node number (uint32) where ``0``
    means "not locked"; re-relayed payloads may already carry a canonical
    ``!%08x`` string. Both forms are normalised; unlocked or unparseable
    values yield ``None`` so the field is omitted from the POST.

    Parameters:
        value: Raw ``locked_to`` reference (int node num, hex string, or
            ``None``).

    Returns:
        The canonical ``!%08x`` node id, or ``None`` when unlocked/invalid.
    """

    numeric = _coerce_int(value)
    if numeric == 0:
        return None
    return _canonical_node_id(value)


def store_waypoint_packet(packet: Mapping, decoded: Mapping) -> None:
    """Persist a decoded ``WAYPOINT_APP`` packet to the API (SPEC W1/W5).

    Extracts the waypoint fields from the decoded ``waypoint`` section,
    accepting both the floating-point (``latitude``/``longitude``) and the
    protobuf integer-scaled (``latitudeI``/``longitudeI``) coordinate forms,
    normalises the ``(0, 0)`` no-fix sentinel (issue #782 rules), maps
    ``expire <= 0`` to "never expires" (omitted), and canonicalises the
    author and ``locked_to`` node references (C3).

    Parameters:
        packet: Raw packet metadata emitted by the Meshtastic interface.
        decoded: Decoded payload extracted from ``packet['decoded']``.

    Returns:
        ``None``. The formatted waypoint payload is added to the HTTP queue,
        or the packet is recorded as ignored when the waypoint id or author
        cannot be resolved.
    """

    waypoint_section = decoded.get("waypoint") if isinstance(decoded, Mapping) else None
    if not isinstance(waypoint_section, Mapping):
        waypoint_section = {}

    waypoint_id = _coerce_int(_first(waypoint_section, "id", "raw.id", default=None))
    if waypoint_id is None:
        _record_ignored_packet(packet, reason="waypoint-missing-id")
        return

    node_ref = _first(packet, "fromId", "from_id", "from", default=None)
    node_id = _canonical_node_id(node_ref)
    if node_id is None:
        _record_ignored_packet(packet, reason="waypoint-missing-author")
        return
    node_num = _node_num_from_id(node_id)

    rx_time = _coerce_int(_first(packet, "rxTime", "rx_time", default=time.time()))
    if rx_time is None:
        rx_time = int(time.time())

    name = _first(waypoint_section, "name", "raw.name", default=None)
    name = str(name) if name not in {None, ""} else None
    description = _first(
        waypoint_section, "description", "raw.description", default=None
    )
    description = str(description) if description not in {None, ""} else None
    icon = _coerce_int(_first(waypoint_section, "icon", "raw.icon", default=None))

    # Coordinates arrive as floating-point degrees or the protobuf 1e-7
    # integer form depending on firmware/library version — same duality as
    # positions.
    latitude = _coerce_float(
        _first(waypoint_section, "latitude", "raw.latitude", default=None)
    )
    if latitude is None:
        lat_i = _coerce_int(
            _first(
                waypoint_section,
                "latitudeI",
                "latitude_i",
                "raw.latitude_i",
                default=None,
            )
        )
        if lat_i is not None:
            latitude = lat_i / 1e7
    longitude = _coerce_float(
        _first(waypoint_section, "longitude", "raw.longitude", default=None)
    )
    if longitude is None:
        lon_i = _coerce_int(
            _first(
                waypoint_section,
                "longitudeI",
                "longitude_i",
                "raw.longitude_i",
                default=None,
            )
        )
        if lon_i is not None:
            longitude = lon_i / 1e7

    # Collapse the paired (0, 0) "no fix" sentinel to (None, None) — a
    # waypoint pinned at null island is meaningless (issue #782 rules).
    latitude, longitude = _normalize_lat_lon(latitude, longitude)

    # ``expire`` is a unix timestamp; 0/absent means "never expires" and is
    # omitted so the web layer stores NULL (SPEC W5).
    expire = _coerce_int(_first(waypoint_section, "expire", "raw.expire", default=None))
    if expire is not None and expire <= 0:
        expire = None

    locked_to = _canonical_locked_to(
        _first(waypoint_section, "lockedTo", "locked_to", "raw.locked_to", default=None)
    )

    snr = _coerce_float(_first(packet, "snr", "rx_snr", "rxSnr", default=None))
    rssi = _coerce_int(_first(packet, "rssi", "rx_rssi", "rxRssi", default=None))
    hop_limit = _coerce_int(_first(packet, "hopLimit", "hop_limit", default=None))
    payload_b64 = base64_payload(_extract_payload_bytes(decoded))

    waypoint_payload = {
        "id": waypoint_id,
        "node_id": node_id,
        "node_num": node_num,
        "from_id": node_id,
        "rx_time": rx_time,
        "rx_iso": _iso(rx_time),
        "name": name,
        "description": description,
        "icon": icon,
        "latitude": latitude,
        "longitude": longitude,
        "expire": expire,
        "locked_to": locked_to,
        "snr": snr,
        "rssi": rssi,
        "hop_limit": hop_limit,
        "payload_b64": payload_b64,
        "ingestor": _state.host_node_id(),
        # Per-record protocol stamp closes the startup race where the web app
        # processes a waypoint before the ingestor heartbeat registers a
        # protocol mapping — see CONTRACTS.md.
        "protocol": packet.get("protocol") or config.PROTOCOL,
    }

    queue._queue_post_json(
        "/api/waypoints",
        _apply_radio_metadata(waypoint_payload),
        priority=queue._WAYPOINT_POST_PRIORITY,
    )

    if config.DEBUG:
        config._debug_log(
            "Queued waypoint payload",
            context="handlers.store_waypoint",
            node_id=node_id,
            waypoint_id=waypoint_id,
            name=name,
            expire=expire,
        )


__all__ = [
    "store_waypoint_packet",
]
