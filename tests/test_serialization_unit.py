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
"""Focused serialization helper coverage for defensive branches."""

from __future__ import annotations

import builtins
import importlib
import sys
import types
from typing import Any

import pytest

from data.mesh_ingestor import serialization


class _StubFieldDesc:
    def __init__(self, name: str) -> None:
        self.name = name


class _StubContainer:
    def __init__(self, fields: dict[str, Any]) -> None:
        self._fields = fields

    def ListFields(self):  # noqa: D401 - protobuf-compatible stub
        return [(_StubFieldDesc(name), value) for name, value in self._fields.items()]


class _StubProto(serialization.ProtoMessage):
    """Simple ProtoMessage subclass usable for monkeypatched checks."""

    def __init__(self) -> None:
        self._copied_from = None

    def ParseFromString(
        self, payload: bytes
    ) -> None:  # noqa: D401 - protobuf-compatible stub
        raise serialization.DecodeError("boom")

    def CopyFrom(self, other):  # noqa: D401 - protobuf-compatible stub
        self._copied_from = other


@pytest.fixture(autouse=True)
def reset_cli_cache(monkeypatch):
    """Ensure the CLI lookup cache is cleared between tests."""

    serialization._reset_cli_role_cache()
    monkeypatch.setattr(serialization, "_CLI_ROLE_LOOKUP", None, raising=False)
    yield
    serialization._reset_cli_role_cache()


def test_load_cli_role_lookup_prefers_cache(monkeypatch):
    """Return cached CLI role mappings without re-importing modules."""

    sentinel = {1: "ADMIN"}
    monkeypatch.setattr(serialization, "_CLI_ROLE_LOOKUP", sentinel, raising=False)
    assert serialization._load_cli_role_lookup() is sentinel


def test_load_cli_role_lookup_members_mapping(monkeypatch):
    """Resolve role names from a stub module exposing a __members__ mapping."""

    stub_module = types.SimpleNamespace()

    class MembersRole:
        __members__ = {
            "one": types.SimpleNamespace(value=1),
            "TWO": types.SimpleNamespace(value=2),
        }

    stub_module.Roles = MembersRole

    def fake_import(name):
        if name == serialization._CLI_ROLE_MODULE_NAMES[0]:
            return stub_module
        raise ImportError("skip")

    monkeypatch.setattr(importlib, "import_module", fake_import)
    lookup = serialization._load_cli_role_lookup()
    assert lookup == {1: "ONE", 2: "TWO"}


def test_load_cli_role_lookup_skips_empty_candidates(monkeypatch):
    """Skip candidates that do not expose usable members."""

    stub_module = types.SimpleNamespace(Role=types.SimpleNamespace(__members__={}))

    def fake_import(name):
        if name == serialization._CLI_ROLE_MODULE_NAMES[0]:
            return stub_module
        raise ImportError("skip")

    monkeypatch.setattr(importlib, "import_module", fake_import)
    assert serialization._load_cli_role_lookup() == {}


class _ExplodingStr:
    def __str__(self) -> str:  # noqa: D401 - custom str to trigger json.dumps fallback
        return "repr"


def test_node_to_dict_json_error(monkeypatch):
    """Fallback to ``str`` conversion when ``json.dumps`` raises."""

    def boom(*_args, **_kwargs):
        raise ValueError("explode")

    monkeypatch.setattr(serialization.json, "dumps", boom)
    result = serialization._node_to_dict(_ExplodingStr())
    assert result == "repr"


@pytest.mark.parametrize(
    "value,expected",
    [
        ("   ", None),
        (object(), None),
    ],
)
def test_normalize_user_role_edge_cases(value, expected):
    """Normalize blank strings and uncoercible values to ``None``."""

    assert serialization._normalize_user_role(value) is expected


def test_coerce_float_value_error():
    """Invalid strings should return ``None`` when conversion fails."""

    assert serialization._coerce_float("not-a-number") is None


class _BadProto(serialization.ProtoMessage):
    """Proto-like object that raises from MessageToDict and to_dict."""

    def __str__(self) -> str:  # noqa: D401 - string representation for fallbacks
        return "bad-proto"

    def to_dict(self):  # noqa: D401 - protobuf-compatible stub
        raise ValueError("nope")


def test_pkt_to_dict_fallbacks(monkeypatch):
    """Exercise MessageToDict and to_dict failure handling."""

    def fail_message_to_dict(*_args, **_kwargs):
        raise Exception("fail")

    monkeypatch.setattr(serialization, "MessageToDict", fail_message_to_dict)
    result = serialization._pkt_to_dict(_BadProto())
    assert "_unparsed" not in result
    assert isinstance(result, str)


class _Digitish(str):
    def isdigit(self) -> bool:  # noqa: D401 - force digit handling despite letters
        return True

    def strip(self) -> "_Digitish":  # noqa: D401 - preserve subclass through stripping
        return self


@pytest.mark.parametrize(
    "value,expected",
    [
        (float("nan"), None),
        (-5, None),
        (object(), None),
        ("^alias", "^alias"),
        (_Digitish("xyz"), None),
        ("!", None),
    ],
)
def test_canonical_node_id_defensive_paths(value, expected):
    """Cover defensive branches in node id normalisation."""

    assert serialization._canonical_node_id(value) == expected


@pytest.mark.parametrize(
    "value,expected",
    [
        (float("nan"), None),
        (object(), None),
        ("not-a-number", None),
    ],
)
def test_node_num_from_id_defensive_paths(value, expected):
    """Cover numeric and string parsing failures in id extraction."""

    assert serialization._node_num_from_id(value) == expected


def test_merge_mappings_with_non_mapping_extra():
    """Ignore extras that cannot be converted into mappings."""

    assert serialization._merge_mappings({"a": 1}, 5) == {"a": 1}


def test_extract_payload_bytes_invalid_base64():
    """Return ``None`` for strings that are not valid base64 payloads."""

    original_b64decode = serialization.base64.b64decode

    def boom(_value):
        raise ValueError("bad")

    serialization.base64.b64decode = boom
    try:
        decoded = serialization._extract_payload_bytes({"payload": "$$$"})
        assert decoded is None
    finally:
        serialization.base64.b64decode = original_b64decode


def test_normalize_user_role_uppercases():
    """Convert role strings to canonical uppercase names."""

    assert serialization._normalize_user_role(" member ") == "MEMBER"


def test_decode_nodeinfo_payload_import_and_parse_failures(monkeypatch):
    """Handle import errors and parse failures when decoding NodeInfo."""

    assert serialization._decode_nodeinfo_payload(b"") is None

    original_import = builtins.__import__

    def raising_import(name, *args, **kwargs):
        if name.startswith("meshtastic.protobuf"):
            raise ModuleNotFoundError(name)
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", raising_import)
    assert serialization._decode_nodeinfo_payload(b"payload") is None
    monkeypatch.setattr(builtins, "__import__", original_import)

    mesh_pb2 = types.SimpleNamespace(NodeInfo=_StubProto, User=_StubProto)
    protobuf_pkg = types.SimpleNamespace(mesh_pb2=mesh_pb2)
    monkeypatch.setitem(sys.modules, "meshtastic", types.ModuleType("meshtastic"))
    monkeypatch.setitem(sys.modules, "meshtastic.protobuf", protobuf_pkg)
    monkeypatch.setitem(sys.modules, "meshtastic.protobuf.mesh_pb2", mesh_pb2)
    assert serialization._decode_nodeinfo_payload(b"payload") is None


def test_nodeinfo_metrics_dict_handles_optional_fields():
    """Extract only present metrics fields or return ``None`` when absent."""

    assert serialization._nodeinfo_metrics_dict(None) is None

    device_metrics = _StubContainer(
        {
            "battery_level": 5.0,
            "humidity": 42.0,
            "temperature": 21.5,
            "barometric_pressure": 1000.5,
        }
    )
    node_info = types.SimpleNamespace(device_metrics=device_metrics)
    node_info.ListFields = lambda: [(_StubFieldDesc("device_metrics"), device_metrics)]
    metrics = serialization._nodeinfo_metrics_dict(node_info)
    assert metrics == {
        "batteryLevel": 5.0,
        "humidity": 42.0,
        "temperature": 21.5,
        "barometricPressure": 1000.5,
    }


def test_nodeinfo_position_dict_variant_fields():
    """Cover integer conversions and derived latitude/longitude values."""

    assert serialization._nodeinfo_position_dict(None) is None

    position = _StubContainer(
        {
            "latitude_i": 100000000,
            "longitude_i": 200000000,
            "altitude": 7,
            "ground_speed": 1.5,
            "ground_track": 2.5,
            "precision_bits": 3,
            "location_source": 4,
        }
    )
    node_info = types.SimpleNamespace(position=position)
    node_info.ListFields = lambda: [(_StubFieldDesc("position"), position)]
    result = serialization._nodeinfo_position_dict(node_info)
    assert result == {
        "latitudeI": 100000000,
        "longitudeI": 200000000,
        "latitude": 10.0,
        "longitude": 20.0,
        "altitude": 7,
        "groundSpeed": 1.5,
        "groundTrack": 2.5,
        "precisionBits": 3,
        "locationSource": 4,
    }

    position_with_floats = _StubContainer(
        {
            "latitude": 1.5,
            "longitude": 2.5,
        }
    )
    node_info_float = types.SimpleNamespace(position=position_with_floats)
    node_info_float.ListFields = lambda: [
        (_StubFieldDesc("position"), position_with_floats)
    ]
    direct_result = serialization._nodeinfo_position_dict(node_info_float)
    assert direct_result == {"latitude": 1.5, "longitude": 2.5}


def test_nodeinfo_user_dict_monkeypatched_paths(monkeypatch):
    """Cover manual_to_dict failures and decoded user ProtoMessage conversion."""

    monkeypatch.setattr(serialization, "_load_cli_role_lookup", lambda: {})

    proto_pkg = types.SimpleNamespace()
    failing_role = types.SimpleNamespace(
        Name=lambda _value: (_ for _ in ()).throw(ValueError("nope"))
    )
    failing_user = types.SimpleNamespace(Role=failing_role)
    monkeypatch.setitem(
        sys.modules, "meshtastic", types.SimpleNamespace(protobuf=proto_pkg)
    )
    monkeypatch.setitem(sys.modules, "meshtastic.protobuf", proto_pkg)
    monkeypatch.setitem(
        sys.modules,
        "meshtastic.protobuf.mesh_pb2",
        types.SimpleNamespace(User=failing_user),
    )
    monkeypatch.setitem(
        sys.modules,
        "meshtastic.protobuf.config_pb2",
        types.SimpleNamespace(Config=types.SimpleNamespace(DeviceConfig=failing_user)),
    )

    def raising_to_dict():
        raise ValueError("nope")

    user_proto = types.SimpleNamespace(to_dict=raising_to_dict)
    user_proto.ListFields = lambda: []
    node_info = types.SimpleNamespace(user=user_proto)
    node_info.ListFields = lambda: [(_StubFieldDesc("user"), user_proto)]

    def failing_message_to_dict(*_args, **_kwargs):
        raise Exception("fail")

    monkeypatch.setattr(serialization, "MessageToDict", failing_message_to_dict)

    decoded_user = _BadProto()
    decoded_user.to_dict = lambda: {"role": 0}

    result = serialization._nodeinfo_user_dict(node_info, decoded_user)
    assert result == {"role": "0"}


def test_nodeinfo_user_dict_proto_fallback(monkeypatch):
    """Exercise decoded user ProtoMessage fallbacks when conversions fail."""

    def failing_to_dict():
        raise ValueError("nope")

    class DecodedProto(serialization.ProtoMessage):
        def __str__(self):  # noqa: D401
            return "decoded-proto"

        to_dict = staticmethod(failing_to_dict)

    def failing_message_to_dict(*_args, **_kwargs):
        raise Exception("fail")

    monkeypatch.setattr(serialization, "MessageToDict", failing_message_to_dict)

    decoded_user = DecodedProto()
    assert serialization._nodeinfo_user_dict(None, decoded_user) is None


# ---------------------------------------------------------------------------
# _coerce_int edge cases
# ---------------------------------------------------------------------------


class TestCoerceInt:
    """Tests for :func:`serialization._coerce_int` edge cases."""

    def test_bool_true(self):
        """True coerces to 1."""
        assert serialization._coerce_int(True) == 1

    def test_bool_false(self):
        """False coerces to 0."""
        assert serialization._coerce_int(False) == 0

    def test_nan_float_returns_none(self):
        """NaN float returns None."""
        import math

        assert serialization._coerce_int(math.nan) is None

    def test_inf_float_returns_none(self):
        """Inf float returns None."""
        import math

        assert serialization._coerce_int(math.inf) is None

    def test_bytes_decimal(self):
        """Bytes containing a decimal string are parsed."""
        assert serialization._coerce_int(b"42") == 42

    def test_bytes_hex(self):
        """Bytes containing a 0x hex string are parsed."""
        assert serialization._coerce_int(b"0xff") == 255

    def test_empty_bytes_returns_none(self):
        """Empty bytes returns None."""
        assert serialization._coerce_int(b"") is None

    def test_invalid_string_returns_none(self):
        """Non-numeric string returns None."""
        assert serialization._coerce_int("not-an-int") is None

    def test_float_string_coerced(self):
        """Decimal string like '3.7' is truncated to int."""
        assert serialization._coerce_int("3.7") == 3

    def test_none_returns_none(self):
        """None returns None."""
        assert serialization._coerce_int(None) is None


# ---------------------------------------------------------------------------
# _coerce_float edge cases
# ---------------------------------------------------------------------------


class TestCoerceFloat:
    """Tests for :func:`serialization._coerce_float` edge cases."""

    def test_bool_true(self):
        """True coerces to 1.0."""
        assert serialization._coerce_float(True) == pytest.approx(1.0)

    def test_nan_returns_none(self):
        """NaN returns None."""
        import math

        assert serialization._coerce_float(math.nan) is None

    def test_inf_returns_none(self):
        """Inf returns None."""
        import math

        assert serialization._coerce_float(math.inf) is None

    def test_bytes_string(self):
        """Bytes containing a float string are parsed."""
        assert serialization._coerce_float(b"3.14") == pytest.approx(3.14)

    def test_empty_bytes_returns_none(self):
        """Empty bytes returns None."""
        assert serialization._coerce_float(b"") is None

    def test_invalid_string_returns_none(self):
        """Non-numeric string returns None."""
        assert serialization._coerce_float("not-a-float") is None

    def test_none_returns_none(self):
        """None returns None."""
        assert serialization._coerce_float(None) is None


# ---------------------------------------------------------------------------
# _first dot-notation
# ---------------------------------------------------------------------------


class TestFirstDotNotation:
    """Tests for :func:`serialization._first` with dot-separated names."""

    def test_dot_notation_nested_dict(self):
        """Dot notation resolves nested dict keys."""
        d = {"a": {"b": 42}}
        assert serialization._first(d, "a.b") == 42

    def test_dot_notation_falls_back_to_next_name(self):
        """Falls back to the next candidate when dot-path misses."""
        d = {"x": 99}
        assert serialization._first(d, "a.b", "x") == 99

    def test_dot_notation_none_value_skipped(self):
        """None value at dot-path is skipped."""
        d = {"a": {"b": None}}
        assert serialization._first(d, "a.b", default="fallback") == "fallback"

    def test_dot_notation_empty_string_skipped(self):
        """Empty string at dot-path is skipped."""
        d = {"a": {"b": ""}}
        assert serialization._first(d, "a.b", default="fallback") == "fallback"

    def test_attr_dot_notation(self):
        """Dot notation works for objects with attributes."""
        from types import SimpleNamespace

        d = SimpleNamespace(a=SimpleNamespace(b=7))
        assert serialization._first(d, "a.b") == 7


# ---------------------------------------------------------------------------
# _merge_mappings non-mapping extra
# ---------------------------------------------------------------------------


class TestMergeMappingsExtra:
    """Additional tests for :func:`serialization._merge_mappings`."""

    def test_non_mapping_extra_ignored(self):
        """Non-mapping extra with non-convertible value returns base unchanged."""
        base = {"x": 1}
        # Pass a string as extra — _node_to_dict will return the string, which
        # is not a Mapping, so base is returned as-is.
        result = serialization._merge_mappings(base, "not-a-mapping")
        assert result == {"x": 1}

    def test_deep_merge(self):
        """Nested mappings are merged recursively."""
        base = {"a": {"b": 1, "c": 2}}
        extra = {"a": {"b": 99}}
        result = serialization._merge_mappings(base, extra)
        assert result == {"a": {"b": 99, "c": 2}}

    def test_extra_key_added(self):
        """Keys present only in extra are added to the result."""
        base = {"a": 1}
        extra = {"b": 2}
        result = serialization._merge_mappings(base, extra)
        assert result == {"a": 1, "b": 2}


# ---------------------------------------------------------------------------
# _extract_payload_bytes additional branches
# ---------------------------------------------------------------------------


class TestExtractPayloadBytesExtra:
    """Additional coverage for :func:`serialization._extract_payload_bytes`."""

    def test_non_mapping_input_returns_none(self):
        """Non-mapping decoded section returns None."""
        assert serialization._extract_payload_bytes("not-a-dict") is None

    def test_no_payload_key_returns_none(self):
        """Missing payload key returns None."""
        assert serialization._extract_payload_bytes({}) is None

    def test_bytes_payload_returned_directly(self):
        """Raw bytes payload is returned as-is."""
        result = serialization._extract_payload_bytes({"payload": b"\x01\x02"})
        assert result == b"\x01\x02"
