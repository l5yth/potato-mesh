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
"""Unit tests for :mod:`data.mesh_ingestor.field_limits` (SPEC SL8, IB3).

The ingestor trims an oversized string loosely, at its web cap plus
``LOOSE_MARGIN_BYTES`` on a code-point boundary, and cuts a neighbour or hop
list to its first 16 entries, at the one place every payload passes on its way
to the web app: :func:`queue._queue_post_json` (ACCEPTANCE SL-A4, IB-A3).
No radio and no network: the HTTP transport is captured.
"""

from __future__ import annotations

import re
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from google.protobuf.json_format import MessageToDict  # noqa: E402
from meshtastic.protobuf import mesh_pb2, portnums_pb2  # noqa: E402

import data.mesh_ingestor.config as config  # noqa: E402
import data.mesh_ingestor.field_limits as field_limits  # noqa: E402
import data.mesh_ingestor.handlers.generic as generic  # noqa: E402
import data.mesh_ingestor.handlers.neighborinfo as neighborinfo  # noqa: E402
import data.mesh_ingestor.handlers.nodeinfo as nodeinfo  # noqa: E402
import data.mesh_ingestor.handlers.position as position  # noqa: E402
import data.mesh_ingestor.protocols.meshtastic_udp_decode as udp_decode  # noqa: E402
import data.mesh_ingestor.queue as queue  # noqa: E402

# One family emoji: seven code points, 25 bytes, one grapheme cluster.
FAMILY = "\U0001f468\u200d\U0001f469\u200d\U0001f467\u200d\U0001f466"

# The web module holding the final caps the ingestor mirrors.
WEB_FIELD_LIMITS = (
    REPO_ROOT / "web/lib/potato_mesh/application/data_processing/field_limits.rb"
)


@pytest.fixture
def posted(monkeypatch):
    """Capture every payload the queue hands the HTTP transport.

    The real :func:`queue._queue_post_json` runs, so its trim runs too; only
    the transport is replaced, and the queue drains inline.

    Yields:
        The list of ``(path, payload)`` pairs sent, in order.
    """

    sent: list[tuple[str, object]] = []
    monkeypatch.setattr(
        queue, "_post_json", lambda path, payload, **_kw: sent.append((path, payload))
    )
    monkeypatch.setattr(queue.STATE, "drainer", None)
    monkeypatch.setattr(config, "DEBUG", False)
    queue._clear_post_queue()
    yield sent
    queue._clear_post_queue()


def _utf8_len(text: str) -> int:
    """Return the UTF-8 size of ``text`` in bytes."""

    return len(text.encode("utf-8"))


# ---------------------------------------------------------------------------
# The POST boundary (SL-A4)
# ---------------------------------------------------------------------------


def test_nodeinfo_with_a_60000_byte_long_name_posts_it_cut_to_576_bytes(posted):
    """A protobuf parses any length; the queued node carries the loose cut."""

    user = mesh_pb2.User(
        id="!b5b5b5b5", long_name="A" * 60_000, short_name="WAYTOOLONG"
    )
    decoded = {"portnum": "NODEINFO_APP", "user": MessageToDict(user)}
    packet = {"fromId": "!b5b5b5b5", "rxTime": int(time.time()), "decoded": decoded}

    nodeinfo.store_nodeinfo_packet(packet, decoded)

    nodes = [payload for path, payload in posted if path == "/api/nodes"]
    posted_user = nodes[0]["!b5b5b5b5"]["user"]
    assert posted_user["longName"] == "A" * 576
    assert posted_user["shortName"] == "WAYTOOLONG"


def test_upsert_node_posts_a_1mb_long_name_cut_to_576_bytes(posted):
    """The snapshot path is cut at the same boundary."""

    generic.upsert_node("!b5b5b5b6", {"user": {"longName": "A" * 1_000_000}})

    nodes = [payload for path, payload in posted if path == "/api/nodes"]
    assert nodes[0]["!b5b5b5b6"]["user"]["longName"] == "A" * 576


def test_queue_post_json_cuts_a_message_text_before_it_is_queued():
    """A custom transport sees the cut payload; the caller's dict is unchanged."""

    sent: list[tuple[str, object]] = []
    message = {"id": 1, "text": "x" * 5_000, "from_id": "!b5b5b5b7"}

    queue._queue_post_json(
        "/api/messages",
        message,
        state=queue.QueueState(),
        send=lambda path, payload: sent.append((path, payload)),
    )

    assert sent == [
        ("/api/messages", {"id": 1, "text": "x" * 1_088, "from_id": "!b5b5b5b7"})
    ]
    assert message["text"] == "x" * 5_000


# ---------------------------------------------------------------------------
# loose_cut
# ---------------------------------------------------------------------------


def test_loose_cut_returns_text_within_the_margin_unchanged():
    """Text up to the cap plus the margin is the same object."""

    short = "Alice"
    exact = "a" * (16 + field_limits.LOOSE_MARGIN_BYTES)
    assert field_limits.loose_cut(short, 16) is short
    assert field_limits.loose_cut(exact, 16) is exact


def test_loose_cut_cuts_ascii_at_the_cap_plus_the_margin():
    """ASCII is cut at exactly ``cap + LOOSE_MARGIN_BYTES`` bytes."""

    assert field_limits.loose_cut("a" * 1_000, 16) == "a" * 80


def test_loose_cut_ends_on_a_code_point_boundary():
    """A two-byte character never loses half of its bytes."""

    cut = field_limits.loose_cut("\u00e9" * 1_000, 17)
    assert cut == "\u00e9" * 40
    assert _utf8_len(cut) == 80


def test_loose_cut_may_split_a_cluster_and_leaves_the_rest_to_the_web():
    """Code points, not clusters: the web makes the final grapheme cut."""

    text = FAMILY * 100
    cut = field_limits.loose_cut(text, 16)
    assert text.startswith(cut)
    assert _utf8_len(cut) <= 80
    assert _utf8_len(cut) > 80 - 4


def test_loose_cut_drops_lone_surrogates_from_a_cut_value():
    """A cut value is always encodable UTF-8."""

    cut = field_limits.loose_cut("a\ud800" * 400, 16)
    assert cut == "a" * 20
    assert cut.encode("utf-8")


# ---------------------------------------------------------------------------
# bound_post_payload
# ---------------------------------------------------------------------------


def test_bound_post_payload_cuts_every_node_entry_and_leaves_the_rest():
    """Node entries are bounded per key; wrapper keys and fitting entries stay."""

    fitting = {"user": {"longName": "Fits"}}
    payload = {
        "!b5b5b5b8": {"user": {"longName": "L" * 1_000, "shortName": "S" * 100}},
        "!b5b5b5b9": fitting,
        "!b5b5b5bf": {"interface": "i" * 400},
        "ingestor": "!b5b5b5ba",
        "protocol": "meshtastic",
    }

    bounded = field_limits.bound_post_payload("/api/nodes", payload)

    assert bounded["!b5b5b5b8"]["user"] == {
        "longName": "L" * 576,
        "shortName": "S" * 80,
    }
    assert bounded["!b5b5b5bf"] == {"interface": "i" * 320}
    assert bounded["!b5b5b5b9"] is fitting
    assert bounded["ingestor"] == "!b5b5b5ba"
    assert bounded["protocol"] == "meshtastic"
    assert payload["!b5b5b5b8"]["user"]["longName"] == "L" * 1_000


def test_bound_post_payload_returns_a_fitting_payload_as_the_same_object():
    """Nothing is copied when nothing needs a cut."""

    nodes = {"!b5b5b5bb": {"user": {"longName": "Fits"}}, "protocol": "meshcore"}
    message = {"text": "fits", "channel_name": "#test"}
    batch = [message, "not a record"]
    assert field_limits.bound_post_payload("/api/nodes", nodes) is nodes
    assert field_limits.bound_post_payload("/api/messages", message) is message
    assert field_limits.bound_post_payload("/api/messages", batch) is batch


def test_bound_post_payload_cuts_each_record_of_a_batch():
    """A list payload is bounded record by record."""

    batch = [{"text": "t" * 2_000}, {"text": "fits"}]
    bounded = field_limits.bound_post_payload("/api/messages", batch)
    assert bounded == [{"text": "t" * 1_088}, {"text": "fits"}]
    assert bounded[1] is batch[1]


def test_bound_post_payload_ignores_unknown_routes_and_non_text_values():
    """Routes without caps, non-string values and non-mapping levels pass."""

    neighbors = {"neighbors": [{"neighbor_id": "!b5b5b5bc"}], "rx_iso": "x" * 500}
    odd = {
        "!b5b5b5bd": {"user": "not a mapping", "position": {"locationSource": 7}},
        "!b5b5b5be": None,
    }
    assert field_limits.bound_post_payload("/api/unknown", neighbors) is neighbors
    assert field_limits.bound_post_payload("/api/neighbors", neighbors) is neighbors
    assert field_limits.bound_post_payload("/api/nodes", odd) is odd
    assert field_limits.bound_post_payload("/api/nodes", "not a mapping") == (
        "not a mapping"
    )


def test_bound_post_payload_cuts_nested_telemetry_and_position_fields():
    """Nested paths of the route tables are followed."""

    telemetry = {"host_metrics": {"userString": "u" * 1_000}, "payload_b64": "p" * 900}
    position = {"position": {"raw": {"location_source": "l" * 200}}}
    assert field_limits.bound_post_payload("/api/telemetry", telemetry) == {
        "host_metrics": {"userString": "u" * 320},
        "payload_b64": "p" * 576,
    }
    assert field_limits.bound_post_payload("/api/positions", position) == {
        "position": {"raw": {"location_source": "l" * 96}}
    }


def test_caps_match_the_web_caps():
    """Every cap the ingestor trims to is the web's cap of the same name."""

    source = WEB_FIELD_LIMITS.read_text(encoding="utf-8")
    web_caps = {
        name: int(value)
        for name, value in re.findall(r"^\s*([A-Z_]+)_BYTES = (\d+)$", source, re.M)
    }
    assert {name: web_caps.get(name) for name in field_limits.CAPS} == dict(
        field_limits.CAPS
    )


# ---------------------------------------------------------------------------
# Entry caps on neighbour and hop lists (SPEC IB3, IB-A3)
# ---------------------------------------------------------------------------

# Largest UDP payload; one datagram carries one MeshPacket.
UDP_PAYLOAD_BYTES = 65_507


def _udp_packet(portnum: int, payload: bytes) -> dict:
    """Map a broadcast MeshPacket the way the UDP transport does.

    Parameters:
        portnum: ``PortNum`` value of the decoded payload.
        payload: Serialised protobuf payload.

    Returns:
        The packet dict :func:`meshpacket_to_packet_dict` builds, after
        checking that the packet fits one UDP datagram.
    """

    packet = mesh_pb2.MeshPacket()
    setattr(packet, "from", 0x11223344)
    packet.to = 0xFFFFFFFF
    packet.id = 0x0BADF00D
    packet.decoded.portnum = portnum
    packet.decoded.payload = payload
    assert len(packet.SerializeToString()) <= UDP_PAYLOAD_BYTES
    return udp_decode.meshpacket_to_packet_dict(packet)


def test_udp_traceroute_with_16000_hops_posts_the_first_16(posted):
    """One datagram carries 16,000 route entries; the queued trace keeps 16."""

    route = mesh_pb2.RouteDiscovery()
    route.route.extend(range(0x40000000, 0x40000000 + 16_000))
    packet = _udp_packet(portnums_pb2.PortNum.TRACEROUTE_APP, route.SerializeToString())

    position.store_traceroute_packet(packet, packet["decoded"])

    traces = [payload for path, payload in posted if path == "/api/traces"]
    assert traces[0]["hops"] == list(range(0x40000000, 0x40000000 + 16))


def test_udp_neighborinfo_with_4000_neighbours_posts_the_first_16(posted):
    """One datagram carries 4,000 neighbours; the queued snapshot keeps 16."""

    info = mesh_pb2.NeighborInfo(node_id=0x11223344)
    for index in range(4_000):
        info.neighbors.add(node_id=0x50000000 + index, snr=1.0)
    packet = _udp_packet(
        portnums_pb2.PortNum.NEIGHBORINFO_APP, info.SerializeToString()
    )

    neighborinfo.store_neighborinfo_packet(packet, packet["decoded"])

    snapshots = [payload for path, payload in posted if path == "/api/neighbors"]
    ids = [entry["neighbor_id"] for entry in snapshots[0]["neighbors"]]
    assert ids == [f"!{0x50000000 + index:08x}" for index in range(16)]


def test_bound_post_payload_keeps_the_first_16_neighbours_and_hops():
    """Each list is cut to its first entries; the caller's payload is unchanged."""

    neighbors = {
        "node_id": "!b5b5b5c0",
        "neighbors": [{"neighbor_id": f"!b5b5{index:04x}"} for index in range(40)],
    }
    trace = {"id": 1, "hops": list(range(100)), "rx_iso": "x" * 500}

    bounded_neighbors = field_limits.bound_post_payload("/api/neighbors", neighbors)
    bounded_trace = field_limits.bound_post_payload("/api/traces", trace)

    assert bounded_neighbors["neighbors"] == neighbors["neighbors"][:16]
    assert bounded_neighbors["node_id"] == "!b5b5b5c0"
    assert bounded_trace == {"id": 1, "hops": list(range(16)), "rx_iso": "x" * 96}
    assert len(neighbors["neighbors"]) == 40
    assert len(trace["hops"]) == 100


def test_bound_post_payload_returns_lists_within_their_cap_as_the_same_object():
    """A list of 16 entries, a value that is no list and a batch stay as they are."""

    trace = {"id": 2, "hops": list(range(16))}
    odd = {"id": 3, "hops": "not a list"}
    batch = [trace, odd]
    snapshot = {"neighbors": None}
    assert field_limits.bound_post_payload("/api/traces", trace) is trace
    assert field_limits.bound_post_payload("/api/traces", odd) is odd
    assert field_limits.bound_post_payload("/api/traces", batch) is batch
    assert field_limits.bound_post_payload("/api/neighbors", snapshot) is snapshot


def test_entry_caps_match_the_web_caps():
    """Every entry cap the ingestor cuts to is the web's cap of the same name."""

    source = WEB_FIELD_LIMITS.read_text(encoding="utf-8")
    web_caps = {
        name: int(value)
        for name, value in re.findall(r"^\s*([A-Z_]+)_ENTRIES = (\d+)$", source, re.M)
    }
    assert set(field_limits.ENTRY_CAPS) == {"NEIGHBOR", "TRACE_HOP"}
    assert {name: web_caps.get(name) for name in field_limits.ENTRY_CAPS} == dict(
        field_limits.ENTRY_CAPS
    )
