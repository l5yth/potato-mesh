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

"""Protocol-agnostic event payload types for ingestion.

The ingestor ultimately POSTs JSON to the web app's ingest routes. These types
capture the *shape* of those payloads so multiple providers can emit the same
events, regardless of how they source or decode packets.

These are intentionally defined as ``TypedDict`` so existing code can continue
to build plain dictionaries without a runtime dependency on dataclasses.
"""

from __future__ import annotations

from typing import NotRequired, TypedDict


class _MessageEventRequired(TypedDict):
    id: int
    rx_time: int
    rx_iso: str


class MessageEvent(_MessageEventRequired, total=False):
    from_id: object
    to_id: object
    channel: int
    portnum: str | None
    text: str | None
    encrypted: str | None
    snr: float | None
    rssi: int | None
    hop_limit: int | None
    reply_id: int | None
    emoji: str | None
    channel_name: str
    ingestor: str | None
    lora_freq: int
    modem_preset: str


class _PositionEventRequired(TypedDict):
    id: int
    rx_time: int
    rx_iso: str


class PositionEvent(_PositionEventRequired, total=False):
    node_id: str
    node_num: int | None
    num: int | None
    from_id: str | None
    to_id: object
    latitude: float | None
    longitude: float | None
    altitude: float | None
    position_time: int | None
    location_source: str | None
    precision_bits: int | None
    sats_in_view: int | None
    pdop: float | None
    ground_speed: float | None
    ground_track: float | None
    snr: float | None
    rssi: int | None
    hop_limit: int | None
    bitfield: int | None
    payload_b64: str | None
    raw: dict
    ingestor: str | None
    lora_freq: int
    modem_preset: str


class _TelemetryEventRequired(TypedDict):
    id: int
    rx_time: int
    rx_iso: str


class TelemetryEvent(_TelemetryEventRequired, total=False):
    node_id: str | None
    node_num: int | None
    from_id: object
    to_id: object
    telemetry_time: int | None
    channel: int
    portnum: str | None
    hop_limit: int | None
    snr: float | None
    rssi: int | None
    bitfield: int | None
    payload_b64: str
    ingestor: str | None
    lora_freq: int
    modem_preset: str

    # Metric keys are intentionally open-ended; the Ruby side is permissive and
    # evolves over time.


class _NeighborEntryRequired(TypedDict):
    rx_time: int
    rx_iso: str


class NeighborEntry(_NeighborEntryRequired, total=False):
    neighbor_id: str
    neighbor_num: int | None
    snr: float | None


class _NeighborsSnapshotRequired(TypedDict):
    node_id: str
    rx_time: int
    rx_iso: str


class NeighborsSnapshot(_NeighborsSnapshotRequired, total=False):
    node_num: int | None
    neighbors: list[NeighborEntry]
    node_broadcast_interval_secs: int | None
    last_sent_by_id: str | None
    ingestor: str | None
    lora_freq: int
    modem_preset: str


class _TraceEventRequired(TypedDict):
    hops: list[int]
    rx_time: int
    rx_iso: str


class TraceEvent(_TraceEventRequired, total=False):
    id: int | None
    request_id: int | None
    src: int | None
    dest: int | None
    rssi: int | None
    snr: float | None
    elapsed_ms: int | None
    ingestor: str | None
    lora_freq: int
    modem_preset: str


class IngestorHeartbeat(TypedDict):
    node_id: str
    start_time: int
    last_seen_time: int
    version: str
    lora_freq: NotRequired[int]
    modem_preset: NotRequired[str]


NodeUpsert = dict[str, dict]


__all__ = [
    "IngestorHeartbeat",
    "MessageEvent",
    "NeighborEntry",
    "NeighborsSnapshot",
    "NodeUpsert",
    "PositionEvent",
    "TelemetryEvent",
    "TraceEvent",
]
