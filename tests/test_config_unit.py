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


class TestResolveInstanceDomains:
    """Tests for :func:`config._resolve_instance_domains`."""

    def test_single_domain(self, monkeypatch):
        """Single domain produces one-element tuple."""
        monkeypatch.setenv("INSTANCE_DOMAIN", "foo.tld")
        monkeypatch.setenv("API_TOKEN", "secret")
        result = config._resolve_instance_domains()
        assert result == (("https://foo.tld", "secret"),)

    def test_multi_domain_broadcast_token(self, monkeypatch):
        """Multiple domains with a single token broadcast the token."""
        monkeypatch.setenv("INSTANCE_DOMAIN", "foo.tld, bar.tld")
        monkeypatch.setenv("API_TOKEN", "shared")
        result = config._resolve_instance_domains()
        assert result == (
            ("https://foo.tld", "shared"),
            ("https://bar.tld", "shared"),
        )

    def test_multi_domain_per_instance_tokens(self, monkeypatch):
        """Comma-separated tokens are positionally paired with domains."""
        monkeypatch.setenv("INSTANCE_DOMAIN", "a.tld,b.tld")
        monkeypatch.setenv("API_TOKEN", "tok1,tok2")
        result = config._resolve_instance_domains()
        assert result == (("https://a.tld", "tok1"), ("https://b.tld", "tok2"))

    def test_token_count_mismatch_raises(self, monkeypatch):
        """Mismatched counts raise ValueError at parse time."""
        monkeypatch.setenv("INSTANCE_DOMAIN", "a.tld,b.tld")
        monkeypatch.setenv("API_TOKEN", "t1,t2,t3")
        with pytest.raises(ValueError, match="counts must match"):
            config._resolve_instance_domains()

    def test_deduplicates_domains(self, monkeypatch):
        """Duplicate domains are collapsed to a single entry."""
        monkeypatch.setenv("INSTANCE_DOMAIN", "foo.tld, foo.tld")
        monkeypatch.setenv("API_TOKEN", "tok")
        result = config._resolve_instance_domains()
        assert result == (("https://foo.tld", "tok"),)

    def test_preserves_explicit_scheme(self, monkeypatch):
        """Domains with explicit schemes keep them; others get https://."""
        monkeypatch.setenv("INSTANCE_DOMAIN", "http://local:41447,bar.tld")
        monkeypatch.setenv("API_TOKEN", "tok")
        result = config._resolve_instance_domains()
        assert result == (
            ("http://local:41447", "tok"),
            ("https://bar.tld", "tok"),
        )

    def test_empty_domain(self, monkeypatch):
        """Empty INSTANCE_DOMAIN returns an empty tuple."""
        monkeypatch.setenv("INSTANCE_DOMAIN", "")
        monkeypatch.setenv("API_TOKEN", "tok")
        result = config._resolve_instance_domains()
        assert result == ()

    def test_strips_trailing_slashes(self, monkeypatch):
        """Trailing slashes are stripped from domains."""
        monkeypatch.setenv("INSTANCE_DOMAIN", "foo.tld/")
        monkeypatch.setenv("API_TOKEN", "tok")
        result = config._resolve_instance_domains()
        assert result == (("https://foo.tld", "tok"),)

    def test_empty_token_broadcast(self, monkeypatch):
        """Empty API_TOKEN broadcasts empty string to all instances."""
        monkeypatch.setenv("INSTANCE_DOMAIN", "a.tld,b.tld")
        monkeypatch.setenv("API_TOKEN", "")
        result = config._resolve_instance_domains()
        assert result == (("https://a.tld", ""), ("https://b.tld", ""))


# ---------------------------------------------------------------------------
# _resolve_instance_domain (legacy, kept for backward compatibility)
# ---------------------------------------------------------------------------


class TestResolveInstanceDomain:
    """Tests for :func:`config._resolve_instance_domain`."""

    def test_returns_instance_domain_when_set(self, monkeypatch):
        """Uses INSTANCE_DOMAIN when set."""
        monkeypatch.setenv("INSTANCE_DOMAIN", "mesh.example.com")
        result = config._resolve_instance_domain()
        assert result == "https://mesh.example.com"

    def test_adds_https_when_no_scheme(self, monkeypatch):
        """Adds https:// prefix when no scheme is present."""
        monkeypatch.setenv("INSTANCE_DOMAIN", "example.com")
        assert config._resolve_instance_domain() == "https://example.com"

    def test_preserves_existing_scheme(self, monkeypatch):
        """Leaves existing http:// scheme intact."""
        monkeypatch.setenv("INSTANCE_DOMAIN", "http://example.com")
        assert config._resolve_instance_domain() == "http://example.com"

    def test_strips_trailing_slash(self, monkeypatch):
        """Strips trailing slash from instance domain."""
        monkeypatch.setenv("INSTANCE_DOMAIN", "https://example.com/")
        assert config._resolve_instance_domain() == "https://example.com"

    def test_returns_empty_when_not_set(self, monkeypatch):
        """Returns empty string when INSTANCE_DOMAIN is unset."""
        monkeypatch.delenv("INSTANCE_DOMAIN", raising=False)
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
# PROTOCOL validation
# ---------------------------------------------------------------------------


class TestProtocolValidation:
    """Tests for PROTOCOL environment validation at import time."""

    def test_valid_protocol_does_not_raise(self, monkeypatch):
        """Importing config with a valid PROTOCOL succeeds."""
        import importlib

        monkeypatch.setenv("PROTOCOL", "meshtastic")
        # Re-importing should not raise
        importlib.reload(config)

    def test_invalid_protocol_raises_value_error(self, monkeypatch):
        """An invalid PROTOCOL value raises ValueError at module load."""
        import importlib

        monkeypatch.setenv("PROTOCOL", "bogus_protocol_xyz")
        with pytest.raises(ValueError, match="Unknown PROTOCOL"):
            importlib.reload(config)
        # Restore to valid value so subsequent tests work
        monkeypatch.setenv("PROTOCOL", "meshtastic")
        importlib.reload(config)


# ---------------------------------------------------------------------------
# _parse_lora_freq_env
# ---------------------------------------------------------------------------


class TestParseLoraFreqEnv:
    """Tests for :func:`config._parse_lora_freq_env`."""

    def test_none_returns_none(self):
        """None input returns None."""
        assert config._parse_lora_freq_env(None) is None

    def test_empty_string_returns_none(self):
        """Empty string returns None."""
        assert config._parse_lora_freq_env("") is None

    def test_whitespace_only_returns_none(self):
        """Whitespace-only string returns None."""
        assert config._parse_lora_freq_env("   ") is None

    def test_integer_string_returns_int(self):
        """Whole-number string returns int."""
        result = config._parse_lora_freq_env("868")
        assert result == 868
        assert isinstance(result, int)

    def test_float_integer_value_returns_int(self):
        """String like '915.0' (whole float) returns int 915."""
        result = config._parse_lora_freq_env("915.0")
        assert result == 915
        assert isinstance(result, int)

    def test_decimal_string_returns_float(self):
        """Decimal string returns float."""
        result = config._parse_lora_freq_env("869.525")
        assert result == pytest.approx(869.525)
        assert isinstance(result, float)

    def test_non_numeric_label_returns_none(self):
        """Non-numeric string returns None so auto-detection is not blocked."""
        assert config._parse_lora_freq_env("EU_868") is None

    def test_unit_suffixed_string_returns_none(self):
        """String like '915MHz' returns None (not numeric)."""
        assert config._parse_lora_freq_env("915MHz") is None

    def test_inf_returns_none(self):
        """'inf' is non-finite and returns None."""
        assert config._parse_lora_freq_env("inf") is None

    def test_large_exponent_returns_none(self):
        """'1e309' overflows to inf and returns None."""
        assert config._parse_lora_freq_env("1e309") is None

    def test_nan_returns_none(self):
        """'nan' is non-finite and returns None."""
        assert config._parse_lora_freq_env("nan") is None

    def test_whitespace_stripped(self):
        """Leading/trailing whitespace is ignored."""
        assert config._parse_lora_freq_env("  919  ") == 919

    def test_frequency_env_preseeds_lora_freq(self, monkeypatch):
        """FREQUENCY env var pre-seeds LORA_FREQ at module load."""
        import importlib

        monkeypatch.setenv("FREQUENCY", "915")
        importlib.reload(config)
        assert config.LORA_FREQ == 915
        # Restore
        monkeypatch.delenv("FREQUENCY")
        importlib.reload(config)

    def test_no_frequency_env_leaves_lora_freq_none(self, monkeypatch):
        """Absent FREQUENCY env var leaves LORA_FREQ as None."""
        import importlib

        monkeypatch.delenv("FREQUENCY", raising=False)
        importlib.reload(config)
        assert config.LORA_FREQ is None
