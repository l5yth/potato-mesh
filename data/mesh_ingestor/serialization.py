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

"""Utilities for converting Meshtastic structures into JSON-friendly forms.

The helpers normalise loosely structured Meshtastic packets so they can be
forwarded to the web application using predictable field names and types.
"""

from __future__ import annotations

import base64
import dataclasses
import enum
import importlib
import json
import math
import time
from collections.abc import Mapping

from google.protobuf.json_format import MessageToDict
from google.protobuf.message import DecodeError
from google.protobuf.message import Message as ProtoMessage

_CLI_ROLE_MODULE_NAMES: tuple[str, ...] = (
    "meshtastic.cli.common",
    "meshtastic.cli.roles",
    "meshtastic.cli.enums",
    "meshtastic_cli.common",
    "meshtastic_cli.roles",
)
"""Possible module paths that may expose the Meshtastic CLI role enum."""

_CLI_ROLE_LOOKUP: dict[int, str] | None = None
"""Cached mapping of CLI role identifiers to their textual names."""


def _get(obj, key, default=None):
    """Return ``obj[key]`` or ``getattr(obj, key)`` when available.

    Parameters:
        obj: Mapping or object supplying attributes.
        key: Name of the attribute or mapping key to retrieve.
        default: Fallback value when ``key`` is not present.

    Returns:
        The resolved value or ``default`` if the lookup fails.
    """

    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _reset_cli_role_cache() -> None:
    """Clear the cached CLI role lookup mapping.

    The helper is primarily used by tests to ensure deterministic behaviour
    when substituting stub CLI modules.

    Returns:
        ``None``. The next lookup will trigger a fresh import attempt.
    """

    global _CLI_ROLE_LOOKUP
    _CLI_ROLE_LOOKUP = None


def _load_cli_role_lookup() -> dict[int, str]:
    """Return a mapping of role identifiers from the Meshtastic CLI.

    The Meshtastic CLI exposes extended role enums that may include entries
    absent from the protobuf definition shipped with the firmware. This
    helper lazily imports the CLI module when present and extracts the
    available role names so that numeric values received from the firmware can
    be normalised into human-friendly strings.

    Returns:
        Mapping of integer role identifiers to their canonical string names.
    """

    global _CLI_ROLE_LOOKUP
    if _CLI_ROLE_LOOKUP is not None:
        return _CLI_ROLE_LOOKUP

    lookup: dict[int, str] = {}

    def _from_candidate(candidate) -> dict[int, str]:
        mapping: dict[int, str] = {}
        if isinstance(candidate, enum.EnumMeta):
            for member in candidate:  # pragma: no branch - Enum iteration deterministic
                try:
                    mapping[int(member.value)] = str(member.name)
                except Exception:  # pragma: no cover - defensive guard
                    continue
            return mapping
        members = getattr(candidate, "__members__", None)
        if isinstance(members, Mapping):
            for name, member in members.items():
                value = getattr(member, "value", None)
                if isinstance(value, (int, enum.IntEnum)):
                    try:
                        mapping[int(value)] = str(name)
                    except Exception:  # pragma: no cover - defensive
                        continue
            if mapping:
                return mapping
        if isinstance(candidate, Mapping):
            for key, value in candidate.items():
                try:
                    key_int = int(key)
                except Exception:  # pragma: no cover - defensive
                    continue
                mapping[key_int] = str(value)
        return mapping

    for module_name in _CLI_ROLE_MODULE_NAMES:
        try:
            module = importlib.import_module(module_name)
        except Exception:  # pragma: no cover - optional dependency
            continue

        candidates = []
        for attr_name in ("Role", "Roles", "ClientRole", "ClientRoles"):
            candidate = getattr(module, attr_name, None)
            if candidate is not None:
                candidates.append(candidate)

        for candidate in candidates:
            mapping = _from_candidate(candidate)
            if not mapping:
                continue
            lookup.update(mapping)
        if lookup:
            break

    _CLI_ROLE_LOOKUP = {
        key: value.strip().upper()
        for key, value in lookup.items()
        if isinstance(value, str) and value.strip()
    }
    return _CLI_ROLE_LOOKUP


def _node_to_dict(n) -> dict:
    """Convert ``n`` into a JSON-serialisable mapping.

    Parameters:
        n: Arbitrary data structure, commonly a protobuf message, dataclass or
            nested containers produced by Meshtastic.

    Returns:
        A plain dictionary containing recursively converted values.
    """

    def _convert(value):
        if isinstance(value, dict):
            return {k: _convert(v) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [_convert(v) for v in value]
        if dataclasses.is_dataclass(value):
            return {k: _convert(getattr(value, k)) for k in value.__dataclass_fields__}
        if isinstance(value, ProtoMessage):
            manual_to_dict = getattr(value, "to_dict", None)
            if callable(manual_to_dict):
                try:
                    return manual_to_dict()
                except Exception:
                    pass
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


def _normalize_user_role(value) -> str | None:
    """Return a canonical role string for ``value`` when possible.

    Parameters:
        value: Raw role descriptor emitted by the Meshtastic firmware or
            decoded JSON payloads.

    Returns:
        Uppercase role string or ``None`` if the value cannot be resolved.
    """

    if value is None:
        return None

    if isinstance(value, str):
        cleaned = value.strip()
        if not cleaned:
            return None
        return cleaned.upper()

    numeric = _coerce_int(value)
    if numeric is None:
        return None

    role_name = None

    cli_lookup = _load_cli_role_lookup()
    role_name = cli_lookup.get(numeric)

    if not role_name:
        try:  # pragma: no branch - minimal control flow
            from meshtastic.protobuf import mesh_pb2

            role_name = mesh_pb2.User.Role.Name(numeric)
        except Exception:  # pragma: no cover - depends on protobuf version
            role_name = None

    if not role_name:
        try:
            from meshtastic.protobuf import config_pb2

            role_name = config_pb2.Config.DeviceConfig.Role.Name(numeric)
        except Exception:  # pragma: no cover - depends on protobuf version
            role_name = None

    if role_name:
        return role_name.strip().upper()

    return str(numeric)


def upsert_payload(node_id, node) -> dict:
    """Return the payload expected by ``/api/nodes`` upsert requests.

    Parameters:
        node_id: Canonical node identifier.
        node: Node representation to convert with :func:`_node_to_dict`.

    Returns:
        A mapping keyed by ``node_id`` describing the node.
    """

    ndict = _node_to_dict(node)
    return {node_id: ndict}


def _iso(ts: int | float) -> str:
    """Convert ``ts`` into an ISO-8601 timestamp in UTC."""

    import datetime

    return (
        datetime.datetime.fromtimestamp(int(ts), datetime.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _first(d, *names, default=None):
    """Return the first matching attribute or key from ``d``.

    Parameters:
        d: Mapping or object providing nested attributes.
        *names: Candidate names, optionally using ``dot.separated`` notation
            for nested lookups.
        default: Value returned when no candidates succeed.

    Returns:
        The first non-empty value encountered or ``default``.
    """

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
    """Best-effort conversion of ``value`` to an integer.

    Parameters:
        value: Any type supported by Meshtastic payloads.

    Returns:
        An integer or ``None`` when conversion is not possible.
    """

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
    """Best-effort conversion of ``value`` to a float.

    Parameters:
        value: Any type supported by Meshtastic payloads.

    Returns:
        A float or ``None`` when conversion fails or results in ``NaN``.
    """

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
    """Normalise a packet into a plain dictionary.

    Parameters:
        packet: Packet object or mapping emitted by Meshtastic.

    Returns:
        A dictionary representation suitable for downstream processing.
    """

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
    """Convert node identifiers into the canonical ``!xxxxxxxx`` format.

    Parameters:
        value: Input identifier which may be an int, float or string.

    Returns:
        The canonical identifier or ``None`` if conversion fails.
    """

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
    """Extract the numeric node ID from a canonical identifier.

    Parameters:
        node_id: Identifier value accepted by :func:`_canonical_node_id`.

    Returns:
        The numeric node ID or ``None`` when parsing fails.
    """

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
    """Merge two mapping-like objects recursively.

    Parameters:
        base: Existing mapping or mapping-like structure.
        extra: Mapping or compatible object whose entries should overlay
            ``base``.

    Returns:
        A new dictionary containing the merged values.
    """

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
    """Return raw payload bytes from ``decoded_section`` when available.

    Parameters:
        decoded_section: Mapping that may include a ``payload`` entry.

    Returns:
        Raw payload bytes or ``None`` when the payload is missing or invalid.
    """

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
    """Decode ``NodeInfo`` protobuf payloads from raw bytes.

    Parameters:
        payload_bytes: Serialized protobuf data from a NODEINFO packet.

    Returns:
        A :class:`meshtastic.protobuf.mesh_pb2.NodeInfo` instance or ``None``.
    """

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
    """Extract device metric fields from a NodeInfo message.

    Parameters:
        node_info: Parsed NodeInfo protobuf message.

    Returns:
        A dictionary containing selected metric fields, or ``None`` when no
        metrics are present.
    """

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
    """Return a dictionary view of positional data from NodeInfo.

    Parameters:
        node_info: Parsed NodeInfo protobuf message.

    Returns:
        A dictionary of positional fields or ``None`` if no data exists.
    """

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
    """Combine protobuf and decoded user information into a mapping.

    Parameters:
        node_info: Parsed NodeInfo protobuf message that may contain a ``user``
            field.
        decoded_user: Mapping or protobuf message representing decoded user
            data from the packet payload.

    Returns:
        A merged mapping of user information or ``None`` when no data exists.
    """

    user_dict = None
    if node_info:
        field_names = {f[0].name for f in node_info.ListFields()}
        if "user" in field_names:
            manual_to_dict = getattr(node_info.user, "to_dict", None)
            if callable(manual_to_dict):
                try:
                    user_dict = manual_to_dict()
                except Exception:
                    user_dict = None
            try:
                user_dict = MessageToDict(
                    node_info.user,
                    preserving_proto_field_name=False,
                    use_integers_for_enums=False,
                )
            except Exception:
                user_dict = _node_to_dict(node_info.user)
            if user_dict is None and callable(manual_to_dict):
                try:
                    user_dict = manual_to_dict()
                except Exception:
                    user_dict = None

    if isinstance(decoded_user, ProtoMessage):
        manual_to_dict = getattr(decoded_user, "to_dict", None)
        if callable(manual_to_dict):
            try:
                decoded_user = manual_to_dict()
            except Exception:
                decoded_user = decoded_user
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
        role_value = user_dict.get("role")
        normalized_role = _normalize_user_role(role_value)
        if normalized_role and normalized_role != role_value:
            user_dict = dict(user_dict)
            user_dict["role"] = normalized_role
    return user_dict


__all__ = [
    "_canonical_node_id",
    "_coerce_float",
    "_coerce_int",
    "_load_cli_role_lookup",
    "_normalize_user_role",
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
    "_reset_cli_role_cache",
    "DecodeError",
    "MessageToDict",
    "ProtoMessage",
    "upsert_payload",
]
