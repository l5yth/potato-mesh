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

The advert helpers build ``ADVERT`` payloads the way ``Mesh::createAdvert`` and
``AdvertDataBuilder::encodeTo`` do, signed with Ed25519 keys derived from fixed
seeds when a test runs, and parse them with the pinned library's packet parser
as the reader does for an RX-log push (SPEC SG1).  They are a second
independent oracle: the signed bytes are rebuilt here, not taken from the code
under test.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import struct
import types

import meshcore
from Crypto.Cipher import AES
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from meshcore.meshcore_parser import MeshcorePacketParser

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


ADV_TYPE_NONE = 0
"""Firmware ``ADV_TYPE_NONE``: an advert that names no node type."""

ADV_TYPE_CHAT = 1
"""Firmware ``ADV_TYPE_CHAT``: a companion (chat) node."""

ADV_TYPE_REPEATER = 2
"""Firmware ``ADV_TYPE_REPEATER``: a repeater."""

ADV_LATLON_MASK = 0x10
"""Firmware ``ADV_LATLON_MASK``: the app data carries a latitude and longitude."""

ADV_NAME_MASK = 0x80
"""Firmware ``ADV_NAME_MASK``: the app data carries a node name."""

MAX_ADVERT_DATA_SIZE = 32
"""Firmware ``MAX_ADVERT_DATA_SIZE``: the most app-data bytes an advert signs."""


def advert_key(seed: str) -> Ed25519PrivateKey:
    """Return a deterministic Ed25519 key for one test advertiser.

    The key is derived when the test runs, with ``SHA256(seed)`` as the
    RFC 8032 private-key seed, so no private key is stored in a fixture.

    Parameters:
        seed: Fixed label naming the advertiser.

    Returns:
        The advertiser's private key.
    """
    return Ed25519PrivateKey.from_private_bytes(
        hashlib.sha256(seed.encode("utf-8")).digest()
    )


def advert_public_key(key: Ed25519PrivateKey) -> bytes:
    """Return the 32 raw public-key bytes an advert carries for *key*.

    Parameters:
        key: Advertiser key from :func:`advert_key`.

    Returns:
        The raw Ed25519 public key.
    """
    return key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)


def advert_node_id(key: Ed25519PrivateKey) -> str:
    """Return the node id the ingestor posts *key* under.

    Parameters:
        key: Advertiser key from :func:`advert_key`.

    Returns:
        ``!`` followed by the public key's first four bytes in lowercase hex.
    """
    return "!" + advert_public_key(key)[:4].hex()


def advert_app_data(
    adv_type: int = ADV_TYPE_NONE,
    *,
    name: str | None = None,
    lat_e6: int | None = None,
    lon_e6: int | None = None,
) -> bytes:
    """Encode an advert's app data as ``AdvertDataBuilder::encodeTo`` does.

    Parameters:
        adv_type: ``ADV_TYPE_*`` value for the low four flag bits.
        name: Node name, cut to fit the 32-byte app data as the firmware cuts
            it; ``None`` or empty leaves the name out.
        lat_e6: Latitude in millionths of a degree; used with *lon_e6*.
        lon_e6: Longitude in millionths of a degree; used with *lat_e6*.

    Returns:
        ``flags(1) + [lat(4) + lon(4)] + [name]``, integers little-endian.
    """
    flags = adv_type
    body = b""
    if lat_e6 is not None and lon_e6 is not None:
        flags |= ADV_LATLON_MASK
        body += struct.pack("<ii", lat_e6, lon_e6)
    if name:
        flags |= ADV_NAME_MASK
        body += name.encode("utf-8")[: MAX_ADVERT_DATA_SIZE - 1 - len(body)]
    return bytes([flags]) + body


def advert_signed_message(public_key: bytes, timestamp: int, app_data: bytes) -> bytes:
    """Return the bytes ``Mesh::createAdvert`` signs for one advert.

    Parameters:
        public_key: The advertiser's raw public key (:func:`advert_public_key`).
        timestamp: Sender-side advert time.
        app_data: Encoded app data from :func:`advert_app_data`.

    Returns:
        ``pub_key(32) + timestamp(4) + app_data``.
    """
    return public_key + struct.pack("<I", timestamp) + app_data


def advert_payload_bytes(
    public_key: bytes, timestamp: int, signature: bytes, app_data: bytes
) -> bytes:
    """Lay out an ``ADVERT`` packet payload for any public-key bytes.

    For keys no private key stands behind, such as the small-order encodings;
    :func:`advert_payload` signs with a test key instead.

    Parameters:
        public_key: The 32 bytes to send as the advertiser's key.
        timestamp: Sender-side advert time, sent as a little-endian ``uint32``.
        signature: The 64 bytes to send as the signature.
        app_data: Encoded app data from :func:`advert_app_data`.

    Returns:
        ``pub_key(32) + timestamp(4) + signature(64) + app_data``.
    """
    return public_key + struct.pack("<I", timestamp) + signature + app_data


def advert_payload(
    key: Ed25519PrivateKey,
    timestamp: int,
    app_data: bytes,
    *,
    signature: bytes | None = None,
) -> bytes:
    """Build an ``ADVERT`` packet payload as ``Mesh::createAdvert`` does.

    Parameters:
        key: Advertiser key from :func:`advert_key`.
        timestamp: Sender-side advert time, sent as a little-endian ``uint32``.
        app_data: Encoded app data from :func:`advert_app_data`.
        signature: Bytes to send in the signature's place, to forge or cut
            one; by default *key* signs :func:`advert_signed_message`.

    Returns:
        ``pub_key(32) + timestamp(4) + signature(64) + app_data``.
    """
    public_key = advert_public_key(key)
    if signature is None:
        signature = key.sign(advert_signed_message(public_key, timestamp, app_data))
    return advert_payload_bytes(public_key, timestamp, signature, app_data)


def rx_log_advert(
    payload: bytes,
    *,
    recv_time: int,
    snr: float | None = None,
    rssi: int | None = None,
    hops: int = 0,
) -> dict:
    """Return the ``RX_LOG_DATA`` event payload the reader dispatches for an advert.

    Wraps *payload* in a flood packet that travelled *hops* repeaters and
    parses it with the pinned library's ``MeshcorePacketParser``, as
    ``MessageReader`` does for a ``LOG_RX_DATA`` push.  The reader's
    ``raw_hex`` and ``payload`` hex copies are left out: the ingestor reads
    the parsed fields and ``pkt_payload`` only.

    Parameters:
        payload: Advert payload from :func:`advert_payload`.
        recv_time: Receiver-side reception time.
        snr: Reception SNR in dB, or ``None`` to leave it out.
        rssi: Reception RSSI in dBm, or ``None`` to leave it out.
        hops: Repeaters the copy travelled, as one-byte hashes ``01``, ``02``...

    Returns:
        The parsed RX-log frame; ``pkt_payload`` holds *payload*.
    """
    log: dict = {"recv_time": recv_time}
    if snr is not None:
        log["snr"] = snr
    if rssi is not None:
        log["rssi"] = rssi
    raw = raw_packet(
        payload, path=bytes(range(1, hops + 1)), payload_type=PAYLOAD_TYPE_ADVERT
    )
    return asyncio.run(MeshcorePacketParser().parsePacketPayload(raw, log))


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
