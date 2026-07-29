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
"""Unit tests for the ``WAYPOINT_APP`` handler (SPEC W1/W2, acceptance WP-A1).

Covers the decode → normalise → queue path of
:func:`data.mesh_ingestor.handlers.waypoint.store_waypoint_packet`, the
``locked_to`` canonicalisation helper, and the ``store_packet_dict``
dispatch seam that routes waypoint packets to the handler.
"""

from __future__ import annotations

import base64
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.config as config
import data.mesh_ingestor.handlers as handlers
import data.mesh_ingestor.handlers.generic as generic_mod
import data.mesh_ingestor.handlers.waypoint as waypoint_mod
import data.mesh_ingestor.queue as q


@pytest.fixture()
def sent(monkeypatch):
    """Capture queued POSTs as ``(path, payload, priority)`` tuples."""

    captured = []
    monkeypatch.setattr(
        q,
        "_queue_post_json",
        lambda path, payload, *, priority, **kw: captured.append(
            (path, payload, priority)
        ),
    )
    return captured


def _make_packet(**extra):
    """Build a minimal WAYPOINT_APP packet with a decoded waypoint section."""

    pkt = {
        "id": 555_001,
        "rxTime": 1_700_000_000,
        "fromId": "!3769b133",
        "decoded": {
            "portnum": "WAYPOINT_APP",
            "waypoint": {
                "id": 41_206,
                "name": "Tempelhofer Feld",
                "description": "See further",
                "icon": 0x2708,
                "latitude": 52.4751642,
                "longitude": 13.4029586,
                "expire": 1_700_010_000,
                "lockedTo": 0x3769B133,
            },
        },
    }
    pkt.update(extra)
    return pkt


class TestCanonicalLockedTo:
    """Tests for :func:`waypoint._canonical_locked_to` (C3 mapping)."""

    def test_maps_node_num_to_canonical_id(self):
        """A non-zero node number maps to the canonical ``!%08x`` id."""
        assert waypoint_mod._canonical_locked_to(0x3769B133) == "!3769b133"

    def test_normalises_canonical_string(self):
        """An already-canonical id string is normalised to lowercase."""
        assert waypoint_mod._canonical_locked_to("!3769B133") == "!3769b133"

    def test_zero_means_unlocked(self):
        """The Meshtastic ``0`` sentinel yields ``None`` (not locked)."""
        assert waypoint_mod._canonical_locked_to(0) is None
        assert waypoint_mod._canonical_locked_to("0") is None

    def test_nil_and_garbage_yield_none(self):
        """``None`` and unparseable references are treated as unlocked."""
        assert waypoint_mod._canonical_locked_to(None) is None
        assert waypoint_mod._canonical_locked_to("not a node") is None


class TestStoreWaypointPacket:
    """Tests for :func:`handlers.store_waypoint_packet`."""

    def test_queues_full_waypoint_payload(self, sent):
        """A valid packet queues the documented contract shape (WP-A1)."""
        pkt = _make_packet()
        handlers.store_waypoint_packet(pkt, pkt["decoded"])

        assert len(sent) == 1
        path, payload, priority = sent[0]
        assert path == "/api/waypoints"
        assert priority == q._WAYPOINT_POST_PRIORITY
        assert payload["id"] == 41_206
        assert payload["node_id"] == "!3769b133"
        assert payload["node_num"] == 0x3769B133
        assert payload["from_id"] == "!3769b133"
        assert payload["rx_time"] == 1_700_000_000
        assert payload["rx_iso"].startswith("2023-")
        assert payload["name"] == "Tempelhofer Feld"
        assert payload["description"] == "See further"
        assert payload["icon"] == 0x2708
        assert payload["latitude"] == pytest.approx(52.4751642)
        assert payload["longitude"] == pytest.approx(13.4029586)
        assert payload["expire"] == 1_700_010_000
        assert payload["locked_to"] == "!3769b133"
        assert payload["protocol"] == config.PROTOCOL

    def test_ignores_packet_without_waypoint_id(self, sent):
        """A packet whose waypoint section lacks an id is dropped (ignored)."""
        pkt = _make_packet()
        pkt["decoded"]["waypoint"].pop("id")
        handlers.store_waypoint_packet(pkt, pkt["decoded"])
        assert sent == []

    def test_ignores_packet_without_author(self, sent):
        """A packet without a resolvable author node id is dropped."""
        pkt = _make_packet()
        pkt.pop("fromId")
        handlers.store_waypoint_packet(pkt, pkt["decoded"])
        assert sent == []

    def test_tolerates_missing_waypoint_section(self, sent):
        """A decoded mapping without a waypoint section is dropped, not raised."""
        handlers.store_waypoint_packet({"fromId": "!3769b133"}, {})
        assert sent == []

    def test_integer_scaled_coordinates(self, sent):
        """latitudeI/longitudeI (1e-7 degrees) convert to float degrees."""
        pkt = _make_packet()
        section = pkt["decoded"]["waypoint"]
        section.pop("latitude")
        section.pop("longitude")
        section["latitudeI"] = int(52.5 * 1e7)
        section["longitude_i"] = int(13.4 * 1e7)
        handlers.store_waypoint_packet(pkt, pkt["decoded"])
        payload = sent[0][1]
        assert payload["latitude"] == pytest.approx(52.5)
        assert payload["longitude"] == pytest.approx(13.4)

    def test_collapses_null_island_sentinel(self, sent):
        """The paired (0, 0) no-fix sentinel collapses to None/None (#782)."""
        pkt = _make_packet()
        pkt["decoded"]["waypoint"]["latitude"] = 0.0
        pkt["decoded"]["waypoint"]["longitude"] = 0.0
        handlers.store_waypoint_packet(pkt, pkt["decoded"])
        payload = sent[0][1]
        assert payload["latitude"] is None
        assert payload["longitude"] is None

    def test_expire_zero_means_never(self, sent):
        """``expire = 0`` is normalised to None (never expires, W5)."""
        pkt = _make_packet()
        pkt["decoded"]["waypoint"]["expire"] = 0
        handlers.store_waypoint_packet(pkt, pkt["decoded"])
        assert sent[0][1]["expire"] is None

    def test_absent_expire_and_lock_are_none(self, sent):
        """Absent expire/lockedTo fields are omitted as None."""
        pkt = _make_packet()
        pkt["decoded"]["waypoint"].pop("expire")
        pkt["decoded"]["waypoint"].pop("lockedTo")
        handlers.store_waypoint_packet(pkt, pkt["decoded"])
        payload = sent[0][1]
        assert payload["expire"] is None
        assert payload["locked_to"] is None

    def test_blank_name_and_description_become_none(self, sent):
        """Empty strings are normalised to None, non-strings coerced to str."""
        pkt = _make_packet()
        pkt["decoded"]["waypoint"]["name"] = ""
        pkt["decoded"]["waypoint"]["description"] = 123
        handlers.store_waypoint_packet(pkt, pkt["decoded"])
        payload = sent[0][1]
        assert payload["name"] is None
        assert payload["description"] == "123"

    def test_uncoercible_rx_time_falls_back_to_now(self, sent):
        """A non-numeric rxTime falls back to the current clock."""
        pkt = _make_packet(rxTime="not-a-time")
        handlers.store_waypoint_packet(pkt, pkt["decoded"])
        assert sent[0][1]["rx_time"] > 1_700_000_000

    def test_packet_protocol_stamp_wins(self, sent):
        """An explicit per-packet protocol stamp overrides the config default."""
        pkt = _make_packet(protocol="meshcore")
        handlers.store_waypoint_packet(pkt, pkt["decoded"])
        assert sent[0][1]["protocol"] == "meshcore"

    def test_radio_metadata_and_rf_fields(self, sent, monkeypatch):
        """RF fields ride along and radio metadata is applied when configured."""
        monkeypatch.setattr(config, "LORA_FREQ", 868)
        monkeypatch.setattr(config, "MODEM_PRESET", "MediumFast")
        pkt = _make_packet(snr=-8.5, rssi=-90, hopLimit=3)
        handlers.store_waypoint_packet(pkt, pkt["decoded"])
        payload = sent[0][1]
        assert payload["snr"] == pytest.approx(-8.5)
        assert payload["rssi"] == -90
        assert payload["hop_limit"] == 3
        assert payload["lora_freq"] == 868
        assert payload["modem_preset"] == "MediumFast"

    def test_payload_bytes_are_base64_encoded(self, sent):
        """Raw decoded payload bytes are forwarded Base64-encoded."""
        pkt = _make_packet()
        pkt["decoded"]["payload"] = b"\x01\x02"
        handlers.store_waypoint_packet(pkt, pkt["decoded"])
        assert sent[0][1]["payload_b64"] == base64.b64encode(b"\x01\x02").decode(
            "ascii"
        )

    def test_debug_log_branch(self, sent, monkeypatch):
        """The DEBUG branch emits a structured debug log line."""
        logged = []
        monkeypatch.setattr(config, "DEBUG", True)
        monkeypatch.setattr(
            config, "_debug_log", lambda msg, **kw: logged.append((msg, kw))
        )
        pkt = _make_packet()
        handlers.store_waypoint_packet(pkt, pkt["decoded"])
        assert len(sent) == 1
        assert any("waypoint" in msg.lower() for msg, _ in logged)


class TestStorePacketDictWaypointDispatch:
    """Dispatch seam: ``store_packet_dict`` routes waypoints to the handler."""

    def _capture(self, monkeypatch):
        routed = []
        monkeypatch.setattr(
            generic_mod,
            "store_waypoint_packet",
            lambda packet, decoded: routed.append((packet, decoded)),
        )
        return routed

    def test_routes_by_string_portnum(self, sent, monkeypatch):
        """A WAYPOINT_APP portnum string routes to the waypoint handler."""
        routed = self._capture(monkeypatch)
        handlers.store_packet_dict({"decoded": {"portnum": "WAYPOINT_APP"}})
        assert len(routed) == 1

    def test_routes_by_decoded_section(self, sent, monkeypatch):
        """A decoded ``waypoint`` section routes even without a portnum."""
        routed = self._capture(monkeypatch)
        handlers.store_packet_dict({"decoded": {"waypoint": {"id": 1}}})
        assert len(routed) == 1

    def test_routes_by_integer_portnum(self, sent, monkeypatch):
        """The numeric WAYPOINT_APP portnum (8) routes via the enum lookup."""
        routed = self._capture(monkeypatch)
        candidates = generic_mod._portnum_candidates("WAYPOINT_APP")
        if not candidates:
            pytest.skip("meshtastic protobuf enums unavailable")
        handlers.store_packet_dict({"decoded": {"portnum": next(iter(candidates))}})
        assert len(routed) == 1

    def test_non_waypoint_packet_is_not_routed(self, sent, monkeypatch):
        """A plain text message never reaches the waypoint handler."""
        routed = self._capture(monkeypatch)
        handlers.store_packet_dict(
            {"fromId": "!3769b133", "decoded": {"portnum": "TEXT_MESSAGE_APP"}}
        )
        assert routed == []
