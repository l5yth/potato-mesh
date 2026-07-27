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
"""Unit tests for the merged mesh-activity counter (SPEC MA1/MA2).

Covers :mod:`data.mesh_ingestor.activity` (the counter API), the receive-seam
wiring in :func:`data.mesh_ingestor.handlers._state._mark_packet_seen` (so every
received frame — stored, ignored, or errored — is counted), and the
per-interval ``packets`` delta carried by
:func:`data.mesh_ingestor.ingestors.queue_ingestor_heartbeat`.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.activity as activity
import data.mesh_ingestor.ingestors as ingestors_mod
from data.mesh_ingestor.handlers import _state
from data.mesh_ingestor.ingestors import (
    _IngestorState,
    queue_ingestor_heartbeat,
    set_ingestor_node_id,
)


@pytest.fixture(autouse=True)
def reset_activity_counter():
    """Zero the shared activity counter around every test for isolation."""
    activity.reset()
    yield
    activity.reset()


@pytest.fixture(autouse=True)
def reset_ingestor_state():
    """Swap in fresh ingestor identity state around every test."""
    original = ingestors_mod.STATE
    ingestors_mod.STATE = _IngestorState()
    yield
    ingestors_mod.STATE = original


# ---------------------------------------------------------------------------
# Counter API
# ---------------------------------------------------------------------------


class TestCounterApi:
    """Tests for the :mod:`data.mesh_ingestor.activity` counter primitives."""

    def test_record_packet_counts_one_by_default(self):
        """A bare ``record_packet()`` adds a single frame."""
        activity.record_packet()
        assert activity.take_packet_count() == 1

    def test_record_packet_counts_a_custom_amount(self):
        """``record_packet(n)`` adds ``n`` frames at once."""
        activity.record_packet(4)
        assert activity.take_packet_count() == 4

    def test_record_tx_counts_transmissions(self):
        """``record_tx()`` counts an ingestor transmission (MA1)."""
        activity.record_tx()
        activity.record_tx(2)
        assert activity.take_packet_count() == 3

    def test_rx_and_tx_share_one_merged_count(self):
        """RX and TX accumulate into a single merged figure (MA1)."""
        activity.record_packet(5)
        activity.record_tx(2)
        assert activity.take_packet_count() == 7

    def test_take_packet_count_resets_to_zero(self):
        """Reading the count via ``take_packet_count`` clears it (MA2)."""
        activity.record_packet(3)
        assert activity.take_packet_count() == 3
        assert activity.take_packet_count() == 0

    def test_reset_discards_the_running_total(self):
        """``reset()`` zeroes the counter without returning it."""
        activity.record_packet(9)
        activity.reset()
        assert activity.take_packet_count() == 0


# ---------------------------------------------------------------------------
# Receive seam — every frame counted, before any dispatch/drop
# ---------------------------------------------------------------------------


class TestReceiveSeam:
    """The RX seam counts every received frame regardless of its fate."""

    def test_mark_packet_seen_counts_the_frame(self):
        """``_mark_packet_seen`` increments the merged counter (MA1)."""
        _state._mark_packet_seen()
        assert activity.take_packet_count() == 1

    def test_mark_packet_activity_advances_clock_without_counting(self):
        """``_mark_packet_activity`` feeds the reconnect clock only (Model A).

        It advances the monotonic activity clock — so inactivity-reconnect sees
        the link is alive — but leaves the merged counter untouched. This is the
        seam for frames counted elsewhere (MeshCore's ``RX_LOG_DATA`` seam) and
        companion-link reads that are not over-air traffic, so counting is never
        duplicated.
        """
        _state._mark_packet_activity()
        assert activity.take_packet_count() == 0
        assert isinstance(_state.last_packet_monotonic(), float)

    def test_mark_packet_seen_also_advances_the_clock(self):
        """``_mark_packet_seen`` advances the reconnect clock as well (MA1)."""
        _state._mark_packet_seen()
        assert isinstance(_state.last_packet_monotonic(), float)

    def test_on_receive_counts_stored_ignored_and_errored(self, monkeypatch):
        """Every ``on_receive`` outcome is counted at the seam (MA1).

        The count is taken before dispatch, so a packet the downstream handler
        stores, ignores (returns without queuing), or errors on (raises) is
        counted identically.
        """
        from data.mesh_ingestor.handlers import generic

        monkeypatch.setattr(generic, "_pkt_to_dict", lambda p: dict(p))

        # Stored / ignored: store returns without raising.
        monkeypatch.setattr(generic, "store_packet_dict", lambda pkt: None)
        generic.on_receive({"id": 1}, object())
        assert activity.take_packet_count() == 1

        # Errored: store raises; on_receive swallows it, but the frame was
        # already counted at the seam.
        def _boom(pkt):
            raise RuntimeError("boom")

        monkeypatch.setattr(generic, "store_packet_dict", _boom)
        generic.on_receive({"id": 2}, object())
        assert activity.take_packet_count() == 1

    def test_on_receive_dedup_counts_once(self, monkeypatch):
        """A packet already flagged ``_potatomesh_seen`` is not re-counted."""
        from data.mesh_ingestor.handlers import generic

        monkeypatch.setattr(generic, "_pkt_to_dict", lambda p: dict(p))
        monkeypatch.setattr(generic, "store_packet_dict", lambda pkt: None)

        packet = {"id": 1}
        generic.on_receive(packet, object())
        generic.on_receive(packet, object())  # same dict → deduped
        assert activity.take_packet_count() == 1


# ---------------------------------------------------------------------------
# Heartbeat per-interval delta (MA2)
# ---------------------------------------------------------------------------


class TestHeartbeatDelta:
    """The heartbeat carries — and resets — the per-interval packet delta."""

    def test_heartbeat_delta_included_in_payload(self):
        """The heartbeat payload carries the accumulated ``packets`` count."""
        set_ingestor_node_id("!aabbccdd")
        activity.record_packet(7)
        sent = []
        queue_ingestor_heartbeat(force=True, send=lambda p, pl: sent.append(pl))
        assert sent[0]["packets"] == 7

    def test_heartbeat_delta_resets_between_sends(self):
        """Consecutive heartbeats report their own interval, not the cumulative."""
        set_ingestor_node_id("!aabbccdd")
        sent = []
        activity.record_packet(3)
        queue_ingestor_heartbeat(force=True, send=lambda p, pl: sent.append(pl))
        activity.record_packet(2)
        queue_ingestor_heartbeat(force=True, send=lambda p, pl: sent.append(pl))
        assert [pl["packets"] for pl in sent] == [3, 2]

    def test_heartbeat_delta_zero_when_no_traffic(self):
        """A heartbeat with no observed frames reports ``0``."""
        set_ingestor_node_id("!aabbccdd")
        sent = []
        queue_ingestor_heartbeat(force=True, send=lambda p, pl: sent.append(pl))
        assert sent[0]["packets"] == 0

    def test_heartbeat_delta_not_drained_when_suppressed(self):
        """A suppressed (interval-guarded) heartbeat must not discard the count."""
        set_ingestor_node_id("!aabbccdd")
        ingestors_mod.STATE.last_heartbeat = int(time.time())
        activity.record_packet(5)
        sent = []
        result = queue_ingestor_heartbeat(send=lambda p, pl: sent.append(pl))
        assert result is False
        assert sent == []
        # The interval-guarded heartbeat returned before building the payload,
        # so the 5 frames survive for the next real heartbeat.
        assert activity.take_packet_count() == 5
