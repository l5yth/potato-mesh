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
"""Synthetic MeshCore companion frames and an offline radio for tests (#765).

Builds the byte frames a companion radio writes to its serial link the way the
firmware does - ``CHANNEL_INFO``, the ``LOG_RX_DATA`` push (``0x88``,
``MyMesh::logRxRaw``) and ``CHANNEL_MSG_RECV_V3`` (``0x11``,
``MyMesh::onChannelMessageRecv``) - so a test can drive the real ``meshcore``
reader without a radio, and :func:`offline_meshcore` runs the real
``MeshCore`` class through the ingestor's runner without a link.  The
flood-scope helpers are an independent oracle of the firmware rules
(``TransportKey::calcTransportCode`` and ``RegionMap::getTransportKeysFor``),
deliberately not shared with the code under test.  Seeded from the #765
scoping probes.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import types

import meshcore
from Crypto.Cipher import AES

CHANNEL_NAME = "#test"
"""Hashtag channel the frames are encrypted for (index 0)."""

SENDER_TS = 1_791_280_000
"""Sender-side timestamp carried inside every synthetic message."""

TEXT = "Alice: hello path"
"""Default channel-message text (MeshCore embeds the sender name)."""

PAYLOAD_TYPE_GRP_TXT = 0x05
"""Firmware ``PAYLOAD_TYPE_GRP_TXT``: a group-channel text message."""

PAYLOAD_TYPE_ADVERT = 0x04
"""Firmware ``PAYLOAD_TYPE_ADVERT``: a node advertisement."""

ROUTE_TRANSPORT_FLOOD = 0
"""Firmware ``ROUTE_TYPE_TRANSPORT_FLOOD``: a scoped flood."""

ROUTE_FLOOD = 1
"""Firmware ``ROUTE_TYPE_FLOOD``: a plain, unscoped flood."""

ROUTE_DIRECT = 2
"""Firmware ``ROUTE_TYPE_DIRECT``."""


def channel_secret(name: str = CHANNEL_NAME) -> bytes:
    """Return the 16-byte secret of a hashtag channel (``SHA256(name)[:16]``).

    Parameters:
        name: Hashtag channel name including the ``#``.

    Returns:
        The channel's AES-128 key.
    """
    return hashlib.sha256(name.encode("utf-8")).digest()[:16]


def grp_txt_payload(
    secret: bytes, sender_ts: int = SENDER_TS, text: str = TEXT
) -> bytes:
    """Encrypt one channel message into a ``GRP_TXT`` packet payload.

    Parameters:
        secret: Channel secret from :func:`channel_secret`.
        sender_ts: Sender timestamp written into the plaintext.
        text: Message text, sender name included.

    Returns:
        ``channel_hash(1) + mac(2) + AES-ECB ciphertext``.
    """
    plain = sender_ts.to_bytes(4, "little") + b"\x00" + text.encode("utf-8")
    plain += b"\x00" * (-len(plain) % 16)
    cipher = AES.new(secret, AES.MODE_ECB).encrypt(plain)
    mac = hmac.new(secret, cipher, hashlib.sha256).digest()[:2]
    return hashlib.sha256(secret).digest()[:1] + mac + cipher


def region_key(name: str) -> bytes:
    """Return a hashtag region's transport key: ``SHA256("#" + name)[:16]``.

    Parameters:
        name: Region name with or without its leading ``#``.

    Returns:
        The 16-byte region key.
    """
    if not name.startswith("#"):
        name = "#" + name
    return hashlib.sha256(name.encode("utf-8")).digest()[:16]


def transport_code(key: bytes, payload_type: int, payload: bytes) -> bytes:
    """Return the on-air bytes of ``transport_codes[0]`` for *key*.

    The first two bytes of ``HMAC-SHA256(key, payload_type || payload)``; the
    reserved codes ``0000`` and ``FFFF`` map to ``0001`` and ``FFFE``.

    Parameters:
        key: Region key from :func:`region_key`.
        payload_type: Packet payload type.
        payload: Packet payload bytes.

    Returns:
        Two little-endian bytes.
    """
    code = hmac.new(key, bytes([payload_type]) + payload, hashlib.sha256).digest()
    value = int.from_bytes(code[:2], "little")
    if value == 0:
        value = 1
    elif value == 0xFFFF:
        value = 0xFFFE
    return value.to_bytes(2, "little")


def raw_packet(
    payload: bytes,
    *,
    route_type: int = ROUTE_FLOOD,
    path: bytes = b"",
    hash_size: int = 1,
    code0: bytes | None = None,
    payload_type: int = PAYLOAD_TYPE_GRP_TXT,
) -> bytes:
    """Assemble one over-air MeshCore packet.

    Parameters:
        payload: Packet payload (for example from :func:`grp_txt_payload`).
        route_type: Two-bit route type.
        path: Concatenated repeater hashes in travel order.
        hash_size: Bytes per repeater hash (1-3).
        code0: ``transport_codes[0]`` bytes; required for the transport route
            types, where ``transport_codes[1]`` is written as zero.
        payload_type: Four-bit payload type.

    Returns:
        ``header + [transport codes] + path_len + path + payload``.
    """
    header = bytes([(payload_type << 2) | route_type])
    transport = b""
    if route_type in (ROUTE_TRANSPORT_FLOOD, 3):
        transport = (code0 or b"\x00\x00") + b"\x00\x00"
    hops = len(path) // hash_size
    path_len = ((hash_size - 1) << 6) | hops
    return header + transport + bytes([path_len]) + path + payload


def rx_log_frame(raw: bytes, *, snr: float, rssi: int) -> bytes:
    """Wrap a raw packet into a ``LOG_RX_DATA`` push frame.

    Parameters:
        raw: Packet from :func:`raw_packet`.
        snr: Reception SNR in dB (sent as ``int8(snr * 4)``).
        rssi: Reception RSSI in dBm (sent as ``int8``).

    Returns:
        ``0x88 + snr + rssi + raw``.
    """
    return bytes([0x88, int(snr * 4) & 0xFF, rssi & 0xFF]) + raw


def channel_info_frame(
    idx: int = 0, name: str = CHANNEL_NAME, secret: bytes | None = None
) -> bytes:
    """Build a ``CHANNEL_INFO`` reply, which registers the secret in the reader.

    Parameters:
        idx: Channel slot index.
        name: Channel name.
        secret: Channel secret; derived from *name* when omitted.

    Returns:
        ``0x12 + idx + name(32) + secret(16)``.
    """
    key = secret if secret is not None else channel_secret(name)
    return bytes([0x12, idx]) + name.encode("utf-8").ljust(32, b"\x00") + key


def channel_msg_v3_frame(
    *,
    path_len: int,
    snr: float = 10.0,
    channel_idx: int = 0,
    sender_ts: int = SENDER_TS,
    text: str = TEXT,
) -> bytes:
    """Build a ``CHANNEL_MSG_RECV_V3`` sync reply.

    Parameters:
        path_len: The raw path-length byte: the hop count of the delivered
            flood copy, or ``0xFF`` for a direct route.
        snr: SNR of the delivered copy in dB.
        channel_idx: Channel slot index.
        sender_ts: Sender timestamp.
        text: Message text.

    Returns:
        ``0x11 + snr + reserved(2) + channel + path_len + txt_type + ts + text``.
    """
    head = bytes([0x11, int(snr * 4) & 0xFF, 0, 0, channel_idx, path_len, 0])
    return head + sender_ts.to_bytes(4, "little") + text.encode("utf-8")


def message_hash(sender_ts: int = SENDER_TS, text: str = TEXT) -> int:
    """Return the library's message hash: ``SHA256(ts + text)[:4]``, little-endian.

    Parameters:
        sender_ts: Sender timestamp.
        text: Message text.

    Returns:
        The 32-bit hash the reader stores as ``txt_hash`` / ``msg_hash``.
    """
    digest = hashlib.sha256(sender_ts.to_bytes(4, "little") + text.encode("utf-8"))
    return int.from_bytes(digest.digest()[:4], "little")


class FakeConnection:
    """Serial-link stand-in for ``meshcore.MeshCore``; it never sends a byte."""

    def set_disconnect_callback(self, callback) -> None:
        """Accept and ignore the library's disconnect callback.

        Parameters:
            callback: Callback the connection manager registers.
        """

    def set_reader(self, reader) -> None:
        """Accept and ignore the library's frame reader.

        Parameters:
            reader: The ``MessageReader`` the connection would feed.
        """


class QuietCommands:
    """Companion-command stand-in that answers without a radio.

    A command named in *replies* answers with that event (or raises it, when
    it is an exception); every other command answers ``ERROR`` at once.
    """

    def __init__(self, replies: dict | None = None) -> None:
        """Store the canned replies.

        Parameters:
            replies: Mapping of command name to reply event or exception.
        """
        self.replies = dict(replies or {})
        self.calls: list[str] = []

    def __getattr__(self, name: str):
        """Return an async command answering from the canned replies.

        Parameters:
            name: Command name the runner looks up.

        Returns:
            Coroutine function for the command.
        """
        if name.startswith("_"):
            raise AttributeError(name)
        reply = self.replies.get(name)

        async def _answer(*_args, **_kwargs):
            self.calls.append(name)
            if isinstance(reply, BaseException):
                raise reply
            if reply is not None:
                return reply
            return types.SimpleNamespace(type=meshcore.EventType.ERROR, payload={})

        return _answer


def offline_meshcore(replies: dict | None = None) -> type:
    """Return the real ``MeshCore`` class with its radio round-trips stubbed.

    The reader, dispatcher and ``set_decrypt_channel_logs`` stay real;
    ``connect``/``ensure_contacts``/``start_auto_message_fetching``/
    ``disconnect`` return at once and ``commands`` is a :class:`QuietCommands`.

    Parameters:
        replies: Canned command replies for :class:`QuietCommands`.

    Returns:
        A ``meshcore.MeshCore`` subclass taking the runner's ``cx`` argument.
    """

    class OfflineMeshCore(meshcore.MeshCore):
        """Real ``MeshCore`` over a fake link."""

        def __init__(self, cx) -> None:
            """Build the real instance over :class:`FakeConnection`.

            Parameters:
                cx: The runner's connection; replaced by a fake.
            """
            super().__init__(FakeConnection())
            self.commands = QuietCommands(replies)

        async def connect(self):
            """Answer the appstart handshake like a responsive radio.

            Returns:
                A non-``None`` result.
            """
            return "ok"

        async def ensure_contacts(self, follow=False):
            """Skip the roster fetch.

            Parameters:
                follow: Ignored.

            Returns:
                ``True``.
            """
            return True

        async def start_auto_message_fetching(self):
            """Skip the message sync loop."""

        async def disconnect(self):
            """Skip the link teardown."""

    return OfflineMeshCore


def stub_handlers(captured: list) -> types.SimpleNamespace:
    """Return a ``data.mesh_ingestor.handlers`` stand-in that captures packets.

    Parameters:
        captured: List each ``store_packet_dict`` packet is appended to.

    Returns:
        Namespace with the handler functions the MeshCore handlers call.
    """
    return types.SimpleNamespace(
        upsert_node=lambda *_a, **_k: None,
        register_host_node_id=lambda *_a, **_k: None,
        host_node_id=lambda: None,
        _mark_packet_seen=lambda: None,
        _mark_packet_activity=lambda: None,
        store_packet_dict=captured.append,
    )


def install_stub_handlers(monkeypatch, captured: list) -> None:
    """Route the MeshCore handlers' ``handlers`` module to :func:`stub_handlers`.

    ``data.mesh_ingestor`` is imported here, at call time, because
    ``tests/test_mesh.py`` pops the package from ``sys.modules`` after each
    test; the handlers resolve whichever package object is current, so a
    reference taken at collection time could patch a stale one.

    Parameters:
        monkeypatch: pytest fixture.
        captured: List each ``store_packet_dict`` packet is appended to.
    """
    import data.mesh_ingestor as mesh_pkg

    monkeypatch.setattr(mesh_pkg, "handlers", stub_handlers(captured))


async def feed_reader(raw_frames: list, hmap: dict) -> None:
    """Push companion frames through the real reader with the join enabled.

    Subscribes the ingestor's ``CHANNEL_INFO``, ``RX_LOG_DATA`` and
    ``CHANNEL_MSG_RECV`` handlers to a real ``MeshCore`` dispatcher, enables
    RX-log decryption with the library's own switch, and lets each frame's
    handlers finish before the next frame arrives - as on the serial link,
    where the RX-log pushes precede the message sync.

    Parameters:
        raw_frames: Companion frames in arrival order.
        hmap: The ingestor's event-handler map.
    """
    mc = meshcore.MeshCore(FakeConnection())
    await mc.dispatcher.start()
    mc.set_decrypt_channel_logs(True)
    for name in ("CHANNEL_INFO", "RX_LOG_DATA", "CHANNEL_MSG_RECV"):
        mc.subscribe(meshcore.EventType[name], hmap[name])
    try:
        for raw in raw_frames:
            await mc._reader.handle_rx(bytearray(raw))
            await mc.dispatcher.queue.join()
            await asyncio.gather(*list(mc.dispatcher._background_tasks))
    finally:
        await mc.dispatcher.stop()
