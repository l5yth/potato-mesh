#!/usr/bin/env python3

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

"""Mesh daemon helpers for synchronising Meshtastic data.

This module wraps the Meshtastic serial interface and exposes helper
functions that serialise nodes and text messages to JSON before forwarding
them to the accompanying web API.  It also provides the long-running daemon
entry point that performs these synchronisation tasks.
"""

import base64
import dataclasses
import glob
import heapq
import ipaddress
import itertools
import json
import math
import os
import re
import signal
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from functools import lru_cache
from typing import TYPE_CHECKING

from meshtastic.serial_interface import SerialInterface
from meshtastic.tcp_interface import TCPInterface
from pubsub import pub
from google.protobuf.json_format import MessageToDict
from google.protobuf.message import Message as ProtoMessage
from google.protobuf.message import DecodeError

if TYPE_CHECKING:  # pragma: no cover - import only used for type checking
    from meshtastic.ble_interface import BLEInterface as _BLEInterface

# Exposed for tests and backward compatibility; resolved lazily in
# :func:`_load_ble_interface` so importing this module does not require the BLE
# extras to be installed.
BLEInterface = None

# --- Config (env overrides) ---------------------------------------------------
PORT = os.environ.get("MESH_SERIAL")
SNAPSHOT_SECS = int(os.environ.get("MESH_SNAPSHOT_SECS", "60"))
CHANNEL_INDEX = int(os.environ.get("MESH_CHANNEL_INDEX", "0"))
DEBUG = os.environ.get("DEBUG") == "1"
INSTANCE = os.environ.get("POTATOMESH_INSTANCE", "").rstrip("/")
API_TOKEN = os.environ.get("API_TOKEN", "")


# --- Serial interface helpers --------------------------------------------------


_DEFAULT_TCP_PORT = 4403
_DEFAULT_TCP_TARGET = "http://127.0.0.1"

_DEFAULT_SERIAL_PATTERNS = (
    "/dev/ttyACM*",
    "/dev/ttyUSB*",
    "/dev/tty.usbmodem*",
    "/dev/tty.usbserial*",
    "/dev/cu.usbmodem*",
    "/dev/cu.usbserial*",
)

_BLE_ADDRESS_RE = re.compile(r"^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$")


def _debug_log(message: str):
    """Print ``message`` with a UTC timestamp when ``DEBUG`` is enabled."""

    if not DEBUG:
        return

    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(f"[{timestamp}] [debug] {message}")


# Reconnect configuration: retry delays are adjustable via environment
# variables to ease testing while keeping sensible defaults in production.
_RECONNECT_INITIAL_DELAY_SECS = float(os.environ.get("MESH_RECONNECT_INITIAL", "5"))
_RECONNECT_MAX_DELAY_SECS = float(os.environ.get("MESH_RECONNECT_MAX", "60"))
_CLOSE_TIMEOUT_SECS = float(os.environ.get("MESH_CLOSE_TIMEOUT", "5"))


class _DummySerialInterface:
    """In-memory replacement for ``meshtastic.serial_interface.SerialInterface``.

    The GitHub Actions release tests run the ingestor container without access
    to a serial device.  When ``MESH_SERIAL`` is set to ``"mock"`` (or similar)
    we provide this stub interface so the daemon can start and exercise its
    background loop without failing due to missing hardware.
    """

    def __init__(self):
        self.nodes = {}

    def close(self):
        """Mirror the real interface API."""
        pass


def _parse_ble_target(value: str) -> str | None:
    """Return an uppercase BLE MAC address when ``value`` matches the format."""

    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    if _BLE_ADDRESS_RE.fullmatch(value):
        return value.upper()
    return None


def _parse_network_target(value: str) -> tuple[str, int] | None:
    """Return ``(host, port)`` when ``value`` is an IP address string.

    The ingestor accepts values such as ``192.168.1.10`` or
    ``tcp://192.168.1.10:4500`` for ``MESH_SERIAL`` to support Meshtastic
    devices shared via TCP.  Serial device paths (``/dev/ttyACM0``) are ignored
    by returning ``None``.
    """

    if not value:
        return None

    value = value.strip()
    if not value:
        return None

    def _validated_result(host: str | None, port: int | None):
        if not host:
            return None
        try:
            ipaddress.ip_address(host)
        except ValueError:
            return None
        return host, port or _DEFAULT_TCP_PORT

    parsed_values = []
    if "://" in value:
        parsed_values.append(urllib.parse.urlparse(value, scheme="tcp"))
    parsed_values.append(urllib.parse.urlparse(f"//{value}", scheme="tcp"))

    for parsed in parsed_values:
        try:
            port = parsed.port
        except ValueError:
            port = None
        result = _validated_result(parsed.hostname, port)
        if result:
            return result

    if value.count(":") == 1 and not value.startswith("["):
        host, _, port_text = value.partition(":")
        try:
            port = int(port_text) if port_text else None
        except ValueError:
            port = None
        result = _validated_result(host, port)
        if result:
            return result

    return _validated_result(value, None)


@lru_cache(maxsize=1)
def _load_ble_interface():
    """Return :class:`meshtastic.ble_interface.BLEInterface` when available."""

    global BLEInterface
    if BLEInterface is not None:
        return BLEInterface

    try:
        from meshtastic.ble_interface import BLEInterface as _resolved_interface
    except ImportError as exc:  # pragma: no cover - exercised in non-BLE envs
        raise RuntimeError(
            "BLE interface requested but the Meshtastic BLE dependencies are not installed. "
            "Install the 'meshtastic[ble]' extra to enable BLE support."
        ) from exc
    BLEInterface = _resolved_interface
    return _resolved_interface


def _create_serial_interface(port: str) -> tuple[object, str]:
    """Return an appropriate mesh interface for ``port``.

    Passing ``mock`` (case-insensitive) or an empty value skips hardware access
    and returns :class:`_DummySerialInterface`.  This makes it possible to run
    the container in CI environments that do not expose serial devices while
    keeping production behaviour unchanged.
    """

    port_value = (port or "").strip()
    if port_value.lower() in {"", "mock", "none", "null", "disabled"}:
        _debug_log(f"using dummy serial interface for port={port_value!r}")
        return _DummySerialInterface(), "mock"
    ble_target = _parse_ble_target(port_value)
    if ble_target:
        _debug_log(f"using BLE interface for address={ble_target}")
        return _load_ble_interface()(address=ble_target), ble_target
    network_target = _parse_network_target(port_value)
    if network_target:
        host, tcp_port = network_target
        _debug_log(f"using TCP interface for host={host!r} port={tcp_port!r}")
        return (
            TCPInterface(hostname=host, portNumber=tcp_port),
            f"tcp://{host}:{tcp_port}",
        )
    _debug_log(f"using serial interface for port={port_value!r}")
    return SerialInterface(devPath=port_value), port_value


class NoAvailableMeshInterface(RuntimeError):
    """Raised when no default mesh interface can be created."""


def _default_serial_targets() -> list[str]:
    """Return a list of candidate serial device paths for auto-discovery."""

    candidates: list[str] = []
    seen: set[str] = set()
    for pattern in _DEFAULT_SERIAL_PATTERNS:
        for path in sorted(glob.glob(pattern)):
            if path not in seen:
                candidates.append(path)
                seen.add(path)
    if "/dev/ttyACM0" not in seen:
        candidates.append("/dev/ttyACM0")
    return candidates


def _create_default_interface() -> tuple[object, str]:
    """Attempt to create the default mesh interface, raising on failure."""

    errors: list[tuple[str, Exception]] = []
    for candidate in _default_serial_targets():
        try:
            return _create_serial_interface(candidate)
        except Exception as exc:  # pragma: no cover - hardware dependent
            errors.append((candidate, exc))
            _debug_log(f"failed to open serial candidate {candidate!r}: {exc}")
    try:
        return _create_serial_interface(_DEFAULT_TCP_TARGET)
    except Exception as exc:  # pragma: no cover - network dependent
        errors.append((_DEFAULT_TCP_TARGET, exc))
        _debug_log(f"failed to open TCP fallback {_DEFAULT_TCP_TARGET!r}: {exc}")
    if errors:
        summary = "; ".join(f"{target}: {error}" for target, error in errors)
        raise NoAvailableMeshInterface(
            f"no mesh interface available ({summary})"
        ) from errors[-1][1]
    raise NoAvailableMeshInterface("no mesh interface available")


# --- POST queue ----------------------------------------------------------------
_POST_QUEUE_LOCK = threading.Lock()
_POST_QUEUE = []
_POST_QUEUE_COUNTER = itertools.count()
_POST_QUEUE_ACTIVE = False

_MESSAGE_POST_PRIORITY = 0
_POSITION_POST_PRIORITY = 10
_NEIGHBOR_POST_PRIORITY = 12
_TELEMETRY_POST_PRIORITY = 15
_NODE_POST_PRIORITY = 20
_DEFAULT_POST_PRIORITY = 50

_RECEIVE_TOPICS = (
    "meshtastic.receive",
    "meshtastic.receive.text",
    "meshtastic.receive.position",
    "meshtastic.receive.POSITION_APP",
    "meshtastic.receive.user",
    "meshtastic.receive.NODEINFO_APP",
)


def _get(obj, key, default=None):
    """Return a key or attribute value from ``obj``.

    Args:
        obj: Mapping or object containing the desired value.
        key: Key or attribute name to look up.
        default: Value returned when the key is missing.

    Returns:
        The resolved value if present, otherwise ``default``.
    """
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


# --- HTTP helpers -------------------------------------------------------------
def _post_json(path: str, payload: dict):
    """Send a JSON payload to the configured web API.

    Args:
        path: API path relative to the configured ``INSTANCE``.
        payload: Mapping serialised to JSON for the request body.
    """

    if not INSTANCE:
        return
    url = f"{INSTANCE}{path}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}
    )
    if API_TOKEN:
        req.add_header("Authorization", f"Bearer {API_TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except Exception as e:
        _debug_log(f"[warn] POST {url} failed: {e}")


def _enqueue_post_json(path: str, payload: dict, priority: int):
    """Store a POST request in the priority queue."""

    with _POST_QUEUE_LOCK:
        heapq.heappush(
            _POST_QUEUE, (priority, next(_POST_QUEUE_COUNTER), path, payload)
        )


def _drain_post_queue():
    """Process queued POST requests in priority order."""

    global _POST_QUEUE_ACTIVE
    while True:
        with _POST_QUEUE_LOCK:
            if not _POST_QUEUE:
                _POST_QUEUE_ACTIVE = False
                return
            _priority, _idx, path, payload = heapq.heappop(_POST_QUEUE)
        _post_json(path, payload)


def _queue_post_json(
    path: str, payload: dict, *, priority: int = _DEFAULT_POST_PRIORITY
):
    """Queue a POST request and start processing if idle."""

    global _POST_QUEUE_ACTIVE
    _enqueue_post_json(path, payload, priority)
    with _POST_QUEUE_LOCK:
        if _POST_QUEUE_ACTIVE:
            return
        _POST_QUEUE_ACTIVE = True
    _drain_post_queue()


def _clear_post_queue():
    """Clear the pending POST queue (used by tests)."""

    global _POST_QUEUE_ACTIVE
    with _POST_QUEUE_LOCK:
        _POST_QUEUE.clear()
        _POST_QUEUE_ACTIVE = False


# --- Node upsert --------------------------------------------------------------
def _node_to_dict(n) -> dict:
    """Convert Meshtastic node or user structures into plain dictionaries.

    Args:
        n: ``dict``, dataclass or protobuf message describing a node or user.

    Returns:
        JSON serialisable representation of ``n``.
    """

    def _convert(value):
        """Recursively convert dataclasses and protobuf messages."""
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


def upsert_node(node_id, n):
    """Forward a node snapshot to the web API.

    Args:
        node_id: Unique identifier of the node in the mesh.
        n: Node object obtained from the Meshtastic serial interface.
    """

    ndict = _node_to_dict(n)
    _queue_post_json("/api/nodes", {node_id: ndict}, priority=_NODE_POST_PRIORITY)

    if DEBUG:
        user = _get(ndict, "user") or {}
        short = _get(user, "shortName")
        long = _get(user, "longName")
        _debug_log(f"upserted node {node_id} shortName={short!r} longName={long!r}")


# --- Message logging via PubSub -----------------------------------------------
def _iso(ts: int | float) -> str:
    """Return an ISO-8601 timestamp string for ``ts``.

    Args:
        ts: POSIX timestamp as ``int`` or ``float``.

    Returns:
        Timestamp formatted with a trailing ``Z`` to denote UTC.
    """

    import datetime

    return (
        datetime.datetime.fromtimestamp(int(ts), datetime.UTC)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _first(d, *names, default=None):
    """Return the first non-empty key from ``names`` (supports nested lookups).

    Keys that resolve to ``None`` or an empty string are skipped so callers can
    provide multiple potential field names without accidentally capturing an
    explicit ``null`` value.

    Args:
        d: Mapping or object to query.
        *names: Candidate field names using dotted paths for nesting.
        default: Value returned when all candidates are missing.

    Returns:
        The first matching value or ``default`` if none resolve to content.
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
    """Return ``value`` converted to ``int`` when possible."""

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
    """Return ``value`` converted to ``float`` when possible."""

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
    """Normalise a received packet into a JSON-friendly dictionary.

    Args:
        packet: Protobuf ``MeshPacket`` or dictionary received from the daemon.

    Returns:
        Packet data ready for JSON serialisation.
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
    # Last resort: try to read attributes
    try:
        return json.loads(json.dumps(packet, default=lambda o: str(o)))
    except Exception:
        return {"_unparsed": str(packet)}


def _canonical_node_id(value) -> str | None:
    """Normalise node identifiers to the canonical ``!deadbeef`` form."""

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
                from google.protobuf.json_format import MessageToDict

                user_dict = MessageToDict(
                    node_info.user,
                    preserving_proto_field_name=False,
                    use_integers_for_enums=False,
                )
            except Exception:
                user_dict = None

    if isinstance(decoded_user, ProtoMessage):
        try:
            from google.protobuf.json_format import MessageToDict

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


def store_position_packet(packet: dict, decoded: Mapping):
    """Handle ``POSITION_APP`` packets and forward them to ``/api/positions``."""

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
    payload_b64 = (
        base64.b64encode(payload_bytes).decode("ascii") if payload_bytes else None
    )

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
        "node_id": node_id or raw_from,
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
        "/api/positions", position_payload, priority=_POSITION_POST_PRIORITY
    )

    if DEBUG:
        _debug_log(f"stored position for {node_id} lat={latitude!r} lon={longitude!r}")


def store_telemetry_packet(packet: dict, decoded: Mapping):
    """Handle ``TELEMETRY_APP`` packets and forward them to ``/api/telemetry``."""

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

    bitfield = _coerce_int(_first(decoded, "bitfield", default=None))
    snr = _coerce_float(_first(packet, "snr", "rx_snr", "rxSnr", default=None))
    rssi = _coerce_int(_first(packet, "rssi", "rx_rssi", "rxRssi", default=None))
    hop_limit = _coerce_int(_first(packet, "hopLimit", "hop_limit", default=None))

    portnum_raw = _first(decoded, "portnum", default=None)
    portnum = str(portnum_raw) if portnum_raw is not None else None

    payload_bytes = _extract_payload_bytes(decoded)
    payload_b64 = (
        base64.b64encode(payload_bytes).decode("ascii") if payload_bytes else None
    )

    device_metrics_section = telemetry_section.get(
        "deviceMetrics"
    ) or telemetry_section.get("device_metrics")
    device_metrics = (
        _node_to_dict(device_metrics_section)
        if isinstance(device_metrics_section, Mapping)
        else None
    )

    environment_section = telemetry_section.get(
        "environmentMetrics"
    ) or telemetry_section.get("environment_metrics")
    environment_metrics = (
        _node_to_dict(environment_section)
        if isinstance(environment_section, Mapping)
        else None
    )

    metrics_lookup = lambda mapping, *names: _first(mapping or {}, *names, default=None)

    battery_level = _coerce_float(
        metrics_lookup(device_metrics, "batteryLevel", "battery_level")
    )
    voltage = _coerce_float(metrics_lookup(device_metrics, "voltage"))
    channel_utilization = _coerce_float(
        metrics_lookup(device_metrics, "channelUtilization", "channel_utilization")
    )
    air_util_tx = _coerce_float(
        metrics_lookup(device_metrics, "airUtilTx", "air_util_tx")
    )
    uptime_seconds = _coerce_int(
        metrics_lookup(device_metrics, "uptimeSeconds", "uptime_seconds")
    )

    temperature = _coerce_float(
        metrics_lookup(
            environment_metrics,
            "temperature",
            "temperatureC",
            "temperature_c",
            "tempC",
        )
    )
    relative_humidity = _coerce_float(
        metrics_lookup(
            environment_metrics,
            "relativeHumidity",
            "relative_humidity",
            "humidity",
        )
    )
    barometric_pressure = _coerce_float(
        metrics_lookup(
            environment_metrics,
            "barometricPressure",
            "barometric_pressure",
            "pressure",
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
        "/api/telemetry", telemetry_payload, priority=_TELEMETRY_POST_PRIORITY
    )

    if DEBUG:
        _debug_log(
            f"stored telemetry for {node_id!r} battery={battery_level!r} voltage={voltage!r}"
        )


def store_nodeinfo_packet(packet: dict, decoded: Mapping):
    """Handle ``NODEINFO_APP`` packets and forward them to ``/api/nodes``."""

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

    node_payload = {}
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
        "/api/nodes", {node_id: node_payload}, priority=_NODE_POST_PRIORITY
    )

    if DEBUG:
        short = None
        if isinstance(user_dict, Mapping):
            short = user_dict.get("shortName")
            long = user_dict.get("longName")
        else:
            long = None
        _debug_log(
            f"stored nodeinfo for {node_id} shortName={short!r} longName={long!r}"
        )


def store_neighborinfo_packet(packet: dict, decoded: Mapping):
    """Handle ``NEIGHBORINFO_APP`` packets for mesh health broadcasts."""

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
            }
        )

    payload: dict[str, object] = {
        "node_id": node_id,
        "node_num": node_num,
        "rx_time": rx_time,
    }
    if neighbor_entries:
        payload["neighbors"] = neighbor_entries

    broadcast_interval = _coerce_int(
        _first(neighbor_section, "nodeBroadcastIntervalSecs", default=None)
    )
    if broadcast_interval is not None:
        payload["node_broadcast_interval_secs"] = broadcast_interval

    last_sent_by = _canonical_node_id(
        _first(neighbor_section, "lastSentById", "last_sent_by_id", default=None)
    )
    if last_sent_by is not None:
        payload["last_sent_by_id"] = last_sent_by

    _queue_post_json("/api/neighbors", payload, priority=_NEIGHBOR_POST_PRIORITY)

    if DEBUG:
        _debug_log(
            f"stored neighborinfo for {node_id} neighbors={len(neighbor_entries)}"
        )


def store_packet_dict(p: dict):
    """Persist packets extracted from a decoded payload.

    Node information packets are forwarded to the ``/api/nodes`` endpoint
    while text messages from the ``TEXT_MESSAGE_APP`` port continue to be
    stored via ``/api/messages``. Field lookups tolerate camelCase and
    snake_case variants for compatibility across Meshtastic releases.

    Args:
        p: Packet dictionary produced by ``_pkt_to_dict``.
    """
    dec = p.get("decoded") or {}

    portnum_raw = _first(dec, "portnum", default=None)
    portnum = str(portnum_raw).upper() if portnum_raw is not None else None
    portnum_int = _coerce_int(portnum_raw)

    telemetry_section = dec.get("telemetry") if isinstance(dec, Mapping) else None
    if (
        portnum == "TELEMETRY_APP"
        or portnum_int == 65
        or isinstance(telemetry_section, Mapping)
    ):
        store_telemetry_packet(p, dec)
        return

    if portnum in {"5", "NODEINFO_APP"}:
        store_nodeinfo_packet(p, dec)
        return

    if portnum in {"4", "POSITION_APP"}:
        store_position_packet(p, dec)
        return

    neighborinfo_section = dec.get("neighborinfo") if isinstance(dec, Mapping) else None
    if portnum == "NEIGHBORINFO_APP" or isinstance(neighborinfo_section, Mapping):
        store_neighborinfo_packet(p, dec)
        return

    text = _first(dec, "payload.text", "text", default=None)
    encrypted = _first(dec, "payload.encrypted", "encrypted", default=None)
    if encrypted is None:
        encrypted = _first(p, "encrypted", default=None)
    if not text and not encrypted:
        return  # ignore packets that lack text and encrypted payloads

    # port filter: only keep packets from the TEXT_MESSAGE_APP port
    if portnum and portnum not in {"1", "TEXT_MESSAGE_APP"}:
        return  # ignore non-text-message ports

    # channel (prefer decoded.channel if present; else top-level)
    ch = _first(dec, "channel", default=None)
    if ch is None:
        ch = _first(p, "channel", default=0)
    try:
        ch = int(ch)
    except Exception:
        ch = 0

    # timestamps & ids
    pkt_id = _first(p, "id", "packet_id", "packetId", default=None)
    if pkt_id is None:
        return  # ignore packets without an id
    rx_time = int(_first(p, "rxTime", "rx_time", default=time.time()))
    from_id = _first(p, "fromId", "from_id", "from", default=None)
    to_id = _first(p, "toId", "to_id", "to", default=None)

    if (from_id is None or str(from_id) == "") and DEBUG:
        try:
            raw = json.dumps(p, default=str)
        except Exception:
            raw = str(p)
        _debug_log(f"packet missing from_id: {raw}")

    # link metrics
    snr = _first(p, "snr", "rx_snr", "rxSnr", default=None)
    rssi = _first(p, "rssi", "rx_rssi", "rxRssi", default=None)
    hop = _first(p, "hopLimit", "hop_limit", default=None)

    msg = {
        "id": int(pkt_id),
        "rx_time": rx_time,
        "rx_iso": _iso(rx_time),
        "from_id": from_id,
        "to_id": to_id,
        "channel": ch,
        "portnum": str(portnum) if portnum is not None else None,
        "text": text,
        "encrypted": encrypted,
        "snr": float(snr) if snr is not None else None,
        "rssi": int(rssi) if rssi is not None else None,
        "hop_limit": int(hop) if hop is not None else None,
    }
    _queue_post_json("/api/messages", msg, priority=_MESSAGE_POST_PRIORITY)

    if DEBUG:
        from_label = _canonical_node_id(from_id) or from_id
        to_label = _canonical_node_id(to_id) or to_id
        if text is None and encrypted:
            payload = "Encrypted"
        else:
            payload = text
        _debug_log(
            f"stored message from {from_label!r} to {to_label!r} ch={ch} text={payload!r}"
        )


# PubSub receive handler
def on_receive(packet, interface):
    """PubSub callback that stores inbound text messages.

    Args:
        packet: Packet received from the Meshtastic interface.
        interface: Serial interface instance (unused).
    """

    if isinstance(packet, dict):
        if packet.get("_potatomesh_seen"):
            return
        packet["_potatomesh_seen"] = True

    p = None
    try:
        p = _pkt_to_dict(packet)
        store_packet_dict(p)
    except Exception as e:
        info = list(p.keys()) if isinstance(p, dict) else type(packet)
        print(f"[warn] failed to store packet: {e} | info: {info}")


def _subscribe_receive_topics() -> list[str]:
    """Subscribe ``on_receive`` to relevant PubSub topics."""

    subscribed = []
    for topic in _RECEIVE_TOPICS:
        try:
            pub.subscribe(on_receive, topic)
            subscribed.append(topic)
        except Exception as exc:  # pragma: no cover - pub may raise in prod only
            _debug_log(f"failed to subscribe to {topic!r}: {exc}")
    return subscribed


# --- Main ---------------------------------------------------------------------
def _node_items_snapshot(nodes_obj, retries: int = 3):
    """Return a snapshot list of ``(node_id, node)`` pairs.

    The Meshtastic ``SerialInterface`` updates ``iface.nodes`` from another
    thread. When that happens during iteration Python raises ``RuntimeError``.
    To keep the daemon quiet we retry a few times and, if it keeps changing,
    bail out for this loop.

    Args:
        nodes_obj: Container mapping node IDs to node objects.
        retries: Number of attempts performed before giving up.

    Returns:
        Snapshot of node entries or ``None`` when retries were exhausted because
        the container kept mutating.
    """

    if not nodes_obj:
        return []

    items_callable = getattr(nodes_obj, "items", None)
    if callable(items_callable):
        for _ in range(max(1, retries)):
            try:
                return list(items_callable())
            except RuntimeError as err:
                if "dictionary changed size during iteration" not in str(err):
                    raise
                time.sleep(0)
        return None

    if hasattr(nodes_obj, "__iter__") and hasattr(nodes_obj, "__getitem__"):
        for _ in range(max(1, retries)):
            try:
                keys = list(nodes_obj)
                return [(k, nodes_obj[k]) for k in keys]
            except RuntimeError as err:
                if "dictionary changed size during iteration" not in str(err):
                    raise
                time.sleep(0)
        return None

    return []


def main():
    """Run the mesh synchronisation daemon."""

    # Subscribe to PubSub topics (reliable in current meshtastic)
    subscribed = _subscribe_receive_topics()
    if DEBUG and subscribed:
        _debug_log(f"subscribed to receive topics: {', '.join(subscribed)}")

    def _close_interface(iface_obj):
        if iface_obj is None:
            return

        def _do_close():
            try:
                iface_obj.close()
            except Exception as exc:
                if DEBUG:
                    _debug_log(f"error while closing mesh interface: {exc}")

        if _CLOSE_TIMEOUT_SECS <= 0:
            _do_close()
            return

        close_thread = threading.Thread(
            target=_do_close, name="mesh-close", daemon=True
        )
        close_thread.start()
        close_thread.join(_CLOSE_TIMEOUT_SECS)
        if close_thread.is_alive():
            print(
                "[warn] mesh interface did not close within "
                f"{_CLOSE_TIMEOUT_SECS:g}s; continuing shutdown"
            )

    iface = None
    resolved_target = None
    retry_delay = max(0.0, _RECONNECT_INITIAL_DELAY_SECS)

    stop = threading.Event()
    initial_snapshot_sent = False

    def handle_sigterm(*_):
        """Stop the daemon when a termination signal is received."""

        stop.set()

    def handle_sigint(signum, frame):
        """Handle ``SIGINT`` by requesting shutdown and escalating on repeat."""

        if stop.is_set():
            signal.default_int_handler(signum, frame)
            return

        stop.set()

    signal.signal(signal.SIGINT, handle_sigint)
    signal.signal(signal.SIGTERM, handle_sigterm)

    target = INSTANCE or "(no POTATOMESH_INSTANCE)"
    configured_port = PORT
    active_candidate = configured_port
    announced_target = False
    print(
        f"Mesh daemon: nodes+messages → {target} | port={configured_port or 'auto'} | channel={CHANNEL_INDEX}"
    )
    try:
        while not stop.is_set():
            if iface is None:
                try:
                    if active_candidate:
                        iface, resolved_target = _create_serial_interface(
                            active_candidate
                        )
                    else:
                        iface, resolved_target = _create_default_interface()
                        active_candidate = resolved_target
                    retry_delay = max(0.0, _RECONNECT_INITIAL_DELAY_SECS)
                    initial_snapshot_sent = False
                    if not announced_target and resolved_target:
                        print(f"[info] using mesh interface: {resolved_target}")
                        announced_target = True
                except NoAvailableMeshInterface as exc:
                    print(f"[error] {exc}")
                    _close_interface(iface)
                    raise SystemExit(1) from exc
                except Exception as exc:
                    candidate_desc = active_candidate or "auto"
                    print(
                        f"[warn] failed to create mesh interface ({candidate_desc}): {exc}"
                    )
                    if configured_port is None:
                        active_candidate = None
                        announced_target = False
                    stop.wait(retry_delay)
                    if _RECONNECT_MAX_DELAY_SECS > 0:
                        retry_delay = min(
                            (
                                retry_delay * 2
                                if retry_delay
                                else _RECONNECT_INITIAL_DELAY_SECS
                            ),
                            _RECONNECT_MAX_DELAY_SECS,
                        )
                    continue

            if not initial_snapshot_sent:
                try:
                    nodes = getattr(iface, "nodes", {}) or {}
                    node_items = _node_items_snapshot(nodes)
                    if node_items is None:
                        _debug_log(
                            "skipping node snapshot; nodes changed during iteration"
                        )
                    else:
                        processed_snapshot_item = False
                        for node_id, n in node_items:
                            processed_snapshot_item = True
                            try:
                                upsert_node(node_id, n)
                            except Exception as e:
                                print(
                                    f"[warn] failed to update node snapshot for {node_id}: {e}"
                                )
                                if DEBUG:
                                    _debug_log(f"node object: {n!r}")
                        if processed_snapshot_item:
                            initial_snapshot_sent = True
                except Exception as e:
                    print(f"[warn] failed to update node snapshot: {e}")
                    _close_interface(iface)
                    iface = None
                    stop.wait(retry_delay)
                    if _RECONNECT_MAX_DELAY_SECS > 0:
                        retry_delay = min(
                            (
                                retry_delay * 2
                                if retry_delay
                                else _RECONNECT_INITIAL_DELAY_SECS
                            ),
                            _RECONNECT_MAX_DELAY_SECS,
                        )
                    continue

            retry_delay = max(0.0, _RECONNECT_INITIAL_DELAY_SECS)
            stop.wait(SNAPSHOT_SECS)
    except KeyboardInterrupt:
        _debug_log("received KeyboardInterrupt; shutting down")
        stop.set()
    finally:
        _close_interface(iface)


if __name__ == "__main__":
    main()
