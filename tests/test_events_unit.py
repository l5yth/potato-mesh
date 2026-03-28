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
"""Unit tests for :mod:`data.mesh_ingestor.events`."""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from data.mesh_ingestor.events import (  # noqa: E402 - path setup
    IngestorHeartbeat,
    MessageEvent,
    NeighborEntry,
    NeighborsSnapshot,
    PositionEvent,
    TelemetryEvent,
    TraceEvent,
)


def test_message_event_requires_id_rx_time_rx_iso():
    event: MessageEvent = {"id": 1, "rx_time": 1700000000, "rx_iso": "2023-11-14T00:00:00Z"}
    assert event["id"] == 1
    assert event["rx_time"] == 1700000000
    assert event["rx_iso"] == "2023-11-14T00:00:00Z"


def test_message_event_accepts_optional_fields():
    event: MessageEvent = {
        "id": 2,
        "rx_time": 1700000001,
        "rx_iso": "2023-11-14T00:00:01Z",
        "text": "hello",
        "from_id": "!aabbccdd",
        "snr": 4.5,
        "rssi": -90,
    }
    assert event["text"] == "hello"
    assert event["snr"] == 4.5


def test_position_event_required_fields():
    event: PositionEvent = {"id": 10, "rx_time": 1700000002, "rx_iso": "2023-11-14T00:00:02Z"}
    assert event["id"] == 10


def test_position_event_optional_fields():
    event: PositionEvent = {
        "id": 11,
        "rx_time": 1700000003,
        "rx_iso": "2023-11-14T00:00:03Z",
        "latitude": 37.7749,
        "longitude": -122.4194,
        "altitude": 10.0,
        "node_id": "!aabbccdd",
    }
    assert event["latitude"] == 37.7749


def test_telemetry_event_required_fields():
    event: TelemetryEvent = {"id": 20, "rx_time": 1700000004, "rx_iso": "2023-11-14T00:00:04Z"}
    assert event["id"] == 20


def test_telemetry_event_optional_fields():
    event: TelemetryEvent = {
        "id": 21,
        "rx_time": 1700000005,
        "rx_iso": "2023-11-14T00:00:05Z",
        "channel": 0,
        "payload_b64": "AAEC",
        "snr": 3.0,
    }
    assert event["payload_b64"] == "AAEC"


def test_neighbor_entry_required_fields():
    entry: NeighborEntry = {"rx_time": 1700000006, "rx_iso": "2023-11-14T00:00:06Z"}
    assert entry["rx_time"] == 1700000006


def test_neighbor_entry_optional_fields():
    entry: NeighborEntry = {
        "rx_time": 1700000007,
        "rx_iso": "2023-11-14T00:00:07Z",
        "neighbor_id": "!11223344",
        "snr": 6.0,
    }
    assert entry["neighbor_id"] == "!11223344"


def test_neighbors_snapshot_required_fields():
    snap: NeighborsSnapshot = {
        "node_id": "!aabbccdd",
        "rx_time": 1700000008,
        "rx_iso": "2023-11-14T00:00:08Z",
    }
    assert snap["node_id"] == "!aabbccdd"


def test_neighbors_snapshot_optional_fields():
    snap: NeighborsSnapshot = {
        "node_id": "!aabbccdd",
        "rx_time": 1700000009,
        "rx_iso": "2023-11-14T00:00:09Z",
        "neighbors": [],
        "node_broadcast_interval_secs": 900,
    }
    assert snap["node_broadcast_interval_secs"] == 900


def test_trace_event_required_fields():
    event: TraceEvent = {
        "hops": [1, 2, 3],
        "rx_time": 1700000010,
        "rx_iso": "2023-11-14T00:00:10Z",
    }
    assert event["hops"] == [1, 2, 3]


def test_trace_event_optional_fields():
    event: TraceEvent = {
        "hops": [4, 5],
        "rx_time": 1700000011,
        "rx_iso": "2023-11-14T00:00:11Z",
        "elapsed_ms": 42,
        "snr": 2.5,
    }
    assert event["elapsed_ms"] == 42


def test_ingestor_heartbeat_all_fields():
    hb: IngestorHeartbeat = {
        "node_id": "!aabbccdd",
        "start_time": 1700000000,
        "last_seen_time": 1700000012,
        "version": "0.5.11",
        "lora_freq": 906875,
        "modem_preset": "LONG_FAST",
    }
    assert hb["version"] == "0.5.11"
    assert hb["lora_freq"] == 906875


def test_ingestor_heartbeat_without_optional_fields():
    hb: IngestorHeartbeat = {
        "node_id": "!aabbccdd",
        "start_time": 1700000000,
        "last_seen_time": 1700000013,
        "version": "0.5.11",
    }
    assert "lora_freq" not in hb
