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
    """Required fields shared by all :class:`MessageEvent` payloads."""

    id: int
    rx_time: int
    rx_iso: str


class MessageEvent(_MessageEventRequired, total=False):
    """Payload for the ``/api/messages`` ingest route.

    Maps to the ``MessageEvent`` contract described in ``CONTRACTS.md``.
    Required fields are inherited from :class:`_MessageEventRequired`;
    all other fields are optional.
    """

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
    """Required fields shared by all :class:`PositionEvent` payloads."""

    id: int
    rx_time: int
    rx_iso: str


class PositionEvent(_PositionEventRequired, total=False):
    """Payload for the ``/api/positions`` ingest route.

    Maps to the ``PositionEvent`` contract described in ``CONTRACTS.md``.
    Coordinates may be supplied as floating-point degrees or derived from
    Meshtastic's integer-scaled ``latitudeI``/``longitudeI`` fields.
    """

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
    """Required fields shared by all :class:`TelemetryEvent` payloads."""

    id: int
    rx_time: int
    rx_iso: str


class TelemetryEvent(_TelemetryEventRequired, total=False):
    """Payload for the ``/api/telemetry`` ingest route.

    Maps to the ``TelemetryEvent`` contract described in ``CONTRACTS.md``.
    Metric keys beyond the required ones are open-ended; the web layer accepts
    any additional device, environment, power, or air-quality fields.
    """

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
    """Required fields for a single entry within a :class:`NeighborsSnapshot`."""

    rx_time: int
    rx_iso: str


class NeighborEntry(_NeighborEntryRequired, total=False):
    """A single observed neighbour node within a :class:`NeighborsSnapshot`.

    Each entry describes one node heard by the reporting device, including
    optional signal-quality metrics.
    """

    neighbor_id: str
    neighbor_num: int | None
    snr: float | None


class _NeighborsSnapshotRequired(TypedDict):
    """Required fields shared by all :class:`NeighborsSnapshot` payloads."""

    node_id: str
    rx_time: int
    rx_iso: str


class NeighborsSnapshot(_NeighborsSnapshotRequired, total=False):
    """Payload for the ``/api/neighbors`` ingest route.

    Maps to the ``NeighborsSnapshot`` contract described in ``CONTRACTS.md``.
    Encapsulates the full list of neighbours heard by a single reporting node.
    """

    node_num: int | None
    neighbors: list[NeighborEntry]
    node_broadcast_interval_secs: int | None
    last_sent_by_id: str | None
    ingestor: str | None
    lora_freq: int
    modem_preset: str


class _TraceEventRequired(TypedDict):
    """Required fields shared by all :class:`TraceEvent` payloads."""

    hops: list[int]
    rx_time: int
    rx_iso: str


class TraceEvent(_TraceEventRequired, total=False):
    """Payload for the ``/api/traceroutes`` ingest route.

    Maps to the ``TraceEvent`` contract described in ``CONTRACTS.md``.
    The ``hops`` list contains node numbers in transmission order from
    source to destination.
    """

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
    """Payload for the ``/api/ingestors`` heartbeat route.

    Maps to the ``IngestorHeartbeat`` contract described in ``CONTRACTS.md``.
    Sent periodically to signal that the ingestor process is alive and
    associated with a particular radio node.
    """

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
