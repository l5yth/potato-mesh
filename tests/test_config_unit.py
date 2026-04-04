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
"""Unit tests for :mod:`data.mesh_ingestor.config`."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.config as config

# ---------------------------------------------------------------------------
# _parse_channel_names
# ---------------------------------------------------------------------------


class TestParseChannelNames:
    """Tests for :func:`config._parse_channel_names`."""

    def test_none_returns_empty(self):
        """None input returns empty tuple."""
        assert config._parse_channel_names(None) == ()

    def test_empty_string_returns_empty(self):
        """Empty string returns empty tuple."""
        assert config._parse_channel_names("") == ()

    def test_single_name(self):
        """Single channel name is returned as a one-element tuple."""
        assert config._parse_channel_names("LongFast") == ("LongFast",)

    def test_comma_separated(self):
        """Comma-separated names are split and returned."""
        result = config._parse_channel_names("LongFast,Chat")
        assert result == ("LongFast", "Chat")

    def test_strips_whitespace(self):
        """Leading/trailing whitespace around names is stripped."""
        result = config._parse_channel_names(" LongFast , Chat ")
        assert result == ("LongFast", "Chat")

    def test_deduplicates_case_insensitively(self):
        """Duplicate names (case-insensitively) are deduplicated."""
        result = config._parse_channel_names("LongFast,longfast,LONGFAST")
        assert result == ("LongFast",)

    def test_preserves_order(self):
        """Original order is preserved, first occurrence kept on dedup."""
        result = config._parse_channel_names("B,A,B,C")
        assert result == ("B", "A", "C")

    def test_empty_segments_skipped(self):
        """Empty segments from consecutive commas are skipped."""
        result = config._parse_channel_names("A,,B,,,C")
        assert result == ("A", "B", "C")


# ---------------------------------------------------------------------------
# _parse_hidden_channels
# ---------------------------------------------------------------------------


class TestParseHiddenChannels:
    """Tests for :func:`config._parse_hidden_channels`."""

    def test_delegates_to_parse_channel_names(self):
        """_parse_hidden_channels delegates to _parse_channel_names."""
        assert config._parse_hidden_channels(
            "Chat,Admin"
        ) == config._parse_channel_names("Chat,Admin")

    def test_none_returns_empty(self):
        """None input returns empty tuple."""
        assert config._parse_hidden_channels(None) == ()


# ---------------------------------------------------------------------------
# _resolve_instance_domain
# ---------------------------------------------------------------------------


class TestResolveInstanceDomain:
    """Tests for :func:`config._resolve_instance_domain`."""

    def test_returns_instance_domain_when_set(self, monkeypatch):
        """Uses INSTANCE_DOMAIN when set."""
        monkeypatch.setenv("INSTANCE_DOMAIN", "mesh.example.com")
        monkeypatch.delenv("POTATOMESH_INSTANCE", raising=False)
        result = config._resolve_instance_domain()
        assert result == "https://mesh.example.com"

    def test_adds_https_when_no_scheme(self, monkeypatch):
        """Adds https:// prefix when no scheme is present."""
        monkeypatch.setenv("INSTANCE_DOMAIN", "example.com")
        monkeypatch.delenv("POTATOMESH_INSTANCE", raising=False)
        assert config._resolve_instance_domain() == "https://example.com"

    def test_preserves_existing_scheme(self, monkeypatch):
        """Leaves existing http:// scheme intact."""
        monkeypatch.setenv("INSTANCE_DOMAIN", "http://example.com")
        monkeypatch.delenv("POTATOMESH_INSTANCE", raising=False)
        assert config._resolve_instance_domain() == "http://example.com"

    def test_strips_trailing_slash(self, monkeypatch):
        """Strips trailing slash from instance domain."""
        monkeypatch.setenv("INSTANCE_DOMAIN", "https://example.com/")
        monkeypatch.delenv("POTATOMESH_INSTANCE", raising=False)
        assert config._resolve_instance_domain() == "https://example.com"

    def test_falls_back_to_legacy_env(self, monkeypatch):
        """Falls back to POTATOMESH_INSTANCE when INSTANCE_DOMAIN is absent."""
        monkeypatch.delenv("INSTANCE_DOMAIN", raising=False)
        monkeypatch.setenv("POTATOMESH_INSTANCE", "legacy.example.com")
        result = config._resolve_instance_domain()
        assert result == "https://legacy.example.com"

    def test_returns_empty_when_neither_set(self, monkeypatch):
        """Returns empty string when neither env var is set."""
        monkeypatch.delenv("INSTANCE_DOMAIN", raising=False)
        monkeypatch.delenv("POTATOMESH_INSTANCE", raising=False)
        assert config._resolve_instance_domain() == ""


# ---------------------------------------------------------------------------
# _debug_log
# ---------------------------------------------------------------------------


class TestDebugLog:
    """Tests for :func:`config._debug_log`."""

    def test_suppressed_when_debug_false(self, monkeypatch, capsys):
        """Nothing is printed when DEBUG is False and severity is debug."""
        monkeypatch.setattr(config, "DEBUG", False)
        config._debug_log("silent", severity="debug")
        assert capsys.readouterr().out == ""

    def test_prints_when_debug_true(self, monkeypatch, capsys):
        """Message is printed when DEBUG is True."""
        monkeypatch.setattr(config, "DEBUG", True)
        config._debug_log("hello world")
        out = capsys.readouterr().out
        assert "hello world" in out

    def test_always_flag_bypasses_debug_guard(self, monkeypatch, capsys):
        """always=True forces output even when DEBUG is False."""
        monkeypatch.setattr(config, "DEBUG", False)
        config._debug_log("force print", always=True)
        out = capsys.readouterr().out
        assert "force print" in out

    def test_context_included_in_output(self, monkeypatch, capsys):
        """Context label is included in log output."""
        monkeypatch.setattr(config, "DEBUG", True)
        config._debug_log("msg", context="test.ctx")
        out = capsys.readouterr().out
        assert "context=test.ctx" in out

    def test_severity_included_in_output(self, monkeypatch, capsys):
        """Severity level is included in log output."""
        monkeypatch.setattr(config, "DEBUG", True)
        config._debug_log("msg", severity="warn")
        out = capsys.readouterr().out
        assert "[warn]" in out

    def test_metadata_included_in_output(self, monkeypatch, capsys):
        """Additional metadata key=value pairs are included in output."""
        monkeypatch.setattr(config, "DEBUG", True)
        config._debug_log("msg", node_id="!aabb1234")
        out = capsys.readouterr().out
        assert "node_id=" in out

    def test_warn_severity_printed_even_when_debug_false(self, monkeypatch, capsys):
        """Non-debug severity is printed regardless of DEBUG flag."""
        monkeypatch.setattr(config, "DEBUG", False)
        config._debug_log("warn msg", severity="warn")
        out = capsys.readouterr().out
        assert "warn msg" in out


# ---------------------------------------------------------------------------
# PROVIDER validation
# ---------------------------------------------------------------------------


class TestProviderValidation:
    """Tests for PROVIDER environment validation at import time."""

    def test_valid_provider_does_not_raise(self, monkeypatch):
        """Importing config with a valid PROVIDER succeeds."""
        import importlib

        monkeypatch.setenv("PROVIDER", "meshtastic")
        # Re-importing should not raise
        importlib.reload(config)

    def test_invalid_provider_raises_value_error(self, monkeypatch):
        """An invalid PROVIDER value raises ValueError at module load."""
        import importlib

        monkeypatch.setenv("PROVIDER", "bogus_provider_xyz")
        with pytest.raises(ValueError, match="Unknown PROVIDER"):
            importlib.reload(config)
        # Restore to valid value so subsequent tests work
        monkeypatch.setenv("PROVIDER", "meshtastic")
        importlib.reload(config)


# ---------------------------------------------------------------------------
# _ConfigModule proxy
# ---------------------------------------------------------------------------


class TestConfigModuleProxy:
    """Tests for the :class:`config._ConfigModule` proxy behaviour."""

    def test_connection_and_port_stay_in_sync(self):
        """Setting CONNECTION also updates PORT and vice versa."""
        original_connection = config.CONNECTION
        original_port = config.PORT
        try:
            config.CONNECTION = "tcp://testhost"
            assert config.PORT == "tcp://testhost"
            config.PORT = "serial:/dev/ttyUSB0"
            assert config.CONNECTION == "serial:/dev/ttyUSB0"
        finally:
            config.CONNECTION = original_connection
            config.PORT = original_port
