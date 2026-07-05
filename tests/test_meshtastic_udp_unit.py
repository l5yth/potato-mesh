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
"""Unit tests for :mod:`data.mesh_ingestor.protocols.meshtastic_udp`.

Coverage strategy mirrors ``tests/test_meshtastic_udp_decode_unit.py``:

1. **Real-fixture tests** replay genuine captured datagrams (see
   ``tests/fixtures/mesh_udp``) through :meth:`MeshtasticUdpProvider._handle_datagram`
   to prove the primary/private split works end-to-end against real traffic.
2. **Synthetic tests** exercise every remaining line/branch (parse failures,
   the no-``decoded`` drop path, the receive loop's timeout/OSError/dispatch
   branches, and the lifecycle of :class:`_UdpInterface`) with fakes so no
   real socket or long-lived thread is ever involved.

No test opens a real network socket or a real ``socket.timeout``-driven
sleep loop of more than a few milliseconds: every fake socket either raises
immediately or sets the interface's stop flag as a side effect of being
called, so a hung test is not possible.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import sys
import threading
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from meshtastic.protobuf import mesh_pb2, portnums_pb2

from data.mesh_ingestor.protocols import meshtastic_udp as udp_mod
from data.mesh_ingestor.protocols import meshtastic_udp_decode as udp_decode
from data.mesh_ingestor.protocols.meshtastic_udp import (
    MeshtasticUdpProvider,
    _UdpInterface,
)


def _encrypt_packet(
    channel_hash: int,
    *,
    portnum=portnums_pb2.PortNum.TEXT_MESSAGE_APP,
    text: bytes = b"hi",
    key_b64: str = "AQ==",
    packet_id: int = 0x1111,
    node_from: int = 0x2222,
) -> bytes:
    """Build a raw encrypted ``MeshPacket`` carrying *channel_hash*.

    The application payload is AES-CTR-encrypted with *key_b64* using the same
    id/from nonce the firmware uses, so the packet is genuinely decryptable with
    that key. The ``channel`` field is set independently to *channel_hash* --
    this lets a test build a packet that *decrypts* with the default key yet
    carries a non-primary channel hash (i.e. a default-key SECONDARY channel).
    """
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    data = mesh_pb2.Data(portnum=portnum, payload=text)
    key = udp_decode.expand_default_key(key_b64)
    nonce = packet_id.to_bytes(8, "little") + node_from.to_bytes(8, "little")
    encryptor = Cipher(algorithms.AES(key), modes.CTR(nonce)).encryptor()
    ciphertext = encryptor.update(data.SerializeToString()) + encryptor.finalize()

    mp = mesh_pb2.MeshPacket()
    mp.id = packet_id
    setattr(mp, "from", node_from)
    mp.to = 0xFFFFFFFF
    mp.channel = channel_hash
    mp.encrypted = ciphertext
    return mp.SerializeToString()


FIXTURE_PATH = os.path.join(
    os.path.dirname(__file__),
    "fixtures",
    "mesh_udp",
    "primary_and_private_capture.jsonl",
)
"""Path to the real captured-datagram fixture, resolved relative to this file."""


def _load_fixture_raw() -> tuple[bytes, bytes]:
    """Return ``(primary_raw, private_raw)`` from the real-capture fixture.

    Scans the fixture for the first datagram whose ``MeshPacket.channel`` is
    31 (the primary channel's channel hash, per the fixture README) and the
    first whose channel is anything else, and returns their raw bytes.
    """
    primary_raw = None
    private_raw = None
    with open(FIXTURE_PATH, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            raw = base64.b64decode(record["raw_b64"])
            mp = mesh_pb2.MeshPacket()
            mp.ParseFromString(raw)
            if mp.channel == 31 and primary_raw is None:
                primary_raw = raw
            elif mp.channel != 31 and private_raw is None:
                private_raw = raw
            if primary_raw is not None and private_raw is not None:
                break
    assert primary_raw is not None, "fixture must contain a primary-channel datagram"
    assert private_raw is not None, "fixture must contain a private-channel datagram"
    return primary_raw, private_raw


# ---------------------------------------------------------------------------
# Real-fixture integration tests
# ---------------------------------------------------------------------------


class TestHandleDatagramRealFixture:
    """Replays real captured datagrams through ``_handle_datagram``."""

    def test_primary_datagram_dispatches_exactly_once(self, monkeypatch):
        """A real primary-channel datagram decrypts and reaches on_receive once."""
        primary_raw, _private_raw = _load_fixture_raw()
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_KEY", "AQ==")
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_NAME", "MediumFast")

        received: list[dict] = []
        monkeypatch.setattr(
            udp_mod.handlers,
            "on_receive",
            lambda packet, interface: received.append(packet),
        )

        provider = MeshtasticUdpProvider()
        iface = _UdpInterface()
        provider._handle_datagram(primary_raw, iface)

        assert len(received) == 1
        packet = received[0]
        assert packet["channel"] == 0
        portnum = packet["decoded"]["portnum"]
        assert isinstance(portnum, str) and portnum

    def test_private_datagram_is_dropped(self, monkeypatch):
        """A real private-channel datagram never reaches on_receive."""
        _primary_raw, private_raw = _load_fixture_raw()
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_KEY", "AQ==")
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_NAME", "MediumFast")

        received: list[dict] = []
        monkeypatch.setattr(
            udp_mod.handlers,
            "on_receive",
            lambda packet, interface: received.append(packet),
        )

        provider = MeshtasticUdpProvider()
        iface = _UdpInterface()
        provider._handle_datagram(private_raw, iface)

        assert received == []


# ---------------------------------------------------------------------------
# _handle_datagram synthetic drop paths
# ---------------------------------------------------------------------------


class TestHandleDatagramDropPaths:
    """Exercises the parse-failure and no-``decoded`` drop branches."""

    def test_unparseable_bytes_are_dropped(self, monkeypatch):
        """Bytes that fail protobuf parsing never reach on_receive."""
        received: list[dict] = []
        monkeypatch.setattr(
            udp_mod.handlers,
            "on_receive",
            lambda packet, interface: received.append(packet),
        )

        provider = MeshtasticUdpProvider()
        iface = _UdpInterface()
        provider._handle_datagram(b"\xff\xff", iface)

        assert received == []

    def test_packet_without_encrypted_or_decoded_is_dropped(self, monkeypatch):
        """A parsed MeshPacket with neither payload_variant field is dropped."""
        received: list[dict] = []
        monkeypatch.setattr(
            udp_mod.handlers,
            "on_receive",
            lambda packet, interface: received.append(packet),
        )

        mp = mesh_pb2.MeshPacket()
        mp.id = 42
        setattr(mp, "from", 7)
        raw = mp.SerializeToString()

        provider = MeshtasticUdpProvider()
        iface = _UdpInterface()
        provider._handle_datagram(raw, iface)

        assert received == []

    def test_plaintext_decoded_packet_is_dropped(self, monkeypatch):
        """A packet arriving already-``decoded`` (unencrypted) is dropped.

        Even when it carries the correct primary channel hash, a plaintext
        packet is rejected: real primary traffic is channel-encrypted, and
        accepting plaintext would let a keyless LAN attacker inject spoofed
        records.
        """
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_KEY", "AQ==")
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_NAME", "MediumFast")
        received: list[dict] = []
        monkeypatch.setattr(
            udp_mod.handlers,
            "on_receive",
            lambda packet, interface: received.append(packet),
        )

        mp = mesh_pb2.MeshPacket()
        mp.id = 1
        setattr(mp, "from", 1)
        mp.to = 2
        mp.channel = udp_decode.channel_hash("MediumFast", "AQ==")  # passes hash gate
        mp.decoded.portnum = 3  # POSITION_APP, but plaintext -> must be dropped
        raw = mp.SerializeToString()

        provider = MeshtasticUdpProvider()
        iface = _UdpInterface()
        provider._handle_datagram(raw, iface)

        assert received == []

    def test_encrypted_with_wrong_key_is_dropped(self, monkeypatch):
        """An encrypted packet that fails to decrypt with the configured key is dropped."""
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_KEY", "AQ==")
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_NAME", "MediumFast")
        received: list[dict] = []
        monkeypatch.setattr(
            udp_mod.handlers,
            "on_receive",
            lambda packet, interface: received.append(packet),
        )

        mp = mesh_pb2.MeshPacket()
        mp.id = 1
        setattr(mp, "from", 1)
        mp.channel = udp_decode.channel_hash("MediumFast", "AQ==")  # passes hash gate
        # Garbage ciphertext under the default key never parses to a
        # non-empty Data, so decrypt_meshpacket returns None.
        mp.encrypted = b"\x00" * 16
        raw = mp.SerializeToString()

        provider = MeshtasticUdpProvider()
        iface = _UdpInterface()
        provider._handle_datagram(raw, iface)

        assert received == []

    def test_unknown_portnum_does_not_crash_the_reader(self, monkeypatch):
        """A packet decrypting to an unknown portnum is handled, never raised.

        Regression for the DoS where ``PortNum.Name()`` raised ``ValueError``
        on an out-of-enum portnum and killed the receive thread. It must be
        mapped to a sentinel and dispatched (a handler-less portnum is simply
        ignored downstream), not crash.
        """
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_KEY", "AQ==")
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_NAME", "MediumFast")
        received: list[dict] = []
        monkeypatch.setattr(
            udp_mod.handlers,
            "on_receive",
            lambda packet, interface: received.append(packet),
        )

        primary_hash = udp_decode.channel_hash("MediumFast", "AQ==")
        # portnum 99999 is not in the PortNum enum (proto3 open enums accept it).
        raw = _encrypt_packet(primary_hash, portnum=99999, text=b"x")

        provider = MeshtasticUdpProvider()
        iface = _UdpInterface()
        provider._handle_datagram(raw, iface)  # must not raise

        assert len(received) == 1
        assert received[0]["decoded"]["portnum"] == "UNKNOWN_APP"


# ---------------------------------------------------------------------------
# _recv_loop
# ---------------------------------------------------------------------------


class TestRecvLoop:
    """Directly exercises ``_recv_loop``'s branches without a real thread."""

    def test_timeout_then_stop(self):
        """A socket.timeout is swallowed (continue) and the loop exits on stop."""
        iface = _UdpInterface()

        calls = {"n": 0}

        class FakeSock:
            def recvfrom(self, bufsize):
                calls["n"] += 1
                if calls["n"] >= 2:
                    iface._stop.set()
                raise socket.timeout()

        iface._sock = FakeSock()
        provider = MeshtasticUdpProvider()
        provider._recv_loop(iface)

        assert calls["n"] == 2

    def test_oserror_breaks_and_clears_connected(self):
        """An OSError from recvfrom clears isConnected and exits the loop."""
        iface = _UdpInterface()
        iface.isConnected.set()

        class FakeSock:
            def recvfrom(self, bufsize):
                raise OSError("socket closed")

        iface._sock = FakeSock()
        provider = MeshtasticUdpProvider()
        provider._recv_loop(iface)

        assert not iface.isConnected.is_set()

    def test_dispatches_datagram_then_stops(self, monkeypatch):
        """A successfully received datagram is routed through _handle_datagram."""
        iface = _UdpInterface()
        handled: list[bytes] = []

        mp = mesh_pb2.MeshPacket()
        mp.id = 9
        setattr(mp, "from", 9)
        mp.decoded.portnum = 1
        raw = mp.SerializeToString()

        calls = {"n": 0}

        class FakeSock:
            def recvfrom(self, bufsize):
                calls["n"] += 1
                if calls["n"] == 1:
                    return raw, ("192.0.2.1", 4403)
                iface._stop.set()
                raise socket.timeout()

        iface._sock = FakeSock()
        provider = MeshtasticUdpProvider()
        monkeypatch.setattr(
            provider, "_handle_datagram", lambda r, i: handled.append(r)
        )
        provider._recv_loop(iface)

        assert handled == [raw]

    def test_handle_datagram_exception_is_swallowed_loop_survives(self, monkeypatch):
        """An exception from _handle_datagram is caught; the loop keeps running.

        Regression for the DoS where one bad datagram propagated out of
        _handle_datagram and killed the reader thread. Here _handle_datagram
        raises on the first datagram; the loop must continue to the second and
        exit cleanly on the stop flag rather than propagating.
        """
        iface = _UdpInterface()
        iface.isConnected.set()
        calls = {"n": 0}

        class FakeSock:
            def recvfrom(self, bufsize):
                calls["n"] += 1
                if calls["n"] == 1:
                    return b"anything", ("192.0.2.1", 4403)
                iface._stop.set()
                raise socket.timeout()

        def boom(_raw, _iface):
            raise ValueError("simulated bad datagram")

        iface._sock = FakeSock()
        provider = MeshtasticUdpProvider()
        monkeypatch.setattr(provider, "_handle_datagram", boom)
        provider._recv_loop(iface)  # must not raise

        assert calls["n"] == 2
        # Loop exit clears isConnected so a dead reader is detectable.
        assert not iface.isConnected.is_set()


# ---------------------------------------------------------------------------
# _UdpInterface lifecycle
# ---------------------------------------------------------------------------


class TestUdpInterfaceLifecycle:
    """Tests for :class:`_UdpInterface`."""

    def test_init_defaults(self):
        """A fresh interface has no nodes, is not connected, and has no thread/sock."""
        iface = _UdpInterface()
        assert iface.nodes == {}
        assert isinstance(iface.isConnected, threading.Event)
        assert not iface.isConnected.is_set()
        assert iface._sock is None
        assert iface._thread is None
        assert not iface._stop.is_set()

    def test_close_with_no_sock_or_thread_is_safe(self):
        """close() must not raise when _sock and _thread were never set."""
        iface = _UdpInterface()
        iface.isConnected.set()
        iface.close()
        assert iface._stop.is_set()
        assert not iface.isConnected.is_set()

    def test_close_closes_socket_and_swallows_oserror(self):
        """close() swallows an OSError raised by the socket's close()."""
        iface = _UdpInterface()

        class RaisingSock:
            def close(self):
                raise OSError("already closed")

        iface._sock = RaisingSock()
        iface.close()  # must not raise
        assert iface._stop.is_set()

    def test_close_joins_thread(self):
        """close() joins the receive thread with a bounded timeout."""
        iface = _UdpInterface()
        joined = {"timeout": None}

        class FakeThread:
            def join(self, timeout=None):
                joined["timeout"] = timeout

        iface._thread = FakeThread()
        iface.close()

        assert joined["timeout"] == 2.0

    def test_close_is_idempotent(self):
        """Calling close() twice must not raise."""
        iface = _UdpInterface()
        iface.close()
        iface.close()


# ---------------------------------------------------------------------------
# MeshtasticUdpProvider.connect (full lifecycle through a fake socket)
# ---------------------------------------------------------------------------


class TestConnectLifecycle:
    """Exercises connect() end-to-end with a fake socket and a real thread."""

    def test_connect_returns_triple_and_receives_then_closes(self, monkeypatch):
        """connect() starts the receive thread; close() stops it cleanly."""
        primary_raw, _private_raw = _load_fixture_raw()
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_KEY", "AQ==")
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_NAME", "MediumFast")
        monkeypatch.setattr(udp_mod.config, "MESH_UDP_GROUP", "224.0.0.69")
        monkeypatch.setattr(udp_mod.config, "MESH_UDP_PORT", 4403)

        received: list[dict] = []
        monkeypatch.setattr(
            udp_mod.handlers,
            "on_receive",
            lambda packet, interface: received.append(packet),
        )

        class FakeSock:
            def __init__(self):
                self._served = False
                self.closed = False

            def recvfrom(self, bufsize):
                if not self._served:
                    self._served = True
                    return primary_raw, ("192.0.2.1", 4403)
                # Small sleep keeps the background thread from busy-spinning
                # at full CPU while the test asserts and calls close().
                time.sleep(0.005)
                raise socket.timeout()

            def close(self):
                self.closed = True

        fake_sock = FakeSock()
        monkeypatch.setattr(
            udp_mod, "open_multicast_socket", lambda group, port: fake_sock
        )

        provider = MeshtasticUdpProvider()
        iface, target, next_candidate = provider.connect(active_candidate="ignored")

        assert target == "udp://224.0.0.69:4403"
        assert next_candidate == "ignored"
        assert iface.isConnected.is_set()

        deadline = time.monotonic() + 2.0
        while not received and time.monotonic() < deadline:
            time.sleep(0.01)
        assert len(received) == 1

        iface.close()

        assert not iface._thread.is_alive()
        assert not iface.isConnected.is_set()
        assert fake_sock.closed


# ---------------------------------------------------------------------------
# subscribe / extract_host_node_id / node_snapshot_items
# ---------------------------------------------------------------------------


PRIMARY_HASH = udp_decode.channel_hash("MediumFast", "AQ==")  # 31, per the fixture
SECONDARY_HASH = udp_decode.channel_hash("Private", "AQ==")  # default-key secondary


class TestPrimaryChannelHashHelper:
    """Tests for :meth:`MeshtasticUdpProvider._primary_channel_hash`."""

    def test_returns_hash_when_name_set(self, monkeypatch):
        """With a configured name, the helper returns the computed channel hash."""
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_NAME", "MediumFast")
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_KEY", "AQ==")
        assert MeshtasticUdpProvider()._primary_channel_hash() == 31

    def test_returns_none_when_name_blank(self, monkeypatch):
        """A blank name yields None so primary-only mode can fail closed."""
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_NAME", "")
        assert MeshtasticUdpProvider()._primary_channel_hash() is None


class TestPrimaryChannelFilter:
    """The channel-hash gate: only channel-0 (primary) traffic is dispatched."""

    @pytest.fixture
    def received(self, monkeypatch):
        """Capture packets that reach on_receive; default env to the RGW1 setup."""
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_KEY", "AQ==")
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_NAME", "MediumFast")
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_ONLY", True)
        captured: list[dict] = []
        monkeypatch.setattr(
            udp_mod.handlers,
            "on_receive",
            lambda packet, interface: captured.append(packet),
        )
        return captured

    def test_primary_hash_packet_is_dispatched(self, received):
        """A packet whose channel hash matches the primary channel is delivered."""
        raw = _encrypt_packet(PRIMARY_HASH)
        MeshtasticUdpProvider()._handle_datagram(raw, _UdpInterface())
        assert len(received) == 1
        assert received[0]["channel"] == 0

    def test_default_key_secondary_channel_is_dropped(self, received):
        """A default-key SECONDARY channel that DECRYPTS is still dropped by hash.

        This is the core privacy guarantee: the packet is encrypted with the
        very same ``AQ==`` key as the primary channel and would decrypt cleanly,
        but its channel hash is not the primary's, so it must never reach the
        collector.
        """
        raw = _encrypt_packet(SECONDARY_HASH)
        # Sanity: prove the packet really does decrypt with the primary key, so
        # the drop is attributable to the hash gate and not a decrypt failure.
        mp = mesh_pb2.MeshPacket()
        mp.ParseFromString(raw)
        assert udp_decode.decrypt_meshpacket(mp, "AQ==") is not None
        assert mp.channel != PRIMARY_HASH

        MeshtasticUdpProvider()._handle_datagram(raw, _UdpInterface())
        assert received == []

    def test_blank_name_fails_closed(self, received, monkeypatch):
        """primary-only with no configured name drops even a valid primary packet."""
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_NAME", "")
        raw = _encrypt_packet(PRIMARY_HASH)
        MeshtasticUdpProvider()._handle_datagram(raw, _UdpInterface())
        assert received == []

    def test_filtering_is_unconditional_of_primary_channel_only(self, monkeypatch):
        """The hash gate applies even when PRIMARY_CHANNEL_ONLY is False.

        PRIMARY_CHANNEL_ONLY governs only the API/serial transport; the UDP
        transport can never represent a non-primary channel (it stamps index 0),
        so it filters unconditionally. A secondary-channel packet is dropped and
        a primary-channel packet is accepted regardless of the flag.
        """
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_KEY", "AQ==")
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_NAME", "MediumFast")
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_ONLY", False)
        captured: list[dict] = []
        monkeypatch.setattr(
            udp_mod.handlers,
            "on_receive",
            lambda packet, interface: captured.append(packet),
        )

        provider = MeshtasticUdpProvider()
        provider._handle_datagram(_encrypt_packet(SECONDARY_HASH), _UdpInterface())
        assert captured == []  # secondary dropped despite the flag being off

        provider._handle_datagram(_encrypt_packet(PRIMARY_HASH), _UdpInterface())
        assert len(captured) == 1  # primary still accepted


class TestConnectLogsPrimaryFilter:
    """connect() emits a startup log describing the resolved primary filter."""

    def _fake_socket(self, monkeypatch):
        """Install a fake multicast socket that only times out (no traffic)."""

        class FakeSock:
            def recvfrom(self, bufsize):
                time.sleep(0.005)
                raise socket.timeout()

            def close(self):
                pass

        monkeypatch.setattr(
            udp_mod, "open_multicast_socket", lambda group, port: FakeSock()
        )

    def test_logs_resolved_hash_info(self, monkeypatch):
        """A configured name logs the resolved hash at info severity."""
        self._fake_socket(monkeypatch)
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_NAME", "MediumFast")
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_KEY", "AQ==")
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_ONLY", True)
        logs: list[dict] = []
        monkeypatch.setattr(
            udp_mod.config,
            "_debug_log",
            lambda *a, **k: logs.append(k),
        )
        provider = MeshtasticUdpProvider()
        iface, _target, _c = provider.connect(active_candidate=None)
        iface.close()

        assert any(k.get("primary_channel_hash") == 31 for k in logs)
        entry = next(k for k in logs if "primary_channel_hash" in k)
        assert entry["severity"] == "info"

    def test_logs_warn_when_fail_closed(self, monkeypatch):
        """primary-only with no name logs at warn severity (fail-closed)."""
        self._fake_socket(monkeypatch)
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_NAME", "")
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_ONLY", True)
        logs: list[dict] = []
        monkeypatch.setattr(
            udp_mod.config,
            "_debug_log",
            lambda *a, **k: logs.append(k),
        )
        provider = MeshtasticUdpProvider()
        iface, _target, _c = provider.connect(active_candidate=None)
        iface.close()

        entry = next(k for k in logs if "primary_channel_hash" in k)
        assert entry["primary_channel_hash"] is None
        assert entry["severity"] == "warn"


class TestProviderMisc:
    """Tests for the remaining small provider methods."""

    def test_subscribe_returns_empty_list_and_is_idempotent(self):
        """subscribe() always returns [] and calling it twice is harmless."""
        provider = MeshtasticUdpProvider()
        first = provider.subscribe()
        second = provider.subscribe()
        assert first == []
        assert second == []

    def test_extract_host_node_id_returns_config_value(self, monkeypatch):
        """extract_host_node_id surfaces config.INGESTOR_NODE_ID verbatim."""
        monkeypatch.setattr(udp_mod.config, "INGESTOR_NODE_ID", "!deadbeef")
        provider = MeshtasticUdpProvider()
        assert provider.extract_host_node_id(object()) == "!deadbeef"

    def test_extract_host_node_id_none_by_default(self, monkeypatch):
        """extract_host_node_id returns None when unset."""
        monkeypatch.setattr(udp_mod.config, "INGESTOR_NODE_ID", None)
        provider = MeshtasticUdpProvider()
        assert provider.extract_host_node_id(object()) is None

    def test_node_snapshot_items_empty(self):
        """node_snapshot_items returns [] for a fresh interface."""
        provider = MeshtasticUdpProvider()
        iface = _UdpInterface()
        assert provider.node_snapshot_items(iface) == []

    def test_node_snapshot_items_populated(self):
        """node_snapshot_items reflects a non-empty nodes mapping."""
        provider = MeshtasticUdpProvider()
        iface = _UdpInterface()
        iface.nodes["!aabbccdd"] = {"num": 1}
        items = provider.node_snapshot_items(iface)
        assert items == [("!aabbccdd", {"num": 1})]
