"""Utilities for converting Meshtastic structures into JSON-friendly forms."""

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


def _get(obj, key, default=None):
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _node_to_dict(n) -> dict:
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


def upsert_payload(node_id, node) -> dict:
    ndict = _node_to_dict(node)
    return {node_id: ndict}


def _iso(ts: int | float) -> str:
    import datetime

    return (
        datetime.datetime.fromtimestamp(int(ts), datetime.UTC)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _first(d, *names, default=None):
    def _mapping_get(obj, key):
        if isinstance(obj, Mapping) and key in obj:
            return True, obj[key]
        if hasattr(obj, "__getitem__"):
            try:
                return True, obj[key]
            except Exception:
                pass
        if hasattr(obj, key):
            return True, getattr(obj, key)
        return False, None

    for name in names:
        cur = d
        ok = True
        for part in name.split("."):
            ok, cur = _mapping_get(cur, part)
            if not ok:
                break
        if ok:
            if cur is None:
                continue
            if isinstance(cur, str) and cur == "":
                continue
            return cur
    return default


def _coerce_int(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if math.isfinite(value) else None
    if isinstance(value, (str, bytes, bytearray)):
        text = value.decode() if isinstance(value, (bytes, bytearray)) else value
        stripped = text.strip()
        if not stripped:
            return None
        try:
            if stripped.lower().startswith("0x"):
                return int(stripped, 16)
            return int(stripped, 10)
        except ValueError:
            try:
                return int(float(stripped))
            except ValueError:
                return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _coerce_float(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        result = float(value)
        return result if math.isfinite(result) else None
    if isinstance(value, (str, bytes, bytearray)):
        text = value.decode() if isinstance(value, (bytes, bytearray)) else value
        stripped = text.strip()
        if not stripped:
            return None
        try:
            result = float(stripped)
        except ValueError:
            return None
        return result if math.isfinite(result) else None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _pkt_to_dict(packet) -> dict:
    if isinstance(packet, dict):
        return packet
    if isinstance(packet, ProtoMessage):
        try:
            return MessageToDict(
                packet, preserving_proto_field_name=True, use_integers_for_enums=False
            )
        except Exception:
            if hasattr(packet, "to_dict"):
                try:
                    return packet.to_dict()
                except Exception:
                    pass
    try:
        return json.loads(json.dumps(packet, default=lambda o: str(o)))
    except Exception:
        return {"_unparsed": str(packet)}


def _canonical_node_id(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            num = int(value)
        except (TypeError, ValueError):
            return None
        if num < 0:
            return None
        return f"!{num & 0xFFFFFFFF:08x}"
    if not isinstance(value, str):
        return None

    trimmed = value.strip()
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
    base_dict: dict
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
        elif name == "humidity":
            metrics["humidity"] = float(value)
        elif name == "temperature":
            metrics["temperature"] = float(value)
        elif name == "barometric_pressure":
            metrics["barometricPressure"] = float(value)
    return metrics or None


def _nodeinfo_position_dict(node_info) -> dict | None:
    if not node_info:
        return None
    fields = {f[0].name for f in node_info.ListFields()}
    if "position" not in fields:
        return None

    result = {}
    latitude_i = None
    longitude_i = None

    for field_desc, value in node_info.position.ListFields():
        name = field_desc.name
        if name == "latitude_i":
            latitude_i = int(value)
            result["latitudeI"] = latitude_i
        elif name == "longitude_i":
            longitude_i = int(value)
            result["longitudeI"] = longitude_i
        elif name == "latitude":
            result["latitude"] = float(value)
        elif name == "longitude":
            result["longitude"] = float(value)
        elif name == "altitude":
            result["altitude"] = int(value)
        elif name == "time":
            result["time"] = int(value)
        elif name == "ground_speed":
            result["groundSpeed"] = float(value)
        elif name == "ground_track":
            result["groundTrack"] = float(value)
        elif name == "precision_bits":
            result["precisionBits"] = int(value)
        elif name == "location_source":
            # Preserve the raw enum value to allow downstream formatting.
            result["locationSource"] = int(value)

    if "latitude" not in result and latitude_i is not None:
        result["latitude"] = latitude_i / 1e7
    if "longitude" not in result and longitude_i is not None:
        result["longitude"] = longitude_i / 1e7

    return result or None


def _nodeinfo_user_dict(node_info, decoded_user):
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
    "DecodeError",
    "MessageToDict",
    "ProtoMessage",
    "upsert_payload",
]
