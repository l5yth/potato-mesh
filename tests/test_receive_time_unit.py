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
"""Regression guard: a Meshtastic packet received now is posted with a receive
time the web app's read windows can see, even when the radio's clock is wrong.

The web app stores ``rx_time`` as posted (it clamps only future values) and
every read route filters on it: 7 days for ``GET /api/telemetry`` and the
charts, 28 days for ``GET /api/telemetry/:id`` (``CONTRACTS.md``, "GET
endpoint time windows").  A radio whose clock runs weeks behind therefore turns
every live record into a row no page can show, while the node row still takes
the packet's battery and uptime.  Each case feeds one live packet through
:func:`handlers.on_receive`, the seam both the pubsub and the UDP transports
use, with the radio clock 60 days behind the ingestor host clock.

The cases after the regression guard pin the rule of the fix,
:mod:`data.mesh_ingestor.handlers.receive_time` (SPEC RK1-RK3): the one-hour
tolerance in both directions, the rate-limited warning, both Meshtastic
transports, the host-telemetry suppression window, and the MeshCore paths the
rule leaves alone.
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

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from meshtastic import mesh_interface as lib_mesh_interface
from meshtastic.protobuf import mesh_pb2, portnums_pb2
from pubsub import pub

import data.mesh_ingestor.config as config
import data.mesh_ingestor.handlers as handlers
import data.mesh_ingestor.handlers._state as _state_mod
import data.mesh_ingestor.handlers.receive_time as receive_time
import data.mesh_ingestor.queue as queue
from data.mesh_ingestor.protocols import meshtastic_udp_decode as udp_decode
from data.mesh_ingestor.protocols.meshcore import (
    _MeshcoreInterface,
    _process_contacts,
)
from data.mesh_ingestor.protocols.meshtastic import MeshtasticProvider
from data.mesh_ingestor.protocols.meshtastic_udp import (
    MeshtasticUdpProvider,
    _UdpInterface,
)
from data.mesh_ingestor.serialization import _iso

NOW = 1_791_288_000
"""Ingestor host clock for every case: 2026-10-06T12:00:00Z."""

RADIO_CLOCK = NOW - 60 * 86_400
"""The radio's ``rxTime``: 60 days behind the host, past the 28-day window."""

BULK_WINDOW = 7 * 86_400
"""Narrowest read floor a live record must clear (``GET /api/telemetry``)."""

SENDER = {"from": 0xF0ACBFBA, "fromId": "!f0acbfba", "to": 0xFFFFFFFF, "toId": "^all"}
"""Broadcast addressing shared by every packet, as the meshtastic library emits it."""

CASES = {
    "environment telemetry": (
        "/api/telemetry",
        {
            "portnum": "TELEMETRY_APP",
            "telemetry": {
                "time": NOW - 5,
                "environmentMetrics": {
                    "temperature": 21.5,
                    "relativeHumidity": 48.0,
                    "barometricPressure": 1012.3,
                },
            },
        },
    ),
    "device telemetry": (
        "/api/telemetry",
        {
            "portnum": "TELEMETRY_APP",
            "telemetry": {
                "time": NOW - 5,
                "deviceMetrics": {"batteryLevel": 101, "voltage": 4.2},
            },
        },
    ),
    "position": (
        "/api/positions",
        {
            "portnum": "POSITION_APP",
            "position": {"latitude": 52.49, "longitude": 13.47, "time": NOW - 5},
        },
    ),
    "text message": (
        "/api/messages",
        {"portnum": "TEXT_MESSAGE_APP", "payload": {"text": "hello"}},
    ),
}
"""Record types the dashboard reads through rx_time windows, by POST route."""


@pytest.fixture(autouse=True)
def reset_handler_state():
    """Clear the handler module state other suites may have left behind."""

    _state_mod._host_node_id = None
    _state_mod._host_telemetry_last_rx = None
    yield
    _state_mod._host_node_id = None
    _state_mod._host_telemetry_last_rx = None


@pytest.fixture(autouse=True)
def reset_warning_state(monkeypatch):
    """Start every case with no receive-time warning logged yet."""

    monkeypatch.setattr(receive_time, "_last_warning_monotonic", None)
    monkeypatch.setattr(receive_time, "_unlogged_replacements", 0)


@pytest.fixture
def host_now():
    """Start the shared ``host_clock`` fixture (``tests/conftest.py``) at :data:`NOW`."""

    return NOW


@pytest.fixture
def posts(monkeypatch, host_clock):
    """Start the host clock at :data:`NOW` and capture every queued POST.

    Returns:
        A list that collects ``(path, payload)`` for each queued request.
    """

    sent = []
    monkeypatch.setattr(
        queue,
        "_queue_post_json",
        lambda path, payload, *args, **kwargs: sent.append((path, payload)),
    )
    return sent


@pytest.mark.parametrize("case", sorted(CASES))
def test_live_packet_lands_inside_read_window(case, posts):
    """A packet received at :data:`NOW` is posted with ``rx_time`` inside the
    7-day bulk window, not at the radio's clock 60 days earlier."""

    route, decoded = CASES[case]
    packet = {"id": 0x5EED0001, "rxTime": RADIO_CLOCK, "channel": 0, **SENDER}
    packet["decoded"] = decoded
    handlers.on_receive(packet, None)

    payloads = [payload for path, payload in posts if path == route]
    assert payloads, f"{case}: nothing queued for {route}"
    rx_time = payloads[0]["rx_time"]
    days_behind = (NOW - rx_time) / 86_400
    assert NOW - BULK_WINDOW <= rx_time <= NOW, (
        f"{case}: posted rx_time {rx_time} ({_iso(rx_time)}) is the radio clock, "
        f"{days_behind:.0f} days behind the ingestor clock ({_iso(NOW)}); "
        "no GET route returns it (7-day bulk and 28-day per-id windows)"
    )
    assert payloads[0]["rx_iso"] == _iso(rx_time)


# ---------------------------------------------------------------------------
# Shared helpers for the rule's cases
# ---------------------------------------------------------------------------


@pytest.fixture
def warnings_logged(monkeypatch):
    """Capture the receive-time warnings instead of printing them.

    Returns:
        A list that collects each warning's severity and metadata.
    """

    logged = []

    def record(message, *, context=None, severity="debug", **metadata):
        """Keep the receive-time warnings and drop every other log line."""

        if context == "handlers.receive_time":
            logged.append({"severity": severity, **metadata})

    monkeypatch.setattr(config, "_debug_log", record)
    return logged


def _routed(posts, route):
    """Return the payloads queued for ``route``, in order."""

    return [payload for path, payload in posts if path == route]


def _text_packet(radio_time, packet_id=0x5EED0010):
    """Return a broadcast text packet that the radio stamped ``radio_time``."""

    return {
        "id": packet_id,
        "rxTime": radio_time,
        "channel": 0,
        **SENDER,
        "decoded": {"portnum": "TEXT_MESSAGE_APP", "payload": {"text": "hello"}},
    }


# ---------------------------------------------------------------------------
# Tolerance: one hour, in both directions (SPEC RK2)
# ---------------------------------------------------------------------------


def test_tolerance_and_warning_interval_are_named_constants():
    """The rule's two numbers live in named constants (SPEC RK2)."""

    assert receive_time.RX_TIME_TOLERANCE_SECS == 60 * 60
    assert receive_time.RX_TIME_WARNING_INTERVAL_SECS == 10 * 60


@pytest.mark.parametrize(
    ("minutes_off", "kept"),
    [(-59, True), (59, True), (-60, True), (60, True), (-61, False), (61, False)],
    ids=[
        "59 min behind kept",
        "59 min ahead kept",
        "60 min behind kept",
        "60 min ahead kept",
        "61 min behind replaced",
        "61 min ahead replaced",
    ],
)
def test_radio_time_is_kept_only_within_the_hour(minutes_off, kept, posts):
    """A radio time up to an hour off the host clock is posted as stamped; one
    further off, behind or ahead, is posted as the host clock."""

    radio_time = NOW + minutes_off * 60
    handlers.on_receive(_text_packet(radio_time), None)

    [message] = _routed(posts, "/api/messages")
    assert message["rx_time"] == (radio_time if kept else NOW)
    assert message["rx_iso"] == _iso(message["rx_time"])


# ---------------------------------------------------------------------------
# Warning: names the node and the offset, rate-limited (SPEC RK2)
# ---------------------------------------------------------------------------


@pytest.fixture
def monotonic(monkeypatch):
    """Drive :func:`time.monotonic` by hand, starting at 1000 seconds.

    Returns:
        A namespace whose ``now`` attribute :func:`time.monotonic` returns.
    """

    clock = SimpleNamespace(now=1_000.0)
    monkeypatch.setattr(time, "monotonic", lambda: clock.now)
    return clock


def test_replacement_warns_naming_the_node_and_the_offset(posts, warnings_logged):
    """The first replacement logs one warning with the sender and the offset."""

    handlers.on_receive(_text_packet(RADIO_CLOCK), None)

    assert warnings_logged == [
        {
            "severity": "warn",
            "from_id": "!f0acbfba",
            "host_node_id": None,
            "offset_secs": -60 * 86_400,
            "offset_hours": -1440.0,
            "tolerance_secs": 3600,
            "unlogged_replacements": 0,
        }
    ]


def test_warning_is_logged_at_most_once_per_interval(
    host_clock, monotonic, warnings_logged
):
    """Replacements inside the interval are counted, not logged, and the first
    warning after it reports the count, which then starts again from zero.  A
    radio time inside the tolerance is neither logged nor counted."""

    replace = receive_time.replace_skewed_rx_time
    interval = receive_time.RX_TIME_WARNING_INTERVAL_SECS
    replace(_text_packet(RADIO_CLOCK))
    monotonic.now += interval - 1
    replace(_text_packet(NOW + 2 * 3600))
    replace(_text_packet(NOW - 2 * 3600))
    replace(_text_packet(NOW - 30 * 60))
    assert len(warnings_logged) == 1

    monotonic.now += 1
    replace(_text_packet(NOW + 39 * 3600))
    # A third interval: one skipped replacement, then a warning that counts only
    # that one, not the two the second warning already reported.
    monotonic.now += interval - 1
    replace(_text_packet(NOW - 3 * 3600))
    monotonic.now += 1
    replace(_text_packet(NOW - 4 * 3600))

    assert [
        (w["offset_secs"], w["unlogged_replacements"]) for w in warnings_logged
    ] == [
        (-60 * 86_400, 0),
        (39 * 3600, 2),
        (-4 * 3600, 1),
    ]


# ---------------------------------------------------------------------------
# Both Meshtastic transports pass the check (SPEC RK3)
# ---------------------------------------------------------------------------


@pytest.fixture
def open_filters(monkeypatch):
    """Neutral ingest filters and a primary channel ``MediumFast`` on ``AQ==``."""

    for name, value in (
        ("ALLOWED_CHANNELS", ()),
        ("HIDDEN_CHANNELS", ()),
        ("PRIMARY_CHANNEL_ONLY", False),
        ("DROP_VIA_MQTT", False),
        ("PRIMARY_CHANNEL_NAME", "MediumFast"),
        ("PRIMARY_CHANNEL_KEY", "AQ=="),
    ):
        monkeypatch.setattr(config, name, value, raising=False)


def _udp_datagram(radio_time):
    """Return a primary-channel text datagram that a gateway stamped ``radio_time``.

    The payload is AES-CTR-encrypted with the default key under the firmware's
    id/from nonce, so the UDP transport decrypts it as it would a real one;
    ``rx_time`` sits in the unencrypted header.
    """

    packet_id, sender = 0x5EED0011, SENDER["from"]
    nonce = packet_id.to_bytes(8, "little") + sender.to_bytes(8, "little")
    key = udp_decode.expand_default_key("AQ==")
    encryptor = Cipher(algorithms.AES(key), modes.CTR(nonce)).encryptor()
    data = mesh_pb2.Data(
        portnum=portnums_pb2.PortNum.TEXT_MESSAGE_APP, payload=b"hello"
    )
    packet = mesh_pb2.MeshPacket(
        id=packet_id,
        to=0xFFFFFFFF,
        channel=udp_decode.channel_hash("MediumFast", "AQ=="),
        rx_time=radio_time,
        encrypted=encryptor.update(data.SerializeToString()) + encryptor.finalize(),
    )
    setattr(packet, "from", sender)
    return packet.SerializeToString()


def test_udp_transport_posts_the_host_clock(posts, open_filters):
    """A datagram stamped by a gateway clock 60 days behind posts the host clock."""

    MeshtasticUdpProvider()._handle_datagram(
        _udp_datagram(RADIO_CLOCK), _UdpInterface()
    )

    assert [m["rx_time"] for m in _routed(posts, "/api/messages")] == [NOW]


def test_pubsub_transport_posts_the_host_clock(posts, open_filters, monkeypatch):
    """A packet the serial, TCP or BLE interface publishes posts the host clock.

    Drives the pinned meshtastic library's own receive path into the
    subscription that :class:`MeshtasticProvider` registers in production.
    """

    monkeypatch.setattr(
        lib_mesh_interface.publishingThread, "queueWork", lambda work: work()
    )
    iface = lib_mesh_interface.MeshInterface(noProto=True)
    iface.nodes = {}
    iface.nodesByNum = {}
    packet = mesh_pb2.MeshPacket(id=0x5EED0012, to=0xFFFFFFFF, rx_time=RADIO_CLOCK)
    setattr(packet, "from", SENDER["from"])
    packet.decoded.portnum = portnums_pb2.PortNum.TEXT_MESSAGE_APP
    packet.decoded.payload = b"hello"
    topics = MeshtasticProvider().subscribe()
    try:
        iface._getOrCreateByNum(SENDER["from"])
        iface._handlePacketFromRadio(packet)
    finally:
        for topic in topics:
            pub.unsubscribe(handlers.on_receive, topic)

    assert [m["rx_time"] for m in _routed(posts, "/api/messages")] == [NOW]


# ---------------------------------------------------------------------------
# The host-telemetry suppression window runs on the posted receive time
# ---------------------------------------------------------------------------


def _host_telemetry(radio_time, packet_id):
    """Return a device-telemetry packet from the host radio itself."""

    return {
        "id": packet_id,
        "rxTime": radio_time,
        "channel": 0,
        **SENDER,
        "decoded": {
            "portnum": "TELEMETRY_APP",
            "telemetry": {"deviceMetrics": {"batteryLevel": 101, "voltage": 4.2}},
        },
    }


@pytest.mark.parametrize(
    "radio_offsets",
    [
        (-60 * 86_400, -60 * 86_400, -60 * 86_400),
        ((39 * 60 + 18) * 60, 0, 0),
    ],
    ids=["radio 60 days behind", "radio 39.3 hours fast, then corrected"],
)
def test_host_telemetry_window_runs_on_the_host_clock(radio_offsets, posts, host_clock):
    """Host telemetry heard at 0, 30 and 61 minutes posts the first and the
    last: the hourly window (``_state._host_telemetry_suppressed``) measures the
    posted receive time.  Before the fix, a radio clock 39.3 hours fast held
    the window shut for 40 hours once the clock was corrected."""

    _state_mod.register_host_node_id(SENDER["fromId"])
    for index, (minutes, offset) in enumerate(zip((0, 30, 61), radio_offsets)):
        host_clock.now = NOW + minutes * 60
        packet = _host_telemetry(host_clock.now + offset, 0x5EED0020 + index)
        handlers.on_receive(packet, None)

    posted = [t["rx_time"] for t in _routed(posts, "/api/telemetry")]
    assert posted == [NOW, NOW + 61 * 60]


# ---------------------------------------------------------------------------
# Out of scope: MeshCore keeps the times it assigns (SPEC RK3, RS1)
# ---------------------------------------------------------------------------


def test_meshcore_roster_position_keeps_last_advert(posts, warnings_logged):
    """MeshCore roster sync posts a contact's ``last_advert`` itself, outside
    ``on_receive``, so an advert 60 days old stays 60 days old (RS-A1)."""

    last_advert = NOW - 60 * 86_400
    stub = SimpleNamespace(
        upsert_node=lambda *_args, **_kwargs: None,
        host_node_id=lambda: None,
        _mark_packet_activity=lambda: None,
    )
    pub_key = "f0acbfba" + "00" * 28
    contact = {
        "public_key": pub_key,
        "adv_name": "RB",
        "adv_lat": 52.49,
        "adv_lon": 13.47,
        "last_advert": last_advert,
    }
    _process_contacts({pub_key: contact}, _MeshcoreInterface(target=None), stub)

    assert [p["rx_time"] for p in _routed(posts, "/api/positions")] == [last_advert]
    assert warnings_logged == []


def test_store_packet_dict_posts_the_time_it_is_given(posts, warnings_logged):
    """The check runs in ``on_receive`` alone: ``store_packet_dict``, the entry
    MeshCore messages and telemetry use, posts ``rx_time`` as given (C2 pins
    the same through ``tests/test_mesh.py``)."""

    handlers.store_packet_dict({**_text_packet(RADIO_CLOCK), "protocol": "meshcore"})

    assert [m["rx_time"] for m in _routed(posts, "/api/messages")] == [RADIO_CLOCK]
    assert warnings_logged == []


# ---------------------------------------------------------------------------
# replace_skewed_rx_time: what it leaves alone and what it copies
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "packet",
    [
        "<object object at 0x0>",
        None,
        {},
        {"rxTime": None},
        {"rxTime": "soon"},
        {"rxTime": NOW - 60},
    ],
    ids=[
        "not a mapping",
        "None",
        "no receive time",
        "null receive time",
        "unparseable receive time",
        "inside the tolerance",
    ],
)
def test_packet_without_a_skewed_rx_time_comes_back_as_is(
    packet, host_clock, warnings_logged
):
    """With nothing to replace, the same object comes back and nothing is logged."""

    assert receive_time.replace_skewed_rx_time(packet) is packet
    assert warnings_logged == []


def test_replacement_copies_the_packet_and_covers_both_keys(
    host_clock, warnings_logged
):
    """Both receive-time keys are replaced on a copy, so the meshtastic
    library's own packet dict keeps the radio time; one packet, one warning."""

    packet = {**_text_packet(RADIO_CLOCK), "rx_time": str(RADIO_CLOCK)}
    corrected = receive_time.replace_skewed_rx_time(packet)

    assert (corrected["rxTime"], corrected["rx_time"]) == (NOW, NOW)
    assert (packet["rxTime"], packet["rx_time"]) == (RADIO_CLOCK, str(RADIO_CLOCK))
    assert len(warnings_logged) == 1
