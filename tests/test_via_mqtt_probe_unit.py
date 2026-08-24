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
"""Unit tests for :mod:`data.mesh_ingestor.via_mqtt_probe` (issue #884).

Covers the classification matrix, the presence-means-true reading of the
protobuf flag, tally pacing, the snapshot reporter, the failure guards, and the
inert-by-default contract — including that the probe never alters what
:func:`data.mesh_ingestor.handlers.store_packet_dict` routes or stores.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.config as config
import data.mesh_ingestor.via_mqtt_probe as probe


@pytest.fixture(autouse=True)
def reset_probe():
    """Zero the probe counters around every test for isolation."""
    probe._reset_probe_state()
    yield
    probe._reset_probe_state()


@pytest.fixture
def enabled(monkeypatch):
    """Switch the probe on for the duration of a test."""
    monkeypatch.setattr(config, "VIA_MQTT_PROBE", True)
    return config


def _packet(**overrides):
    """Build a minimal received-packet mapping, overridable per test."""
    packet = {
        "fromId": "!336a1b2c",
        "channel": 0,
        "hopLimit": 3,
        "hopStart": 3,
    }
    packet.update(overrides)
    return packet


def _lines(capsys):
    """Return the probe's stdout lines emitted so far."""
    return [
        line
        for line in capsys.readouterr().out.splitlines()
        if "via_mqtt probe" in line
    ]


# ---------------------------------------------------------------------------
# Enablement
# ---------------------------------------------------------------------------


def test_probe_disabled_by_default():
    """The shipped default leaves the probe inert."""
    assert config.VIA_MQTT_PROBE is False
    assert probe.probe_enabled() is False


def test_probe_packet_is_a_noop_when_disabled(capsys):
    """A disabled probe logs nothing and counts nothing."""
    probe.probe_packet(_packet(viaMqtt=True, rxSnr=-8.0), {})
    assert _lines(capsys) == []
    assert probe._probed_total == 0


def test_probe_snapshot_is_a_noop_when_disabled(capsys):
    """A disabled snapshot probe logs nothing."""
    probe.probe_snapshot([("!336a1b2c", {"viaMqtt": True})])
    assert _lines(capsys) == []


def test_probe_enabled_reads_config_at_call_time(monkeypatch):
    """The flag is read live, not captured at import."""
    monkeypatch.setattr(config, "VIA_MQTT_PROBE", True)
    assert probe.probe_enabled() is True
    monkeypatch.setattr(config, "VIA_MQTT_PROBE", False)
    assert probe.probe_enabled() is False


def test_probe_enabled_tolerates_a_missing_attribute(monkeypatch):
    """A config module without the attribute resolves to off, not AttributeError."""
    monkeypatch.delattr(config, "VIA_MQTT_PROBE", raising=False)
    assert probe.probe_enabled() is False


# ---------------------------------------------------------------------------
# Classification matrix
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("via_mqtt", "has_rf", "expected"),
    [
        (True, True, "mqtt-over-rf"),
        (True, False, "mqtt-no-rf"),
        (False, True, "direct-rf"),
        (False, False, "no-rf-metadata"),
    ],
)
def test_classify_matrix(via_mqtt, has_rf, expected):
    """Every combination of flag and RF evidence maps to its own bucket."""
    assert probe._classify(via_mqtt, has_rf) == expected


def test_mqtt_over_rf_is_the_finding_that_matters(enabled, capsys):
    """A flagged packet carrying radio-stamped SNR is the decisive case."""
    probe.probe_packet(_packet(viaMqtt=True, rxSnr=-11.25, rxRssi=-97), {})
    (line,) = _lines(capsys)
    assert "classification='mqtt-over-rf'" in line
    assert "via_mqtt=True" in line
    assert "rx_snr=-11.25" in line
    assert probe._counts["mqtt-over-rf"] == 1


def test_rssi_alone_counts_as_rf_evidence(enabled, capsys):
    """Either RF field is sufficient; they are not required together."""
    probe.probe_packet(_packet(viaMqtt=True, rxRssi=-97), {})
    assert "classification='mqtt-over-rf'" in _lines(capsys)[0]


def test_flagged_packet_without_rf_metadata(enabled, capsys):
    """No SNR/RSSI means the packet did not arrive over the air."""
    probe.probe_packet(_packet(viaMqtt=True), {})
    assert "classification='mqtt-no-rf'" in _lines(capsys)[0]


def test_unflagged_rf_packet_is_direct(enabled, capsys):
    """Ordinary local traffic classifies as direct RF."""
    probe.probe_packet(_packet(rxSnr=4.5), {})
    assert "classification='direct-rf'" in _lines(capsys)[0]


def test_unflagged_packet_without_rf_metadata(enabled, capsys):
    """A locally generated packet has neither flag nor RF metadata."""
    probe.probe_packet(_packet(), {})
    assert "classification='no-rf-metadata'" in _lines(capsys)[0]


# ---------------------------------------------------------------------------
# Flag reading: presence means true, snake_case accepted
# ---------------------------------------------------------------------------


def test_absent_flag_reads_as_false(enabled, capsys):
    """``MessageToDict`` omits a false ``via_mqtt``; absence must mean 'keep'."""
    probe.probe_packet(_packet(rxSnr=1.0), {})
    assert "via_mqtt=False" in _lines(capsys)[0]


def test_explicit_false_flag_reads_as_false(enabled, capsys):
    """An explicitly false flag is still 'not flagged'."""
    probe.probe_packet(_packet(viaMqtt=False, rxSnr=1.0), {})
    line = _lines(capsys)[0]
    assert "via_mqtt=False" in line
    assert "classification='direct-rf'" in line


def test_snake_case_flag_is_accepted(enabled, capsys):
    """A protobuf-named ``via_mqtt`` key is read as well as ``viaMqtt``."""
    probe.probe_packet(_packet(via_mqtt=True, rxSnr=1.0), {})
    assert "classification='mqtt-over-rf'" in _lines(capsys)[0]


def test_snake_case_rf_fields_are_accepted(enabled, capsys):
    """Alternate RF metadata spellings still count as RF evidence."""
    probe.probe_packet(_packet(viaMqtt=True, rx_snr=-3.0), {})
    assert "classification='mqtt-over-rf'" in _lines(capsys)[0]


# ---------------------------------------------------------------------------
# Reported detail
# ---------------------------------------------------------------------------


def test_packet_detail_is_reported(enabled, capsys):
    """The line carries the fields needed to interpret a flagged packet."""
    probe.probe_packet(
        _packet(viaMqtt=True, rxSnr=-8.0, channel=2, relayNode=17),
        {"portnum": "TEXT_MESSAGE_APP"},
    )
    line = _lines(capsys)[0]
    for fragment in (
        "from_id='!336a1b2c'",
        "portnum='TEXT_MESSAGE_APP'",
        "channel=2",
        "hop_limit=3",
        "hop_start=3",
        "relay_node=17",
    ):
        assert fragment in line


def test_sender_id_is_canonicalised(enabled, capsys):
    """A numeric ``from`` is reported in canonical ``!hex`` form."""
    probe.probe_packet(_packet(fromId=None, **{"from": 0x336A1B2C}), {})
    assert "from_id='!336a1b2c'" in _lines(capsys)[0]


def test_uncanonicalisable_sender_falls_back_to_raw(enabled, capsys):
    """An unparseable sender is reported verbatim rather than dropped."""
    probe.probe_packet(_packet(fromId="not-a-node-id", rxSnr=1.0), {})
    assert "from_id='not-a-node-id'" in _lines(capsys)[0]


# ---------------------------------------------------------------------------
# Tally
# ---------------------------------------------------------------------------


def test_summary_is_emitted_on_the_configured_cadence(enabled, capsys, monkeypatch):
    """A tally line follows every ``_SUMMARY_EVERY`` packets."""
    monkeypatch.setattr(probe, "_SUMMARY_EVERY", 3)
    for _ in range(2):
        probe.probe_packet(_packet(rxSnr=1.0), {})
    assert not [line for line in _lines(capsys) if "tally" in line]

    probe.probe_packet(_packet(viaMqtt=True, rxSnr=1.0), {})
    (summary,) = [line for line in _lines(capsys) if "tally" in line]
    assert "probed_packets=3" in summary
    assert "direct_rf=2" in summary
    assert "mqtt_over_rf=1" in summary


def test_tally_tracks_distinct_flagged_senders(enabled, capsys, monkeypatch):
    """Flagged senders are de-duplicated and sorted in the tally."""
    monkeypatch.setattr(probe, "_SUMMARY_EVERY", 3)
    probe.probe_packet(_packet(fromId="!00000002", viaMqtt=True, rxSnr=1.0), {})
    probe.probe_packet(_packet(fromId="!00000001", viaMqtt=True, rxSnr=1.0), {})
    probe.probe_packet(_packet(fromId="!00000002", viaMqtt=True, rxSnr=1.0), {})
    (summary,) = [line for line in _lines(capsys) if "tally" in line]
    assert "flagged_senders=['!00000001', '!00000002']" in summary


def test_unflagged_senders_are_not_listed(enabled, capsys, monkeypatch):
    """Only MQTT-flagged senders appear in the tally's sender list."""
    monkeypatch.setattr(probe, "_SUMMARY_EVERY", 1)
    probe.probe_packet(_packet(rxSnr=1.0), {})
    (summary,) = [line for line in _lines(capsys) if "tally" in line]
    assert "flagged_senders=[]" in summary


def test_flagged_sender_list_is_capped(enabled, capsys, monkeypatch):
    """One pathological mesh cannot produce an unbounded log record."""
    monkeypatch.setattr(probe, "_MAX_LISTED_SENDERS", 2)
    monkeypatch.setattr(probe, "_SUMMARY_EVERY", 4)
    for index in range(4):
        probe.probe_packet(
            _packet(fromId=f"!0000000{index}", viaMqtt=True, rxSnr=1.0), {}
        )
    (summary,) = [line for line in _lines(capsys) if "tally" in line]
    assert "flagged_senders=['!00000000', '!00000001']" in summary


def test_reset_clears_counters(enabled, capsys, monkeypatch):
    """The test-only reset zeroes tallies and the flagged-sender set."""
    probe.probe_packet(_packet(viaMqtt=True, rxSnr=1.0), {})
    assert probe._probed_total == 1
    probe._reset_probe_state()
    assert probe._probed_total == 0
    assert probe._flagged_senders == set()
    assert all(count == 0 for count in probe._counts.values())


# ---------------------------------------------------------------------------
# Snapshot reporter
# ---------------------------------------------------------------------------


def test_snapshot_counts_flagged_roster_entries(enabled, capsys):
    """The snapshot line quantifies nodeDB contamination."""
    probe.probe_snapshot(
        [
            ("!00000001", {"viaMqtt": True}),
            ("!00000002", {}),
            ("!00000003", {"via_mqtt": True}),
        ]
    )
    (line,) = _lines(capsys)
    assert "snapshot_nodes=3" in line
    assert "flagged_nodes=2" in line
    assert "flagged_node_ids=['!00000001', '!00000003']" in line


def test_snapshot_handles_an_empty_roster(enabled, capsys):
    """An empty nodeDB reports zeroes rather than skipping the line."""
    probe.probe_snapshot([])
    (line,) = _lines(capsys)
    assert "snapshot_nodes=0" in line
    assert "flagged_nodes=0" in line


def test_snapshot_id_list_is_capped(enabled, capsys, monkeypatch):
    """Flagged node IDs are truncated to the listing cap."""
    monkeypatch.setattr(probe, "_MAX_LISTED_SENDERS", 1)
    probe.probe_snapshot(
        [("!00000001", {"viaMqtt": True}), ("!00000002", {"viaMqtt": True})]
    )
    (line,) = _lines(capsys)
    assert "flagged_nodes=2" in line
    assert "flagged_node_ids=['!00000001']" in line


# ---------------------------------------------------------------------------
# Failure guards — a diagnostic must never break ingestion
# ---------------------------------------------------------------------------


def test_packet_probe_swallows_internal_failure(enabled, capsys, monkeypatch):
    """A probe bug degrades to a warning rather than interrupting ingest."""

    def _boom(packet, decoded):
        raise RuntimeError("probe exploded")

    monkeypatch.setattr(probe, "_probe_packet_inner", _boom)
    probe.probe_packet(_packet(), {})
    (line,) = _lines(capsys)
    assert "[warning]" in line
    assert "error_class='RuntimeError'" in line


def test_snapshot_probe_swallows_internal_failure(enabled, capsys):
    """A malformed snapshot is reported, not raised."""

    def _exploding_items():
        yield ("!00000001", {})
        raise RuntimeError("snapshot exploded")

    probe.probe_snapshot(_exploding_items())
    (line,) = _lines(capsys)
    assert "[warning]" in line
    assert "error_class='RuntimeError'" in line


# ---------------------------------------------------------------------------
# Wiring — the probe observes without changing behaviour
# ---------------------------------------------------------------------------


def test_store_packet_dict_probes_before_routing(enabled, capsys, monkeypatch):
    """Every packet type is observed from the single pre-routing seam."""
    from data.mesh_ingestor.handlers import generic

    routed = []
    monkeypatch.setattr(
        generic, "store_nodeinfo_packet", lambda p, d: routed.append("nodeinfo")
    )

    generic.store_packet_dict(
        {
            "fromId": "!336a1b2c",
            "viaMqtt": True,
            "rxSnr": -9.0,
            "decoded": {"portnum": "NODEINFO_APP"},
        }
    )

    assert routed == ["nodeinfo"], "probe must not divert or swallow routing"
    assert "classification='mqtt-over-rf'" in _lines(capsys)[0]


def test_store_packet_dict_unaffected_when_probe_disabled(monkeypatch, capsys):
    """With the probe off, routing is byte-for-byte the previous behaviour."""
    from data.mesh_ingestor.handlers import generic

    monkeypatch.setattr(config, "VIA_MQTT_PROBE", False)
    routed = []
    monkeypatch.setattr(
        generic, "store_position_packet", lambda p, d: routed.append("position")
    )

    generic.store_packet_dict(
        {"fromId": "!336a1b2c", "viaMqtt": True, "decoded": {"portnum": "POSITION_APP"}}
    )

    assert routed == ["position"]
    assert _lines(capsys) == []


def test_daemon_snapshot_probes_and_still_upserts(enabled, capsys, monkeypatch):
    """The snapshot probe reports without consuming the upsert iterator."""
    import data.mesh_ingestor.daemon as daemon

    class _GeneratorProvider:
        """Returns a one-shot generator, as ``MeshProtocol`` permits."""

        def node_snapshot_items(self, iface):
            yield ("!00000001", {"viaMqtt": True})
            yield ("!00000002", {})

    state = daemon._DaemonState(
        provider=_GeneratorProvider(),  # type: ignore[arg-type]
        stop=None,  # type: ignore[arg-type]
        configured_port=None,
        inactivity_reconnect_secs=0.0,
        energy_saving_enabled=False,
        energy_online_secs=0.0,
        energy_sleep_secs=0.0,
        retry_delay=0.0,
        last_seen_packet_monotonic=None,
        active_candidate=None,
    )
    state.iface = object()

    upserted = []
    monkeypatch.setattr(
        daemon.handlers, "upsert_node", lambda nid, node: upserted.append(nid)
    )

    assert daemon._try_send_snapshot(state) is True
    assert upserted == ["!00000001", "!00000002"], "probe consumed the generator"

    (line,) = _lines(capsys)
    assert "snapshot_nodes=2" in line
    assert "flagged_nodes=1" in line
