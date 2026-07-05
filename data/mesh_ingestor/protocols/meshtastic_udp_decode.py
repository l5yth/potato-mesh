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

"""Decrypt raw Meshtastic ``MeshPacket`` datagrams and map them to dicts.

This module is the pure-logic core of the passive UDP transport: it has no
socket, threading, or daemon dependencies, so it can be unit tested (and
100%-covered) in complete isolation from the network.

Meshtastic's default/primary channel uses a small, publicly documented set
of 1-byte "default" PSKs (``0x01``..``0x07``) that every stock node ships
with, specifically so default-channel traffic is decodable by any compatible
client. This module implements that well-known key expansion plus the
AES-CTR decrypt used by the Meshtastic firmware, and maps a decoded packet
into the same dict shape the rest of this ingestor's pipeline already
consumes (see :mod:`data.mesh_ingestor.handlers`).
"""

from __future__ import annotations

import base64
import time

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from google.protobuf.json_format import MessageToDict
from meshtastic import protocols as _PROTOCOLS
from meshtastic.protobuf import mesh_pb2, portnums_pb2

_ONE_BYTE_PSK_PREFIX = bytes.fromhex("d4f1bb3a20290759f0bcffabcf4e69")
"""15-byte prefix Meshtastic firmware prepends to a 1-byte default PSK.

Concatenating this prefix with the raw 1-byte key (``0x01``..``0x07``)
reconstructs the 16-byte AES-128 key used for the corresponding default
channel, per the Meshtastic firmware's crypto implementation.
"""


def expand_default_key(key_b64: str) -> bytes:
    """Return the 16-byte AES key encoded by *key_b64*.

    Meshtastic channel PSKs are base64-encoded. A single decoded byte in the
    range ``0x01``..``0x07`` denotes one of the firmware's built-in "default"
    keys and must be expanded to 16 bytes via :data:`_ONE_BYTE_PSK_PREFIX`
    before use with AES-128. Any other decoded length (typically a full
    16-byte or 32-byte channel PSK) is returned unchanged.

    Args:
        key_b64: Base64-encoded channel PSK, e.g. ``"AQ=="``.

    Returns:
        The raw AES key bytes.

    Raises:
        binascii.Error: If *key_b64* is not valid base64.
    """
    raw = base64.b64decode(key_b64.encode("ascii"), validate=True)
    if len(raw) == 1 and 0x01 <= raw[0] <= 0x07:
        return _ONE_BYTE_PSK_PREFIX + raw
    return raw


def _xor_hash(data: bytes) -> int:
    """Return the XOR of every byte in *data* (Meshtastic's ``xorHash``).

    Args:
        data: The bytes to fold together.

    Returns:
        A single byte (``0``..``255``): all of *data* XOR-ed into one value,
        or ``0`` for empty input.
    """
    result = 0
    for byte in data:
        result ^= byte
    return result


def channel_hash(channel_name: str, key_b64: str) -> int:
    """Return the 1-byte Meshtastic channel hash for *(channel_name, key)*.

    This mirrors the firmware's ``Channels::generateHash``: the XOR-fold of the
    UTF-8 channel name XOR-ed with the XOR-fold of the (expanded) channel key.
    The hash is what a Meshtastic ``MeshPacket`` carries in its ``channel``
    field so receivers can pick the matching channel/key.

    Because the hash mixes in the channel *name*, two channels that share the
    same PSK -- e.g. the PRIMARY channel and a SECONDARY channel both left on
    the default ``AQ==`` key -- still produce different hashes. That distinction
    is exactly what lets the passive UDP transport keep only PRIMARY traffic:
    decrypting with the default key is not sufficient (a default-key SECONDARY
    channel would decrypt too), so we additionally require the packet's channel
    hash to equal the PRIMARY channel's hash.

    Args:
        channel_name: The channel name used by the firmware when hashing (the
            configured name, or the modem-preset name when the name is blank).
        key_b64: Base64-encoded channel PSK (see :func:`expand_default_key`).

    Returns:
        The channel hash byte (``0``..``255``).

    Raises:
        binascii.Error: If *key_b64* is not valid base64.
    """
    return _xor_hash(channel_name.encode("utf-8")) ^ _xor_hash(
        expand_default_key(key_b64)
    )


def decrypt_meshpacket(
    mp: "mesh_pb2.MeshPacket", key_b64: str
) -> "mesh_pb2.Data | None":
    """Decrypt ``mp.encrypted`` and return the parsed :class:`~mesh_pb2.Data`.

    Uses AES-CTR with the key derived from *key_b64* (see
    :func:`expand_default_key`) and a nonce built from the packet's ``id``
    and ``from`` fields (both little-endian, 8 bytes each), matching the
    Meshtastic firmware's construction.

    Any failure along the way -- a malformed *key_b64*, an undersized/absent
    ``mp.encrypted`` payload, or ciphertext that fails to decode as a valid
    ``Data`` protobuf -- is treated as "this packet was not encrypted with
    this key" and reported as ``None`` rather than raised, since the same
    code path is used to probe packets on channels this process has no key
    for (e.g. private channels captured alongside the primary channel).

    A packet that decodes cleanly but carries the default/unknown portnum
    (``0``) with an empty payload is also treated as a decrypt failure: in
    practice this is what "wrong key, coincidentally valid protobuf" garbage
    looks like, and real Meshtastic application payloads always set a
    portnum, a payload, or both.

    Args:
        mp: A parsed ``MeshPacket`` whose ``encrypted`` field holds
            ciphertext (as opposed to an already-``decoded`` packet).
        key_b64: Base64-encoded channel PSK to decrypt with.

    Returns:
        The decrypted :class:`~mesh_pb2.Data`, or ``None`` if decryption or
        parsing failed, or the result looks like private-channel noise.
    """
    try:
        key = expand_default_key(key_b64)
        nonce = mp.id.to_bytes(8, "little") + getattr(mp, "from").to_bytes(8, "little")
        decryptor = Cipher(algorithms.AES(key), modes.CTR(nonce)).decryptor()
        clear = decryptor.update(mp.encrypted) + decryptor.finalize()
        data = mesh_pb2.Data()
        data.ParseFromString(clear)
    except Exception:
        # Any decode/parse failure means this key does not open this packet.
        return None
    # A wrong key usually yields non-parseable bytes; a parse that produced
    # an unknown/zero portnum with no payload is treated as failure (i.e.
    # traffic on a channel this key does not decrypt).
    if data.portnum == 0 and not data.payload:
        return None
    return data


def _node_id(num: int) -> str:
    """Return the canonical Meshtastic node id string for *num*.

    Args:
        num: A 32-bit (or wider, masked down) node number.

    Returns:
        ``"^all"`` for the reserved broadcast address
        (``0xFFFFFFFF``), otherwise the canonical ``"!xxxxxxxx"`` hex form.
    """
    num &= 0xFFFFFFFF
    return "^all" if num == 0xFFFFFFFF else "!%08x" % num


def _enrich_decoded(decoded: dict, portnum: int, payload: bytes) -> None:
    """Populate *decoded* with the protobuf section for *portnum*, in place.

    The passive UDP transport only recovers ``portnum`` + raw ``payload`` from a
    ``MeshPacket``, but the ingestor's handlers (position, telemetry,
    traceroute, neighborinfo, ...) read the *decoded application message* from a
    named sub-dict -- ``decoded["position"]``, ``decoded["telemetry"]``, etc. --
    exactly as the Meshtastic Python library populates it on the API/serial
    path. This reproduces that step so a UDP-sourced packet yields byte-for-byte
    the same POST payloads as a library-sourced one.

    The decode table (``meshtastic.protocols``) and ``MessageToDict`` call are
    the same ones the library uses in ``_handlePacketFromRadio``, so field names
    (camelCase) and value formats match. Portnums with no protobuf factory
    (e.g. ``TEXT_MESSAGE_APP``) are left untouched. A malformed sub-payload is
    swallowed -- the packet still flows with its ``portnum``/``payload`` intact.

    Args:
        decoded: The decoded dict to mutate (already holds ``portnum`` and
            base64 ``payload``).
        portnum: The integer application portnum from the packet.
        payload: The raw application-payload bytes to parse.
    """
    handler = _PROTOCOLS.get(portnum)
    factory = getattr(handler, "protobufFactory", None) if handler else None
    if factory is None:
        return
    try:
        message = factory()
        message.ParseFromString(payload)
        decoded[handler.name] = MessageToDict(message)
    except Exception:
        # A wrong-length or malformed sub-payload is non-fatal: the handler for
        # this portnum will simply find its section absent, exactly as it would
        # for a library packet the firmware could not decode.
        return


def meshpacket_to_packet_dict(mp: "mesh_pb2.MeshPacket") -> dict:
    """Map a ``MeshPacket`` with a populated ``decoded`` field to a packet dict.

    Produces the same dict shape the rest of the ingestor pipeline already
    consumes from the Meshtastic library's pubsub callbacks (see
    :mod:`data.mesh_ingestor.handlers`), so a UDP-sourced packet can be fed
    into ``handlers.on_receive`` unchanged.

    Args:
        mp: A ``MeshPacket`` whose ``decoded`` field is already populated
            (typically via :func:`decrypt_meshpacket` followed by
            ``mp.decoded.CopyFrom(data)``, or a packet that was never
            encrypted in the first place).

    Returns:
        A dict with ``from``, ``fromId``, ``to``, ``toId``, ``id``,
        ``channel``, ``rxTime``, and ``decoded`` always present; ``rxSnr``,
        ``rxRssi``, and ``hopLimit`` present only when the corresponding
        source field is non-zero. The ``decoded`` sub-dict is enriched with the
        same protobuf-derived sections the Meshtastic library populates (see
        :func:`_enrich_decoded`) so downstream handlers behave identically to
        the API/serial transport.
    """
    try:
        portnum_name = portnums_pb2.PortNum.Name(mp.decoded.portnum)
    except ValueError:
        # A portnum newer than the installed protobufs (or attacker-supplied
        # garbage on the LAN multicast) has no enum name. Map it to a stable
        # sentinel that no handler dispatches on, rather than letting the
        # ValueError escape and kill the receive thread (a single such packet
        # would otherwise permanently stop ingestion).
        portnum_name = "UNKNOWN_APP"
    decoded: dict = {
        "portnum": portnum_name,
        "payload": base64.b64encode(mp.decoded.payload).decode("ascii"),
    }
    if portnum_name == "TEXT_MESSAGE_APP":
        decoded["text"] = mp.decoded.payload.decode("utf-8", errors="replace")
    _enrich_decoded(decoded, mp.decoded.portnum, mp.decoded.payload)

    packet = {
        "from": getattr(mp, "from"),
        "fromId": _node_id(getattr(mp, "from")),
        "to": mp.to,
        "toId": _node_id(mp.to),
        "id": mp.id,
        # The caller (MeshtasticUdpProvider) only dispatches packets whose
        # channel hash equals the PRIMARY channel's hash (see
        # channel_hash / MeshtasticUdpProvider._handle_datagram), so a mapped
        # packet is always primary -- channel index 0.
        "channel": 0,
        "rxTime": int(mp.rx_time) if mp.rx_time else int(time.time()),
        "decoded": decoded,
    }
    if mp.rx_snr:
        packet["rxSnr"] = float(mp.rx_snr)
    if mp.rx_rssi:
        packet["rxRssi"] = int(mp.rx_rssi)
    if mp.hop_limit:
        packet["hopLimit"] = int(mp.hop_limit)
    return packet
