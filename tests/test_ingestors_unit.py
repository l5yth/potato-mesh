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
"""Unit tests for :mod:`data.mesh_ingestor.ingestors`."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.config as config
from data.mesh_ingestor.ingestors import (
    HEARTBEAT_INTERVAL_SECS,
    _IngestorState,
    ingestor_start_time,
    queue_ingestor_heartbeat,
    set_ingestor_node_id,
)
import data.mesh_ingestor.ingestors as ingestors_mod


@pytest.fixture(autouse=True)
def reset_ingestor_state():
    """Reset shared ingestor state between tests."""
    original = ingestors_mod.STATE
    ingestors_mod.STATE = _IngestorState()
    yield
    ingestors_mod.STATE = original


# ---------------------------------------------------------------------------
# ingestor_start_time
# ---------------------------------------------------------------------------


class TestIngestorStartTime:
    """Tests for :func:`ingestors.ingestor_start_time`."""

    def test_returns_integer(self):
        """Returns an integer unix timestamp."""
        result = ingestor_start_time()
        assert isinstance(result, int)

    def test_is_close_to_now(self):
        """Start time is within a few seconds of now (fresh state)."""
        result = ingestor_start_time()
        assert abs(result - int(time.time())) < 5

    def test_same_across_calls(self):
        """Returns the same value on repeated calls."""
        assert ingestor_start_time() == ingestor_start_time()


# ---------------------------------------------------------------------------
# set_ingestor_node_id
# ---------------------------------------------------------------------------


class TestSetIngestorNodeId:
    """Tests for :func:`ingestors.set_ingestor_node_id`."""

    def test_canonical_id_stored(self):
        """Sets canonical !xxxxxxxx node ID."""
        result = set_ingestor_node_id("!aabbccdd")
        assert result == "!aabbccdd"
        assert ingestors_mod.STATE.node_id == "!aabbccdd"

    def test_numeric_id_canonicalised(self):
        """Numeric node ID is canonicalised to !xxxxxxxx format."""
        result = set_ingestor_node_id(0xAABBCCDD)
        assert result is not None
        assert result.startswith("!")

    def test_none_returns_none(self):
        """None input returns None and does not update state."""
        ingestors_mod.STATE.node_id = "!existing"
        result = set_ingestor_node_id(None)
        assert result is None
        assert ingestors_mod.STATE.node_id == "!existing"

    def test_invalid_id_returns_none(self):
        """Invalid node ID returns None."""
        result = set_ingestor_node_id("not-a-node-id")
        assert result is None

    def test_new_id_resets_last_heartbeat(self):
        """Changing node ID resets the last heartbeat timestamp."""
        ingestors_mod.STATE.node_id = "!aabbccdd"
        ingestors_mod.STATE.last_heartbeat = 12345
        set_ingestor_node_id("!11223344")
        assert ingestors_mod.STATE.last_heartbeat is None

    def test_same_id_does_not_reset_heartbeat(self):
        """Setting the same node ID preserves the last heartbeat."""
        ingestors_mod.STATE.node_id = "!aabbccdd"
        ingestors_mod.STATE.last_heartbeat = 12345
        set_ingestor_node_id("!aabbccdd")
        assert ingestors_mod.STATE.last_heartbeat == 12345


# ---------------------------------------------------------------------------
# queue_ingestor_heartbeat
# ---------------------------------------------------------------------------


class TestQueueIngestorHeartbeat:
    """Tests for :func:`ingestors.queue_ingestor_heartbeat`."""

    def test_returns_false_when_no_node_id(self):
        """Returns False when no node ID is set."""
        assert queue_ingestor_heartbeat() is False

    def test_queues_heartbeat_with_node_id(self):
        """Returns True and queues a payload when node ID is set."""
        set_ingestor_node_id("!aabbccdd")
        sent = []
        result = queue_ingestor_heartbeat(
            send=lambda path, payload: sent.append((path, payload))
        )
        assert result is True
        assert len(sent) == 1
        path, payload = sent[0]
        assert path == "/api/ingestors"
        assert payload["node_id"] == "!aabbccdd"

    def test_payload_contains_required_fields(self):
        """Heartbeat payload includes all required contract fields."""
        set_ingestor_node_id("!aabbccdd")
        sent = []
        queue_ingestor_heartbeat(send=lambda path, payload: sent.append(payload))
        payload = sent[0]
        assert "node_id" in payload
        assert "start_time" in payload
        assert "last_seen_time" in payload
        assert "version" in payload

    def test_force_bypasses_interval(self):
        """force=True sends even within the heartbeat interval."""
        set_ingestor_node_id("!aabbccdd")
        ingestors_mod.STATE.last_heartbeat = int(time.time())
        sent = []
        result = queue_ingestor_heartbeat(
            force=True,
            send=lambda path, payload: sent.append(payload),
        )
        assert result is True
        assert len(sent) == 1

    def test_interval_prevents_duplicate_send(self):
        """Heartbeat is suppressed when interval has not elapsed."""
        set_ingestor_node_id("!aabbccdd")
        ingestors_mod.STATE.last_heartbeat = int(time.time())
        sent = []
        result = queue_ingestor_heartbeat(
            send=lambda path, payload: sent.append(payload)
        )
        assert result is False
        assert sent == []

    def test_heartbeat_with_node_id_kwarg(self):
        """Providing node_id kwarg sets it before sending."""
        sent = []
        result = queue_ingestor_heartbeat(
            node_id="!11223344",
            send=lambda path, payload: sent.append(payload),
        )
        assert result is True
        assert sent[0]["node_id"] == "!11223344"

    def test_lora_freq_included_when_set(self, monkeypatch):
        """lora_freq is included in payload when LORA_FREQ is configured."""
        set_ingestor_node_id("!aabbccdd")
        monkeypatch.setattr(config, "LORA_FREQ", 915.0)
        sent = []
        queue_ingestor_heartbeat(send=lambda path, payload: sent.append(payload))
        assert sent[0].get("lora_freq") == pytest.approx(915.0)

    def test_modem_preset_included_when_set(self, monkeypatch):
        """modem_preset is included in payload when MODEM_PRESET is configured."""
        set_ingestor_node_id("!aabbccdd")
        monkeypatch.setattr(config, "MODEM_PRESET", "LongFast")
        sent = []
        queue_ingestor_heartbeat(send=lambda path, payload: sent.append(payload))
        assert sent[0].get("modem_preset") == "LongFast"

    def test_updates_last_heartbeat_after_send(self):
        """STATE.last_heartbeat is updated after a successful send."""
        set_ingestor_node_id("!aabbccdd")
        before = int(time.time())
        queue_ingestor_heartbeat(send=lambda path, payload: None)
        assert ingestors_mod.STATE.last_heartbeat is not None
        assert ingestors_mod.STATE.last_heartbeat >= before
