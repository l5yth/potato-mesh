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

"""Handlers for telemetry and router-heartbeat packets."""

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
)
from . import _state
from .position import base64_payload
from .radio import _apply_radio_metadata, _apply_radio_metadata_to_nodes

_VALID_TELEMETRY_TYPES: frozenset[str] = frozenset(
    {"device", "environment", "power", "air_quality"}
)
"""Allowed discriminator values for the ``telemetry_type`` field.

Meshtastic uses a protobuf ``oneof`` so only one metric sub-object can be
populated per packet.  Values outside this set indicate a firmware version
that added a new type not yet handled here; those are logged and dropped to
avoid persisting unexpected data shapes.
"""


def store_telemetry_packet(packet: Mapping, decoded: Mapping) -> None:
    """Persist telemetry metrics extracted from a packet.

    Handles all four Meshtastic telemetry sub-types (device, environment,
    power, air quality) by extracting common fields first and then
    conditionally adding type-specific metric keys.

    Host telemetry is rate-limited: if the locally connected node's own
    telemetry arrives within the suppression window it is silently dropped to
    avoid constant self-updates overwriting other node data.

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

    host_id = _state.host_node_id()
    # The locally connected node broadcasts its own telemetry frequently.
    # Accepting every packet would overwrite the host's profile more often
    # than necessary; the suppression window (default 1 h) rate-limits
    # self-updates without blocking telemetry from other nodes.
    if host_id is not None and node_id == host_id:
        suppressed, minutes_remaining = _state._host_telemetry_suppressed(rx_time)
        if suppressed:
            config._debug_log(
                "Suppressed host telemetry update",
                context="handlers.store_telemetry",
                host_node_id=host_id,
                minutes_remaining=minutes_remaining,
            )
            return
        _state._mark_host_telemetry_seen(rx_time)

    telemetry_time = _coerce_int(_first(telemetry_section, "time", default=None))

    _dm = telemetry_section.get("deviceMetrics") or telemetry_section.get(
        "device_metrics"
    )
    _em = telemetry_section.get("environmentMetrics") or telemetry_section.get(
        "environment_metrics"
    )
    _pm = telemetry_section.get("powerMetrics") or telemetry_section.get(
        "power_metrics"
    )
    _aq = telemetry_section.get("airQualityMetrics") or telemetry_section.get(
        "air_quality_metrics"
    )
    # Priority order matters: deviceMetrics is checked first because the device
    # sub-object also carries a voltage field that overlaps with powerMetrics.
    # Meshtastic uses a protobuf oneof so only one sub-object can be populated per
    # packet; the elif chain handles any hypothetical overlap from future protocols.
    if isinstance(_dm, Mapping):
        telemetry_type: str | None = "device"
    elif isinstance(_em, Mapping):
        telemetry_type = "environment"
    elif isinstance(_pm, Mapping):
        telemetry_type = "power"
    elif isinstance(_aq, Mapping):
        telemetry_type = "air_quality"
    else:
        telemetry_type = None

    if telemetry_type is not None and telemetry_type not in _VALID_TELEMETRY_TYPES:
        config._debug_log(
            "Unexpected telemetry_type value; dropping field",
            context="handlers.store_telemetry",
            severity="warning",
            always=True,
            telemetry_type=telemetry_type,
        )
        telemetry_type = None

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

    current = _coerce_float(
        _first(
            telemetry_section,
            "current",
            "deviceMetrics.current",
            "deviceMetrics.current_ma",
            "deviceMetrics.currentMa",
            "environmentMetrics.current",
            default=None,
        )
    )
    gas_resistance = _coerce_float(
        _first(
            telemetry_section,
            "gasResistance",
            "gas_resistance",
            "environmentMetrics.gasResistance",
            "environmentMetrics.gas_resistance",
            default=None,
        )
    )
    iaq = _coerce_int(
        _first(
            telemetry_section,
            "iaq",
            "environmentMetrics.iaq",
            "environmentMetrics.iaqIndex",
            "environmentMetrics.iaq_index",
            default=None,
        )
    )
    distance = _coerce_float(
        _first(
            telemetry_section,
            "distance",
            "environmentMetrics.distance",
            "environmentMetrics.range",
            "environmentMetrics.rangeMeters",
            default=None,
        )
    )
    lux = _coerce_float(
        _first(
            telemetry_section,
            "lux",
            "environmentMetrics.lux",
            "environmentMetrics.illuminance",
            default=None,
        )
    )
    white_lux = _coerce_float(
        _first(
            telemetry_section,
            "whiteLux",
            "white_lux",
            "environmentMetrics.whiteLux",
            "environmentMetrics.white_lux",
            default=None,
        )
    )
    ir_lux = _coerce_float(
        _first(
            telemetry_section,
            "irLux",
            "ir_lux",
            "environmentMetrics.irLux",
            "environmentMetrics.ir_lux",
            default=None,
        )
    )
    uv_lux = _coerce_float(
        _first(
            telemetry_section,
            "uvLux",
            "uv_lux",
            "environmentMetrics.uvLux",
            "environmentMetrics.uv_lux",
            "environmentMetrics.uvIndex",
            default=None,
        )
    )
    wind_direction = _coerce_int(
        _first(
            telemetry_section,
            "windDirection",
            "wind_direction",
            "environmentMetrics.windDirection",
            "environmentMetrics.wind_direction",
            default=None,
        )
    )
    wind_speed = _coerce_float(
        _first(
            telemetry_section,
            "windSpeed",
            "wind_speed",
            "environmentMetrics.windSpeed",
            "environmentMetrics.wind_speed",
            "environmentMetrics.windSpeedMps",
            default=None,
        )
    )
    wind_gust = _coerce_float(
        _first(
            telemetry_section,
            "windGust",
            "wind_gust",
            "environmentMetrics.windGust",
            "environmentMetrics.wind_gust",
            default=None,
        )
    )
    wind_lull = _coerce_float(
        _first(
            telemetry_section,
            "windLull",
            "wind_lull",
            "environmentMetrics.windLull",
            "environmentMetrics.wind_lull",
            default=None,
        )
    )
    weight = _coerce_float(
        _first(
            telemetry_section,
            "weight",
            "environmentMetrics.weight",
            "environmentMetrics.mass",
            default=None,
        )
    )
    radiation = _coerce_float(
        _first(
            telemetry_section,
            "radiation",
            "environmentMetrics.radiation",
            "environmentMetrics.radiationLevel",
            default=None,
        )
    )
    rainfall_1h = _coerce_float(
        _first(
            telemetry_section,
            "rainfall1h",
            "rainfall_1h",
            "environmentMetrics.rainfall1h",
            "environmentMetrics.rainfall_1h",
            "environmentMetrics.rainfallOneHour",
            default=None,
        )
    )
    rainfall_24h = _coerce_float(
        _first(
            telemetry_section,
            "rainfall24h",
            "rainfall_24h",
            "environmentMetrics.rainfall24h",
            "environmentMetrics.rainfall_24h",
            "environmentMetrics.rainfallTwentyFourHour",
            default=None,
        )
    )
    soil_moisture = _coerce_int(
        _first(
            telemetry_section,
            "soilMoisture",
            "soil_moisture",
            "environmentMetrics.soilMoisture",
            "environmentMetrics.soil_moisture",
            default=None,
        )
    )
    soil_temperature = _coerce_float(
        _first(
            telemetry_section,
            "soilTemperature",
            "soil_temperature",
            "environmentMetrics.soilTemperature",
            "environmentMetrics.soil_temperature",
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
        "ingestor": _state.host_node_id(),
    }

    # Conditionally include metric keys so the API ignores absent fields rather
    # than overwriting existing values with null.
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
    if current is not None:
        telemetry_payload["current"] = current
    if gas_resistance is not None:
        telemetry_payload["gas_resistance"] = gas_resistance
    if iaq is not None:
        telemetry_payload["iaq"] = iaq
    if distance is not None:
        telemetry_payload["distance"] = distance
    if lux is not None:
        telemetry_payload["lux"] = lux
    if white_lux is not None:
        telemetry_payload["white_lux"] = white_lux
    if ir_lux is not None:
        telemetry_payload["ir_lux"] = ir_lux
    if uv_lux is not None:
        telemetry_payload["uv_lux"] = uv_lux
    if wind_direction is not None:
        telemetry_payload["wind_direction"] = wind_direction
    if wind_speed is not None:
        telemetry_payload["wind_speed"] = wind_speed
    if wind_gust is not None:
        telemetry_payload["wind_gust"] = wind_gust
    if wind_lull is not None:
        telemetry_payload["wind_lull"] = wind_lull
    if weight is not None:
        telemetry_payload["weight"] = weight
    if radiation is not None:
        telemetry_payload["radiation"] = radiation
    if rainfall_1h is not None:
        telemetry_payload["rainfall_1h"] = rainfall_1h
    if rainfall_24h is not None:
        telemetry_payload["rainfall_24h"] = rainfall_24h
    if soil_moisture is not None:
        telemetry_payload["soil_moisture"] = soil_moisture
    if soil_temperature is not None:
        telemetry_payload["soil_temperature"] = soil_temperature
    if telemetry_type is not None:
        telemetry_payload["telemetry_type"] = telemetry_type

    queue._queue_post_json(
        "/api/telemetry",
        _apply_radio_metadata(telemetry_payload),
        priority=queue._TELEMETRY_POST_PRIORITY,
    )

    if config.DEBUG:
        config._debug_log(
            "Queued telemetry payload",
            context="handlers.store_telemetry",
            node_id=node_id,
            battery_level=battery_level,
            voltage=voltage,
        )


def store_router_heartbeat_packet(packet: Mapping) -> None:
    """Persist a ``STORE_FORWARD_APP ROUTER_HEARTBEAT`` as a node presence update.

    The heartbeat carries no message payload — the only actionable signal is
    that the store-and-forward router is alive at the observed ``rx_time``.
    All other fields are left untouched so the router's existing profile is
    not overwritten.

    Parameters:
        packet: Raw packet metadata.

    Returns:
        ``None``. A minimal node upsert is enqueued at low priority.
    """

    node_id = _canonical_node_id(
        _first(packet, "fromId", "from_id", "from", default=None)
    )
    if node_id is None:
        return

    rx_time = int(_first(packet, "rxTime", "rx_time", default=time.time()))

    node_payload: dict = {"lastHeard": rx_time}
    nodes_payload = _apply_radio_metadata_to_nodes({node_id: node_payload})
    nodes_payload["ingestor"] = _state.host_node_id()
    queue._queue_post_json(
        "/api/nodes", nodes_payload, priority=queue._DEFAULT_POST_PRIORITY
    )

    if config.DEBUG:
        config._debug_log(
            "Queued router heartbeat node upsert",
            context="handlers.store_router_heartbeat",
            node_id=node_id,
            rx_time=rx_time,
        )


__all__ = [
    "store_router_heartbeat_packet",
    "store_telemetry_packet",
]
