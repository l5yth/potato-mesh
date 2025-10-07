"""Utility helpers for working with Meshtastic packets."""

from __future__ import annotations

import base64
import dataclasses
import json
import math
import time
from collections.abc import Mapping

from google.protobuf.json_format import MessageToDict
from google.protobuf.message import DecodeError
from google.protobuf.message import Message as ProtoMessage

from .. import config


def _get(obj, key, default=None):
    """Return a key or attribute value from ``obj``."""

    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _node_to_dict(n) -> dict:
    """Convert Meshtastic node or user structures into plain dictionaries."""

    def _convert(value):
        if isinstance(value, dict):
            return {k: _convert(v) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [_convert(v) for v in value]
        if dataclasses.is_dataclass(value):
            return {k: _convert(getattr(value, k)) for k in value.__dataclass_fields__}
        if isinstance(value, ProtoMessage):
            try:
                return MessageToDict(
                    value,
                    preserving_proto_field_name=True,
                    use_integers_for_enums=False,
                )
            except Exception:
                if hasattr(value, "to_dict"):
                    try:
                        return value.to_dict()
                    except Exception:
                        pass
                try:
                    return json.loads(json.dumps(value, default=str))
                except Exception:
                    return str(value)
        if isinstance(value, bytes):
            try:
                return value.decode()
            except Exception:
                return value.hex()
        if isinstance(value, (str, int, float, bool)) or value is None:
            return value
        try:
            return json.loads(json.dumps(value, default=str))
        except Exception:
            return str(value)

    return _convert(n)


def _iso(ts: int | float) -> str:
    """Return an ISO-8601 timestamp string for ``ts``."""

    import datetime

    return (
        datetime.datetime.fromtimestamp(int(ts), datetime.UTC)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _first(d, *names, default=None):
    """Return the first non-empty key from ``names`` (supports nested lookups)."""

    def _mapping_get(obj, key):
        if isinstance(obj, Mapping):
            return True, obj.get(key)
        if hasattr(obj, key):
            return True, getattr(obj, key)
        return False, None

    for name in names:
        if not name:
            continue
        path = name.split(".")
        current = d
        found = True
        for part in path:
            found, current = _mapping_get(current, part)
            if not found:
                break
        if found and current not in {None, ""}:
            return current
    return default


def _pkt_to_dict(packet) -> dict:
    """Convert packets to dictionaries for consistent downstream processing."""

    if isinstance(packet, dict):
        return packet
    if isinstance(packet, ProtoMessage):
        try:
            return MessageToDict(
                packet, preserving_proto_field_name=True, use_integers_for_enums=False
            )
        except Exception:
            pass
    if hasattr(packet, "to_dict"):
        try:
            converted = packet.to_dict()
            if isinstance(converted, Mapping):
                return dict(converted)
        except Exception:
            pass
    try:
        return json.loads(json.dumps(packet, default=_node_to_dict))
    except Exception:
        try:
            return json.loads(json.dumps(packet, default=str))
        except Exception:
            if config.DEBUG:
                config._debug_log(f"failed to convert packet to dict: {packet!r}")
            return {"_unparsed": str(packet)}


def _coerce_int(value) -> int | None:
    """Return an integer coerced from ``value`` when possible."""

    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return int(value)
    if isinstance(value, (bytes, bytearray)):
        try:
            value = value.decode()
        except Exception:
            return None
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return None
        try:
            return int(trimmed, 0)
        except ValueError:
            try:
                return int(float(trimmed))
            except Exception:
                return None
    if hasattr(value, "__int__"):
        try:
            return int(value)
        except Exception:
            return None
    return None


def _coerce_float(value) -> float | None:
    """Return a float coerced from ``value`` when possible."""

    if value is None:
        return None
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
            return None
        return float(value)
    if isinstance(value, (bytes, bytearray)):
        try:
            value = value.decode()
        except Exception:
            return None
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return None
        try:
            number = float(trimmed)
        except ValueError:
            return None
        if math.isnan(number) or math.isinf(number):
            return None
        return number
    if hasattr(value, "__float__"):
        try:
            number = float(value)
        except Exception:
            return None
        if math.isnan(number) or math.isinf(number):
            return None
        return number
    return None


def _canonical_node_id(node_id) -> str | None:
    """Return ``node_id`` normalised to the ``!xxxxxxxx`` representation."""

    if node_id is None:
        return None
    if isinstance(node_id, (bytes, bytearray)):
        try:
            node_id = node_id.decode()
        except Exception:
            return None
    if isinstance(node_id, (int, float)):
        try:
            value = int(node_id)
        except (TypeError, ValueError):
            return None
        if value < 0:
            return None
        return f"!{value & 0xFFFFFFFF:08x}"
    if not isinstance(node_id, str):
        return None

    trimmed = node_id.strip()
    if not trimmed:
        return None
    if trimmed.startswith("^"):
        return trimmed
    if trimmed.startswith("!"):
        body = trimmed[1:]
    elif trimmed.lower().startswith("0x"):
        body = trimmed[2:]
    elif trimmed.isdigit():
        try:
            return f"!{int(trimmed, 10) & 0xFFFFFFFF:08x}"
        except ValueError:
            return None
    else:
        body = trimmed

    if not body:
        return None
    try:
        return f"!{int(body, 16) & 0xFFFFFFFF:08x}"
    except ValueError:
        return None


def _node_num_from_id(node_id) -> int | None:
    """Return the numeric node reference derived from ``node_id``."""

    if node_id is None:
        return None
    if isinstance(node_id, (int, float)):
        try:
            num = int(node_id)
        except (TypeError, ValueError):
            return None
        return num if num >= 0 else None
    if not isinstance(node_id, str):
        return None

    trimmed = node_id.strip()
    if not trimmed:
        return None
    if trimmed.startswith("!"):
        trimmed = trimmed[1:]
    if trimmed.lower().startswith("0x"):
        trimmed = trimmed[2:]
    try:
        return int(trimmed, 16)
    except ValueError:
        try:
            return int(trimmed, 10)
        except ValueError:
            return None


def _merge_mappings(base, extra):
    """Recursively merge mapping ``extra`` into ``base`` without mutation."""

    if isinstance(base, Mapping):
        base_dict = dict(base)
    elif base:
        converted_base = _node_to_dict(base)
        base_dict = dict(converted_base) if isinstance(converted_base, Mapping) else {}
    else:
        base_dict = {}

    if not isinstance(extra, Mapping):
        converted_extra = _node_to_dict(extra)
        if not isinstance(converted_extra, Mapping):
            return base_dict
        extra = converted_extra

    for key, value in extra.items():
        if isinstance(value, Mapping):
            existing = base_dict.get(key)
            base_dict[key] = _merge_mappings(existing, value)
        else:
            base_dict[key] = _node_to_dict(value)
    return base_dict


def _extract_payload_bytes(decoded_section: Mapping) -> bytes | None:
    """Extract raw payload bytes from a decoded packet section."""

    if not isinstance(decoded_section, Mapping):
        return None
    payload = decoded_section.get("payload")
    if isinstance(payload, Mapping):
        data = payload.get("__bytes_b64__") or payload.get("bytes")
        if isinstance(data, str):
            try:
                return base64.b64decode(data)
            except Exception:
                return None
    if isinstance(payload, (bytes, bytearray)):
        return bytes(payload)
    if isinstance(payload, str):
        try:
            return base64.b64decode(payload)
        except Exception:
            return None
    return None


def _decode_nodeinfo_payload(payload_bytes):
    """Return a ``NodeInfo`` protobuf message parsed from ``payload_bytes``."""

    if not payload_bytes:
        return None
    try:
        from meshtastic.protobuf import mesh_pb2
    except Exception:
        return None

    node_info = mesh_pb2.NodeInfo()
    try:
        node_info.ParseFromString(payload_bytes)
        return node_info
    except DecodeError:
        try:
            user_msg = mesh_pb2.User()
            user_msg.ParseFromString(payload_bytes)
        except DecodeError:
            return None
        node_info = mesh_pb2.NodeInfo()
        node_info.user.CopyFrom(user_msg)
        return node_info


def _nodeinfo_metrics_dict(node_info) -> dict | None:
    """Convert ``NodeInfo.device_metrics`` into a JSON-friendly mapping."""

    if not node_info:
        return None
    metrics_field_names = {f[0].name for f in node_info.ListFields()}
    if "device_metrics" not in metrics_field_names:
        return None
    metrics = {}
    for field_desc, value in node_info.device_metrics.ListFields():
        name = field_desc.name
        if name == "battery_level":
            metrics["batteryLevel"] = float(value)
        elif name == "voltage":
            metrics["voltage"] = float(value)
        elif name == "channel_utilization":
            metrics["channelUtilization"] = float(value)
        elif name == "air_util_tx":
            metrics["airUtilTx"] = float(value)
        elif name == "uptime_seconds":
            metrics["uptimeSeconds"] = int(value)
    return metrics if metrics else None


def _nodeinfo_position_dict(node_info) -> dict | None:
    """Convert ``NodeInfo.position`` into a dictionary with decoded coordinates."""

    if not node_info:
        return None
    field_names = {f[0].name for f in node_info.ListFields()}
    if "position" not in field_names:
        return None
    position = {}
    for field_desc, value in node_info.position.ListFields():
        name = field_desc.name
        if name == "latitude_i":
            position["latitude"] = float(value) / 1e7
        elif name == "longitude_i":
            position["longitude"] = float(value) / 1e7
        elif name == "altitude":
            position["altitude"] = float(value)
        elif name == "time":
            position["time"] = int(value)
        elif name == "location_source":
            try:
                from meshtastic.protobuf import mesh_pb2

                position["locationSource"] = mesh_pb2.Position.LocSource.Name(value)
            except Exception:
                position["locationSource"] = value
    return position if position else None


def _nodeinfo_user_dict(node_info, decoded_user) -> dict | None:
    """Merge user details from the decoded packet and NodeInfo payload."""

    user_dict = None
    if node_info:
        field_names = {f[0].name for f in node_info.ListFields()}
        if "user" in field_names:
            try:
                user_dict = MessageToDict(
                    node_info.user,
                    preserving_proto_field_name=False,
                    use_integers_for_enums=False,
                )
            except Exception:
                user_dict = None

    if isinstance(decoded_user, ProtoMessage):
        try:
            decoded_user = MessageToDict(
                decoded_user,
                preserving_proto_field_name=False,
                use_integers_for_enums=False,
            )
        except Exception:
            decoded_user = _node_to_dict(decoded_user)

    if isinstance(decoded_user, Mapping):
        user_dict = _merge_mappings(user_dict, decoded_user)

    if isinstance(user_dict, Mapping):
        canonical = _canonical_node_id(user_dict.get("id"))
        if canonical:
            user_dict = dict(user_dict)
            user_dict["id"] = canonical
    return user_dict


__all__ = [
    "DecodeError",
    "MessageToDict",
    "ProtoMessage",
    "_canonical_node_id",
    "_coerce_float",
    "_coerce_int",
    "_decode_nodeinfo_payload",
    "_extract_payload_bytes",
    "_first",
    "_get",
    "_iso",
    "_merge_mappings",
    "_node_num_from_id",
    "_node_to_dict",
    "_nodeinfo_metrics_dict",
    "_nodeinfo_position_dict",
    "_nodeinfo_user_dict",
    "_pkt_to_dict",
]
