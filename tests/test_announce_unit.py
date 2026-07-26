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
"""Unit tests for :mod:`data.mesh_ingestor.announce` (SPEC MA6).

Covers the character-limited announcement message builder and the read-only
*dogfeed* HTTP client (fetch the instance's own ``/version`` and ``/api/stats``),
including the fail-soft behaviour on network / shape errors.
"""

from __future__ import annotations

import json
import sys
import urllib.error
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.announce as announce


class _FakeResponse:
    """Minimal context-manager stand-in for an ``http.client.HTTPResponse``."""

    def __init__(self, body: str):
        self._body = body.encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def read(self):
        return self._body


def _install_fake_http(monkeypatch, url_to_payload):
    """Patch ``announce``'s ``urlopen`` to serve *url_to_payload* by URL."""

    def _fake_urlopen(req, timeout=None):
        url = getattr(req, "full_url", req)
        if url not in url_to_payload:
            raise urllib.error.URLError(f"no fake response for {url}")
        return _FakeResponse(json.dumps(url_to_payload[url]))

    monkeypatch.setattr(announce.urllib.request, "urlopen", _fake_urlopen)


# ---------------------------------------------------------------------------
# Message builder
# ---------------------------------------------------------------------------


class TestBuildAnnouncementMessage:
    """Tests for :func:`announce.build_announcement` (MA6)."""

    def test_message_format_matches_spec(self):
        """The announcement line matches the SPEC MA6 template exactly."""
        text = announce.build_announcement("meshcore", 12, 50, "https://mesh.example")
        assert text == (
            "MeshCore activity in the last 24h: 12 active nodes, "
            "50 packets/hour. https://mesh.example"
        )

    def test_message_uses_protocol_display_name(self):
        """Meshtastic renders its capitalised display name."""
        text = announce.build_announcement("meshtastic", 3, 7, "https://m")
        assert text.startswith("Meshtastic activity in the last 24h:")

    def test_message_truncates_to_protocol_char_limit(self):
        """An over-long line is clipped to the protocol's character limit."""
        long_url = "https://" + ("a" * 300) + ".example"
        text = announce.build_announcement("meshtastic", 5, 10, long_url)
        assert len(text) == announce.ANNOUNCE_CHAR_LIMITS["meshtastic"]

    def test_message_honours_explicit_char_limit(self):
        """An explicit ``char_limit`` overrides the per-protocol default."""
        text = announce.build_announcement(
            "meshcore", 5, 10, "https://x", char_limit=10
        )
        assert len(text) == 10

    def test_message_unknown_protocol_uses_fallback_limit(self):
        """An unrecognised protocol falls back to the default char limit."""
        long_url = "https://" + ("z" * 300)
        text = announce.build_announcement("reticulum", 1, 2, long_url)
        assert text.startswith("Reticulum activity")
        assert len(text) == announce._DEFAULT_CHAR_LIMIT


class TestProtocolDisplayName:
    """Tests for :func:`announce.protocol_display_name`."""

    def test_known_protocols(self):
        """Known keys map to their branded labels."""
        assert announce.protocol_display_name("meshcore") == "MeshCore"
        assert announce.protocol_display_name("meshtastic") == "Meshtastic"

    def test_unknown_protocol_is_capitalised(self):
        """An unknown key is capitalised as a best effort."""
        assert announce.protocol_display_name("reticulum") == "Reticulum"

    def test_empty_protocol_is_blank(self):
        """An empty/``None`` protocol yields an empty label."""
        assert announce.protocol_display_name("") == ""
        assert announce.protocol_display_name(None) == ""


# ---------------------------------------------------------------------------
# Dogfeed HTTP client
# ---------------------------------------------------------------------------


class TestDogfeedFetchActivity:
    """Tests for :func:`announce.fetch_activity` (MA6)."""

    def test_dogfeed_reads_nodes_and_packets_per_hour(self, monkeypatch):
        """Returns ``(<protocol>.nodes.day, <protocol>.packets.hour)``."""
        _install_fake_http(
            monkeypatch,
            {
                "https://mesh.example/api/stats": {
                    "meshcore": {
                        "nodes": {"day": 12, "hour": 3},
                        "packets": {"hour": 50},
                    },
                    "meshtastic": {"nodes": {"day": 99}, "packets": {"hour": 30}},
                },
            },
        )
        assert announce.fetch_activity("https://mesh.example", "meshcore") == (12, 50)

    def test_dogfeed_returns_none_when_packets_section_missing(self, monkeypatch):
        """A scope present but lacking a ``packets`` sub-object yields ``None``."""
        _install_fake_http(
            monkeypatch,
            {"https://mesh.example/api/stats": {"meshcore": {"nodes": {"day": 1}}}},
        )
        assert announce.fetch_activity("https://mesh.example", "meshcore") is None

    def test_dogfeed_returns_none_when_nodes_object_missing(self, monkeypatch):
        """A scope present but lacking a ``nodes`` sub-object yields ``None``."""
        _install_fake_http(
            monkeypatch,
            {
                "https://mesh.example/api/stats": {
                    "meshcore": {"packets": {"hour": 50}},
                },
            },
        )
        assert announce.fetch_activity("https://mesh.example", "meshcore") is None

    def test_dogfeed_returns_none_on_non_integer_counts(self, monkeypatch):
        """Non-numeric counts are rejected as malformed."""
        _install_fake_http(
            monkeypatch,
            {
                "https://mesh.example/api/stats": {
                    "meshcore": {
                        "nodes": {"day": "lots"},
                        "packets": {"hour": 50},
                    },
                },
            },
        )
        assert announce.fetch_activity("https://mesh.example", "meshcore") is None

    def test_dogfeed_returns_none_on_non_numeric_packets(self, monkeypatch):
        """A valid node count but a non-numeric packets/hour yields ``None``."""
        _install_fake_http(
            monkeypatch,
            {
                "https://mesh.example/api/stats": {
                    "meshcore": {
                        "nodes": {"day": 5},
                        "packets": {"hour": "lots"},
                    },
                },
            },
        )
        assert announce.fetch_activity("https://mesh.example", "meshcore") is None

    def test_dogfeed_returns_none_on_network_error(self, monkeypatch):
        """A transport error fails soft to ``None``."""

        def _boom(req, timeout=None):
            raise urllib.error.URLError("boom")

        monkeypatch.setattr(announce.urllib.request, "urlopen", _boom)
        assert announce.fetch_activity("https://mesh.example", "meshtastic") is None


class TestDogfeedFetchPrivateMode:
    """Tests for :func:`announce.fetch_private_mode` (MA7 privacy gate)."""

    @pytest.mark.parametrize("flag", [True, False])
    def test_dogfeed_reads_private_mode_flag(self, monkeypatch, flag):
        """Reads ``config.private_mode`` from ``/version``."""
        _install_fake_http(
            monkeypatch,
            {"https://mesh.example/version": {"config": {"private_mode": flag}}},
        )
        assert announce.fetch_private_mode("https://mesh.example") is flag

    def test_dogfeed_missing_flag_returns_none(self, monkeypatch):
        """A response without the flag yields ``None`` (caller fails closed)."""
        _install_fake_http(
            monkeypatch,
            {"https://mesh.example/version": {"config": {"site_name": "x"}}},
        )
        assert announce.fetch_private_mode("https://mesh.example") is None

    def test_dogfeed_missing_config_block_returns_none(self, monkeypatch):
        """A response without a ``config`` block yields ``None``."""
        _install_fake_http(
            monkeypatch, {"https://mesh.example/version": {"version": "0.7.3"}}
        )
        assert announce.fetch_private_mode("https://mesh.example") is None

    def test_dogfeed_network_error_returns_none(self, monkeypatch):
        """A transport error fails soft to ``None`` (fail-closed input)."""

        def _boom(req, timeout=None):
            raise urllib.error.URLError("boom")

        monkeypatch.setattr(announce.urllib.request, "urlopen", _boom)
        assert announce.fetch_private_mode("https://mesh.example") is None


class TestDogfeedGetJson:
    """Tests for the low-level :func:`announce._get_json` helper."""

    def test_dogfeed_non_object_json_returns_none(self, monkeypatch):
        """A JSON array (not an object) is rejected."""
        _install_fake_http(monkeypatch, {"https://mesh.example/x": [1, 2, 3]})
        assert announce._get_json("https://mesh.example/x") is None


# ---------------------------------------------------------------------------
# Scheduling & gating (SPEC MA7/MA8)
# ---------------------------------------------------------------------------


class _RecordingProvider:
    """Fake provider that records ``send_channel_announcement`` calls."""

    def __init__(self):
        self.sent = []

    def send_channel_announcement(self, iface, text):
        self.sent.append((iface, text))


def _stub_dogfeed(monkeypatch, *, private=False, numbers=(12, 50)):
    """Patch the dogfeed fetchers to controlled return values (no HTTP)."""
    monkeypatch.setattr(announce, "fetch_private_mode", lambda url, **_kw: private)
    monkeypatch.setattr(announce, "fetch_activity", lambda url, proto, **_kw: numbers)


class TestAnnouncementGates:
    """Tests for :func:`announce.announcements_enabled` (SPEC MA7 a)."""

    def test_gate_enabled_by_default(self, monkeypatch):
        """Enabled when RX_ONLY is off (the default)."""
        monkeypatch.setattr(announce.config, "RX_ONLY", False)
        assert announce.announcements_enabled() is True

    def test_gate_disabled_when_rx_only(self, monkeypatch):
        """RX_ONLY (reused as the single transmit gate) forbids the announcement."""
        monkeypatch.setattr(announce.config, "RX_ONLY", True)
        assert announce.announcements_enabled() is False


class TestAnnounceDue:
    """Tests for :func:`announce.announce_due` (SPEC MA7 d / MA8)."""

    def test_gate_not_due_before_24h_elapsed(self):
        """Withheld until 24 h after start."""
        now = 1_000_000
        assert (
            announce.announce_due(start_time=now - 1000, last_announce=None, now=now)
            is False
        )

    def test_due_after_24h_elapsed(self):
        """Eligible once 24 h have elapsed since start."""
        now = 1_000_000
        assert (
            announce.announce_due(start_time=now - 90_000, last_announce=None, now=now)
            is True
        )

    def test_cadence_interval_blocks_second_within_24h(self):
        """A recent cycle blocks the next until the 24 h interval passes."""
        now = 1_000_000
        assert (
            announce.announce_due(
                start_time=now - 200_000, last_announce=now - 3600, now=now
            )
            is False
        )

    def test_cadence_due_again_after_24h_interval(self):
        """Due again once 24 h have elapsed since the previous cycle."""
        now = 1_000_000
        assert (
            announce.announce_due(
                start_time=now - 200_000, last_announce=now - 90_000, now=now
            )
            is True
        )


class TestSendAnnouncementToInstance:
    """Tests for :func:`announce.send_announcement_to_instance` (MA6/MA7)."""

    def test_sends_the_built_line_when_public(self, monkeypatch):
        """A public instance receives the dogfed announcement line."""
        _stub_dogfeed(monkeypatch, private=False, numbers=(12, 50))
        provider = _RecordingProvider()
        sent = announce.send_announcement_to_instance(
            provider, "IFACE", "https://mesh.example", "meshcore"
        )
        assert sent is True
        assert provider.sent == [
            (
                "IFACE",
                "MeshCore activity in the last 24h: 12 active nodes, "
                "50 packets/hour. https://mesh.example",
            )
        ]

    def test_private_instance_is_skipped_fail_closed(self, monkeypatch):
        """A private instance is skipped (nothing transmitted)."""
        _stub_dogfeed(monkeypatch, private=True)
        provider = _RecordingProvider()
        assert (
            announce.send_announcement_to_instance(
                provider, "I", "https://m", "meshcore"
            )
            is False
        )
        assert provider.sent == []

    def test_private_fetch_error_fails_closed(self, monkeypatch):
        """An unknown privacy state (None) is treated as private (fail-closed)."""
        _stub_dogfeed(monkeypatch, private=None)
        provider = _RecordingProvider()
        assert (
            announce.send_announcement_to_instance(
                provider, "I", "https://m", "meshcore"
            )
            is False
        )
        assert provider.sent == []

    def test_skips_when_activity_numbers_unavailable(self, monkeypatch):
        """No announcement when the stats dogfeed yields nothing."""
        monkeypatch.setattr(announce, "fetch_private_mode", lambda url, **_kw: False)
        monkeypatch.setattr(announce, "fetch_activity", lambda url, proto, **_kw: None)
        provider = _RecordingProvider()
        assert (
            announce.send_announcement_to_instance(
                provider, "I", "https://m", "meshcore"
            )
            is False
        )
        assert provider.sent == []

    def test_skips_when_provider_cannot_send(self, monkeypatch):
        """A provider without send_channel_announcement is a no-op."""
        _stub_dogfeed(monkeypatch, private=False, numbers=(1, 2))
        assert (
            announce.send_announcement_to_instance(
                object(), "I", "https://m", "meshcore"
            )
            is False
        )

    def test_logs_transmitting_with_full_context(self, monkeypatch):
        """Every outbound announcement emits an ``announce.tx`` debug line so the
        TX is traceable end-to-end (target, protocol, numbers, text)."""
        _stub_dogfeed(monkeypatch, private=False, numbers=(12, 50))
        logs = []
        monkeypatch.setattr(
            announce.config,
            "_debug_log",
            lambda message, **meta: logs.append((message, meta)),
        )
        announce.send_announcement_to_instance(
            _RecordingProvider(), "IFACE", "https://mesh.example", "meshcore"
        )
        transmit = [
            meta for msg, meta in logs if msg == "Activity announcement transmitting"
        ]
        assert len(transmit) == 1
        meta = transmit[0]
        assert meta["context"] == "announce.tx"
        assert meta["url"] == "https://mesh.example"
        assert meta["protocol"] == "meshcore"
        assert meta["active_nodes"] == 12
        assert meta["packets_per_hour"] == 50
        assert "packets/hour" in meta["text"]

    def test_logs_skip_reason_when_private(self, monkeypatch):
        """A skipped (private/unreachable) instance emits a skip debug line."""
        _stub_dogfeed(monkeypatch, private=True)
        logs = []
        monkeypatch.setattr(
            announce.config,
            "_debug_log",
            lambda message, **meta: logs.append((message, meta)),
        )
        announce.send_announcement_to_instance(
            _RecordingProvider(), "I", "https://m", "meshcore"
        )
        assert any("skipped: instance private" in msg for msg, _meta in logs)


class TestRunAnnouncementCycle:
    """Tests for :func:`announce.run_announcement_cycle` (SPEC MA8 per-domain)."""

    def test_domains_announces_each_configured_instance(self, monkeypatch):
        """Every configured instance is announced to, with its own link."""
        monkeypatch.setattr(
            announce.config, "INSTANCES", (("https://a", ""), ("https://b", ""))
        )
        monkeypatch.setattr(announce.config, "PROTOCOL", "meshtastic")
        _stub_dogfeed(monkeypatch, private=False, numbers=(3, 7))
        provider = _RecordingProvider()
        assert announce.run_announcement_cycle(provider, "IFACE") is True
        urls = [text.rsplit(" ", 1)[-1] for _iface, text in provider.sent]
        assert urls == ["https://a", "https://b"]

    def test_cycle_survives_one_instance_error(self, monkeypatch):
        """A failure against one instance never aborts the others."""
        monkeypatch.setattr(
            announce.config, "INSTANCES", (("https://bad", ""), ("https://good", ""))
        )
        monkeypatch.setattr(announce.config, "PROTOCOL", "meshcore")

        def _priv(url, **_kw):
            if url == "https://bad":
                raise RuntimeError("boom")
            return False

        monkeypatch.setattr(announce, "fetch_private_mode", _priv)
        monkeypatch.setattr(
            announce, "fetch_activity", lambda url, proto, **_kw: (1, 1)
        )
        provider = _RecordingProvider()
        assert announce.run_announcement_cycle(provider, "I") is True
        assert [t.rsplit(" ", 1)[-1] for _i, t in provider.sent] == ["https://good"]


class TestMaybeRunAnnouncements:
    """Tests for the daemon entry point :func:`announce.maybe_run_announcements`."""

    def test_gate_noop_when_not_enabled(self, monkeypatch):
        """No cycle runs and last_announce is unchanged when RX_ONLY forbids TX."""
        monkeypatch.setattr(announce.config, "RX_ONLY", True)
        ran = []
        monkeypatch.setattr(
            announce, "run_announcement_cycle", lambda *a, **k: ran.append(True)
        )
        result = announce.maybe_run_announcements(
            "P", "I", start_time=0, last_announce=42.0, now=1_000_000
        )
        assert result == 42.0
        assert ran == []

    def test_cadence_noop_when_not_due(self, monkeypatch):
        """No cycle runs before the 24 h delay; last_announce is unchanged."""
        monkeypatch.setattr(announce.config, "RX_ONLY", False)
        ran = []
        monkeypatch.setattr(
            announce, "run_announcement_cycle", lambda *a, **k: ran.append(True)
        )
        now = 1_000_000
        result = announce.maybe_run_announcements(
            "P", "I", start_time=now - 1000, last_announce=None, now=now
        )
        assert result is None
        assert ran == []

    def test_cadence_runs_cycle_and_advances_timestamp(self, monkeypatch):
        """When due, the cycle runs and last_announce advances to now."""
        monkeypatch.setattr(announce.config, "RX_ONLY", False)
        ran = []
        monkeypatch.setattr(
            announce,
            "run_announcement_cycle",
            lambda provider, iface, **k: ran.append((provider, iface)) or True,
        )
        now = 1_000_000
        result = announce.maybe_run_announcements(
            "P", "IFACE", start_time=now - 90_000, last_announce=None, now=now
        )
        assert result == now
        assert ran == [("P", "IFACE")]

    def test_cadence_defaults_now_to_wall_clock(self, monkeypatch):
        """With ``now`` omitted the current wall clock is used (gate-off path)."""
        monkeypatch.setattr(announce.config, "RX_ONLY", True)
        result = announce.maybe_run_announcements(
            "P", "I", start_time=0, last_announce=7.0
        )
        assert result == 7.0
