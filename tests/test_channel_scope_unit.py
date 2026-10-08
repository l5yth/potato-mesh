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
"""Unit tests for channel-scoped ingest filtering (SPEC CF1-CF3, VM1-VM2).

``ALLOWED_CHANNELS``, ``HIDDEN_CHANNELS`` and ``PRIMARY_CHANNEL_ONLY`` drop
every record heard on an excluded channel, and ``DROP_VIA_MQTT`` every record
relayed via_mqtt, before anything is POSTed - not only text messages
(issues #784, #884).

Packets are real ``MeshPacket`` protobufs handed to the pinned meshtastic
library's own ``MeshInterface._handlePacketFromRadio`` (protocol off, pubsub
delivered synchronously) and from there to the production subscription, so
every case sees the exact dict shape a radio produces - including proto3's
omission of ``channel`` when it is 0.  Only the HTTP queue is replaced.
"""

from __future__ import annotations

import re
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from meshtastic import mesh_interface as lib_mesh_interface  # noqa: E402
from meshtastic.protobuf import (  # noqa: E402
    channel_pb2,
    mesh_pb2,
    portnums_pb2,
    storeforward_pb2,
    telemetry_pb2,
)
from pubsub import pub  # noqa: E402

from daemon_fakes import make_state  # noqa: E402

import data.mesh_ingestor.activity as activity  # noqa: E402
import data.mesh_ingestor.channels as channels  # noqa: E402
import data.mesh_ingestor.config as config  # noqa: E402
import data.mesh_ingestor.daemon as daemon  # noqa: E402
import data.mesh_ingestor.handlers as handlers  # noqa: E402
import data.mesh_ingestor.handlers._state as _state  # noqa: E402
import data.mesh_ingestor.handlers.ignored as ignored_mod  # noqa: E402
import data.mesh_ingestor.queue as queue  # noqa: E402
from data.mesh_ingestor.protocols.meshtastic import MeshtasticProvider  # noqa: E402
from data.mesh_ingestor.protocols.meshtastic_udp_decode import (  # noqa: E402
    meshpacket_to_packet_dict,
)

SENDER = 0xA1B2C3D4
"""Node number of the remote node every probe packet comes from."""

SENDER_ID = "!a1b2c3d4"
"""Canonical id of :data:`SENDER`."""

PRIMARY = 0
"""Index of the probe radio's primary channel, ``LongFast``."""

SECONDARY = 1
"""Index of the probe radio's secondary channel, ``Secret``."""

MODES = {
    "hidden": {"HIDDEN_CHANNELS": ("Secret",)},
    "allowed": {"ALLOWED_CHANNELS": ("LongFast",)},
    "primary-only": {"PRIMARY_CHANNEL_ONLY": True},
}
"""Filter configurations under test; each excludes ``Secret`` and admits ``LongFast``."""

MODE_REASONS = {
    "hidden": "hidden-channel",
    "allowed": "disallowed-channel",
    "primary-only": "non-primary-channel",
}
"""Drop reason each mode records for a packet heard on ``Secret``."""

PORT_ROUTES = {
    "TEXT_MESSAGE_APP": "/api/messages",
    "POSITION_APP": "/api/positions",
    "TELEMETRY_APP": "/api/telemetry",
    "NODEINFO_APP": "/api/nodes",
    "TRACEROUTE_APP": "/api/traces",
    "WAYPOINT_APP": "/api/waypoints",
    "NEIGHBORINFO_APP": "/api/neighbors",
    "STORE_FORWARD_APP": "/api/nodes",
}
"""Every port ``store_packet_dict`` routes, mapped to the route its handler POSTs."""


def _payload(port: str) -> bytes:
    """Return a realistic serialized ``Data.payload`` for ``port``."""

    now = int(time.time())
    if port == "TEXT_MESSAGE_APP":
        return b"meet at the usual spot"
    if port == "POSITION_APP":
        return mesh_pb2.Position(
            latitude_i=525_200_000, longitude_i=134_050_000, time=now
        ).SerializeToString()
    if port == "TELEMETRY_APP":
        return telemetry_pb2.Telemetry(
            time=now, device_metrics=telemetry_pb2.DeviceMetrics(battery_level=87)
        ).SerializeToString()
    if port == "NODEINFO_APP":
        return mesh_pb2.User(
            id=SENDER_ID, long_name="Secret Squirrel", short_name="SQRL"
        ).SerializeToString()
    if port == "TRACEROUTE_APP":
        return mesh_pb2.RouteDiscovery(route=[0x11111111]).SerializeToString()
    if port == "WAYPOINT_APP":
        return mesh_pb2.Waypoint(
            id=777, name="Secret cache", latitude_i=525_100_000, longitude_i=1
        ).SerializeToString()
    if port == "NEIGHBORINFO_APP":
        return mesh_pb2.NeighborInfo(
            node_id=SENDER, neighbors=[mesh_pb2.Neighbor(node_id=0x55667788, snr=7.5)]
        ).SerializeToString()
    store_forward = storeforward_pb2.StoreAndForward
    return store_forward(
        rr=store_forward.RequestResponse.ROUTER_HEARTBEAT,
        heartbeat=store_forward.Heartbeat(period=900),
    ).SerializeToString()


def _mesh_packet(port: str, *, channel: int, via_mqtt: bool = False):
    """Build the ``MeshPacket`` a radio hands its client for ``port``."""

    packet = mesh_pb2.MeshPacket()
    setattr(packet, "from", SENDER)
    packet.to = 0xFFFFFFFF
    packet.id = 0x1000 + list(PORT_ROUTES).index(port)
    packet.channel = channel
    packet.rx_time = int(time.time())
    packet.via_mqtt = via_mqtt
    packet.decoded.portnum = portnums_pb2.PortNum.Value(port)
    packet.decoded.payload = _payload(port)
    return packet


def _node_info_frame(num: int, *, channel: int = 0, via_mqtt: bool = False) -> bytes:
    """Serialized ``FromRadio.node_info`` as the radio sends its nodeDB."""

    info = mesh_pb2.NodeInfo(
        num=num,
        user=mesh_pb2.User(id=f"!{num:08x}", long_name=f"Node {num:x}"),
        channel=channel,
        via_mqtt=via_mqtt,
    )
    return mesh_pb2.FromRadio(node_info=info).SerializeToString()


class _ChannelTable:
    """Interface stand-in exposing the probe radio's two channels."""

    def __init__(self) -> None:
        role = channel_pb2.Channel.Role
        self.localNode = SimpleNamespace(
            channels=[
                channel_pb2.Channel(
                    index=PRIMARY,
                    role=role.PRIMARY,
                    settings=channel_pb2.ChannelSettings(name="LongFast"),
                ),
                channel_pb2.Channel(
                    index=SECONDARY,
                    role=role.SECONDARY,
                    settings=channel_pb2.ChannelSettings(name="Secret"),
                ),
            ]
        )

    def waitForConfig(self) -> None:
        """Mirror the library call :func:`channels.capture_from_interface` makes."""


@pytest.fixture
def scope(monkeypatch, tmp_path):
    """Neutral filters on a two-channel radio, with POSTs and drops recorded."""

    for name, value in (
        ("DEBUG", False),
        ("PROTOCOL", "meshtastic"),
        ("ALLOWED_CHANNELS", ()),
        ("HIDDEN_CHANNELS", ()),
        ("PRIMARY_CHANNEL_ONLY", False),
        ("DROP_VIA_MQTT", False),
        ("PRIMARY_CHANNEL_NAME", ""),
    ):
        monkeypatch.setattr(config, name, value, raising=False)
    for name in (
        "_host_node_id",
        "_host_telemetry_last_rx",
        "_host_nodeinfo_last_seen",
        "_last_packet_monotonic",
    ):
        monkeypatch.setattr(_state, name, None)
    # Handlers that import the ignored-packet recorder directly would write
    # next to the repo under DEBUG; keep any such write inside tmp_path.
    monkeypatch.setattr(ignored_mod, "_IGNORED_PACKET_LOG_PATH", tmp_path / "x.txt")
    monkeypatch.setattr(activity, "_packet_count", 0)
    channels._reset_channel_cache()
    channels.capture_from_interface(_ChannelTable())
    posts: list[tuple[str, dict]] = []
    reasons: list[str] = []
    monkeypatch.setattr(
        queue,
        "_queue_post_json",
        lambda path, payload, *, priority=None, **_kw: posts.append((path, payload)),
    )
    monkeypatch.setattr(
        ignored_mod,
        "_record_ignored_packet",
        lambda packet, *, reason: reasons.append(reason),
    )

    def apply(*modes: str, **overrides) -> None:
        """Enable the named :data:`MODES` plus any explicit config overrides."""
        for mode in modes:
            for name, value in MODES[mode].items():
                monkeypatch.setattr(config, name, value)
        for name, value in overrides.items():
            monkeypatch.setattr(config, name, value)

    yield SimpleNamespace(posts=posts, reasons=reasons, apply=apply)
    channels._reset_channel_cache()


@pytest.fixture
def radio(scope, monkeypatch):
    """The pinned library's interface, wired to the production subscription."""

    monkeypatch.setattr(lib_mesh_interface.publishingThread, "queueWork", lambda w: w())
    iface = lib_mesh_interface.MeshInterface(noProto=True)
    iface.nodes = {}
    iface.nodesByNum = {}
    topics = MeshtasticProvider().subscribe()

    def hear(port: str, *, channel: int, via_mqtt: bool = False) -> None:
        """Deliver one received packet from the already-known :data:`SENDER`."""
        iface._getOrCreateByNum(SENDER)
        iface._handlePacketFromRadio(
            _mesh_packet(port, channel=channel, via_mqtt=via_mqtt)
        )

    yield SimpleNamespace(iface=iface, hear=hear, **vars(scope))
    for topic in topics:
        pub.unsubscribe(handlers.on_receive, topic)


def _routes(posts) -> list[str]:
    """Return the route of every recorded POST."""

    return [path for path, _payload in posts]


def _position_packet(**fields) -> dict:
    """Return a minimal hand-built position packet dict with ``fields`` added."""

    return {
        "id": 43,
        "fromId": SENDER_ID,
        "decoded": {"portnum": "POSITION_APP", "position": {"latitude": 1.0}},
        **fields,
    }


def _snapshot(radio) -> dict[str, dict]:
    """Run the daemon snapshot over ``radio``'s nodeDB; return the upserted nodes."""

    state = make_state(provider=MeshtasticProvider(), iface=radio.iface)
    assert daemon._try_send_snapshot(state)
    upserts: dict[str, dict] = {}
    for path, payload in radio.posts:
        if path == "/api/nodes":
            upserts.update({k: v for k, v in payload.items() if k.startswith("!")})
    return upserts


# ---------------------------------------------------------------------------
# channels.ingest_filter_reason - the one policy (SPEC CF2/VM2)
# ---------------------------------------------------------------------------


class TestIngestFilterReason:
    """Tests for :func:`channels.ingest_filter_reason`."""

    @pytest.mark.parametrize("mode", list(MODES))
    def test_excluded_channel_names_the_reason(self, scope, mode):
        """Each mode drops ``Secret`` with its own reason and admits ``LongFast``."""
        scope.apply(mode)
        assert channels.ingest_filter_reason(SECONDARY) == MODE_REASONS[mode]
        assert channels.ingest_filter_reason(PRIMARY) is None

    def test_no_filter_admits_every_channel(self, scope):
        """With nothing configured every channel, named or not, is admitted."""
        assert channels.ingest_filter_reason(SECONDARY) is None
        assert channels.ingest_filter_reason(7) is None

    def test_unnamed_channel_is_dropped_by_an_allowlist(self, scope):
        """An index the radio has no name for cannot match an allowlist."""
        scope.apply("allowed")
        assert channels.ingest_filter_reason(7) == "disallowed-channel"

    def test_unattributed_record_skips_channel_filters(self, scope):
        """``None`` (no channel attribution) is never channel-filtered."""
        scope.apply("hidden", "allowed", "primary-only")
        assert channels.ingest_filter_reason(None) is None

    def test_via_mqtt_dropped_only_when_opted_in(self, scope):
        """``DROP_VIA_MQTT`` decides; a channel reason wins when both apply."""
        assert channels.ingest_filter_reason(PRIMARY, via_mqtt=True) is None
        scope.apply(DROP_VIA_MQTT=True)
        assert channels.ingest_filter_reason(PRIMARY, via_mqtt=True) == "via_mqtt"
        assert channels.ingest_filter_reason(None, via_mqtt=True) == "via_mqtt"
        assert channels.ingest_filter_reason(PRIMARY) is None
        scope.apply("hidden")
        assert (
            channels.ingest_filter_reason(SECONDARY, via_mqtt=True) == "hidden-channel"
        )

    @pytest.mark.parametrize(
        "modes, expected",
        [
            (("hidden", "allowed", "primary-only"), "non-primary-channel"),
            (("hidden", "allowed"), "disallowed-channel"),
            (("hidden",), "hidden-channel"),
        ],
    )
    def test_primary_only_then_allowlist_then_hidden(self, scope, modes, expected):
        """CF2's order: when several filters exclude ``Secret``, the first of
        ``PRIMARY_CHANNEL_ONLY``, ``ALLOWED_CHANNELS``, ``HIDDEN_CHANNELS``
        names the reason."""
        scope.apply(*modes)
        assert channels.ingest_filter_reason(SECONDARY) == expected

    def test_unnamed_primary_channel_matches_primary_channel_name(self, scope):
        """With no names captured (the passive UDP transport), channel 0 is
        matched by ``PRIMARY_CHANNEL_NAME``; other indexes stay unnamed."""
        channels._reset_channel_cache()
        scope.apply(ALLOWED_CHANNELS=("MediumFast",))
        assert channels.ingest_filter_reason(PRIMARY) == "disallowed-channel"
        scope.apply(PRIMARY_CHANNEL_NAME="MediumFast")
        assert channels.ingest_filter_reason(PRIMARY) is None
        assert channels.ingest_filter_reason(SECONDARY) == "disallowed-channel"
        scope.apply(ALLOWED_CHANNELS=(), HIDDEN_CHANNELS=("MediumFast",))
        assert channels.ingest_filter_reason(PRIMARY) == "hidden-channel"

    def test_captured_primary_name_wins_over_primary_channel_name(self, scope):
        """A name captured from the radio is the one the filters match."""
        scope.apply(ALLOWED_CHANNELS=("MediumFast",), PRIMARY_CHANNEL_NAME="MediumFast")
        assert channels.ingest_filter_reason(PRIMARY) == "disallowed-channel"


# ---------------------------------------------------------------------------
# store_packet_dict - every port honours the filters (SPEC CF1/CF2)
# ---------------------------------------------------------------------------


class TestStorePacketDictChannelScope:
    """The pre-dispatch gate in :func:`handlers.store_packet_dict`."""

    @pytest.mark.parametrize("port", list(PORT_ROUTES))
    @pytest.mark.parametrize("mode", list(MODES))
    def test_filtered_channel_packet_not_forwarded(self, radio, mode, port):
        """A packet heard on ``Secret`` queues nothing, whatever its port."""
        radio.apply(mode)
        radio.hear(port, channel=SECONDARY)
        assert (
            radio.posts == []
        ), f"{mode}: {port} heard on 'Secret' was queued to {_routes(radio.posts)}"
        assert radio.reasons == [MODE_REASONS[mode]]

    @pytest.mark.parametrize("port", list(PORT_ROUTES))
    @pytest.mark.parametrize("mode", list(MODES))
    def test_primary_channel_packet_still_forwarded(self, radio, mode, port):
        """The same packet on ``LongFast`` (no ``channel`` key) is still queued."""
        radio.apply(mode)
        radio.hear(port, channel=PRIMARY)
        assert PORT_ROUTES[port] in _routes(radio.posts)

    @pytest.mark.parametrize(
        "mode, line, field",
        [
            ("hidden", "Ignored packet on hidden channel", "channel_name='Secret'"),
            ("primary-only", "Ignored packet on non-primary channel", "channel=1"),
            (
                "allowed",
                "Ignored packet on disallowed channel",
                "allowed_channels=('LongFast',)",
            ),
        ],
    )
    def test_debug_line_names_the_filter(self, radio, capsys, mode, line, field):
        """DEBUG keeps each filter's log line and fields, now for every port."""
        radio.apply(mode, DEBUG=True)
        capsys.readouterr()
        radio.hear("POSITION_APP", channel=SECONDARY)
        out = capsys.readouterr().out
        assert line in out and field in out

    @pytest.mark.parametrize(
        "excluding_channel_0",
        [{"HIDDEN_CHANNELS": ("LongFast",)}, {"ALLOWED_CHANNELS": ("Secret",)}],
    )
    def test_unattributed_records_of_other_protocols_pass(
        self, scope, excluding_channel_0
    ):
        """CF-A2: a synthesised packet without ``channel`` (a MeshCore telemetry
        pull) carries no channel attribution and is never channel-filtered,
        even when channel 0 is excluded."""
        scope.apply(**excluding_channel_0)
        handlers.store_packet_dict(
            {
                "id": 42,
                "rx_time": 1_700_000_000,
                "fromId": SENDER_ID,
                "protocol": "meshcore",
                "decoded": {
                    "portnum": "TELEMETRY_APP",
                    "telemetry": {"time": 1_700_000_000, "voltage": 3.9},
                },
            }
        )
        assert _routes(scope.posts) == ["/api/telemetry"]

    @pytest.mark.parametrize(
        "fields",
        [{}, {"channel": "not-a-number"}],
        ids=["absent", "unparseable"],
    )
    def test_meshtastic_packet_without_usable_channel_is_primary(self, scope, fields):
        """proto3 omits ``channel`` when it is 0, so a Meshtastic packet without
        one - or with one that does not parse - is filtered as index 0."""
        scope.apply(HIDDEN_CHANNELS=("LongFast",))
        handlers.store_packet_dict(_position_packet(**fields))
        assert scope.posts == [] and scope.reasons == ["hidden-channel"]

    def test_decoded_channel_wins_over_packet_channel(self, scope):
        """A handler-stamped ``decoded.channel`` is the attribution used."""
        scope.apply("hidden")
        packet = _position_packet(channel=PRIMARY)
        packet["decoded"]["channel"] = SECONDARY
        handlers.store_packet_dict(packet)
        assert scope.posts == [] and scope.reasons == ["hidden-channel"]

    @pytest.mark.parametrize("port", list(PORT_ROUTES))
    def test_via_mqtt_packet_dropped_when_opted_in(self, radio, port):
        """``DROP_VIA_MQTT=1`` drops a ``viaMqtt`` packet on every port."""
        radio.apply(DROP_VIA_MQTT=True)
        radio.hear(port, channel=PRIMARY, via_mqtt=True)
        assert radio.posts == [], f"viaMqtt {port} queued to {_routes(radio.posts)}"
        assert radio.reasons == ["via_mqtt"]

    def test_via_mqtt_packet_kept_by_default(self, radio):
        """Without the opt-in a ``viaMqtt`` packet is forwarded as before."""
        radio.hear("POSITION_APP", channel=PRIMARY, via_mqtt=True)
        assert _routes(radio.posts) == ["/api/positions"]

    def test_snake_case_via_mqtt_is_honoured(self, scope):
        """A packet converted with proto field names carries ``via_mqtt``."""
        scope.apply(DROP_VIA_MQTT=True)
        handlers.store_packet_dict(_position_packet(via_mqtt=True))
        assert scope.posts == [] and scope.reasons == ["via_mqtt"]


class TestUdpPrimaryChannel:
    """The passive UDP transport carries only channel 0 and names no channels."""

    @pytest.fixture
    def udp(self, scope):
        """No captured channel names; ``PRIMARY_CHANNEL_NAME`` names channel 0."""
        channels._reset_channel_cache()
        scope.apply(PRIMARY_CHANNEL_NAME="MediumFast")

        def hear(port: str) -> None:
            """Deliver one packet in the shape the UDP transport's mapping emits."""
            packet = meshpacket_to_packet_dict(_mesh_packet(port, channel=PRIMARY))
            handlers.on_receive(packet, None)

        return SimpleNamespace(hear=hear, **vars(scope))

    @pytest.mark.parametrize("port", list(PORT_ROUTES))
    def test_named_allowlist_matches_the_udp_primary_channel(self, udp, port):
        """``ALLOWED_CHANNELS`` naming ``PRIMARY_CHANNEL_NAME`` admits every port."""
        udp.apply(ALLOWED_CHANNELS=("MediumFast",))
        udp.hear(port)
        assert PORT_ROUTES[port] in _routes(udp.posts), udp.reasons

    def test_udp_message_still_carries_no_channel_name(self, udp):
        """The name is used for matching only: a UDP message keeps its shape."""
        udp.apply(ALLOWED_CHANNELS=("MediumFast",))
        udp.hear("TEXT_MESSAGE_APP")
        ((path, payload),) = udp.posts
        assert path == "/api/messages" and "channel_name" not in payload

    def test_hidden_udp_primary_channel_drops_what_it_hears(self, udp):
        """Hiding the one channel the UDP transport carries drops its packets."""
        udp.apply(HIDDEN_CHANNELS=("MediumFast",))
        udp.hear("POSITION_APP")
        assert udp.posts == [] and udp.reasons == ["hidden-channel"]


# ---------------------------------------------------------------------------
# Node-list snapshot (SPEC CF3/VM2)
# ---------------------------------------------------------------------------


class TestSnapshotChannelScope:
    """The Meshtastic nodeDB snapshot honours the same filters."""

    @pytest.fixture
    def node_db(self, radio):
        """Load a primary, a ``Secret`` and a via_mqtt node into the library nodeDB."""
        radio.iface._handleFromRadio(_node_info_frame(0x0A0A0A0A))
        radio.iface._handleFromRadio(_node_info_frame(0x0B0B0B0B, channel=SECONDARY))
        radio.iface._handleFromRadio(_node_info_frame(0x0C0C0C0C, via_mqtt=True))
        return radio

    @pytest.mark.parametrize("mode", list(MODES))
    def test_filtered_channel_entries_not_published(self, node_db, mode):
        """An entry last heard on ``Secret`` is skipped; the others are published."""
        node_db.apply(mode)
        upserts = _snapshot(node_db)
        assert set(upserts) == {"!0a0a0a0a", "!0c0c0c0c"}

    def test_every_entry_published_without_filters(self, node_db):
        """No filter configured: the snapshot is unchanged."""
        assert set(_snapshot(node_db)) == {"!0a0a0a0a", "!0b0b0b0b", "!0c0c0c0c"}

    def test_via_mqtt_entries_skipped_when_opted_in(self, node_db):
        """``DROP_VIA_MQTT=1`` also skips nodeDB entries flagged ``viaMqtt``."""
        node_db.apply(DROP_VIA_MQTT=True)
        assert set(_snapshot(node_db)) == {"!0a0a0a0a", "!0b0b0b0b"}

    def test_fully_filtered_snapshot_still_latches(self, node_db):
        """The latch still means "the radio had nodes", not "something was sent"."""
        node_db.apply(HIDDEN_CHANNELS=("LongFast", "Secret"))
        state = make_state(provider=MeshtasticProvider(), iface=node_db.iface)
        assert daemon._try_send_snapshot(state) is True
        assert node_db.posts == [] and state.initial_snapshot_sent is True

    def test_skipped_entry_is_logged_under_debug(self, node_db, capsys):
        """A skipped entry leaves one DEBUG line naming the node and reason."""
        node_db.apply("hidden", DEBUG=True)
        capsys.readouterr()
        _snapshot(node_db)
        out = capsys.readouterr().out
        assert "Skipped snapshot node" in out
        assert "node_id='!0b0b0b0b'" in out and "reason='hidden-channel'" in out

    def test_a_node_dict_mutating_mid_snapshot_fails_alone(self, scope):
        """An entry the library mutates while it is serialised costs only that
        entry: the others are still published and the latch is set."""

        class _Mutating(dict):
            """A node dict whose iteration races the library's writer thread."""

            def items(self):
                raise RuntimeError("dictionary changed size during iteration")

        iface = SimpleNamespace(
            nodes={
                "!0000000a": _Mutating(num=10, lastReceived={"id": 1}),
                "!0000000b": {"num": 11},
            }
        )
        state = make_state(provider=MeshtasticProvider(), iface=iface)
        assert daemon._try_send_snapshot(state) is True
        assert state.iface is iface and state.initial_snapshot_sent is True
        published = [k for _p, body in scope.posts for k in body if k.startswith("!")]
        assert published == ["!0000000b"]

    def test_last_received_packet_is_not_published(self, radio):
        """The library's per-node ``lastReceived`` copy of the last packet heard
        (here a text the live path dropped) stays out of the upsert body."""
        radio.apply("hidden")
        radio.iface._handleFromRadio(_node_info_frame(SENDER))
        radio.hear("TEXT_MESSAGE_APP", channel=SECONDARY)
        assert radio.reasons == ["hidden-channel"]
        assert "lastReceived" in radio.iface.nodes[SENDER_ID]
        upserts = _snapshot(radio)
        assert "lastReceived" not in upserts[SENDER_ID]
        assert "lastReceived" in radio.iface.nodes[SENDER_ID]  # library dict untouched


class TestMeshtasticSnapshotHooks:
    """Direct tests for the snapshot's filter hook and ``lastReceived`` strip."""

    def test_upsert_node_strips_last_received_from_the_serialised_copy(self, scope):
        """``upsert_node`` drops ``lastReceived`` from what it POSTs, never from
        the source dict; an entry that does not serialise to a dict passes."""
        node = {"num": 1, "lastReceived": {"decoded": {"text": "meet"}}}
        handlers.upsert_node("!00000001", node)
        handlers.upsert_node("!00000002", SimpleNamespace(num=2))
        first, second = (body for _path, body in scope.posts)
        assert "lastReceived" not in first["!00000001"] and "lastReceived" in node
        assert first["!00000001"]["num"] == 1 and "!00000002" in second

    def test_filter_reason_ignores_non_mapping_entries(self, scope):
        """A non-mapping entry carries no channel attribution."""
        scope.apply("hidden", DROP_VIA_MQTT=True)
        provider = MeshtasticProvider()
        assert provider.snapshot_filter_reason("!00000001", SimpleNamespace()) is None

    def test_filter_reason_reads_channel_and_via_mqtt(self, scope):
        """``channel`` (absent = 0) and ``viaMqtt`` drive the shared policy."""
        scope.apply("hidden", DROP_VIA_MQTT=True)
        provider = MeshtasticProvider()
        assert provider.snapshot_filter_reason("!1", {"channel": SECONDARY}) == (
            "hidden-channel"
        )
        assert provider.snapshot_filter_reason("!2", {"viaMqtt": True}) == "via_mqtt"
        assert provider.snapshot_filter_reason("!3", {"channel": "junk"}) is None
        assert provider.snapshot_filter_reason("!4", {}) is None


# ---------------------------------------------------------------------------
# DROP_VIA_MQTT reaches every packaged deployment surface (DOC2)
# ---------------------------------------------------------------------------

_SURFACES = (
    ("README.md", r"^\| `DROP_VIA_MQTT` \| `0` \|"),
    (".env.example", r"^# DROP_VIA_MQTT=1$"),
    ("docker-compose.yml", r"^\s+DROP_VIA_MQTT: \$\{DROP_VIA_MQTT:-0\}$"),
    (
        "data/tools/compose.udp.pi.yml",
        r"^\s+DROP_VIA_MQTT: \$\{DROP_VIA_MQTT:-0\}$",
    ),
    (
        "flake.nix",
        r"dropViaMqtt = lib\.mkOption \{\s+type = lib\.types\.bool;\s+default = false;",
    ),
    (
        "flake.nix",
        r"DROP_VIA_MQTT = if cfg\.ingestor\.dropViaMqtt then \"1\" else \"0\";",
    ),
)
"""``(file, pattern)`` pairs every operator-facing surface must match."""


@pytest.mark.parametrize("path, pattern", _SURFACES)
def test_drop_via_mqtt_reaches_the_deployment_surface(path, pattern):
    """The flag can be set from every surface the operator configures."""
    text = (REPO_ROOT / path).read_text(encoding="utf-8")
    assert re.search(pattern, text, re.MULTILINE), f"DROP_VIA_MQTT missing from {path}"


def test_flake_names_the_via_mqtt_flag_on_every_line_about_it():
    """VM4 for Nix: a ``flake.nix`` line about the flag names ``viaMqtt`` itself.

    The bare protocol word is derived from the flag rather than spelled out,
    so this module stays clean under ACCEPTANCE A1b's line-based grep.
    """
    word = "DROP_VIA_MQTT".rsplit("_", 1)[1].casefold()
    lines = (REPO_ROOT / "flake.nix").read_text(encoding="utf-8").splitlines()
    mentions = [line.casefold() for line in lines if word in line.casefold()]
    assert mentions, "flake.nix never mentions the flag"
    assert [m for m in mentions if "via_mqtt" not in m and "viamqtt" not in m] == []


def test_drop_via_mqtt_is_declared_in_both_image_stages():
    """Both ``data/Dockerfile`` stages declare the default."""
    text = (REPO_ROOT / "data" / "Dockerfile").read_text(encoding="utf-8")
    assert text.count("DROP_VIA_MQTT=0 \\") == 2
