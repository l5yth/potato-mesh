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

"""Helpers for capturing and exposing mesh channel metadata."""

from __future__ import annotations

import os
from typing import Any, Iterable, Iterator

from . import config

try:  # pragma: no cover - optional dependency for enum introspection
    from meshtastic.protobuf import channel_pb2
except Exception:  # pragma: no cover - exercised in environments without protobufs
    channel_pb2 = None  # type: ignore[assignment]

_ROLE_PRIMARY = 1
_ROLE_SECONDARY = 2

if channel_pb2 is not None:  # pragma: no branch - evaluated once at import time
    try:
        _ROLE_PRIMARY = int(channel_pb2.Channel.Role.PRIMARY)
        _ROLE_SECONDARY = int(channel_pb2.Channel.Role.SECONDARY)
    except Exception:  # pragma: no cover - defensive, version specific
        _ROLE_PRIMARY = 1
        _ROLE_SECONDARY = 2

_CHANNEL_MAPPINGS: tuple[tuple[int, str], ...] = ()
_CHANNEL_LOOKUP: dict[int, str] = {}


def _iter_channel_objects(channels_obj: Any) -> Iterator[Any]:
    """Yield channel descriptors from ``channels_obj``.

    The real Meshtastic API exposes channels via protobuf containers that are
    list-like. This helper converts the container into a deterministic iterator
    while avoiding runtime errors if an unexpected type is supplied.
    """

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
        except Exception:  # pragma: no cover - defensive only
            length = None
        if length is not None and length >= 0:
            snapshot = []
            for index in range(length):
                try:
                    snapshot.append(getitem(index))
                except Exception:  # pragma: no cover - best effort copy
                    break
            return iter(snapshot)

    return iter(())


def _primary_channel_name() -> str | None:
    """Return the fallback name to use for the primary channel when needed."""

    preset = getattr(config, "MODEM_PRESET", None)
    if isinstance(preset, str) and preset.strip():
        return preset.strip()
    env_name = os.environ.get("CHANNEL", "").strip()
    if env_name:
        return env_name
    return None


def _extract_channel_name(settings_obj: Any) -> str | None:
    """Normalise the configured channel name extracted from ``settings_obj``."""

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
    """Convert a channel role descriptor into an integer value."""

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


def _channel_tuple(channel_obj: Any) -> tuple[int, str] | None:
    """Return ``(index, name)`` for ``channel_obj`` when resolvable."""

    role_value = _normalize_role(getattr(channel_obj, "role", None))
    if role_value == _ROLE_PRIMARY:
        channel_index = 0
        channel_name = _extract_channel_name(getattr(channel_obj, "settings", None))
        if channel_name is None:
            channel_name = _primary_channel_name()
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


def capture_from_interface(iface: Any) -> None:
    """Populate the channel cache by inspecting ``iface`` when possible."""

    global _CHANNEL_MAPPINGS, _CHANNEL_LOOKUP

    if iface is None or _CHANNEL_MAPPINGS:
        return

    try:
        wait_for_config = getattr(iface, "waitForConfig", None)
        if callable(wait_for_config):
            wait_for_config()
    except Exception:  # pragma: no cover - hardware dependent safeguard
        pass

    local_node = getattr(iface, "localNode", None)
    channels_obj = getattr(local_node, "channels", None) if local_node else None

    channel_entries: list[tuple[int, str]] = []
    seen_indices: set[int] = set()
    for candidate in _iter_channel_objects(channels_obj):
        result = _channel_tuple(candidate)
        if result is None:
            continue
        index, name = result
        if index in seen_indices:
            continue
        channel_entries.append((index, name))
        seen_indices.add(index)

    if not channel_entries:
        return

    _CHANNEL_MAPPINGS = tuple(channel_entries)
    _CHANNEL_LOOKUP = {index: name for index, name in _CHANNEL_MAPPINGS}

    config._debug_log(
        "Captured channel metadata",
        context="channels.capture",
        severity="info",
        always=True,
        channels=_CHANNEL_MAPPINGS,
    )


def channel_mappings() -> tuple[tuple[int, str], ...]:
    """Return the cached ``(index, name)`` channel tuples."""

    return _CHANNEL_MAPPINGS


def channel_name(channel_index: int | None) -> str | None:
    """Return the channel name for ``channel_index`` when known."""

    if channel_index is None:
        return None
    return _CHANNEL_LOOKUP.get(int(channel_index))


def _reset_channel_cache() -> None:
    """Clear cached channel data. Intended for use in tests only."""

    global _CHANNEL_MAPPINGS, _CHANNEL_LOOKUP
    _CHANNEL_MAPPINGS = ()
    _CHANNEL_LOOKUP = {}


_ALLOWED_CHANNEL_INDICES: set[int] | None = None
_ALLOWED_CHANNEL_NAMES: set[str] | None = None
_CHANNEL_FILTER_VALIDATED: bool = False


def _parse_allowed_channels() -> None:
    """Parse the ALLOWED_CHANNELS config into index and name sets."""
    global _ALLOWED_CHANNEL_INDICES, _ALLOWED_CHANNEL_NAMES

    raw = getattr(config, "ALLOWED_CHANNELS", None)
    if not raw or not isinstance(raw, str):
        _ALLOWED_CHANNEL_INDICES = None
        _ALLOWED_CHANNEL_NAMES = None
        return

    indices: set[int] = set()
    names: set[str] = set()

    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            indices.add(int(part))
        except ValueError:
            names.add(part.lower())

    _ALLOWED_CHANNEL_INDICES = indices if indices else None
    _ALLOWED_CHANNEL_NAMES = names if names else None


def _validate_channel_filter() -> None:
    """Warn if configured allowed channels don't match any device channels."""
    global _CHANNEL_FILTER_VALIDATED

    if _CHANNEL_FILTER_VALIDATED:
        return
    _CHANNEL_FILTER_VALIDATED = True

    if _ALLOWED_CHANNEL_INDICES is None and _ALLOWED_CHANNEL_NAMES is None:
        return

    if not _CHANNEL_MAPPINGS:
        config._debug_log(
            "Channel filter configured but device channels not yet captured",
            context="channels.filter",
            severity="warn",
            always=True,
            allowed_indices=(
                list(_ALLOWED_CHANNEL_INDICES) if _ALLOWED_CHANNEL_INDICES else None
            ),
            allowed_names=(
                list(_ALLOWED_CHANNEL_NAMES) if _ALLOWED_CHANNEL_NAMES else None
            ),
        )
        return

    device_indices = {idx for idx, _ in _CHANNEL_MAPPINGS}
    device_names = {name.lower() for _, name in _CHANNEL_MAPPINGS}

    unmatched_indices: set[int] = set()
    unmatched_names: set[str] = set()

    if _ALLOWED_CHANNEL_INDICES:
        unmatched_indices = _ALLOWED_CHANNEL_INDICES - device_indices

    if _ALLOWED_CHANNEL_NAMES:
        unmatched_names = _ALLOWED_CHANNEL_NAMES - device_names

    if unmatched_indices or unmatched_names:
        config._debug_log(
            "Some allowed channels do not match any device channel",
            context="channels.filter",
            severity="warn",
            always=True,
            unmatched_indices=list(unmatched_indices) if unmatched_indices else None,
            unmatched_names=list(unmatched_names) if unmatched_names else None,
            device_channels=list(_CHANNEL_MAPPINGS),
        )


def is_channel_allowed(channel_index: int | None) -> bool:
    """Return ``True`` if the channel should be processed.

    When ``ALLOWED_CHANNELS`` is not configured, all channels are allowed.
    Otherwise, the channel must match either by index or by resolved name.

    Parameters:
        channel_index: The channel index to check.

    Returns:
        ``True`` if the channel should be processed, ``False`` otherwise.
    """
    global _CHANNEL_FILTER_VALIDATED

    if _ALLOWED_CHANNEL_INDICES is None and _ALLOWED_CHANNEL_NAMES is None:
        _parse_allowed_channels()

    if _ALLOWED_CHANNEL_INDICES is None and _ALLOWED_CHANNEL_NAMES is None:
        return True

    if not _CHANNEL_FILTER_VALIDATED and _CHANNEL_MAPPINGS:
        _validate_channel_filter()

    if _ALLOWED_CHANNEL_INDICES and channel_index in _ALLOWED_CHANNEL_INDICES:
        return True

    if _ALLOWED_CHANNEL_NAMES:
        name = channel_name(channel_index)
        if name and name.lower() in _ALLOWED_CHANNEL_NAMES:
            return True

    return False


def _reset_channel_filter() -> None:
    """Clear channel filter state. Intended for use in tests only."""
    global _ALLOWED_CHANNEL_INDICES, _ALLOWED_CHANNEL_NAMES, _CHANNEL_FILTER_VALIDATED
    _ALLOWED_CHANNEL_INDICES = None
    _ALLOWED_CHANNEL_NAMES = None
    _CHANNEL_FILTER_VALIDATED = False


__all__ = [
    "capture_from_interface",
    "channel_mappings",
    "channel_name",
    "is_channel_allowed",
    "_reset_channel_cache",
    "_reset_channel_filter",
]
