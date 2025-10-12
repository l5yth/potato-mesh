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
"""Minimal Meshtastic protobuf stubs for isolated unit testing."""

from __future__ import annotations

import json
import types
from typing import Any, Callable, Dict, Tuple


def _enum_value(name: str, mapping: Dict[str, int]) -> int:
    normalized = name.upper()
    if normalized not in mapping:
        raise KeyError(f"Unknown enum value: {name}")
    return mapping[normalized]


def build(message_base, decode_error) -> Tuple[types.ModuleType, types.ModuleType]:
    """Return ``(config_pb2, mesh_pb2)`` stubs built from protobuf shims."""

    class _ProtoMessage(message_base):
        """Base class implementing JSON round-tripping for protobuf stubs."""

        _FIELD_ALIASES: Dict[str, str] = {}
        _FIELD_FACTORIES: Dict[str, Callable[[], "_ProtoMessage"]] = {}

        def __init__(self) -> None:
            super().__init__()
            object.__setattr__(self, "_fields", {})

        def __setattr__(
            self, name: str, value: Any
        ) -> None:  # noqa: D401 - behaviour documented on base class
            object.__setattr__(self, name, value)
            if not name.startswith("_"):
                self._fields[name] = value

        def __getattr__(self, name: str) -> Any:
            factories = getattr(self, "_FIELD_FACTORIES", {})
            if name in factories:
                value = factories[name]()
                self.__setattr__(name, value)
                return value
            raise AttributeError(name)

        def _alias_for(self, name: str) -> str:
            return self._FIELD_ALIASES.get(name, name)

        def _name_for(self, alias: str) -> str:
            reverse = getattr(self, "_FIELD_ALIASES", {})
            for key, candidate in reverse.items():
                if candidate == alias:
                    return key
            return alias

        def _to_dict(self) -> Dict[str, Any]:
            result: Dict[str, Any] = {}
            for name, value in self._fields.items():
                alias = self._alias_for(name)
                if isinstance(value, _ProtoMessage):
                    result[alias] = value._to_dict()
                elif isinstance(value, list):
                    result[alias] = [
                        item._to_dict() if isinstance(item, _ProtoMessage) else item
                        for item in value
                    ]
                else:
                    result[alias] = value
            return result

        def SerializeToString(self) -> bytes:
            """Encode the message contents as a JSON byte string."""

            return json.dumps(self._to_dict(), sort_keys=True).encode("utf-8")

        def ParseFromString(self, payload: bytes) -> None:
            """Populate the message from a JSON byte string."""

            try:
                data = json.loads(payload.decode("utf-8"))
            except Exception as exc:  # pragma: no cover - defensive guard
                raise decode_error(str(exc)) from exc
            self._load_from_dict(data)

        def _load_from_dict(self, data: Dict[str, Any]) -> None:
            factories = getattr(self, "_FIELD_FACTORIES", {})
            for alias, value in data.items():
                name = self._name_for(alias)
                if name in factories and isinstance(value, dict):
                    nested = getattr(self, name, None)
                    if not isinstance(nested, _ProtoMessage):
                        nested = factories[name]()
                        object.__setattr__(self, name, nested)
                    nested._load_from_dict(value)
                    self._fields[name] = nested
                else:
                    setattr(self, name, value)

        def to_dict(self) -> Dict[str, Any]:
            """Return a JSON-compatible representation of the message."""

            return self._to_dict()

        def ListFields(self):
            """Mimic protobuf ``ListFields`` for the subset of tests used."""

            from types import SimpleNamespace

            entries = []
            for name, value in self._fields.items():
                descriptor = SimpleNamespace(name=name)
                entries.append((descriptor, value))
            return entries

        def CopyFrom(self, other: "_ProtoMessage") -> None:
            """Populate this message with values from ``other``."""

            if not isinstance(other, _ProtoMessage):
                raise TypeError("CopyFrom expects another protobuf message")
            self._fields.clear()
            for name, value in other._fields.items():
                if isinstance(value, _ProtoMessage):
                    copied = type(value)()
                    copied.CopyFrom(value)
                    setattr(self, name, copied)
                elif isinstance(value, list):
                    converted = []
                    for item in value:
                        if isinstance(item, _ProtoMessage):
                            nested = type(item)()
                            nested.CopyFrom(item)
                            converted.append(nested)
                        else:
                            converted.append(item)
                    setattr(self, name, converted)
                else:
                    setattr(self, name, value)

    class _DeviceMetrics(_ProtoMessage):
        _FIELD_ALIASES = {
            "battery_level": "batteryLevel",
            "voltage": "voltage",
            "channel_utilization": "channelUtilization",
            "air_util_tx": "airUtilTx",
            "uptime_seconds": "uptimeSeconds",
        }

    class _Position(_ProtoMessage):
        _FIELD_ALIASES = {
            "latitude_i": "latitudeI",
            "longitude_i": "longitudeI",
            "location_source": "locationSource",
        }

        class LocSource:
            _VALUES = {
                "LOC_UNSET": 0,
                "LOC_INTERNAL": 1,
                "LOC_EXTERNAL": 2,
            }

            @classmethod
            def Value(cls, name: str) -> int:
                return _enum_value(name, cls._VALUES)

    class _User(_ProtoMessage):
        _FIELD_ALIASES = {
            "short_name": "shortName",
            "long_name": "longName",
            "hw_model": "hwModel",
        }

    class _NodeInfo(_ProtoMessage):
        _FIELD_ALIASES = {
            "last_heard": "lastHeard",
            "is_favorite": "isFavorite",
            "hops_away": "hopsAway",
        }
        _FIELD_FACTORIES = {
            "user": _User,
            "device_metrics": _DeviceMetrics,
            "position": _Position,
        }

        def __init__(self) -> None:
            super().__init__()

    class _HardwareModel:
        _VALUES = {
            "UNKNOWN": 0,
            "TBEAM": 1,
            "HELTEC": 2,
        }

        @classmethod
        def Value(cls, name: str) -> int:
            return _enum_value(name, cls._VALUES)

    mesh_pb2 = types.ModuleType("mesh_pb2")
    mesh_pb2.NodeInfo = _NodeInfo
    mesh_pb2.User = _User
    mesh_pb2.Position = _Position
    mesh_pb2.DeviceMetrics = _DeviceMetrics
    mesh_pb2.HardwareModel = _HardwareModel

    class _RoleEnum:
        _VALUES = {
            "UNKNOWN": 0,
            "CLIENT": 1,
            "REPEATER": 2,
            "ROUTER": 3,
        }

        @classmethod
        def Value(cls, name: str) -> int:
            return _enum_value(name, cls._VALUES)

    class _DeviceConfig:
        Role = _RoleEnum

    class _Config:
        DeviceConfig = _DeviceConfig

    config_pb2 = types.ModuleType("config_pb2")
    config_pb2.Config = _Config

    return config_pb2, mesh_pb2
