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
"""A Meshtastic NodeInfo is filed under the node that sent it (SPEC NI1).

Packets are real ``MeshPacket`` protobufs handed to the pinned meshtastic
library's own ``MeshInterface._handlePacketFromRadio`` (``noProto=True``: no
device, no serial port, pubsub delivered synchronously) and from there to the
production subscription, so every case sees the dict shapes a radio produces.
The radio's nodeDB at connect holds three nodes: the sender ``A``, the node
``B`` its NodeInfo names, and a third node ``C``.  Only the HTTP queue is
replaced; nothing touches the network.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import meshtastic  # noqa: E402
from meshtastic import mesh_interface as lib_mesh_interface  # noqa: E402
from meshtastic.protobuf import mesh_pb2, portnums_pb2  # noqa: E402
from pubsub import pub  # noqa: E402

from daemon_fakes import make_state  # noqa: E402

import data.mesh_ingestor.activity as activity  # noqa: E402
import data.mesh_ingestor.channels as channels  # noqa: E402
import data.mesh_ingestor.config as config  # noqa: E402
import data.mesh_ingestor.daemon as daemon  # noqa: E402
import data.mesh_ingestor.handlers as handlers  # noqa: E402
import data.mesh_ingestor.handlers._state as _state  # noqa: E402
import data.mesh_ingestor.handlers.ignored as ignored_mod  # noqa: E402
import data.mesh_ingestor.interfaces as interfaces  # noqa: E402
import data.mesh_ingestor.queue as queue  # noqa: E402
from data.mesh_ingestor.protocols.meshtastic import MeshtasticProvider  # noqa: E402

SENDER = 0xA1A1A1A1
"""Node number in the header ``from`` of every packet: the radio that sent it."""

SENDER_ID = "!a1a1a1a1"
"""Canonical id of :data:`SENDER`."""

NAMED = 0xB2B2B2B2
"""Node number of the node the sender's NodeInfo names as itself."""

NAMED_ID = "!b2b2b2b2"
"""Canonical id of :data:`NAMED`."""

OTHER = 0xC3C3C3C3
"""A third node in the radio's nodeDB."""

OTHER_ID = "!c3c3c3c3"
"""Canonical id of :data:`OTHER`."""

NODEINFO_APP = portnums_pb2.PortNum.NODEINFO_APP
"""Port number of the dispatch-table entry the ingestor guards."""


@pytest.fixture
def posts(monkeypatch, tmp_path):
    """Neutral ingest filters; every queued POST is recorded instead of sent.

    Returns:
        A list that collects ``(path, payload)`` for each queued request.
    """

    for name, value in (
        ("DEBUG", False),
        ("PROTOCOL", "meshtastic"),
        ("ALLOWED_CHANNELS", ()),
        ("HIDDEN_CHANNELS", ()),
        ("PRIMARY_CHANNEL_ONLY", False),
        ("DROP_VIA_MQTT", False),
        ("PRIMARY_CHANNEL_NAME", ""),
        ("LORA_FREQ", None),
        ("MODEM_PRESET", None),
    ):
        monkeypatch.setattr(config, name, value, raising=False)
    for name in (
        "_host_node_id",
        "_host_telemetry_last_rx",
        "_host_nodeinfo_last_seen",
    ):
        monkeypatch.setattr(_state, name, None)
    monkeypatch.setattr(ignored_mod, "_IGNORED_PACKET_LOG_PATH", tmp_path / "x.txt")
    monkeypatch.setattr(activity, "_packet_count", 0)
    channels._reset_channel_cache()
    recorded: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        queue,
        "_queue_post_json",
        lambda path, payload, *, priority=None, **_kw: recorded.append((path, payload)),
    )
    yield recorded
    channels._reset_channel_cache()


@pytest.fixture
def warnings_logged(monkeypatch):
    """Capture ``warn`` log lines instead of printing them.

    Returns:
        A list that collects each warning's context and metadata.
    """

    logged: list[dict] = []

    def record(message, *, context=None, severity="debug", **metadata):
        """Keep the warnings and drop every other log line."""

        if severity == "warn":
            logged.append({"context": context, **metadata})

    monkeypatch.setattr(config, "_debug_log", record)
    return logged


@pytest.fixture
def radio(posts, monkeypatch):
    """The pinned library's interface after connect, wired to the subscription.

    The ingestor's meshtastic patches are applied to the real library the way
    importing :mod:`data.mesh_ingestor.interfaces` applies them; the library's
    dispatch table and module attribute are restored afterwards.

    Returns:
        A namespace with the interface ``iface`` and the recorded ``posts``.
    """

    monkeypatch.setitem(
        meshtastic.protocols, NODEINFO_APP, meshtastic.protocols[NODEINFO_APP]
    )
    monkeypatch.setattr(meshtastic, "_onNodeInfoReceive", meshtastic._onNodeInfoReceive)
    interfaces._patch_meshtastic_nodeinfo_handler()
    monkeypatch.setattr(lib_mesh_interface.publishingThread, "queueWork", lambda w: w())
    iface = lib_mesh_interface.MeshInterface(noProto=True)
    iface.nodes = {}
    iface.nodesByNum = {}
    topics = MeshtasticProvider().subscribe()
    for num, name in (
        (SENDER, "Sender Radio"),
        (NAMED, "Named Node"),
        (OTHER, "Other"),
    ):
        info = mesh_pb2.NodeInfo(
            num=num, user=mesh_pb2.User(id=f"!{num:08x}", long_name=name)
        )
        iface._handleFromRadio(mesh_pb2.FromRadio(node_info=info).SerializeToString())
    yield SimpleNamespace(iface=iface, posts=posts)
    for topic in topics:
        pub.unsubscribe(handlers.on_receive, topic)


def _hear(iface, port: str, payload: bytes, *, packet_id: int) -> None:
    """Deliver one received ``MeshPacket`` whose header ``from`` is :data:`SENDER`."""

    packet = mesh_pb2.MeshPacket()
    setattr(packet, "from", SENDER)
    packet.to = 0xFFFFFFFF
    packet.id = packet_id
    packet.channel = 0
    packet.rx_time = int(time.time())
    packet.decoded.portnum = portnums_pb2.PortNum.Value(port)
    packet.decoded.payload = payload
    iface._handlePacketFromRadio(packet)


def _profile_naming_another_node() -> bytes:
    """A ``NODEINFO_APP`` payload from :data:`SENDER` whose ``user.id`` is :data:`NAMED_ID`."""

    return mesh_pb2.User(
        id=NAMED_ID, long_name="Mallory", short_name="MLRY", hw_model=9
    ).SerializeToString()


def _varint(value: int) -> bytes:
    """Encode ``value`` as a protobuf base-128 varint."""

    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if not value:
            out.append(byte)
            return bytes(out)
        out.append(byte | 0x80)


def _nodeinfo_payload_with_another_number() -> bytes:
    """A ``NODEINFO_APP`` payload from :data:`SENDER` that carries :data:`NAMED`'s number.

    Field 1 appears twice: as a varint it is ``NodeInfo.num`` (the number of
    :data:`NAMED`), as a string ``User.id`` (the sender's own id).  The
    library parses the payload as a ``User`` and sees the sender's id; the
    ingestor's decoder parses it as a ``NodeInfo`` and sees the other number.
    """

    sender_id = SENDER_ID.encode()
    profile = mesh_pb2.User(
        id=SENDER_ID, long_name="Sender Radio", short_name="SNDR"
    ).SerializeToString()
    return (
        b"\x08"
        + _varint(NAMED)
        + b"\x0a"
        + bytes([len(sender_id)])
        + sender_id
        + b"\x12"
        + bytes([len(profile)])
        + profile
    )


def _node_posts(recorded) -> dict[str, dict]:
    """Merge every ``/api/nodes`` POST body into ``{node_id: entry}``."""

    out: dict[str, dict] = {}
    for path, payload in recorded:
        if path == "/api/nodes":
            out.update({k: v for k, v in payload.items() if k.startswith("!")})
    return out


def _snapshot(radio) -> dict[str, dict]:
    """Run the daemon's node-list snapshot over ``radio``; return the posted nodes."""

    radio.posts.clear()
    state = make_state(provider=MeshtasticProvider(), iface=radio.iface)
    assert daemon._try_send_snapshot(state)
    return _node_posts(radio.posts)


def test_nodeinfo_naming_another_node_posts_nothing_keyed_on_it(radio, warnings_logged):
    """A NodeInfo from A whose ``user.id`` is B is dropped with a warning naming both."""

    _hear(radio.iface, "NODEINFO_APP", _profile_naming_another_node(), packet_id=0x51)

    assert _node_posts(radio.posts) == {}
    assert warnings_logged == [
        {
            "context": "handlers.store_nodeinfo",
            "from_id": SENDER_ID,
            "user_id": NAMED_ID,
        }
    ]
    # The library's nodeDB keeps each node under its own profile.
    assert radio.iface.nodesByNum[SENDER]["user"]["id"] == SENDER_ID
    assert radio.iface.nodes[NAMED_ID]["num"] == NAMED


def test_later_packets_stay_attributed_to_the_header_source(radio):
    """After such a NodeInfo, A's own position and text still post under A."""

    _hear(radio.iface, "NODEINFO_APP", _profile_naming_another_node(), packet_id=0x52)
    radio.posts.clear()
    position = mesh_pb2.Position(
        latitude_i=481_000_000, longitude_i=116_000_000, time=int(time.time())
    ).SerializeToString()
    _hear(radio.iface, "POSITION_APP", position, packet_id=0x53)
    _hear(radio.iface, "TEXT_MESSAGE_APP", b"hello from the sender", packet_id=0x54)

    attributed = [
        (path, payload.get("node_id") or payload.get("from_id"))
        for path, payload in radio.posts
        if path in ("/api/positions", "/api/messages")
    ]
    assert attributed == [("/api/positions", SENDER_ID), ("/api/messages", SENDER_ID)]


def test_neighborinfo_naming_another_node_is_dropped(radio, warnings_logged):
    """A NeighborInfo from A whose ``node_id`` is B posts nothing; A's own posts under A."""

    foreign = mesh_pb2.NeighborInfo(
        node_id=NAMED, neighbors=[mesh_pb2.Neighbor(node_id=OTHER, snr=5.0)]
    ).SerializeToString()
    own = mesh_pb2.NeighborInfo(
        node_id=SENDER, neighbors=[mesh_pb2.Neighbor(node_id=OTHER, snr=5.0)]
    ).SerializeToString()

    _hear(radio.iface, "NEIGHBORINFO_APP", foreign, packet_id=0x61)
    _hear(radio.iface, "NEIGHBORINFO_APP", own, packet_id=0x62)

    filed = [
        (body["node_id"], body["node_num"])
        for path, body in radio.posts
        if path == "/api/neighbors"
    ]
    assert filed == [(SENDER_ID, SENDER)]
    assert warnings_logged == [
        {
            "context": "handlers.store_neighborinfo",
            "from_id": SENDER_ID,
            "node_id": NAMED_ID,
        }
    ]


def test_nodeinfo_number_naming_another_node_is_not_posted(radio, warnings_logged):
    """A NodeInfo-format payload carrying B's number posts the sender's own number."""

    _hear(
        radio.iface,
        "NODEINFO_APP",
        _nodeinfo_payload_with_another_number(),
        packet_id=0x64,
    )

    nodes = _node_posts(radio.posts)
    assert {node_id: entry["num"] for node_id, entry in nodes.items()} == {
        SENDER_ID: SENDER
    }
    assert warnings_logged == []


def test_nodeinfo_without_a_user_id_reaches_the_handler(radio):
    """A NodeInfo whose ``User`` has no ``id`` is filed under its sender.

    The library's own NodeInfo callback raised ``KeyError('id')`` on it, which
    ended ``_handlePacketFromRadio`` before the packet was published.
    """

    profile = mesh_pb2.User(long_name="No Id", short_name="NOID").SerializeToString()

    _hear(radio.iface, "NODEINFO_APP", profile, packet_id=0x63)

    nodes = _node_posts(radio.posts)
    assert {node_id: entry["user"]["longName"] for node_id, entry in nodes.items()} == {
        SENDER_ID: "No Id"
    }
    assert radio.iface.nodesByNum[SENDER]["user"]["id"] == SENDER_ID


def test_nodeinfo_with_a_non_canonical_user_id_is_dropped(radio, warnings_logged):
    """Only the sender's canonical id files a NodeInfo under the sender.

    A ``user.id`` that names no node, or the sender in another spelling, is a
    present id other than the sender's canonical one: dropped like one naming
    another node, and kept out of the library's node database.
    """

    for packet_id, claimed in ((0x65, "!Decrypted"), (0x66, "!A1A1A1A1")):
        profile = mesh_pb2.User(id=claimed, long_name="Decoded").SerializeToString()
        _hear(radio.iface, "NODEINFO_APP", profile, packet_id=packet_id)

    assert _node_posts(radio.posts) == {}
    assert warnings_logged == [
        {"context": "handlers.store_nodeinfo", "from_id": SENDER_ID, "user_id": claimed}
        for claimed in ("!Decrypted", "!A1A1A1A1")
    ]
    assert radio.iface.nodesByNum[SENDER]["user"]["id"] == SENDER_ID
    assert set(radio.iface.nodes) == {SENDER_ID, NAMED_ID, OTHER_ID}


def test_snapshot_skips_an_entry_whose_num_disagrees_with_its_id(radio):
    """A nodeDB entry filed under another node's id is not posted under that id."""

    # The library view an unguarded NodeInfo naming B leaves behind: A's own
    # entry is filed under B's id as well.
    radio.iface.nodes[NAMED_ID] = radio.iface.nodesByNum[SENDER]

    nodes = _snapshot(radio)

    assert {node_id: entry["num"] for node_id, entry in nodes.items()} == {
        SENDER_ID: SENDER,
        OTHER_ID: OTHER,
    }


def test_snapshot_still_posts_every_radio_entry(radio):
    """The snapshot legitimately posts other nodes: every entry under its own id."""

    nodes = _snapshot(radio)

    assert set(nodes) == {SENDER_ID, NAMED_ID, OTHER_ID}
    for node_id, entry in nodes.items():
        assert f"!{entry['num']:08x}" == node_id == entry["user"]["id"]
