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

"""Handlers for position and traceroute packets."""

from __future__ import annotations

import base64
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
    _node_to_dict,
    _pkt_to_dict,
)
from . import _state
from .ignored import _record_ignored_packet
from .radio import _apply_radio_metadata


def base64_payload(payload_bytes: bytes | None) -> str | None:
    """Encode raw payload bytes as a Base64 string for JSON transport.

    Parameters:
        payload_bytes: Optional raw bytes to encode. When ``None`` or empty,
            ``None`` is returned so callers can omit the field.

    Returns:
        The Base64-encoded ASCII string, or ``None`` when ``payload_bytes`` is
        falsy.
    """

    if not payload_bytes:
        return None
    return base64.b64encode(payload_bytes).decode("ascii")


def _normalize_trace_hops(hops_value: object) -> list[int]:
    """Coerce hop entries to integer node numbers, preserving order.

    Each hop can arrive as a plain integer, a canonical node-ID string
    (``!xxxxxxxx``), or a mapping with a ``nodeId`` / ``node_id`` field.
    All forms are normalised to the raw 32-bit node number used by the API.

    Parameters:
        hops_value: A single hop or list of hops in any supported form.

    Returns:
        List of integer node numbers with ``None``-coerced entries dropped.
    """

    if hops_value is None:
        return []
    hop_entries = hops_value if isinstance(hops_value, list) else [hops_value]
    normalized: list[int] = []
    for hop in hop_entries:
        hop_value = hop
        if isinstance(hop, Mapping):
            hop_value = _first(hop, "node_id", "nodeId", "id", "num", default=None)

        canonical = _canonical_node_id(hop_value)
        hop_id = _node_num_from_id(canonical or hop_value)
        if hop_id is None:
            hop_id = _coerce_int(hop_value)
        if hop_id is not None:
            normalized.append(hop_id)
    return normalized


def store_position_packet(packet: Mapping, decoded: Mapping) -> None:
    """Persist a decoded GPS position packet to the API.

    Extracts coordinates from both the integer-scaled (``latitudeI`` /
    ``longitudeI``) and floating-point (``latitude`` / ``longitude``) forms
    that Meshtastic may produce depending on firmware version.

    Parameters:
        packet: Raw packet metadata emitted by the Meshtastic interface.
        decoded: Decoded payload extracted from ``packet['decoded']``.

    Returns:
        ``None``. The formatted position payload is added to the HTTP queue.
    """

    node_ref = _first(packet, "fromId", "from_id", "from", default=None)
    if node_ref is None:
        node_ref = _first(decoded, "num", default=None)
    node_id = _canonical_node_id(node_ref)
    if node_id is None:
        return

    node_num = _coerce_int(_first(decoded, "num", default=None))
    if node_num is None:
        node_num = _node_num_from_id(node_id)

    pkt_id = _coerce_int(_first(packet, "id", "packet_id", "packetId", default=None))
    if pkt_id is None:
        return

    rx_time = _coerce_int(_first(packet, "rxTime", "rx_time", default=time.time()))
    if rx_time is None:
        rx_time = int(time.time())

    to_id = _first(packet, "toId", "to_id", "to", default=None)
    to_id = to_id if to_id not in {"", None} else None

    position_section = decoded.get("position") if isinstance(decoded, Mapping) else None
    if not isinstance(position_section, Mapping):
        position_section = {}

    # Meshtastic firmware may emit coordinates in one of two forms:
    #   - Floating-point degrees: ``latitude`` / ``longitude``
    #   - Integer-scaled (1e-7 degrees): ``latitudeI`` / ``longitudeI``
    # Try the float form first and fall back to the integer form when absent.
    latitude = _coerce_float(
        _first(position_section, "latitude", "raw.latitude", default=None)
    )
    if latitude is None:
        lat_i = _coerce_int(
            _first(
                position_section,
                "latitudeI",
                "latitude_i",
                "raw.latitude_i",
                default=None,
            )
        )
        if lat_i is not None:
            latitude = lat_i / 1e7

    longitude = _coerce_float(
        _first(position_section, "longitude", "raw.longitude", default=None)
    )
    if longitude is None:
        lon_i = _coerce_int(
            _first(
                position_section,
                "longitudeI",
                "longitude_i",
                "raw.longitude_i",
                default=None,
            )
        )
        if lon_i is not None:
            longitude = lon_i / 1e7

    altitude = _coerce_float(
        _first(position_section, "altitude", "raw.altitude", default=None)
    )
    position_time = _coerce_int(
        _first(position_section, "time", "raw.time", default=None)
    )
    location_source = _first(
        position_section,
        "locationSource",
        "location_source",
        "raw.location_source",
        default=None,
    )
    location_source = (
        str(location_source).strip() if location_source not in {None, ""} else None
    )

    precision_bits = _coerce_int(
        _first(
            position_section,
            "precisionBits",
            "precision_bits",
            "raw.precision_bits",
            default=None,
        )
    )
    sats_in_view = _coerce_int(
        _first(
            position_section,
            "satsInView",
            "sats_in_view",
            "raw.sats_in_view",
            default=None,
        )
    )
    pdop = _coerce_float(
        _first(position_section, "PDOP", "pdop", "raw.PDOP", "raw.pdop", default=None)
    )
    ground_speed = _coerce_float(
        _first(
            position_section,
            "groundSpeed",
            "ground_speed",
            "raw.ground_speed",
            default=None,
        )
    )
    ground_track = _coerce_float(
        _first(
            position_section,
            "groundTrack",
            "ground_track",
            "raw.ground_track",
            default=None,
        )
    )

    snr = _coerce_float(_first(packet, "snr", "rx_snr", "rxSnr", default=None))
    rssi = _coerce_int(_first(packet, "rssi", "rx_rssi", "rxRssi", default=None))
    hop_limit = _coerce_int(_first(packet, "hopLimit", "hop_limit", default=None))
    bitfield = _coerce_int(_first(decoded, "bitfield", default=None))

    payload_bytes = _extract_payload_bytes(decoded)
    payload_b64 = base64_payload(payload_bytes)

    raw_section = decoded.get("raw") if isinstance(decoded, Mapping) else None
    raw_payload = _node_to_dict(raw_section) if raw_section else None
    if raw_payload is None and position_section:
        raw_position = (
            position_section.get("raw")
            if isinstance(position_section, Mapping)
            else None
        )
        if raw_position:
            raw_payload = _node_to_dict(raw_position)

    position_payload = {
        "id": pkt_id,
        "node_id": node_id or node_ref,
        "node_num": node_num,
        "num": node_num,
        "from_id": node_id,
        "to_id": to_id,
        "rx_time": rx_time,
        "rx_iso": _iso(rx_time),
        "latitude": latitude,
        "longitude": longitude,
        "altitude": altitude,
        "position_time": position_time,
        "location_source": location_source,
        "precision_bits": precision_bits,
        "sats_in_view": sats_in_view,
        "pdop": pdop,
        "ground_speed": ground_speed,
        "ground_track": ground_track,
        "snr": snr,
        "rssi": rssi,
        "hop_limit": hop_limit,
        "bitfield": bitfield,
        "payload_b64": payload_b64,
        "ingestor": _state.host_node_id(),
    }
    if raw_payload:
        position_payload["raw"] = raw_payload

    queue._queue_post_json(
        "/api/positions",
        _apply_radio_metadata(position_payload),
        priority=queue._POSITION_POST_PRIORITY,
    )

    if config.DEBUG:
        config._debug_log(
            "Queued position payload",
            context="handlers.store_position",
            node_id=node_id,
            latitude=latitude,
            longitude=longitude,
            position_time=position_time,
        )


def store_traceroute_packet(packet: Mapping, decoded: Mapping) -> None:
    """Persist traceroute details and the observed hop path to the API.

    Hop lists can arrive under several key names (``hops``, ``path``,
    ``route``) and may appear at multiple nesting levels.  All candidates are
    deduplicated and merged into a single ordered list.

    Parameters:
        packet: Raw packet metadata from the Meshtastic interface.
        decoded: Decoded payload containing the traceroute section.

    Returns:
        ``None``. The traceroute payload is queued for HTTP submission, or
        silently dropped when identifiers are entirely absent.
    """

    traceroute_section = (
        decoded.get("traceroute") if isinstance(decoded, Mapping) else None
    )
    request_id = _coerce_int(
        _first(
            traceroute_section,
            "requestId",
            "request_id",
            default=_first(decoded, "req", "requestId", "request_id", default=None),
        )
    )
    pkt_id = _coerce_int(_first(packet, "id", "packet_id", "packetId", default=None))
    if pkt_id is None:
        pkt_id = request_id

    rx_time = _coerce_int(_first(packet, "rxTime", "rx_time", default=time.time()))
    if rx_time is None:
        rx_time = int(time.time())

    src = _coerce_int(
        _first(
            decoded,
            "src",
            "source",
            default=_first(packet, "fromId", "from_id", "from", default=None),
        )
    )
    dest = _coerce_int(
        _first(
            decoded,
            "dest",
            "destination",
            default=_first(packet, "toId", "to_id", "to", default=None),
        )
    )

    metrics = traceroute_section if isinstance(traceroute_section, Mapping) else {}
    rssi = _coerce_int(
        _first(metrics, "rssi", default=_first(packet, "rssi", "rx_rssi", "rxRssi"))
    )
    snr = _coerce_float(
        _first(metrics, "snr", default=_first(packet, "snr", "rx_snr", "rxSnr"))
    )
    elapsed_ms = _coerce_int(
        _first(metrics, "elapsed_ms", "latency_ms", "latencyMs", default=None)
    )

    # Hops can appear under multiple keys at different nesting levels; collect
    # all candidates and deduplicate while preserving first-seen order.
    hop_candidates = (
        _first(metrics, "hops", default=None),
        _first(metrics, "path", default=None),
        _first(metrics, "route", default=None),
        _first(decoded, "hops", default=None),
        _first(decoded, "path", default=None),
        (
            _first(traceroute_section, "route", default=None)
            if isinstance(traceroute_section, Mapping)
            else None
        ),
    )
    hops: list[int] = []
    seen_hops: set[int] = set()
    for candidate in hop_candidates:
        for hop in _normalize_trace_hops(candidate):
            if hop in seen_hops:
                continue
            seen_hops.add(hop)
            hops.append(hop)

    if pkt_id is None and request_id is None and not hops:
        _record_ignored_packet(packet, reason="traceroute-missing-identifiers")
        return

    payload = {
        "id": pkt_id,
        "request_id": request_id,
        "src": src,
        "dest": dest,
        "rx_time": rx_time,
        "rx_iso": _iso(rx_time),
        "hops": hops,
        "rssi": rssi,
        "snr": snr,
        "elapsed_ms": elapsed_ms,
        "ingestor": _state.host_node_id(),
    }

    queue._queue_post_json(
        "/api/traces",
        _apply_radio_metadata(payload),
        priority=queue._TRACE_POST_PRIORITY,
    )

    if config.DEBUG:
        config._debug_log(
            "Queued traceroute payload",
            context="handlers.store_traceroute_packet",
            request_id=request_id,
            src=src,
            dest=dest,
            hop_count=len(hops),
        )


__all__ = [
    "base64_payload",
    "store_position_packet",
    "store_traceroute_packet",
]
