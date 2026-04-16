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
"""Unit tests for the :mod:`data.mesh_ingestor.handlers` subpackage."""

from __future__ import annotations

import base64
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.config as config
import data.mesh_ingestor.handlers as handlers
import data.mesh_ingestor.handlers._state as _state_mod
import data.mesh_ingestor.handlers.generic as generic_mod
import data.mesh_ingestor.handlers.ignored as ignored_mod
import data.mesh_ingestor.handlers.telemetry as telemetry_mod


@pytest.fixture(autouse=True)
def reset_handler_state():
    """Reset global handler state between tests."""
    _state_mod._host_node_id = None
    _state_mod._host_telemetry_last_rx = None
    _state_mod._host_nodeinfo_last_seen = None
    _state_mod._last_packet_monotonic = None
    yield
    _state_mod._host_node_id = None
    _state_mod._host_telemetry_last_rx = None
    _state_mod._host_nodeinfo_last_seen = None
    _state_mod._last_packet_monotonic = None


# ---------------------------------------------------------------------------
# _state: host_node_id / register_host_node_id
# ---------------------------------------------------------------------------


class TestHostNodeId:
    """Tests for host node ID state accessors."""

    def test_returns_none_initially(self):
        """host_node_id() returns None before registration."""
        assert handlers.host_node_id() is None

    def test_register_stores_canonical_id(self):
        """Registering a valid node ID stores it canonically."""
        handlers.register_host_node_id("!aabbccdd")
        assert handlers.host_node_id() == "!aabbccdd"

    def test_register_none_clears_id(self):
        """Registering None clears the stored host ID."""
        handlers.register_host_node_id("!aabbccdd")
        handlers.register_host_node_id(None)
        assert handlers.host_node_id() is None

    def test_register_resets_telemetry_window(self):
        """Registering a new host ID resets the telemetry suppression window."""
        _state_mod._host_telemetry_last_rx = 999_999
        handlers.register_host_node_id("!aabbccdd")
        assert _state_mod._host_telemetry_last_rx is None

    def test_register_resets_nodeinfo_window(self):
        """Registering a new host ID resets the NODEINFO suppression window."""
        _state_mod._host_nodeinfo_last_seen = 12345.0
        handlers.register_host_node_id("!aabbccdd")
        assert _state_mod._host_nodeinfo_last_seen is None

    def test_register_canonicalises_numeric(self):
        """Numeric node ID is converted to !xxxxxxxx form."""
        handlers.register_host_node_id(0xAABBCCDD)
        assert handlers.host_node_id() == "!aabbccdd"


# ---------------------------------------------------------------------------
# _state: last_packet_monotonic / _mark_packet_seen
# ---------------------------------------------------------------------------


class TestLastPacketMonotonic:
    """Tests for packet timestamp tracking."""

    def test_returns_none_initially(self):
        """Returns None before any packet is processed."""
        assert handlers.last_packet_monotonic() is None

    def test_updates_after_mark(self):
        """_mark_packet_seen() updates the monotonic timestamp."""
        _state_mod._mark_packet_seen()
        ts = handlers.last_packet_monotonic()
        assert ts is not None
        assert isinstance(ts, float)

    def test_mark_packet_seen_exported_from_handlers(self):
        """handlers._mark_packet_seen must be accessible via the package."""
        assert callable(handlers._mark_packet_seen)
        handlers._mark_packet_seen()
        ts = handlers.last_packet_monotonic()
        assert ts is not None


# ---------------------------------------------------------------------------
# _state: _host_telemetry_suppressed
# ---------------------------------------------------------------------------


class TestHostTelemetrySuppressed:
    """Tests for host telemetry suppression logic."""

    def test_not_suppressed_when_no_previous(self):
        """Not suppressed when no previous telemetry timestamp is set."""
        suppressed, mins = _state_mod._host_telemetry_suppressed(int(time.time()))
        assert suppressed is False
        assert mins == 0

    def test_suppressed_within_interval(self):
        """Suppressed when within the suppression window."""
        now = int(time.time())
        _state_mod._host_telemetry_last_rx = now - 10  # 10 seconds ago
        suppressed, mins = _state_mod._host_telemetry_suppressed(now)
        assert suppressed is True
        assert mins > 0

    def test_not_suppressed_after_interval(self):
        """Not suppressed after the full interval has elapsed."""
        now = int(time.time())
        _state_mod._host_telemetry_last_rx = (
            now - _state_mod._HOST_TELEMETRY_INTERVAL_SECS - 1
        )
        suppressed, mins = _state_mod._host_telemetry_suppressed(now)
        assert suppressed is False
        assert mins == 0

    def test_minutes_remaining_rounds_up(self):
        """Minutes remaining is rounded up (ceiling division)."""
        now = int(time.time())
        # 30 seconds remaining → 1 minute remaining
        _state_mod._host_telemetry_last_rx = (
            now - _state_mod._HOST_TELEMETRY_INTERVAL_SECS + 30
        )
        suppressed, mins = _state_mod._host_telemetry_suppressed(now)
        assert suppressed is True
        assert mins == 1


# ---------------------------------------------------------------------------
# _state: _host_nodeinfo_suppressed / _mark_host_nodeinfo_seen
# ---------------------------------------------------------------------------


class TestHostNodeinfoSuppressed:
    """Tests for host NODEINFO suppression logic."""

    def test_not_suppressed_when_no_previous(self):
        """Not suppressed when no previous NODEINFO timestamp is set."""
        assert _state_mod._host_nodeinfo_suppressed(time.monotonic()) is False

    def test_suppressed_within_interval(self):
        """Suppressed when within the suppression window."""
        now = time.monotonic()
        _state_mod._host_nodeinfo_last_seen = now - 10.0  # 10 seconds ago
        assert _state_mod._host_nodeinfo_suppressed(now) is True

    def test_not_suppressed_after_interval(self):
        """Not suppressed after the full interval has elapsed."""
        now = time.monotonic()
        _state_mod._host_nodeinfo_last_seen = (
            now - _state_mod._HOST_NODEINFO_INTERVAL_SECS - 1.0
        )
        assert _state_mod._host_nodeinfo_suppressed(now) is False

    def test_mark_updates_timestamp(self):
        """_mark_host_nodeinfo_seen stores the provided timestamp."""
        now = time.monotonic()
        _state_mod._mark_host_nodeinfo_seen(now)
        assert _state_mod._host_nodeinfo_last_seen == now

    def test_suppressed_after_mark(self):
        """Immediately after marking, a second call is suppressed."""
        now = time.monotonic()
        _state_mod._mark_host_nodeinfo_seen(now)
        assert _state_mod._host_nodeinfo_suppressed(now + 1.0) is True

    def test_not_suppressed_after_mark_and_full_interval(self):
        """After a full interval has elapsed, suppression lifts."""
        long_ago = time.monotonic() - _state_mod._HOST_NODEINFO_INTERVAL_SECS - 5.0
        _state_mod._mark_host_nodeinfo_seen(long_ago)
        assert _state_mod._host_nodeinfo_suppressed(time.monotonic()) is False


# ---------------------------------------------------------------------------
# radio: _radio_metadata_fields / _apply_radio_metadata
# ---------------------------------------------------------------------------


class TestRadioMetadata:
    """Tests for radio metadata helper functions."""

    def test_empty_when_neither_configured(self, monkeypatch):
        """Returns empty dict when LORA_FREQ and MODEM_PRESET are both None."""
        monkeypatch.setattr(config, "LORA_FREQ", None)
        monkeypatch.setattr(config, "MODEM_PRESET", None)
        assert handlers._radio_metadata_fields() == {}

    def test_includes_lora_freq(self, monkeypatch):
        """Includes lora_freq when configured."""
        monkeypatch.setattr(config, "LORA_FREQ", 915)
        monkeypatch.setattr(config, "MODEM_PRESET", None)
        assert handlers._radio_metadata_fields() == {"lora_freq": 915}

    def test_includes_modem_preset(self, monkeypatch):
        """Includes modem_preset when configured."""
        monkeypatch.setattr(config, "LORA_FREQ", None)
        monkeypatch.setattr(config, "MODEM_PRESET", "LongFast")
        assert handlers._radio_metadata_fields() == {"modem_preset": "LongFast"}

    def test_apply_radio_metadata_enriches_payload(self, monkeypatch):
        """_apply_radio_metadata adds radio fields to the payload."""
        monkeypatch.setattr(config, "LORA_FREQ", 915)
        monkeypatch.setattr(config, "MODEM_PRESET", "LongFast")
        payload = {"id": 1}
        result = handlers._apply_radio_metadata(payload)
        assert result["lora_freq"] == 915
        assert result["modem_preset"] == "LongFast"
        assert result is payload  # mutated in-place

    def test_apply_radio_metadata_to_nodes_enriches_node_dicts(self, monkeypatch):
        """_apply_radio_metadata_to_nodes enriches each node-value dict."""
        monkeypatch.setattr(config, "LORA_FREQ", 915)
        monkeypatch.setattr(config, "MODEM_PRESET", None)
        payload = {"!aabb": {"lastHeard": 100}, "ingestor": "!host"}
        handlers._apply_radio_metadata_to_nodes(payload)
        assert payload["!aabb"]["lora_freq"] == 915
        # Non-dict values like "ingestor" string are not enriched
        assert isinstance(payload["ingestor"], str)


# ---------------------------------------------------------------------------
# ignored: _record_ignored_packet
# ---------------------------------------------------------------------------


class TestRecordIgnoredPacket:
    """Tests for :func:`handlers.ignored._record_ignored_packet`."""

    def test_noop_when_debug_false(self, monkeypatch, tmp_path):
        """Does nothing when DEBUG is disabled."""
        monkeypatch.setattr(config, "DEBUG", False)
        log_path = tmp_path / "ignored.txt"
        monkeypatch.setattr(ignored_mod, "_IGNORED_PACKET_LOG_PATH", log_path)
        ignored_mod._record_ignored_packet({"test": 1}, reason="test-reason")
        assert not log_path.exists()

    def test_writes_json_line_when_debug(self, monkeypatch, tmp_path):
        """Appends a JSON record when DEBUG is enabled."""
        import json
        import threading

        monkeypatch.setattr(config, "DEBUG", True)
        log_path = tmp_path / "ignored.txt"
        monkeypatch.setattr(ignored_mod, "_IGNORED_PACKET_LOG_PATH", log_path)
        monkeypatch.setattr(ignored_mod, "_IGNORED_PACKET_LOCK", threading.Lock())
        ignored_mod._record_ignored_packet(
            {"portnum": "BAD"}, reason="unsupported-port"
        )
        assert log_path.exists()
        line = log_path.read_text().strip()
        record = json.loads(line)
        assert record["reason"] == "unsupported-port"
        assert "timestamp" in record

    def test_bytes_in_packet_are_base64(self, monkeypatch, tmp_path):
        """Byte values in the packet are Base64-encoded in the log."""
        import json
        import threading

        monkeypatch.setattr(config, "DEBUG", True)
        log_path = tmp_path / "ignored.txt"
        monkeypatch.setattr(ignored_mod, "_IGNORED_PACKET_LOG_PATH", log_path)
        monkeypatch.setattr(ignored_mod, "_IGNORED_PACKET_LOCK", threading.Lock())
        ignored_mod._record_ignored_packet({"data": b"\x00\x01"}, reason="test")
        record = json.loads(log_path.read_text().strip())
        assert record["packet"]["data"] == base64.b64encode(b"\x00\x01").decode()


# ---------------------------------------------------------------------------
# position: base64_payload
# ---------------------------------------------------------------------------


class TestBase64Payload:
    """Tests for :func:`handlers.base64_payload`."""

    def test_none_returns_none(self):
        """None input returns None."""
        assert handlers.base64_payload(None) is None

    def test_empty_bytes_returns_none(self):
        """Empty bytes return None."""
        assert handlers.base64_payload(b"") is None

    def test_encodes_bytes(self):
        """Non-empty bytes are Base64 encoded."""
        result = handlers.base64_payload(b"\x00\x01\x02")
        assert result == base64.b64encode(b"\x00\x01\x02").decode("ascii")


# ---------------------------------------------------------------------------
# generic: _is_encrypted_flag
# ---------------------------------------------------------------------------


class TestIsEncryptedFlag:
    """Tests for :func:`handlers._is_encrypted_flag`."""

    def test_true_bool(self):
        assert handlers._is_encrypted_flag(True) is True

    def test_false_bool(self):
        assert handlers._is_encrypted_flag(False) is False

    def test_nonzero_int(self):
        assert handlers._is_encrypted_flag(1) is True

    def test_zero_int(self):
        assert handlers._is_encrypted_flag(0) is False

    def test_empty_string(self):
        assert handlers._is_encrypted_flag("") is False

    def test_false_string(self):
        assert handlers._is_encrypted_flag("false") is False

    def test_no_string(self):
        assert handlers._is_encrypted_flag("no") is False

    def test_zero_string(self):
        assert handlers._is_encrypted_flag("0") is False

    def test_truthy_string(self):
        assert handlers._is_encrypted_flag("yes") is True

    def test_none_is_falsy(self):
        assert handlers._is_encrypted_flag(None) is False

    def test_nonempty_bytes(self):
        assert handlers._is_encrypted_flag(b"\x01") is True

    def test_empty_bytes(self):
        assert handlers._is_encrypted_flag(b"") is False


# ---------------------------------------------------------------------------
# generic: upsert_node
# ---------------------------------------------------------------------------


class TestUpsertNode:
    """Tests for :func:`handlers.upsert_node`."""

    def test_queues_node_payload(self):
        """upsert_node enqueues a POST to /api/nodes."""
        import data.mesh_ingestor.queue as q

        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(
            (path, payload)
        )
        try:
            handlers.upsert_node("!aabbccdd", {"user": {"shortName": "AB"}})
        finally:
            q._queue_post_json = original
        assert any(p == "/api/nodes" for p, _ in sent)

    def test_includes_ingestor_field(self):
        """Payload includes ingestor field with host node ID."""
        import data.mesh_ingestor.queue as q

        handlers.register_host_node_id("!deadbeef")
        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(
            (path, payload)
        )
        try:
            handlers.upsert_node("!aabbccdd", {"user": {}})
        finally:
            q._queue_post_json = original
        _, payload = sent[0]
        assert payload.get("ingestor") == "!deadbeef"


# ---------------------------------------------------------------------------
# generic: on_receive deduplication
# ---------------------------------------------------------------------------


class TestOnReceive:
    """Tests for :func:`handlers.on_receive`."""

    def test_deduplicates_via_seen_flag(self, monkeypatch):
        """Packets with _potatomesh_seen=True are skipped."""
        calls = []
        monkeypatch.setattr(
            "data.mesh_ingestor.handlers.generic.store_packet_dict",
            lambda pkt: calls.append(pkt),
        )
        packet = {"_potatomesh_seen": True, "decoded": {}}
        handlers.on_receive(packet, None)
        assert calls == []

    def test_marks_packet_seen(self, monkeypatch):
        """First call marks the packet as seen."""
        monkeypatch.setattr(
            "data.mesh_ingestor.handlers.generic.store_packet_dict",
            lambda pkt: None,
        )
        packet = {"decoded": {}}
        handlers.on_receive(packet, None)
        assert packet.get("_potatomesh_seen") is True

    def test_updates_monotonic_timestamp(self, monkeypatch):
        """on_receive updates the last-packet monotonic timestamp."""
        monkeypatch.setattr(
            "data.mesh_ingestor.handlers.generic.store_packet_dict",
            lambda pkt: None,
        )
        handlers.on_receive({"decoded": {}}, None)
        assert handlers.last_packet_monotonic() is not None


# ---------------------------------------------------------------------------
# store_position_packet
# ---------------------------------------------------------------------------


class TestStorePositionPacket:
    """Tests for :func:`handlers.store_position_packet`."""

    def _make_packet(self, from_id="!aabbccdd", pkt_id=1001, **extra):
        pkt = {
            "id": pkt_id,
            "rxTime": 1_700_000_000,
            "fromId": from_id,
            "decoded": {
                "position": {"latitude": 37.5, "longitude": -122.1},
            },
        }
        pkt.update(extra)
        return pkt

    def test_queues_position_payload(self):
        """Valid position packet is queued to /api/positions."""
        import data.mesh_ingestor.queue as q

        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(
            (path, payload)
        )
        try:
            handlers.store_position_packet(
                self._make_packet(),
                {"position": {"latitude": 37.5, "longitude": -122.1}},
            )
        finally:
            q._queue_post_json = original
        assert any(p == "/api/positions" for p, _ in sent)

    def test_skips_when_no_node_id(self):
        """Packet missing a node ID is silently dropped."""
        import data.mesh_ingestor.queue as q

        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(
            (path, payload)
        )
        try:
            handlers.store_position_packet({}, {})
        finally:
            q._queue_post_json = original
        assert sent == []

    def test_skips_when_no_packet_id(self):
        """Packet missing a packet ID is silently dropped."""
        import data.mesh_ingestor.queue as q

        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(
            (path, payload)
        )
        try:
            handlers.store_position_packet({"fromId": "!aabbccdd"}, {})
        finally:
            q._queue_post_json = original
        assert sent == []

    def test_latitude_i_conversion(self):
        """latitudeI integer is divided by 1e7 to get degrees."""
        import data.mesh_ingestor.queue as q

        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(
            (path, payload)
        )
        try:
            handlers.store_position_packet(
                {"id": 99, "rxTime": 100, "fromId": "!aabbccdd"},
                {"position": {"latitudeI": 375000000, "longitudeI": -1221000000}},
            )
        finally:
            q._queue_post_json = original
        assert len(sent) == 1
        payload = sent[0][1]
        assert abs(payload["latitude"] - 37.5) < 1e-4
        assert abs(payload["longitude"] - -122.1) < 1e-4


# ---------------------------------------------------------------------------
# store_telemetry_packet
# ---------------------------------------------------------------------------


class TestStoreTelemetryPacket:
    """Tests for :func:`handlers.store_telemetry_packet`."""

    def _make_telemetry_packet(self, from_id="!aabbccdd", pkt_id=2001):
        return {
            "id": pkt_id,
            "rxTime": 1_700_000_000,
            "fromId": from_id,
            "decoded": {
                "portnum": "TELEMETRY_APP",
                "telemetry": {
                    "deviceMetrics": {"batteryLevel": 80, "voltage": 3.8},
                },
            },
        }

    def test_queues_telemetry_payload(self):
        """Valid telemetry packet is queued to /api/telemetry."""
        import data.mesh_ingestor.queue as q

        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(
            (path, payload)
        )
        try:
            pkt = self._make_telemetry_packet()
            handlers.store_telemetry_packet(pkt, pkt["decoded"])
        finally:
            q._queue_post_json = original
        assert any(p == "/api/telemetry" for p, _ in sent)

    def test_skips_without_telemetry_section(self):
        """Packet without a telemetry section is silently dropped."""
        import data.mesh_ingestor.queue as q

        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(
            (path, payload)
        )
        try:
            handlers.store_telemetry_packet({"id": 1}, {})
        finally:
            q._queue_post_json = original
        assert sent == []

    def test_skips_without_packet_id(self):
        """Telemetry packet without an id is dropped."""
        import data.mesh_ingestor.queue as q

        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(
            (path, payload)
        )
        try:
            handlers.store_telemetry_packet(
                {"fromId": "!aabbccdd"},
                {"telemetry": {"deviceMetrics": {}}},
            )
        finally:
            q._queue_post_json = original
        assert sent == []

    def test_host_telemetry_suppressed_within_interval(self, monkeypatch):
        """Host node telemetry is suppressed within the interval window."""
        import data.mesh_ingestor.queue as q

        handlers.register_host_node_id("!aabbccdd")
        now = int(time.time())
        _state_mod._host_telemetry_last_rx = now - 10  # recent
        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(
            (path, payload)
        )
        try:
            pkt = {
                "id": 1,
                "rxTime": now,
                "fromId": "!aabbccdd",
                "decoded": {
                    "portnum": "TELEMETRY_APP",
                    "telemetry": {"deviceMetrics": {"batteryLevel": 80}},
                },
            }
            handlers.store_telemetry_packet(pkt, pkt["decoded"])
        finally:
            q._queue_post_json = original
        assert sent == []

    def test_telemetry_type_device(self):
        """deviceMetrics triggers telemetry_type='device'."""
        import data.mesh_ingestor.queue as q

        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(
            (path, payload)
        )
        try:
            pkt = self._make_telemetry_packet()
            handlers.store_telemetry_packet(pkt, pkt["decoded"])
        finally:
            q._queue_post_json = original
        _, payload = sent[0]
        assert payload.get("telemetry_type") == "device"

    def test_invalid_telemetry_type_dropped_from_payload(self, monkeypatch):
        """Unrecognised telemetry_type is omitted from the payload."""
        import data.mesh_ingestor.queue as q

        monkeypatch.setattr(telemetry_mod, "_VALID_TELEMETRY_TYPES", frozenset())
        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(
            (path, payload)
        )
        try:
            pkt = self._make_telemetry_packet()
            handlers.store_telemetry_packet(pkt, pkt["decoded"])
        finally:
            q._queue_post_json = original
        _, payload = sent[0]
        assert "telemetry_type" not in payload


# ---------------------------------------------------------------------------
# store_nodeinfo_packet
# ---------------------------------------------------------------------------


class TestStoreNodeinfoPacket:
    """Tests for :func:`handlers.store_nodeinfo_packet`."""

    def test_queues_node_payload(self):
        """Valid nodeinfo packet is queued to /api/nodes."""
        import data.mesh_ingestor.queue as q

        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(
            (path, payload)
        )
        try:
            handlers.store_nodeinfo_packet(
                {"id": 1, "rxTime": 100, "fromId": "!aabbccdd"},
                {
                    "user": {
                        "id": "!aabbccdd",
                        "shortName": "AB",
                        "longName": "Alpha Bravo",
                    }
                },
            )
        finally:
            q._queue_post_json = original
        assert any(p == "/api/nodes" for p, _ in sent)

    def test_skips_when_no_node_id(self):
        """Packet with no resolvable node ID is silently dropped."""
        import data.mesh_ingestor.queue as q

        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(
            (path, payload)
        )
        try:
            handlers.store_nodeinfo_packet({}, {})
        finally:
            q._queue_post_json = original
        assert sent == []

    def test_host_nodeinfo_not_suppressed_on_first_call(self):
        """First NODEINFO from the host node is always forwarded."""
        import data.mesh_ingestor.queue as q

        handlers.register_host_node_id("!aabbccdd")
        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(path)
        try:
            handlers.store_nodeinfo_packet(
                {"id": 1, "rxTime": 100, "fromId": "!aabbccdd"},
                {"user": {"id": "!aabbccdd", "shortName": "AB", "longName": "Alpha"}},
            )
        finally:
            q._queue_post_json = original
        assert "/api/nodes" in sent

    def test_host_nodeinfo_suppressed_within_window(self):
        """Second NODEINFO from the host within the throttle window is dropped."""
        import data.mesh_ingestor.queue as q

        handlers.register_host_node_id("!aabbccdd")
        # Simulate a recent upsert so the window is active.
        _state_mod._mark_host_nodeinfo_seen(time.monotonic())

        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(path)
        try:
            handlers.store_nodeinfo_packet(
                {"id": 2, "rxTime": 200, "fromId": "!aabbccdd"},
                {"user": {"id": "!aabbccdd", "shortName": "AB", "longName": "Alpha"}},
            )
        finally:
            q._queue_post_json = original
        assert sent == []

    def test_host_nodeinfo_allowed_after_window_expires(self):
        """NODEINFO from the host is forwarded after the throttle window expires."""
        import data.mesh_ingestor.queue as q

        handlers.register_host_node_id("!aabbccdd")
        # Place last-seen far in the past so the window has expired.
        _state_mod._host_nodeinfo_last_seen = (
            time.monotonic() - _state_mod._HOST_NODEINFO_INTERVAL_SECS - 10.0
        )

        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(path)
        try:
            handlers.store_nodeinfo_packet(
                {"id": 3, "rxTime": 300, "fromId": "!aabbccdd"},
                {"user": {"id": "!aabbccdd", "shortName": "AB", "longName": "Alpha"}},
            )
        finally:
            q._queue_post_json = original
        assert "/api/nodes" in sent

    def test_non_host_nodeinfo_never_suppressed(self):
        """NODEINFO from a non-host node is never throttled."""
        import data.mesh_ingestor.queue as q

        handlers.register_host_node_id("!aabbccdd")
        # Mark the host as recently seen to activate the throttle.
        _state_mod._mark_host_nodeinfo_seen(time.monotonic())

        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(path)
        try:
            handlers.store_nodeinfo_packet(
                {"id": 4, "rxTime": 400, "fromId": "!11223344"},
                {
                    "user": {
                        "id": "!11223344",
                        "shortName": "CD",
                        "longName": "Charlie Delta",
                    }
                },
            )
        finally:
            q._queue_post_json = original
        assert "/api/nodes" in sent


# ---------------------------------------------------------------------------
# store_neighborinfo_packet
# ---------------------------------------------------------------------------


class TestStoreNeighborinfoPacket:
    """Tests for :func:`handlers.store_neighborinfo_packet`."""

    def test_queues_neighbor_payload(self):
        """Valid neighborinfo packet is queued to /api/neighbors."""
        import data.mesh_ingestor.queue as q

        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(
            (path, payload)
        )
        try:
            handlers.store_neighborinfo_packet(
                {"id": 1, "rxTime": 100, "fromId": "!aabbccdd"},
                {
                    "neighborinfo": {
                        "nodeId": 0xAABBCCDD,
                        "neighbors": [
                            {"nodeId": 0x11223344, "snr": 5.0},
                        ],
                    }
                },
            )
        finally:
            q._queue_post_json = original
        assert any(p == "/api/neighbors" for p, _ in sent)

    def test_skips_when_no_neighborinfo_section(self):
        """Missing neighborinfo section is silently dropped."""
        import data.mesh_ingestor.queue as q

        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(
            (path, payload)
        )
        try:
            handlers.store_neighborinfo_packet({"fromId": "!aabbccdd"}, {})
        finally:
            q._queue_post_json = original
        assert sent == []


# ---------------------------------------------------------------------------
# store_router_heartbeat_packet
# ---------------------------------------------------------------------------


class TestStoreRouterHeartbeatPacket:
    """Tests for :func:`handlers.store_router_heartbeat_packet`."""

    def test_queues_node_upsert(self):
        """Router heartbeat queues a minimal node upsert."""
        import data.mesh_ingestor.queue as q

        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(
            (path, payload)
        )
        try:
            handlers.store_router_heartbeat_packet(
                {"fromId": "!aabbccdd", "rxTime": 1_700_000_000}
            )
        finally:
            q._queue_post_json = original
        assert any(p == "/api/nodes" for p, _ in sent)

    def test_skips_when_no_from_id(self):
        """Heartbeat without from_id is silently dropped."""
        import data.mesh_ingestor.queue as q

        sent = []
        original = q._queue_post_json
        q._queue_post_json = lambda path, payload, *, priority, **kw: sent.append(
            (path, payload)
        )
        try:
            handlers.store_router_heartbeat_packet({})
        finally:
            q._queue_post_json = original
        assert sent == []


# ---------------------------------------------------------------------------
# _coerce_emoji_codepoint
# ---------------------------------------------------------------------------


class TestCoerceEmojiCodepoint:
    """Tests for :func:`_coerce_emoji_codepoint`."""

    def test_none_returns_none(self):
        """``None`` input yields ``None``."""
        assert generic_mod._coerce_emoji_codepoint(None) is None

    def test_int_codepoint_above_127(self):
        """Integer codepoint above 127 is converted to the character."""
        assert generic_mod._coerce_emoji_codepoint(128077) == "\U0001f44d"

    def test_string_codepoint_above_127(self):
        """Digit string representing a codepoint above 127 is converted."""
        assert generic_mod._coerce_emoji_codepoint("128077") == "\U0001f44d"

    def test_small_int_preserved_as_string(self):
        """Small integer (≤ 127) is kept as its string representation."""
        assert generic_mod._coerce_emoji_codepoint(1) == "1"

    def test_small_string_digit_preserved(self):
        """Digit string ≤ 127 is kept as-is (slot marker)."""
        assert generic_mod._coerce_emoji_codepoint("1") == "1"

    def test_emoji_string_passthrough(self):
        """An already-resolved emoji character passes through."""
        assert generic_mod._coerce_emoji_codepoint("\U0001f44d") == "\U0001f44d"

    def test_whitespace_only_returns_none(self):
        """Whitespace-only string yields ``None``."""
        assert generic_mod._coerce_emoji_codepoint("   ") is None

    def test_empty_string_returns_none(self):
        """Empty string yields ``None``."""
        assert generic_mod._coerce_emoji_codepoint("") is None

    def test_float_codepoint_above_127(self):
        """Float codepoint above 127 is truncated and converted."""
        assert generic_mod._coerce_emoji_codepoint(128077.0) == "\U0001f44d"

    def test_invalid_codepoint_returns_none(self):
        """Out-of-range numeric codepoint returns ``None`` rather than the
        decimal form (which would render as garbage in the chat log)."""
        assert generic_mod._coerce_emoji_codepoint(0x7FFFFFFF) is None

    def test_invalid_string_codepoint_returns_none(self):
        """Out-of-range numeric string also returns ``None``."""
        assert generic_mod._coerce_emoji_codepoint(str(0x7FFFFFFF)) is None


# ---------------------------------------------------------------------------
# _is_reaction_placeholder_text
# ---------------------------------------------------------------------------


class TestIsReactionPlaceholderText:
    """Tests for :func:`_is_reaction_placeholder_text`."""

    def test_none_is_placeholder(self):
        """``None`` is a placeholder."""
        assert generic_mod._is_reaction_placeholder_text(None) is True

    def test_empty_is_placeholder(self):
        """Empty string is a placeholder."""
        assert generic_mod._is_reaction_placeholder_text("") is True

    def test_whitespace_is_placeholder(self):
        """Whitespace-only string is a placeholder."""
        assert generic_mod._is_reaction_placeholder_text("   ") is True

    def test_digit_slot_marker(self):
        """Digit strings like '1' and '3' are placeholders."""
        assert generic_mod._is_reaction_placeholder_text("1") is True
        assert generic_mod._is_reaction_placeholder_text("3") is True

    def test_bare_emoji_is_placeholder(self):
        """A single emoji character is a placeholder."""
        assert generic_mod._is_reaction_placeholder_text("\U0001f44d") is True

    def test_substantial_text_is_not_placeholder(self):
        """Prose text is not a placeholder."""
        assert generic_mod._is_reaction_placeholder_text("Hello world") is False

    def test_text_with_emoji_is_not_placeholder(self):
        """Text containing both words and emoji is not a placeholder."""
        assert (
            generic_mod._is_reaction_placeholder_text("Great job! \U0001f44d") is False
        )

    def test_short_ascii_word_is_not_placeholder(self):
        """A short ASCII word is not a placeholder."""
        assert generic_mod._is_reaction_placeholder_text("hi") is False


# ---------------------------------------------------------------------------
# _is_likely_reaction
# ---------------------------------------------------------------------------


class TestIsLikelyReaction:
    """Tests for :func:`_is_likely_reaction`."""

    def test_reaction_app_portnum_string(self):
        """Explicit REACTION_APP portnum is always a reaction."""
        assert (
            generic_mod._is_likely_reaction(
                "REACTION_APP", None, 123, "\U0001f44d", None
            )
            is True
        )

    def test_reply_id_emoji_no_text(self):
        """reply_id + emoji + no text is a reaction."""
        assert (
            generic_mod._is_likely_reaction(
                "TEXT_MESSAGE_APP", 1, 123, "\U0001f44d", None
            )
            is True
        )

    def test_reply_id_emoji_digit_text(self):
        """reply_id + emoji + digit count text is a reaction."""
        assert (
            generic_mod._is_likely_reaction(
                "TEXT_MESSAGE_APP", 1, 123, "\U0001f44d", "3"
            )
            is True
        )

    def test_reply_id_emoji_substantial_text_not_reaction(self):
        """reply_id + emoji + substantial text is NOT a reaction."""
        assert (
            generic_mod._is_likely_reaction(
                "TEXT_MESSAGE_APP", 1, 123, "\U0001f44d", "Great job!"
            )
            is False
        )

    def test_no_emoji_not_reaction(self):
        """Missing emoji means not a reaction (even with reply_id)."""
        assert (
            generic_mod._is_likely_reaction("TEXT_MESSAGE_APP", 1, 123, None, None)
            is False
        )

    def test_no_reply_id_not_reaction(self):
        """Missing reply_id means not a reaction (non-REACTION_APP portnum)."""
        assert (
            generic_mod._is_likely_reaction(
                "TEXT_MESSAGE_APP", 1, None, "\U0001f44d", None
            )
            is False
        )

    def test_portnum_int_matches_reaction_candidate(self, monkeypatch):
        """An unknown portnum string is still classified as a reaction when
        ``portnum_int`` matches one of the firmware-resolved REACTION_APP
        candidates.  Different Meshtastic firmware versions assign different
        integer values to the REACTION_APP enum, so the integer fallback is
        the authoritative path."""
        monkeypatch.setattr(generic_mod, "_portnum_candidates", lambda name: {77})
        assert (
            generic_mod._is_likely_reaction("UNKNOWN_PORT", 77, None, None, None)
            is True
        )


# ---------------------------------------------------------------------------
# _coerce_emoji_codepoint — string conversion failure path
# ---------------------------------------------------------------------------


class TestCoerceEmojiStringFailure:
    """Cover the ``except Exception`` branch in :func:`_coerce_emoji_codepoint`.

    The string-conversion ``try`` is defensive against pathological values
    (objects whose ``__str__`` raises).  We exercise it directly so the
    fallback ``return None`` line is covered.
    """

    def test_object_str_raises(self):
        """A value whose ``__str__`` raises yields ``None``."""

        class Boom:
            def __str__(self):  # noqa: D401 - pytest-style helper
                raise RuntimeError("boom")

        assert generic_mod._coerce_emoji_codepoint(Boom()) is None
