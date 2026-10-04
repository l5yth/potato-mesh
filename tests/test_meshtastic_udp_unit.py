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
   the no-``decoded`` drop path, the receive loop's wait/timeout/OSError/
   dispatch branches, and the lifecycle of :class:`_UdpInterface`) with fakes:
   a scripted ``select`` drives the receive loop synchronously, with no thread.
3. **Connect tests** join every group over local ``AF_UNIX`` socketpairs, so
   the real ``select`` waits on real file descriptors and one test runs the
   real reader thread end-to-end.

No test opens a real network socket or a wait of more than a few
milliseconds: the scripted ``select`` sets the interface's stop flag once its
script is spent, and the real-thread test shortens the loop's poll interval,
so a hung test is not possible.
"""

from __future__ import annotations

import base64
import importlib
import json
import os
import select
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


class _ScriptedSock:
    """Fake group socket replaying scripted ``recvfrom`` results.

    Each positional entry is the bytes of one datagram to return or an
    exception instance to raise, consumed in order. ``close()`` records the
    call and raises *close_error* when one is given.
    """

    def __init__(self, *script, close_error: BaseException | None = None):
        """Queue *script* for ``recvfrom`` and remember *close_error*."""
        self._script = list(script)
        self._close_error = close_error
        self.closed = False

    def recvfrom(self, bufsize):
        """Return the next scripted datagram, or raise the next scripted error."""
        step = self._script.pop(0)
        if isinstance(step, BaseException):
            raise step
        return step, ("192.0.2.1", 4403)

    def close(self):
        """Record the close, raising the configured error if there is one."""
        self.closed = True
        if self._close_error is not None:
            raise self._close_error


class _ScriptedSelect:
    """Stand-in for the :mod:`select` module replaying scripted readiness.

    Installed as ``udp_mod.select``, so only the provider sees it. Each wait
    consumes one step: the list of sockets to report readable, or an
    exception instance to raise. Once the script is spent it sets the
    interface's stop flag and reports nothing ready, so a loop under test
    always terminates.
    """

    def __init__(self, iface, *script):
        """Queue *script* for the waits of the loop serving *iface*."""
        self._iface = iface
        self._script = list(script)
        self.waits: list[tuple[list, float]] = []

    def select(self, rlist, wlist, xlist, timeout):
        """Record the wait, then return (or raise) the next scripted step."""
        self.waits.append((list(rlist), timeout))
        if not self._script:
            self._iface._stop.set()
            return [], [], []
        step = self._script.pop(0)
        if isinstance(step, BaseException):
            raise step
        return step, [], []


@pytest.fixture
def run_loop(monkeypatch):
    """Run ``_recv_loop`` synchronously over scripted sockets and readiness.

    Returns ``run(socks, *script, handle=None)``: it builds a connected
    interface over *socks*, installs a :class:`_ScriptedSelect` replaying
    *script*, replaces ``_handle_datagram`` with *handle* (by default, record
    the raw bytes), runs the loop to completion, and returns
    ``(iface, selector, handled)``.
    """

    def run(socks, *script, handle=None):
        """Run the loop to completion over *socks*, replaying *script*."""
        iface = _UdpInterface()
        iface._socks = list(socks)
        iface.isConnected.set()
        selector = _ScriptedSelect(iface, *script)
        monkeypatch.setattr(udp_mod, "select", selector)
        handled: list[bytes] = []
        provider = MeshtasticUdpProvider()
        monkeypatch.setattr(
            provider,
            "_handle_datagram",
            handle or (lambda raw, _iface: handled.append(raw)),
        )
        provider._recv_loop(iface)
        return iface, selector, handled

    return run


class TestRecvLoop:
    """Directly exercises ``_recv_loop``'s branches without a real thread."""

    def test_idle_wait_rechecks_stop_flag(self, run_loop):
        """An empty wait (the poll timeout) loops back to the stop-flag check."""
        sock = _ScriptedSock()
        iface, selector, handled = run_loop([sock], [])

        assert selector.waits == [([sock], udp_mod._RECV_POLL_SECS)] * 2
        assert handled == []
        # Loop exit clears isConnected so a dead reader is detectable.
        assert not iface.isConnected.is_set()

    def test_dispatches_datagrams_from_either_group_socket(self, run_loop):
        """One thread serves every group: whichever socket is ready is read.

        The first wait reports only the second group's socket ready, the next
        reports both, and every wait covers both sockets.
        """
        new_group = _ScriptedSock(b"from-239")
        old_group = _ScriptedSock(b"from-224", b"again-224")
        _iface, selector, handled = run_loop(
            [new_group, old_group], [old_group], [new_group, old_group]
        )

        assert handled == [b"from-224", b"from-239", b"again-224"]
        assert all(rlist == [new_group, old_group] for rlist, _ in selector.waits)

    def test_ready_socket_that_times_out_is_skipped(self, run_loop):
        """Readable-then-empty skips only that socket; the loop carries on."""
        quiet = _ScriptedSock(socket.timeout())
        busy = _ScriptedSock(b"datagram")
        _iface, selector, handled = run_loop([quiet, busy], [quiet, busy])

        assert handled == [b"datagram"]
        assert len(selector.waits) == 2

    @pytest.mark.parametrize("error", [OSError("bad fd"), ValueError("fd -1")])
    def test_wait_error_ends_loop_and_clears_connected(self, run_loop, error):
        """A socket closed under the wait ends the loop and marks it dead."""
        iface, selector, _handled = run_loop([_ScriptedSock()], error)

        assert len(selector.waits) == 1
        assert not iface.isConnected.is_set()

    def test_recv_oserror_ends_loop_and_clears_connected(self, run_loop):
        """An OSError from recvfrom (socket closed after the wait) ends the loop."""
        dead = _ScriptedSock(OSError("socket closed"))
        iface, selector, handled = run_loop([dead], [dead])

        assert len(selector.waits) == 1
        assert handled == []
        assert not iface.isConnected.is_set()

    def test_handle_datagram_exception_is_swallowed_loop_survives(self, run_loop):
        """An exception from _handle_datagram is caught; the loop keeps running.

        Regression for the DoS where one bad datagram propagated out of
        _handle_datagram and killed the reader thread. Here _handle_datagram
        raises on the first datagram; the loop must go on to the second and
        exit cleanly on the stop flag rather than propagating.
        """
        seen: list[bytes] = []

        def boom_once(raw, _iface):
            """Record *raw*, raising for the ``b"bad"`` datagram only."""
            seen.append(raw)
            if raw == b"bad":
                raise ValueError("simulated bad datagram")

        sock = _ScriptedSock(b"bad", b"good")
        iface, _selector, _handled = run_loop(
            [sock], [sock], [sock], handle=boom_once
        )  # must not raise

        assert seen == [b"bad", b"good"]
        assert not iface.isConnected.is_set()

    def test_real_select_rejects_a_closed_socket_and_the_loop_ends(self):
        """The real ``select`` raises ValueError on a closed socket; the loop ends.

        Pins the premise of the ValueError branch with no script: a closed
        socket's ``fileno()`` is -1, which ``select`` rejects. That is the race
        where :meth:`_UdpInterface.close` runs between the stop-flag check and
        the wait.
        """
        receiver, sender = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
        sender.close()
        receiver.close()
        with pytest.raises(ValueError):
            select.select([receiver], [], [], 0)

        iface = _UdpInterface()
        iface._socks = [receiver]
        iface.isConnected.set()
        MeshtasticUdpProvider()._recv_loop(iface)  # must return, not raise

        assert not iface.isConnected.is_set()


# ---------------------------------------------------------------------------
# _UdpInterface lifecycle
# ---------------------------------------------------------------------------


class TestUdpInterfaceLifecycle:
    """Tests for :class:`_UdpInterface`."""

    def test_init_defaults(self):
        """A fresh interface has no nodes, sockets or thread, and is not connected."""
        iface = _UdpInterface()
        assert iface.nodes == {}
        assert isinstance(iface.isConnected, threading.Event)
        assert not iface.isConnected.is_set()
        assert iface._socks == []
        assert iface._thread is None
        assert not iface._stop.is_set()

    def test_close_with_no_sock_or_thread_is_safe(self):
        """close() must not raise when no socket was opened and no thread started."""
        iface = _UdpInterface()
        iface.isConnected.set()
        iface.close()
        assert iface._stop.is_set()
        assert not iface.isConnected.is_set()

    def test_close_closes_every_socket_and_swallows_oserror(self):
        """close() closes each group socket, even after one close() raises."""
        iface = _UdpInterface()
        failing = _ScriptedSock(close_error=OSError("already closed"))
        healthy = _ScriptedSock()
        iface._socks = [failing, healthy]

        iface.close()  # must not raise

        assert failing.closed and healthy.closed
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
# MeshtasticUdpProvider.connect (group joins over local socketpairs)
# ---------------------------------------------------------------------------


class _GroupSockets:
    """Stand-in for ``open_multicast_socket`` backed by local socketpairs.

    Each join records ``(group, port)`` and returns the receiving end of a
    fresh ``AF_UNIX`` datagram socketpair: a real file descriptor the real
    ``select`` can wait on, with no network socket involved. The sending end
    stays here so a test can deliver a datagram to one group's socket.
    """

    def __init__(self) -> None:
        """Start with no joins recorded and no group set to fail."""
        self.joined: list[tuple[str, int]] = []
        self.fail_on: str | None = None
        self._receivers: dict[str, socket.socket] = {}
        self._senders: dict[str, socket.socket] = {}

    def open(self, group: str, port: int) -> socket.socket:
        """Join *group* on *port*, or raise ``OSError`` when it is :attr:`fail_on`."""
        if group == self.fail_on:
            raise OSError(f"simulated join failure for {group}")
        self.joined.append((group, port))
        receiver, sender = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
        receiver.settimeout(1.0)  # as open_multicast_socket does
        self._receivers[group] = receiver
        self._senders[group] = sender
        return receiver

    def send(self, group: str, payload: bytes) -> None:
        """Deliver *payload* to the provider's socket for *group*."""
        self._senders[group].send(payload)

    def is_closed(self, group: str) -> bool:
        """Return whether the provider's socket for *group* has been closed."""
        return self._receivers[group].fileno() == -1

    def close_all(self) -> None:
        """Close both ends of every socketpair handed out."""
        for sock in (*self._receivers.values(), *self._senders.values()):
            sock.close()


@pytest.fixture
def group_sockets(monkeypatch):
    """Route the provider's group joins to a fresh :class:`_GroupSockets`."""
    sockets = _GroupSockets()
    monkeypatch.setattr(udp_mod, "open_multicast_socket", sockets.open)
    yield sockets
    sockets.close_all()


@pytest.fixture
def idle_reader(monkeypatch):
    """Make the receive thread a no-op, for tests that only inspect connect()."""
    monkeypatch.setattr(MeshtasticUdpProvider, "_recv_loop", lambda self, iface: None)


@pytest.fixture
def shipped_config(monkeypatch):
    """Reload ``config`` with the UDP group and port unset, as shipped.

    Reloads again on teardown. That reload runs before ``monkeypatch``
    restores the variables, so it yields the shipped defaults, not the
    caller's environment; a later test that needs environment-derived values
    must reload ``config`` itself.
    """
    monkeypatch.delenv("MESH_UDP_GROUP", raising=False)
    monkeypatch.delenv("MESH_UDP_PORT", raising=False)
    yield importlib.reload(udp_mod.config)
    importlib.reload(udp_mod.config)


class TestConnectLifecycle:
    """Exercises connect() end-to-end over local sockets and a real thread."""

    def test_connect_returns_triple_and_receives_then_closes(
        self, monkeypatch, group_sockets
    ):
        """One reader thread serves every group; close() releases them all.

        The real captured primary datagram arrives on one group's socket and
        a synthetic primary packet on the other's; both must reach on_receive.
        """
        primary_raw, _private_raw = _load_fixture_raw()
        captured = mesh_pb2.MeshPacket()
        captured.ParseFromString(primary_raw)
        synthetic_raw = _encrypt_packet(
            udp_decode.channel_hash("MediumFast", "AQ=="), packet_id=0x5151
        )
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_KEY", "AQ==")
        monkeypatch.setattr(udp_mod.config, "PRIMARY_CHANNEL_NAME", "MediumFast")
        monkeypatch.setattr(
            udp_mod.config, "MESH_UDP_GROUPS", ("239.0.0.69", "224.0.0.69")
        )
        monkeypatch.setattr(udp_mod.config, "MESH_UDP_PORT", 4403)
        # A short poll keeps close() from idling a full second in select.
        monkeypatch.setattr(udp_mod, "_RECV_POLL_SECS", 0.01)

        received: list[dict] = []
        monkeypatch.setattr(
            udp_mod.handlers,
            "on_receive",
            lambda packet, interface: received.append(packet),
        )

        provider = MeshtasticUdpProvider()
        iface, target, next_candidate = provider.connect(active_candidate="ignored")

        assert target == "udp://239.0.0.69,224.0.0.69:4403"
        assert next_candidate == "ignored"
        assert iface.isConnected.is_set()

        group_sockets.send("224.0.0.69", primary_raw)
        group_sockets.send("239.0.0.69", synthetic_raw)
        deadline = time.monotonic() + 2.0
        while len(received) < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert sorted(packet["id"] for packet in received) == sorted(
            [captured.id, 0x5151]
        )

        iface.close()

        assert not iface._thread.is_alive()
        assert not iface.isConnected.is_set()
        assert group_sockets.is_closed("239.0.0.69")
        assert group_sockets.is_closed("224.0.0.69")


@pytest.mark.usefixtures("idle_reader")
class TestConnectGroups:
    """connect() opens one group-bound socket per configured group."""

    def test_shipped_default_joins_both_groups(self, shipped_config, group_sockets):
        """Unconfigured, both Meshtastic groups are joined (issue #903).

        Firmware 2.8 and later sends to 239.0.0.69 and earlier firmware to
        224.0.0.69, so a listener on only one group hears nothing from the
        other firmware line.
        """
        iface, target, _next = MeshtasticUdpProvider().connect(active_candidate=None)
        iface.close()

        assert group_sockets.joined == [("239.0.0.69", 4403), ("224.0.0.69", 4403)]
        assert target == "udp://239.0.0.69,224.0.0.69:4403"

    def test_one_configured_group_opens_one_socket(self, monkeypatch, group_sockets):
        """A single configured group listens on that group only."""
        monkeypatch.setattr(udp_mod.config, "MESH_UDP_GROUPS", ("224.0.0.69",))
        monkeypatch.setattr(udp_mod.config, "MESH_UDP_PORT", 4403)

        iface, target, _next = MeshtasticUdpProvider().connect(active_candidate=None)
        iface.close()

        assert group_sockets.joined == [("224.0.0.69", 4403)]
        assert target == "udp://224.0.0.69:4403"

    def test_failed_join_closes_joined_sockets_and_propagates(
        self, monkeypatch, group_sockets
    ):
        """A group that cannot be joined fails connect() without leaking the others.

        The daemon retries a failed connect with backoff, so a socket left open
        on each attempt would pile up for as long as the group stays unjoinable.
        """
        monkeypatch.setattr(
            udp_mod.config, "MESH_UDP_GROUPS", ("239.0.0.69", "224.0.0.69")
        )
        group_sockets.fail_on = "224.0.0.69"

        with pytest.raises(OSError, match="224.0.0.69"):
            MeshtasticUdpProvider().connect(active_candidate=None)

        assert [group for group, _port in group_sockets.joined] == ["239.0.0.69"]
        assert group_sockets.is_closed("239.0.0.69")


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


@pytest.mark.usefixtures("group_sockets", "idle_reader")
class TestConnectLogsPrimaryFilter:
    """connect() emits a startup log describing the resolved primary filter."""

    def test_logs_resolved_hash_info(self, monkeypatch):
        """A configured name logs the resolved hash at info severity."""
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
