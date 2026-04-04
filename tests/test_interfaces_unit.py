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
"""Unit tests for :mod:`data.mesh_ingestor.interfaces`."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.config as config
import data.mesh_ingestor.interfaces as ifaces

# ---------------------------------------------------------------------------
# _ensure_mapping
# ---------------------------------------------------------------------------


class TestEnsureMapping:
    """Tests for :func:`interfaces._ensure_mapping`."""

    def test_mapping_returned_as_is(self):
        """A dict is returned directly without conversion."""
        d = {"a": 1}
        result = ifaces._ensure_mapping(d)
        # Use id() to assert identity (same object, not just equal value).
        assert id(result) == id(d)

    def test_object_with_dict_attr(self):
        """Object whose ``__dict__`` is a mapping is wrapped."""
        obj = SimpleNamespace(x=10)
        result = ifaces._ensure_mapping(obj)
        assert isinstance(result, dict)
        assert result.get("x") == 10

    def test_convertible_via_node_to_dict(self, monkeypatch):
        """Objects convertible by ``_node_to_dict`` return a mapping."""

        import data.mesh_ingestor.serialization as ser

        monkeypatch.setattr(ser, "_node_to_dict", lambda _v: {"converted": True})

        # Use an object without __dict__ to avoid the __dict__ branch
        class NoDict:
            __slots__ = ()

        result = ifaces._ensure_mapping(NoDict())
        assert result == {"converted": True}

    def test_non_convertible_returns_none(self, monkeypatch):
        """Returns None for objects that cannot be converted to a mapping."""

        import data.mesh_ingestor.serialization as ser

        monkeypatch.setattr(ser, "_node_to_dict", lambda _v: "not-a-mapping")

        class NoDict:
            __slots__ = ()

        assert ifaces._ensure_mapping(NoDict()) is None

    def test_none_returns_none(self):
        """None input returns None."""
        assert ifaces._ensure_mapping(None) is None


# ---------------------------------------------------------------------------
# _is_nodeish_identifier
# ---------------------------------------------------------------------------


class TestIsNodeishIdentifier:
    """Tests for :func:`interfaces._is_nodeish_identifier`."""

    def test_int_returns_false(self):
        """Integers are not node identifiers."""
        assert ifaces._is_nodeish_identifier(42) is False

    def test_float_returns_false(self):
        """Floats are not node identifiers."""
        assert ifaces._is_nodeish_identifier(3.14) is False

    def test_non_string_returns_false(self):
        """Non-string, non-numeric objects return False."""
        assert ifaces._is_nodeish_identifier(object()) is False

    def test_empty_string_returns_false(self):
        """Empty string is not a node identifier."""
        assert ifaces._is_nodeish_identifier("   ") is False

    def test_caret_prefix_returns_true(self):
        """Strings starting with ^ are recognised as special destinations."""
        assert ifaces._is_nodeish_identifier("^all") is True

    def test_bang_hex_valid(self):
        """!xxxxxxxx style identifiers are recognised."""
        assert ifaces._is_nodeish_identifier("!aabbccdd") is True

    def test_bang_hex_too_long(self):
        """More than 8 hex digits after ! are rejected."""
        assert ifaces._is_nodeish_identifier("!aabbccdd00") is False

    def test_0x_prefix_valid(self):
        """0x-prefixed hex strings with ≤8 digits are recognised."""
        assert ifaces._is_nodeish_identifier("0xaabb") is True

    def test_bare_decimal_rejected(self):
        """Bare decimal strings without hex digits are not node identifiers."""
        assert ifaces._is_nodeish_identifier("12345678") is False

    def test_bare_hex_valid(self):
        """Bare hex strings containing a-f are recognised."""
        assert ifaces._is_nodeish_identifier("aabbccdd") is True

    def test_bare_hex_too_long_rejected(self):
        """More than 8 bare hex characters are rejected."""
        assert ifaces._is_nodeish_identifier("aabbccdd00") is False


# ---------------------------------------------------------------------------
# _candidate_node_id
# ---------------------------------------------------------------------------


class TestCandidateNodeId:
    """Tests for :func:`interfaces._candidate_node_id`."""

    def test_none_returns_none(self):
        """None input returns None."""
        assert ifaces._candidate_node_id(None) is None

    def test_from_id_key(self):
        """fromId key resolves to canonical node ID."""
        result = ifaces._candidate_node_id({"fromId": "!aabbccdd"})
        assert result == "!aabbccdd"

    def test_node_num_key(self):
        """nodeNum integer key is canonicalised."""
        result = ifaces._candidate_node_id({"nodeNum": 0xAABBCCDD})
        assert result is not None
        assert result.startswith("!")

    def test_id_key_nodeish(self):
        """'id' key is resolved when it looks like a node identifier."""
        result = ifaces._candidate_node_id({"id": "!aabbccdd"})
        assert result == "!aabbccdd"

    def test_id_key_non_nodeish_skipped(self):
        """Non-nodeish 'id' values are ignored."""
        result = ifaces._candidate_node_id({"id": "not-an-id"})
        assert result is None

    def test_user_section_lookup(self):
        """Searches user sub-section for node ID."""
        result = ifaces._candidate_node_id({"user": {"id": "!aabbccdd"}})
        assert result == "!aabbccdd"

    def test_decoded_section_lookup(self):
        """Searches decoded sub-section for node ID."""
        result = ifaces._candidate_node_id({"decoded": {"fromId": "!aabbccdd"}})
        assert result == "!aabbccdd"

    def test_payload_section_lookup(self):
        """Searches payload sub-section for node ID."""
        result = ifaces._candidate_node_id({"payload": {"fromId": "!aabbccdd"}})
        assert result == "!aabbccdd"

    def test_empty_mapping_returns_none(self):
        """Mapping with no recognisable ID fields returns None."""
        assert ifaces._candidate_node_id({"foo": "bar"}) is None

    def test_list_value_scanned(self):
        """Node IDs inside list values are found."""
        result = ifaces._candidate_node_id({"items": [{"fromId": "!aabbccdd"}]})
        assert result == "!aabbccdd"


# ---------------------------------------------------------------------------
# _has_field
# ---------------------------------------------------------------------------


class TestHasField:
    """Tests for :func:`interfaces._has_field`."""

    def test_none_returns_false(self):
        """None message returns False."""
        assert ifaces._has_field(None, "anything") is False

    def test_has_field_callable_true(self):
        """HasField callable returning True is propagated."""
        msg = SimpleNamespace(HasField=lambda name: name == "lora")
        assert ifaces._has_field(msg, "lora") is True

    def test_has_field_callable_false(self):
        """HasField callable returning False is propagated."""
        msg = SimpleNamespace(HasField=lambda name: False)
        assert ifaces._has_field(msg, "lora") is False

    def test_no_has_field_but_attr_present(self):
        """Falls back to hasattr when HasField is absent."""
        msg = SimpleNamespace(lora=object())
        assert ifaces._has_field(msg, "lora") is True

    def test_no_has_field_attr_absent(self):
        """Returns False when both HasField and the attribute are absent."""
        assert ifaces._has_field(SimpleNamespace(), "lora") is False


# ---------------------------------------------------------------------------
# _enum_name_from_field
# ---------------------------------------------------------------------------


class TestEnumNameFromField:
    """Tests for :func:`interfaces._enum_name_from_field`."""

    def test_no_descriptor_returns_none(self):
        """Message without DESCRIPTOR returns None."""
        assert ifaces._enum_name_from_field(object(), "region", 1) is None

    def test_field_not_in_descriptor(self):
        """Unknown field name returns None."""
        desc = SimpleNamespace(fields_by_name={})
        msg = SimpleNamespace(DESCRIPTOR=desc)
        assert ifaces._enum_name_from_field(msg, "region", 1) is None

    def test_no_enum_type_returns_none(self):
        """Field without enum_type returns None."""
        field_desc = SimpleNamespace(enum_type=None)
        desc = SimpleNamespace(fields_by_name={"region": field_desc})
        msg = SimpleNamespace(DESCRIPTOR=desc)
        assert ifaces._enum_name_from_field(msg, "region", 1) is None

    def test_value_not_in_enum_returns_none(self):
        """Enum value not found in values_by_number returns None."""
        enum_type = SimpleNamespace(values_by_number={})
        field_desc = SimpleNamespace(enum_type=enum_type)
        desc = SimpleNamespace(fields_by_name={"region": field_desc})
        msg = SimpleNamespace(DESCRIPTOR=desc)
        assert ifaces._enum_name_from_field(msg, "region", 99) is None

    def test_valid_lookup(self):
        """Returns the enum value name for a known numeric value."""
        enum_val = SimpleNamespace(name="US_915")
        enum_type = SimpleNamespace(values_by_number={3: enum_val})
        field_desc = SimpleNamespace(enum_type=enum_type)
        desc = SimpleNamespace(fields_by_name={"region": field_desc})
        msg = SimpleNamespace(DESCRIPTOR=desc)
        assert ifaces._enum_name_from_field(msg, "region", 3) == "US_915"


# ---------------------------------------------------------------------------
# _region_frequency
# ---------------------------------------------------------------------------


class TestRegionFrequency:
    """Tests for :func:`interfaces._region_frequency`."""

    def test_none_returns_none(self):
        """None input returns None."""
        assert ifaces._region_frequency(None) is None

    def test_numeric_override_frequency(self):
        """Positive numeric override_frequency is floored to MHz."""
        msg = SimpleNamespace(override_frequency=915.8, region=None)
        assert ifaces._region_frequency(msg) == 915

    def test_zero_override_frequency_falls_through(self):
        """Zero override_frequency is ignored."""
        msg = SimpleNamespace(override_frequency=0, region=None)
        assert ifaces._region_frequency(msg) is None

    def test_string_override_frequency(self):
        """Non-empty string override_frequency is returned as-is."""
        msg = SimpleNamespace(override_frequency="915MHz", region=None)
        assert ifaces._region_frequency(msg) == "915MHz"

    def test_enum_name_with_freq_digits(self):
        """Extracts MHz frequency from enum name like US_915."""
        enum_val = SimpleNamespace(name="US_915")
        enum_type = SimpleNamespace(values_by_number={1: enum_val})
        field_desc = SimpleNamespace(enum_type=enum_type)
        desc = SimpleNamespace(fields_by_name={"region": field_desc})
        msg = SimpleNamespace(DESCRIPTOR=desc, override_frequency=None, region=1)
        assert ifaces._region_frequency(msg) == 915

    def test_enum_name_without_large_digit_returns_name(self):
        """Enum name with only small digits returns the full name string."""
        enum_val = SimpleNamespace(name="BAND_24")
        enum_type = SimpleNamespace(values_by_number={2: enum_val})
        field_desc = SimpleNamespace(enum_type=enum_type)
        desc = SimpleNamespace(fields_by_name={"region": field_desc})
        msg = SimpleNamespace(DESCRIPTOR=desc, override_frequency=None, region=2)
        # 24 < 100, so falls through to reversed digits → returns 24
        assert ifaces._region_frequency(msg) == 24

    def test_large_integer_region_returned(self):
        """Integer region value >= 100 is returned directly."""
        msg = SimpleNamespace(DESCRIPTOR=None, override_frequency=None, region=433)
        assert ifaces._region_frequency(msg) == 433

    def test_string_region_returned(self):
        """Non-empty string region is returned directly."""
        msg = SimpleNamespace(DESCRIPTOR=None, override_frequency=None, region="EU433")
        assert ifaces._region_frequency(msg) == "EU433"


# ---------------------------------------------------------------------------
# _camelcase_enum_name
# ---------------------------------------------------------------------------


class TestCamelcaseEnumName:
    """Tests for :func:`interfaces._camelcase_enum_name`."""

    def test_none_returns_none(self):
        """None input returns None."""
        assert ifaces._camelcase_enum_name(None) is None

    def test_empty_string_returns_none(self):
        """Empty string returns None."""
        assert ifaces._camelcase_enum_name("") is None

    def test_screaming_snake(self):
        """SCREAMING_SNAKE_CASE is converted to CamelCase."""
        assert ifaces._camelcase_enum_name("LONG_FAST") == "LongFast"

    def test_single_word(self):
        """Single word is capitalised."""
        assert ifaces._camelcase_enum_name("SHORT") == "Short"

    def test_with_digits(self):
        """Digits in the name are preserved."""
        assert ifaces._camelcase_enum_name("BAND_915") == "Band915"


# ---------------------------------------------------------------------------
# _modem_preset
# ---------------------------------------------------------------------------


class TestModemPreset:
    """Tests for :func:`interfaces._modem_preset`."""

    def test_none_returns_none(self):
        """None lora_message returns None."""
        assert ifaces._modem_preset(None) is None

    def test_no_descriptor_no_attr_returns_none(self):
        """Message with neither descriptor nor modem_preset attr returns None."""

        class NoPreset:
            DESCRIPTOR = None

        assert ifaces._modem_preset(NoPreset()) is None

    def test_descriptor_modem_preset_field(self):
        """Finds modem_preset via DESCRIPTOR fields_by_name."""
        enum_val = SimpleNamespace(name="LONG_FAST")
        enum_type = SimpleNamespace(values_by_number={0: enum_val})
        field_desc = SimpleNamespace(enum_type=enum_type)
        desc = SimpleNamespace(fields_by_name={"modem_preset": field_desc})
        msg = SimpleNamespace(DESCRIPTOR=desc, modem_preset=0)
        assert ifaces._modem_preset(msg) == "LongFast"

    def test_attr_fallback(self):
        """Falls back to hasattr when DESCRIPTOR is absent."""
        msg = SimpleNamespace(modem_preset="LONG_FAST")
        # No DESCRIPTOR so enum lookup won't work, falls to string branch
        result = ifaces._modem_preset(msg)
        assert result == "LongFast"

    def test_preset_field_name_fallback(self):
        """'preset' field is used when 'modem_preset' is absent in descriptor."""
        enum_val = SimpleNamespace(name="SHORT_FAST")
        enum_type = SimpleNamespace(values_by_number={1: enum_val})
        field_desc = SimpleNamespace(enum_type=enum_type)
        desc = SimpleNamespace(fields_by_name={"preset": field_desc})
        msg = SimpleNamespace(DESCRIPTOR=desc, preset=1)
        assert ifaces._modem_preset(msg) == "ShortFast"


# ---------------------------------------------------------------------------
# _ensure_radio_metadata caching
# ---------------------------------------------------------------------------


class TestEnsureRadioMetadata:
    """Tests for :func:`interfaces._ensure_radio_metadata` caching behaviour."""

    def test_none_iface_is_noop(self, monkeypatch):
        """None interface does not touch config."""
        original_freq = config.LORA_FREQ
        original_preset = config.MODEM_PRESET
        ifaces._ensure_radio_metadata(None)
        assert config.LORA_FREQ == original_freq
        assert config.MODEM_PRESET == original_preset

    def test_sets_lora_freq_when_not_cached(self, monkeypatch):
        """Populates LORA_FREQ from interface when not yet configured."""
        monkeypatch.setattr(config, "LORA_FREQ", None)
        monkeypatch.setattr(config, "MODEM_PRESET", None)

        enum_val = SimpleNamespace(name="US_915")
        enum_type = SimpleNamespace(values_by_number={1: enum_val})
        region_field = SimpleNamespace(enum_type=enum_type)
        desc = SimpleNamespace(fields_by_name={"region": region_field})
        lora = SimpleNamespace(
            DESCRIPTOR=desc, region=1, override_frequency=None, modem_preset=None
        )
        local_config = SimpleNamespace(lora=lora, HasField=lambda f: f == "lora")
        local_node = SimpleNamespace(localConfig=local_config)
        iface = SimpleNamespace(localNode=local_node, waitForConfig=lambda: None)

        ifaces._ensure_radio_metadata(iface)
        assert config.LORA_FREQ == 915

    def test_does_not_overwrite_existing_freq(self, monkeypatch):
        """Does not overwrite LORA_FREQ when already set."""
        monkeypatch.setattr(config, "LORA_FREQ", 433)
        monkeypatch.setattr(config, "MODEM_PRESET", None)

        enum_val = SimpleNamespace(name="US_915")
        enum_type = SimpleNamespace(values_by_number={1: enum_val})
        region_field = SimpleNamespace(enum_type=enum_type)
        desc = SimpleNamespace(fields_by_name={"region": region_field})
        lora = SimpleNamespace(
            DESCRIPTOR=desc, region=1, override_frequency=None, modem_preset=None
        )
        local_config = SimpleNamespace(lora=lora, HasField=lambda f: f == "lora")
        local_node = SimpleNamespace(localConfig=local_config)
        iface = SimpleNamespace(localNode=local_node, waitForConfig=lambda: None)

        ifaces._ensure_radio_metadata(iface)
        assert config.LORA_FREQ == 433
