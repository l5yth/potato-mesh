# Copyright (C) 2025 l5yth
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

"""Packet handlers that serialise data and push it to the HTTP queue."""

from __future__ import annotations

import base64
import json
import time
from collections.abc import Mapping

from . import config, queue
from .serialization import (
    _canonical_node_id,
    _coerce_float,
    _coerce_int,
    _decode_nodeinfo_payload,
    _extract_payload_bytes,
    _first,
    _get,
    _iso,
    _merge_mappings,
    _node_num_from_id,
    _node_to_dict,
    _nodeinfo_metrics_dict,
    _nodeinfo_position_dict,
    _nodeinfo_user_dict,
    _pkt_to_dict,
    upsert_payload,
)


def upsert_node(node_id, node) -> None:
    """Schedule an upsert for a single node.

    Parameters:
        node_id: Canonical identifier for the node in the ``!xxxxxxxx`` format.
        node: Node object or mapping to serialise for the API payload.

    Returns:
        ``None``. The payload is forwarded to the shared HTTP queue.
    """

    payload = upsert_payload(node_id, node)
    _queue_post_json("/api/nodes", payload, priority=queue._NODE_POST_PRIORITY)

    if config.DEBUG:
        user = _get(payload[node_id], "user") or {}
        short = _get(user, "shortName")
        long = _get(user, "longName")
        config._debug_log(
            f"upserted node {node_id} shortName={short!r} longName={long!r}"
        )


def store_position_packet(packet: Mapping, decoded: Mapping) -> None:
    """Persist a decoded position packet.

    Parameters:
        packet: Raw packet metadata emitted by Meshtastic.
        decoded: Decoded payload extracted from ``packet['decoded']``.

    Returns:
        ``None``. The formatted position data is queued for HTTP submission.
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
    }
    if raw_payload:
        position_payload["raw"] = raw_payload

    _queue_post_json(
        "/api/positions", position_payload, priority=queue._POSITION_POST_PRIORITY
    )

    if config.DEBUG:
        config._debug_log(
            f"stored position for {node_id} lat={latitude!r} lon={longitude!r}"
        )


def base64_payload(payload_bytes: bytes | None) -> str | None:
    """Encode raw payload bytes for JSON transport.

    Parameters:
        payload_bytes: Optional payload to encode. ``None`` is returned when
            the payload is empty or missing.

    Returns:
        The Base64 encoded payload string or ``None`` when no payload exists.
    """

    if not payload_bytes:
        return None
    return base64.b64encode(payload_bytes).decode("ascii")


def store_telemetry_packet(packet: Mapping, decoded: Mapping) -> None:
    """Persist telemetry metrics extracted from a packet.

    Parameters:
        packet: Packet metadata received from the radio interface.
        decoded: Meshtastic-decoded view containing telemetry structures.

    Returns:
        ``None``. The telemetry payload is added to the HTTP queue.
    """

    telemetry_section = (
        decoded.get("telemetry") if isinstance(decoded, Mapping) else None
    )
    if not isinstance(telemetry_section, Mapping):
        return

    pkt_id = _coerce_int(_first(packet, "id", "packet_id", "packetId", default=None))
    if pkt_id is None:
        return

    raw_from = _first(packet, "fromId", "from_id", "from", default=None)
    node_id = _canonical_node_id(raw_from)
    node_num = _coerce_int(_first(decoded, "num", "node_num", default=None))
    if node_num is None:
        node_num = _node_num_from_id(node_id or raw_from)

    to_id = _first(packet, "toId", "to_id", "to", default=None)

    raw_rx_time = _first(packet, "rxTime", "rx_time", default=time.time())
    try:
        rx_time = int(raw_rx_time)
    except (TypeError, ValueError):
        rx_time = int(time.time())
    rx_iso = _iso(rx_time)

    telemetry_time = _coerce_int(_first(telemetry_section, "time", default=None))

    channel = _coerce_int(_first(decoded, "channel", default=None))
    if channel is None:
        channel = _coerce_int(_first(packet, "channel", default=None))
    if channel is None:
        channel = 0

    portnum = _first(decoded, "portnum", default=None)
    portnum = str(portnum) if portnum not in {None, ""} else None

    bitfield = _coerce_int(_first(decoded, "bitfield", default=None))

    snr = _coerce_float(_first(packet, "snr", "rx_snr", "rxSnr", default=None))
    rssi = _coerce_int(_first(packet, "rssi", "rx_rssi", "rxRssi", default=None))
    hop_limit = _coerce_int(_first(packet, "hopLimit", "hop_limit", default=None))

    payload_bytes = _extract_payload_bytes(decoded)
    payload_b64 = base64_payload(payload_bytes) or ""

    battery_level = _coerce_float(
        _first(
            telemetry_section,
            "batteryLevel",
            "battery_level",
            "deviceMetrics.batteryLevel",
            "environmentMetrics.battery_level",
            "deviceMetrics.battery_level",
            default=None,
        )
    )
    voltage = _coerce_float(
        _first(
            telemetry_section,
            "voltage",
            "environmentMetrics.voltage",
            "deviceMetrics.voltage",
            default=None,
        )
    )
    channel_utilization = _coerce_float(
        _first(
            telemetry_section,
            "channelUtilization",
            "channel_utilization",
            "deviceMetrics.channelUtilization",
            "deviceMetrics.channel_utilization",
            default=None,
        )
    )
    air_util_tx = _coerce_float(
        _first(
            telemetry_section,
            "airUtilTx",
            "air_util_tx",
            "deviceMetrics.airUtilTx",
            "deviceMetrics.air_util_tx",
            default=None,
        )
    )
    uptime_seconds = _coerce_int(
        _first(
            telemetry_section,
            "uptimeSeconds",
            "uptime_seconds",
            "deviceMetrics.uptimeSeconds",
            "deviceMetrics.uptime_seconds",
            default=None,
        )
    )

    temperature = _coerce_float(
        _first(
            telemetry_section,
            "temperature",
            "environmentMetrics.temperature",
            default=None,
        )
    )
    relative_humidity = _coerce_float(
        _first(
            telemetry_section,
            "relativeHumidity",
            "relative_humidity",
            "environmentMetrics.relativeHumidity",
            "environmentMetrics.relative_humidity",
            default=None,
        )
    )
    barometric_pressure = _coerce_float(
        _first(
            telemetry_section,
            "barometricPressure",
            "barometric_pressure",
            "environmentMetrics.barometricPressure",
            "environmentMetrics.barometric_pressure",
            default=None,
        )
    )

    telemetry_payload = {
        "id": pkt_id,
        "node_id": node_id,
        "node_num": node_num,
        "from_id": node_id or raw_from,
        "to_id": to_id,
        "rx_time": rx_time,
        "rx_iso": rx_iso,
        "telemetry_time": telemetry_time,
        "channel": channel,
        "portnum": portnum,
        "bitfield": bitfield,
        "snr": snr,
        "rssi": rssi,
        "hop_limit": hop_limit,
        "payload_b64": payload_b64,
    }

    if battery_level is not None:
        telemetry_payload["battery_level"] = battery_level
    if voltage is not None:
        telemetry_payload["voltage"] = voltage
    if channel_utilization is not None:
        telemetry_payload["channel_utilization"] = channel_utilization
    if air_util_tx is not None:
        telemetry_payload["air_util_tx"] = air_util_tx
    if uptime_seconds is not None:
        telemetry_payload["uptime_seconds"] = uptime_seconds
    if temperature is not None:
        telemetry_payload["temperature"] = temperature
    if relative_humidity is not None:
        telemetry_payload["relative_humidity"] = relative_humidity
    if barometric_pressure is not None:
        telemetry_payload["barometric_pressure"] = barometric_pressure

    _queue_post_json(
        "/api/telemetry", telemetry_payload, priority=queue._TELEMETRY_POST_PRIORITY
    )

    if config.DEBUG:
        config._debug_log(
            f"stored telemetry for {node_id!r} battery={battery_level!r} voltage={voltage!r}"
        )


def store_nodeinfo_packet(packet: Mapping, decoded: Mapping) -> None:
    """Persist node information updates.

    Parameters:
        packet: Raw packet metadata describing the update.
        decoded: Decoded payload that may include ``user`` and ``position``
            sections.

    Returns:
        ``None``. The node payload is merged into the API queue.
    """

    payload_bytes = _extract_payload_bytes(decoded)
    node_info = _decode_nodeinfo_payload(payload_bytes)
    decoded_user = decoded.get("user")
    user_dict = _nodeinfo_user_dict(node_info, decoded_user)

    node_info_fields = set()
    if node_info:
        node_info_fields = {field_desc.name for field_desc, _ in node_info.ListFields()}

    node_id = None
    if isinstance(user_dict, Mapping):
        node_id = _canonical_node_id(user_dict.get("id"))

    if node_id is None:
        node_id = _canonical_node_id(
            _first(packet, "fromId", "from_id", "from", default=None)
        )

    if node_id is None:
        return

    node_payload: dict = {}
    if user_dict:
        node_payload["user"] = user_dict

    node_num = None
    if node_info and "num" in node_info_fields:
        try:
            node_num = int(node_info.num)
        except (TypeError, ValueError):
            node_num = None
    if node_num is None:
        decoded_num = decoded.get("num")
        if decoded_num is not None:
            try:
                node_num = int(decoded_num)
            except (TypeError, ValueError):
                try:
                    node_num = int(str(decoded_num).strip(), 0)
                except Exception:
                    node_num = None
    if node_num is None:
        node_num = _node_num_from_id(node_id)
    if node_num is not None:
        node_payload["num"] = node_num

    rx_time = int(_first(packet, "rxTime", "rx_time", default=time.time()))
    last_heard = None
    if node_info and "last_heard" in node_info_fields:
        try:
            last_heard = int(node_info.last_heard)
        except (TypeError, ValueError):
            last_heard = None
    if last_heard is None:
        decoded_last_heard = decoded.get("lastHeard")
        if decoded_last_heard is not None:
            try:
                last_heard = int(decoded_last_heard)
            except (TypeError, ValueError):
                last_heard = None
    if last_heard is None or last_heard < rx_time:
        last_heard = rx_time
    node_payload["lastHeard"] = last_heard

    snr = None
    if node_info and "snr" in node_info_fields:
        try:
            snr = float(node_info.snr)
        except (TypeError, ValueError):
            snr = None
    if snr is None:
        snr = _first(packet, "snr", "rx_snr", "rxSnr", default=None)
        if snr is not None:
            try:
                snr = float(snr)
            except (TypeError, ValueError):
                snr = None
    if snr is not None:
        node_payload["snr"] = snr

    hops = None
    if node_info and "hops_away" in node_info_fields:
        try:
            hops = int(node_info.hops_away)
        except (TypeError, ValueError):
            hops = None
    if hops is None:
        hops = decoded.get("hopsAway")
        if hops is not None:
            try:
                hops = int(hops)
            except (TypeError, ValueError):
                hops = None
    if hops is not None:
        node_payload["hopsAway"] = hops

    if node_info and "channel" in node_info_fields:
        try:
            node_payload["channel"] = int(node_info.channel)
        except (TypeError, ValueError):
            pass

    if node_info and "via_mqtt" in node_info_fields:
        node_payload["viaMqtt"] = bool(node_info.via_mqtt)

    if node_info and "is_favorite" in node_info_fields:
        node_payload["isFavorite"] = bool(node_info.is_favorite)
    elif "isFavorite" in decoded:
        node_payload["isFavorite"] = bool(decoded.get("isFavorite"))

    if node_info and "is_ignored" in node_info_fields:
        node_payload["isIgnored"] = bool(node_info.is_ignored)
    if node_info and "is_key_manually_verified" in node_info_fields:
        node_payload["isKeyManuallyVerified"] = bool(node_info.is_key_manually_verified)

    metrics = _nodeinfo_metrics_dict(node_info)
    decoded_metrics = decoded.get("deviceMetrics")
    if isinstance(decoded_metrics, Mapping):
        metrics = _merge_mappings(metrics, _node_to_dict(decoded_metrics))
    if metrics:
        node_payload["deviceMetrics"] = metrics

    position = _nodeinfo_position_dict(node_info)
    decoded_position = decoded.get("position")
    if isinstance(decoded_position, Mapping):
        position = _merge_mappings(position, _node_to_dict(decoded_position))
    if position:
        node_payload["position"] = position

    hop_limit = _first(packet, "hopLimit", "hop_limit", default=None)
    if hop_limit is not None and "hopLimit" not in node_payload:
        try:
            node_payload["hopLimit"] = int(hop_limit)
        except (TypeError, ValueError):
            pass

    _queue_post_json(
        "/api/nodes", {node_id: node_payload}, priority=queue._NODE_POST_PRIORITY
    )

    if config.DEBUG:
        short = None
        long_name = None
        if isinstance(user_dict, Mapping):
            short = user_dict.get("shortName")
            long_name = user_dict.get("longName")
        config._debug_log(
            f"stored nodeinfo for {node_id} shortName={short!r} longName={long_name!r}"
        )


def store_neighborinfo_packet(packet: Mapping, decoded: Mapping) -> None:
    """Persist neighbour information gathered from a packet.

    Parameters:
        packet: Raw Meshtastic packet metadata.
        decoded: Decoded view containing the neighbour information section.

    Returns:
        ``None``. The neighbour snapshot is queued for submission.
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
    }

    if node_broadcast_interval is not None:
        payload["node_broadcast_interval_secs"] = node_broadcast_interval
    if last_sent_by_id is not None:
        payload["last_sent_by_id"] = last_sent_by_id

    _queue_post_json("/api/neighbors", payload, priority=queue._NEIGHBOR_POST_PRIORITY)

    if config.DEBUG:
        config._debug_log(
            f"stored neighborinfo for {node_id} neighbors={len(neighbor_entries)}"
        )


def store_packet_dict(packet: Mapping) -> None:
    """Route a decoded packet to the appropriate storage handler.

    Parameters:
        packet: Packet dictionary emitted by the mesh interface.

    Returns:
        ``None``. Side-effects depend on the specific handler invoked.
    """

    decoded = packet.get("decoded") or {}

    portnum_raw = _first(decoded, "portnum", default=None)
    portnum = str(portnum_raw).upper() if portnum_raw is not None else None
    portnum_int = _coerce_int(portnum_raw)

    telemetry_section = (
        decoded.get("telemetry") if isinstance(decoded, Mapping) else None
    )
    if (
        portnum == "TELEMETRY_APP"
        or portnum_int == 65
        or isinstance(telemetry_section, Mapping)
    ):
        store_telemetry_packet(packet, decoded)
        return

    if portnum in {"5", "NODEINFO_APP"}:
        store_nodeinfo_packet(packet, decoded)
        return

    if portnum in {"4", "POSITION_APP"}:
        store_position_packet(packet, decoded)
        return

    neighborinfo_section = (
        decoded.get("neighborinfo") if isinstance(decoded, Mapping) else None
    )
    if portnum == "NEIGHBORINFO_APP" or isinstance(neighborinfo_section, Mapping):
        store_neighborinfo_packet(packet, decoded)
        return

    text = _first(decoded, "payload.text", "text", default=None)
    encrypted = _first(decoded, "payload.encrypted", "encrypted", default=None)
    if encrypted is None:
        encrypted = _first(packet, "encrypted", default=None)
    if not text and not encrypted:
        return

    if portnum and portnum not in {"1", "TEXT_MESSAGE_APP"}:
        return

    channel = _first(decoded, "channel", default=None)
    if channel is None:
        channel = _first(packet, "channel", default=0)
    try:
        channel = int(channel)
    except Exception:
        channel = 0

    pkt_id = _first(packet, "id", "packet_id", "packetId", default=None)
    if pkt_id is None:
        return
    rx_time = int(_first(packet, "rxTime", "rx_time", default=time.time()))
    from_id = _first(packet, "fromId", "from_id", "from", default=None)
    to_id = _first(packet, "toId", "to_id", "to", default=None)

    if (from_id is None or str(from_id) == "") and config.DEBUG:
        try:
            raw = json.dumps(packet, default=str)
        except Exception:
            raw = str(packet)
        config._debug_log(f"packet missing from_id: {raw}")

    snr = _first(packet, "snr", "rx_snr", "rxSnr", default=None)
    rssi = _first(packet, "rssi", "rx_rssi", "rxRssi", default=None)
    hop = _first(packet, "hopLimit", "hop_limit", default=None)

    message_payload = {
        "id": int(pkt_id),
        "rx_time": rx_time,
        "rx_iso": _iso(rx_time),
        "from_id": from_id,
        "to_id": to_id,
        "channel": channel,
        "portnum": str(portnum) if portnum is not None else None,
        "text": text,
        "encrypted": encrypted,
        "snr": float(snr) if snr is not None else None,
        "rssi": int(rssi) if rssi is not None else None,
        "hop_limit": int(hop) if hop is not None else None,
    }
    _queue_post_json(
        "/api/messages", message_payload, priority=queue._MESSAGE_POST_PRIORITY
    )

    if config.DEBUG:
        from_label = _canonical_node_id(from_id) or from_id
        to_label = _canonical_node_id(to_id) or to_id
        payload_desc = "Encrypted" if text is None and encrypted else text
        config._debug_log(
            f"stored message from {from_label!r} to {to_label!r} ch={channel} text={payload_desc!r}"
        )


def on_receive(packet, interface) -> None:
    """Callback registered with Meshtastic to capture incoming packets.

    Parameters:
        packet: Packet payload supplied by the Meshtastic pubsub topic.
        interface: Interface instance that produced the packet. Only used for
            compatibility with Meshtastic's callback signature.

    Returns:
        ``None``. Packets are serialised and enqueued asynchronously.
    """

    if isinstance(packet, dict):
        if packet.get("_potatomesh_seen"):
            return
        packet["_potatomesh_seen"] = True

    packet_dict = None
    try:
        packet_dict = _pkt_to_dict(packet)
        store_packet_dict(packet_dict)
    except Exception as exc:
        info = (
            list(packet_dict.keys()) if isinstance(packet_dict, dict) else type(packet)
        )
        print(f"[warn] failed to store packet: {exc} | info: {info}")


__all__ = [
    "_queue_post_json",
    "on_receive",
    "store_neighborinfo_packet",
    "store_nodeinfo_packet",
    "store_packet_dict",
    "store_position_packet",
    "store_telemetry_packet",
    "upsert_node",
]

_queue_post_json = queue._queue_post_json
