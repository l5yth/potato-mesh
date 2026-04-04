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

"""Short Meshtastic connections to list channel index/name pairs (no mesh_ingestor imports)."""

from __future__ import annotations

from typing import Any, Iterable, Iterator

from .connection_parse import parse_ble_target, parse_tcp_target

try:
    from meshtastic.protobuf import channel_pb2
except Exception:
    channel_pb2 = None

_ROLE_PRIMARY = 1
_ROLE_SECONDARY = 2
if channel_pb2 is not None:
    try:
        _ROLE_PRIMARY = int(channel_pb2.Channel.Role.PRIMARY)
        _ROLE_SECONDARY = int(channel_pb2.Channel.Role.SECONDARY)
    except Exception:
        pass


def _iter_channel_objects(channels_obj: Any) -> Iterator[Any]:
    if channels_obj is None:
        return iter(())

    if isinstance(channels_obj, dict):
        return iter(channels_obj.values())

    if isinstance(channels_obj, Iterable):
        return iter(list(channels_obj))

    length_fn = getattr(channels_obj, "__len__", None)
    getitem = getattr(channels_obj, "__getitem__", None)
    if callable(length_fn) and callable(getitem):
        try:
            length = int(length_fn())
        except Exception:
            length = None
        if length is not None and length >= 0:
            snapshot = []
            for index in range(length):
                try:
                    snapshot.append(getitem(index))
                except Exception:
                    break
            return iter(snapshot)

    return iter(())


def _extract_channel_name(settings_obj: Any) -> str | None:
    if settings_obj is None:
        return None
    if isinstance(settings_obj, dict):
        candidate = settings_obj.get("name")
    else:
        candidate = getattr(settings_obj, "name", None)
    if isinstance(candidate, str):
        candidate = candidate.strip()
        if candidate:
            return candidate
    return None


def _normalize_role(role: Any) -> int | None:
    if isinstance(role, int):
        return role
    if isinstance(role, str):
        value = role.strip().upper()
        if value == "PRIMARY":
            return _ROLE_PRIMARY
        if value == "SECONDARY":
            return _ROLE_SECONDARY
        try:
            return int(value)
        except ValueError:
            return None
    name_attr = getattr(role, "name", None)
    if isinstance(name_attr, str):
        return _normalize_role(name_attr)
    value_attr = getattr(role, "value", None)
    if isinstance(value_attr, int):
        return value_attr
    try:
        return int(role)  # type: ignore[arg-type]
    except Exception:
        return None


def _channel_tuple(
    channel_obj: Any, primary_fallback: str | None
) -> tuple[int, str] | None:
    role_value = _normalize_role(getattr(channel_obj, "role", None))
    if role_value == _ROLE_PRIMARY:
        channel_index = 0
        channel_name = _extract_channel_name(getattr(channel_obj, "settings", None))
        if channel_name is None:
            channel_name = primary_fallback
    elif role_value == _ROLE_SECONDARY:
        raw_index = getattr(channel_obj, "index", None)
        try:
            channel_index = int(raw_index)
        except Exception:
            channel_index = None
        channel_name = _extract_channel_name(getattr(channel_obj, "settings", None))
    else:
        return None

    if not isinstance(channel_index, int):
        return None
    if not isinstance(channel_name, str) or not channel_name:
        return None
    return channel_index, channel_name


def extract_channel_rows(
    iface: Any, primary_fallback: str | None
) -> list[tuple[int, str]]:
    local_node = getattr(iface, "localNode", None)
    channels_obj = getattr(local_node, "channels", None) if local_node else None
    channel_entries: list[tuple[int, str]] = []
    seen_indices: set[int] = set()
    for candidate in _iter_channel_objects(channels_obj):
        result = _channel_tuple(candidate, primary_fallback)
        if result is None:
            continue
        index, name = result
        if index in seen_indices:
            continue
        channel_entries.append((index, name))
        seen_indices.add(index)
    channel_entries.sort(key=lambda x: x[0])
    return channel_entries


def open_meshtastic_interface(target: str):
    """Return a connected Meshtastic interface for *target* (serial path, BLE MAC/UUID, or host:port)."""

    from meshtastic.serial_interface import SerialInterface
    from meshtastic.tcp_interface import TCPInterface

    t = (target or "").strip()
    ble = parse_ble_target(t)
    if ble:
        try:
            from meshtastic.ble_interface import BLEInterface
        except Exception as exc:
            raise RuntimeError(
                "BLE requested but meshtastic BLE extras are not available. "
                "Install meshtastic with the 'ble' extra."
            ) from exc
        return BLEInterface(address=ble)

    tcp = parse_tcp_target(t)
    if tcp:
        host, port = tcp
        return TCPInterface(hostname=host, portNumber=port)

    return SerialInterface(devPath=t)


def probe_channels(
    target: str, *, channel_fallback: str | None = None
) -> tuple[list[tuple[int, str]], str | None]:
    """Connect, wait for config, return ``(rows, error)``."""

    iface = None
    try:
        iface = open_meshtastic_interface(target)
        wait = getattr(iface, "waitForConfig", None)
        if callable(wait):
            wait()
        rows = extract_channel_rows(iface, channel_fallback)
        return rows, None
    except Exception as exc:
        return [], str(exc)
    finally:
        if iface is not None:
            close = getattr(iface, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
