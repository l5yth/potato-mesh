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
"""Channel metadata helpers for the potato-mesh ingestor."""

from __future__ import annotations

import os
from collections.abc import Iterable, Mapping
from typing import Any

from .serialization import _coerce_int

try:  # pragma: no cover - optional dependency during tests
    from meshtastic import mesh_interface as _mesh_interface_mod  # type: ignore
except Exception:  # pragma: no cover - meshtastic is optional for tests
    _mesh_interface_mod = None

_CHANNEL_METADATA: list[tuple[int, str | None]] = []
"""Cached ``(channel_index, channel_name)`` pairs discovered at runtime."""


def _string_or_none(value: Any) -> str | None:
    """Return ``value`` as a non-empty string or ``None`` when unsuitable."""

    if value in {None, ""}:
        return None
    try:
        text = str(value)
    except Exception:
        return None
    text = text.strip()
    return text or None


def _mapping_from_slots(value: Any) -> Mapping[str, Any] | None:
    """Return a mapping generated from ``__slots__`` when available."""

    slots = getattr(value, "__slots__", None)
    if not slots:
        return None
    if isinstance(slots, str):
        slots = [slots]
    result: dict[str, Any] = {}
    for slot in slots:
        try:
            result[slot] = getattr(value, slot)
        except AttributeError:
            continue
    return result if result else None


def _mapping_from_protobuf(value: Any) -> Mapping[str, Any] | None:
    """Return a mapping for protobuf-style messages when possible."""

    descriptor = getattr(value, "DESCRIPTOR", None)
    list_fields = getattr(value, "ListFields", None)
    if descriptor is None or not callable(list_fields):
        return None
    try:
        result: dict[str, Any] = {}
        for field, field_value in list_fields():
            field_name = getattr(field, "name", None)
            if field_name:
                result[field_name] = field_value
        for field in getattr(descriptor, "fields", []):
            field_name = getattr(field, "name", None)
            if field_name and field_name not in result:
                try:
                    result[field_name] = getattr(value, field_name)
                except Exception:
                    continue
    except Exception:
        return None
    return result if result else None


def _coerce_mapping(value: Any) -> Mapping[str, Any] | None:
    """Return a mapping view over ``value`` when possible."""

    if isinstance(value, Mapping):
        return value
    if hasattr(value, "to_dict"):
        try:
            candidate = value.to_dict()
        except Exception:
            candidate = None
        if isinstance(candidate, Mapping):
            return candidate
    proto_mapping = _mapping_from_protobuf(value)
    if proto_mapping is not None:
        return proto_mapping
    slots_mapping = _mapping_from_slots(value)
    if slots_mapping is not None:
        return slots_mapping
    try:
        attrs = vars(value)
    except TypeError:
        return None
    return attrs


def _mapping_get(mapping: Mapping[str, Any] | None, obj: Any, key: str) -> Any:
    """Fetch ``key`` from ``mapping`` or attribute ``obj.key`` when available."""

    if mapping is not None and key in mapping:
        return mapping[key]
    return getattr(obj, key, None)


def _iter_channels(iface: Any) -> Iterable[Any]:
    """Yield channel entries from ``iface`` when accessible."""

    if iface is None:
        return []
    local_node = getattr(iface, "localNode", None)
    if local_node is None:
        return []
    channels = getattr(local_node, "channels", None)
    if channels is None:
        return []
    if isinstance(channels, Mapping):
        return list(channels.values())
    try:
        return list(channels)
    except TypeError:
        return []


def _primary_channel_name() -> str | None:
    """Return the configured primary channel name, if discoverable."""

    candidates: list[Any] = []
    if _mesh_interface_mod is not None:
        candidates.append(getattr(_mesh_interface_mod, "MODEM_PRESET", None))
        mesh_iface_cls = getattr(_mesh_interface_mod, "MeshInterface", None)
        if mesh_iface_cls is not None:
            candidates.append(getattr(mesh_iface_cls, "MODEM_PRESET", None))
    for candidate in candidates:
        name = _string_or_none(candidate)
        if name:
            return name
    return _string_or_none(os.environ.get("CHANNEL"))


def refresh_channel_metadata(iface: Any) -> list[tuple[int, str | None]]:
    """Refresh :data:`_CHANNEL_METADATA` from ``iface`` channel settings."""

    metadata: dict[int, str | None] = {}
    for entry in _iter_channels(iface):
        channel_mapping = _coerce_mapping(entry)
        role = _coerce_int(_mapping_get(channel_mapping, entry, "role"))
        if role == 1:  # PRIMARY
            name = _primary_channel_name()
            metadata[0] = name
            continue
        if role != 2:  # SECONDARY
            continue
        index = _coerce_int(_mapping_get(channel_mapping, entry, "index"))
        if index is None:
            continue
        settings_obj = _mapping_get(channel_mapping, entry, "settings")
        settings = _coerce_mapping(settings_obj)
        channel_name = _string_or_none(_mapping_get(settings, settings_obj, "name"))
        metadata[index] = channel_name
    global _CHANNEL_METADATA
    _CHANNEL_METADATA = sorted(metadata.items())
    return list(_CHANNEL_METADATA)


def channel_metadata() -> list[tuple[int, str | None]]:
    """Return a copy of the cached channel metadata."""

    return list(_CHANNEL_METADATA)


def channel_name_for(index: Any, *, encrypted: bool = False) -> str | None:
    """Return the known channel name for ``index`` unless ``encrypted``."""

    if encrypted:
        return None
    channel_index = _coerce_int(index)
    if channel_index is None:
        return None
    for stored_index, stored_name in _CHANNEL_METADATA:
        if stored_index == channel_index and stored_name:
            return stored_name
    return None


__all__ = [
    "channel_metadata",
    "channel_name_for",
    "refresh_channel_metadata",
]
