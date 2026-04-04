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
"""Unit tests for :mod:`data.mesh_ingestor.channels`."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.channels as channels
import data.mesh_ingestor.config as config


@pytest.fixture(autouse=True)
def reset_channel_cache():
    """Ensure channel cache is cleared between tests."""
    channels._reset_channel_cache()
    yield
    channels._reset_channel_cache()


# ---------------------------------------------------------------------------
# _iter_channel_objects
# ---------------------------------------------------------------------------


class TestIterChannelObjects:
    """Tests for :func:`channels._iter_channel_objects`."""

    def test_none_returns_empty(self):
        """None input yields no items."""
        assert list(channels._iter_channel_objects(None)) == []

    def test_dict_yields_values(self):
        """Dict input yields values."""
        result = list(channels._iter_channel_objects({"a": 1, "b": 2}))
        assert sorted(result) == [1, 2]

    def test_list_yields_elements(self):
        """List input yields all elements."""
        items = [1, 2, 3]
        assert list(channels._iter_channel_objects(items)) == [1, 2, 3]

    def test_generator_yields_elements(self):
        """Generator input yields all elements."""
        result = list(channels._iter_channel_objects(x for x in [10, 20]))
        assert result == [10, 20]

    def test_object_with_len_and_getitem(self):
        """Object with __len__ and __getitem__ is iterated correctly."""

        class FakeSeq:
            def __len__(self):
                return 3

            def __getitem__(self, idx):
                return idx * 10

        result = list(channels._iter_channel_objects(FakeSeq()))
        assert result == [0, 10, 20]

    def test_non_iterable_without_len_returns_empty(self):
        """Objects with neither iter protocol nor len/getitem yield nothing."""

        class Opaque:
            pass

        assert list(channels._iter_channel_objects(Opaque())) == []


# ---------------------------------------------------------------------------
# _primary_channel_name
# ---------------------------------------------------------------------------


class TestPrimaryChannelName:
    """Tests for :func:`channels._primary_channel_name`."""

    def test_returns_modem_preset_when_set(self, monkeypatch):
        """Returns MODEM_PRESET from config when available."""
        monkeypatch.setattr(config, "MODEM_PRESET", "LongFast")
        assert channels._primary_channel_name() == "LongFast"

    def test_strips_modem_preset_whitespace(self, monkeypatch):
        """MODEM_PRESET is stripped of surrounding whitespace."""
        monkeypatch.setattr(config, "MODEM_PRESET", "  MedFast  ")
        assert channels._primary_channel_name() == "MedFast"

    def test_falls_back_to_env_channel(self, monkeypatch):
        """Falls back to CHANNEL env var when MODEM_PRESET is absent."""
        monkeypatch.setattr(config, "MODEM_PRESET", None)
        monkeypatch.setenv("CHANNEL", "LongRange")
        assert channels._primary_channel_name() == "LongRange"

    def test_returns_none_when_both_absent(self, monkeypatch):
        """Returns None when neither MODEM_PRESET nor CHANNEL is set."""
        monkeypatch.setattr(config, "MODEM_PRESET", None)
        monkeypatch.delenv("CHANNEL", raising=False)
        assert channels._primary_channel_name() is None

    def test_empty_modem_preset_falls_back_to_env(self, monkeypatch):
        """Empty string MODEM_PRESET falls back to CHANNEL env var."""
        monkeypatch.setattr(config, "MODEM_PRESET", "")
        monkeypatch.setenv("CHANNEL", "LongRange")
        assert channels._primary_channel_name() == "LongRange"


# ---------------------------------------------------------------------------
# _extract_channel_name
# ---------------------------------------------------------------------------


class TestExtractChannelName:
    """Tests for :func:`channels._extract_channel_name`."""

    def test_none_returns_none(self):
        """None input returns None."""
        assert channels._extract_channel_name(None) is None

    def test_dict_with_name(self):
        """Dict with 'name' key returns stripped name."""
        assert channels._extract_channel_name({"name": "  LongFast  "}) == "LongFast"

    def test_object_with_name_attr(self):
        """Object with name attribute returns stripped name."""
        obj = SimpleNamespace(name="Chat")
        assert channels._extract_channel_name(obj) == "Chat"

    def test_empty_name_returns_none(self):
        """Empty name string returns None."""
        assert channels._extract_channel_name({"name": "  "}) is None

    def test_missing_name_returns_none(self):
        """Object without name attribute returns None."""
        assert channels._extract_channel_name(SimpleNamespace()) is None

    def test_none_name_returns_none(self):
        """None name value returns None."""
        assert channels._extract_channel_name({"name": None}) is None


# ---------------------------------------------------------------------------
# _normalize_role
# ---------------------------------------------------------------------------


class TestNormalizeRole:
    """Tests for :func:`channels._normalize_role`."""

    def test_integer_passthrough(self):
        """Integer values are returned unchanged."""
        assert channels._normalize_role(1) == 1
        assert channels._normalize_role(2) == 2

    def test_string_primary(self):
        """'PRIMARY' string maps to _ROLE_PRIMARY."""
        assert channels._normalize_role("PRIMARY") == channels._ROLE_PRIMARY

    def test_string_secondary(self):
        """'SECONDARY' string maps to _ROLE_SECONDARY."""
        assert channels._normalize_role("SECONDARY") == channels._ROLE_SECONDARY

    def test_string_case_insensitive(self):
        """Role strings are case-insensitive."""
        assert channels._normalize_role("primary") == channels._ROLE_PRIMARY
        assert channels._normalize_role("Secondary") == channels._ROLE_SECONDARY

    def test_string_numeric(self):
        """Numeric strings are coerced to int."""
        assert channels._normalize_role("1") == 1

    def test_string_invalid_returns_none(self):
        """Non-numeric, non-role strings return None."""
        assert channels._normalize_role("unknown") is None

    def test_object_with_name_attr(self):
        """Objects with a 'name' attribute delegate to string handling."""
        obj = SimpleNamespace(name="PRIMARY")
        assert channels._normalize_role(obj) == channels._ROLE_PRIMARY

    def test_object_with_value_attr(self):
        """Objects with an integer 'value' attribute return that value."""
        obj = SimpleNamespace(value=2)
        assert channels._normalize_role(obj) == 2

    def test_coercible_object(self):
        """Objects coercible to int return their integer value."""

        class IntLike:
            def __int__(self):
                return 3

        assert channels._normalize_role(IntLike()) == 3

    def test_uncoercible_object_returns_none(self):
        """Objects not coercible to int return None."""
        assert channels._normalize_role(object()) is None


# ---------------------------------------------------------------------------
# _channel_tuple
# ---------------------------------------------------------------------------


class TestChannelTuple:
    """Tests for :func:`channels._channel_tuple`."""

    def test_primary_channel_with_name(self, monkeypatch):
        """Primary role with settings name returns (0, name)."""
        monkeypatch.setattr(config, "MODEM_PRESET", None)
        obj = SimpleNamespace(
            role=channels._ROLE_PRIMARY,
            settings=SimpleNamespace(name="LongFast"),
        )
        assert channels._channel_tuple(obj) == (0, "LongFast")

    def test_primary_channel_falls_back_to_preset(self, monkeypatch):
        """Primary channel with no name falls back to MODEM_PRESET."""
        monkeypatch.setattr(config, "MODEM_PRESET", "ShortFast")
        obj = SimpleNamespace(
            role=channels._ROLE_PRIMARY, settings=SimpleNamespace(name="")
        )
        result = channels._channel_tuple(obj)
        assert result == (0, "ShortFast")

    def test_secondary_channel(self):
        """Secondary role with index and name returns (index, name)."""
        obj = SimpleNamespace(
            role=channels._ROLE_SECONDARY,
            index=3,
            settings=SimpleNamespace(name="Chat"),
        )
        assert channels._channel_tuple(obj) == (3, "Chat")

    def test_unknown_role_returns_none(self):
        """Unrecognised roles return None."""
        obj = SimpleNamespace(role=99, index=0, settings=SimpleNamespace(name="X"))
        assert channels._channel_tuple(obj) is None

    def test_secondary_without_valid_index_returns_none(self):
        """Secondary channel with no valid index returns None."""
        obj = SimpleNamespace(
            role=channels._ROLE_SECONDARY,
            index="bad",
            settings=SimpleNamespace(name="Chat"),
        )
        assert channels._channel_tuple(obj) is None

    def test_secondary_without_name_returns_none(self):
        """Secondary channel with no name returns None."""
        obj = SimpleNamespace(
            role=channels._ROLE_SECONDARY,
            index=1,
            settings=SimpleNamespace(name=""),
        )
        assert channels._channel_tuple(obj) is None


# ---------------------------------------------------------------------------
# capture_from_interface
# ---------------------------------------------------------------------------


class TestCaptureFromInterface:
    """Tests for :func:`channels.capture_from_interface`."""

    def _make_iface(self, channel_list):
        local_node = SimpleNamespace(channels=channel_list)
        return SimpleNamespace(localNode=local_node, waitForConfig=lambda: None)

    def test_none_iface_is_noop(self):
        """None interface is silently ignored."""
        channels.capture_from_interface(None)
        assert channels.channel_mappings() == ()

    def test_captures_primary_and_secondary(self):
        """Both primary and secondary channels are captured."""
        iface = self._make_iface(
            [
                SimpleNamespace(
                    role=channels._ROLE_PRIMARY,
                    settings=SimpleNamespace(name="LongFast"),
                ),
                SimpleNamespace(
                    role=channels._ROLE_SECONDARY,
                    index=1,
                    settings=SimpleNamespace(name="Chat"),
                ),
            ]
        )
        channels.capture_from_interface(iface)
        mappings = channels.channel_mappings()
        assert (0, "LongFast") in mappings
        assert (1, "Chat") in mappings

    def test_subsequent_calls_are_noops_when_cached(self):
        """Second call with different interface is ignored once cached."""
        iface1 = self._make_iface(
            [
                SimpleNamespace(
                    role=channels._ROLE_PRIMARY, settings=SimpleNamespace(name="First")
                ),
            ]
        )
        iface2 = self._make_iface(
            [
                SimpleNamespace(
                    role=channels._ROLE_PRIMARY, settings=SimpleNamespace(name="Second")
                ),
            ]
        )
        channels.capture_from_interface(iface1)
        channels.capture_from_interface(iface2)
        assert channels.channel_name(0) == "First"

    def test_deduplicates_indices(self):
        """Duplicate channel indices keep the first seen entry."""
        iface = self._make_iface(
            [
                SimpleNamespace(
                    role=channels._ROLE_SECONDARY,
                    index=1,
                    settings=SimpleNamespace(name="A"),
                ),
                SimpleNamespace(
                    role=channels._ROLE_SECONDARY,
                    index=1,
                    settings=SimpleNamespace(name="B"),
                ),
            ]
        )
        channels.capture_from_interface(iface)
        assert channels.channel_name(1) == "A"

    def test_empty_channels_does_not_set_cache(self):
        """No valid channels leaves the cache empty."""
        iface = self._make_iface([])
        channels.capture_from_interface(iface)
        assert channels.channel_mappings() == ()


# ---------------------------------------------------------------------------
# is_allowed_channel / is_hidden_channel
# ---------------------------------------------------------------------------


class TestIsAllowedChannel:
    """Tests for :func:`channels.is_allowed_channel`."""

    def test_no_allowlist_permits_all(self, monkeypatch):
        """When ALLOWED_CHANNELS is empty, all channels are allowed."""
        monkeypatch.setattr(config, "ALLOWED_CHANNELS", ())
        assert channels.is_allowed_channel("anything") is True

    def test_allowlist_permits_matching_name(self, monkeypatch):
        """A matching name is allowed."""
        monkeypatch.setattr(config, "ALLOWED_CHANNELS", ("LongFast",))
        assert channels.is_allowed_channel("LongFast") is True

    def test_allowlist_case_insensitive(self, monkeypatch):
        """Channel name matching is case-insensitive."""
        monkeypatch.setattr(config, "ALLOWED_CHANNELS", ("longfast",))
        assert channels.is_allowed_channel("LongFast") is True

    def test_allowlist_blocks_non_matching(self, monkeypatch):
        """A non-matching name is rejected."""
        monkeypatch.setattr(config, "ALLOWED_CHANNELS", ("LongFast",))
        assert channels.is_allowed_channel("Chat") is False

    def test_none_rejected_when_allowlist_set(self, monkeypatch):
        """None is rejected when an allowlist is configured."""
        monkeypatch.setattr(config, "ALLOWED_CHANNELS", ("LongFast",))
        assert channels.is_allowed_channel(None) is False

    def test_empty_string_rejected_when_allowlist_set(self, monkeypatch):
        """Empty string is rejected when an allowlist is configured."""
        monkeypatch.setattr(config, "ALLOWED_CHANNELS", ("LongFast",))
        assert channels.is_allowed_channel("   ") is False


class TestIsHiddenChannel:
    """Tests for :func:`channels.is_hidden_channel`."""

    def test_none_not_hidden(self):
        """None is never considered hidden."""
        assert channels.is_hidden_channel(None) is False

    def test_empty_string_not_hidden(self):
        """Empty string is never considered hidden."""
        assert channels.is_hidden_channel("  ") is False

    def test_hidden_name_is_hidden(self, monkeypatch):
        """Configured hidden channel is detected."""
        monkeypatch.setattr(config, "HIDDEN_CHANNELS", ("Chat",))
        assert channels.is_hidden_channel("Chat") is True

    def test_hidden_case_insensitive(self, monkeypatch):
        """Hidden channel matching is case-insensitive."""
        monkeypatch.setattr(config, "HIDDEN_CHANNELS", ("chat",))
        assert channels.is_hidden_channel("CHAT") is True

    def test_non_hidden_name_not_hidden(self, monkeypatch):
        """Non-configured names are not hidden."""
        monkeypatch.setattr(config, "HIDDEN_CHANNELS", ("Chat",))
        assert channels.is_hidden_channel("LongFast") is False
