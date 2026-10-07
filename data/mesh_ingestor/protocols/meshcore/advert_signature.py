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

"""Check the Ed25519 signature of a MeshCore advert heard in the RX log.

The companion radio pushes every frame it receives to the RX log before the
firmware checks it (``Dispatcher::checkRecv`` calls ``logRxRaw`` before it
parses the packet), and the ``meshcore`` library's parser extracts an
advert's signature without checking it.  The firmware verifies an advert only
on its way into the contact roster (``Mesh::onRecvPacket``), so roster
contacts and ``ADVERTISEMENT`` pushes arrive verified and an RX-log advert
does not.  :func:`_rx_advert_signature_problem` repeats the firmware's check
on the raw payload, so the ingestor posts an RX-log advert only when its
signature holds (SPEC SG1) under a key that is not of small order (SG4).
:func:`_rx_advert_signed_timestamp` reads the signed timestamp the replay
check compares (SG5, :mod:`.advert_replay`).
"""

from __future__ import annotations

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

_PUB_KEY_SIZE = 32
"""Bytes of the advertiser's Ed25519 public key (firmware ``PUB_KEY_SIZE``)."""

_SIGNATURE_OFFSET = _PUB_KEY_SIZE + 4
"""Offset of the signature in an ``ADVERT`` payload: after the public key and
the 4-byte sender-side timestamp."""

_APP_DATA_OFFSET = _SIGNATURE_OFFSET + 64
"""Offset of the app data (flags, position, name): after the 64-byte
signature (firmware ``SIGNATURE_SIZE``)."""

_MAX_ADVERT_DATA_SIZE = 32
"""Most app-data bytes an advert carries and signs (firmware
``MAX_ADVERT_DATA_SIZE``; ``Mesh::createAdvert`` refuses more)."""

# libsodium's small-order blocklist, ge25519_has_small_order() in
# src/libsodium/crypto_core/ed25519/ref10/ed25519_ref10.c, compared as there:
# the first 31 bytes exactly, byte 31 with its top bit (the sign of x) masked.
# The seven values are every encoding of the eight points of order 1, 2, 4 and
# 8 on the RFC 8032 curve (section 5.1), non-canonical y = p and y = p + 1
# included; tests/ed25519_oracle.py derives them from the RFC's constants.
_SMALL_ORDER_KEYS = frozenset(
    bytes.fromhex(encoding)
    for encoding in (
        "00" * 32,  # 0 (order 4)
        "01" + "00" * 31,  # 1 (order 1)
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",  # order 8
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",  # order 8
        "ec" + "ff" * 30 + "7f",  # p - 1 (order 2)
        "ed" + "ff" * 30 + "7f",  # p (= 0, order 4)
        "ee" + "ff" * 30 + "7f",  # p + 1 (= 1, order 1)
    )
)
"""Public-key encodings of small order, the sign bit cleared (SPEC SG4)."""


def _has_small_order(pub_key: bytes) -> bool:
    """Return whether a 32-byte public key encodes a point of small order.

    No private key stands behind such a key and trivial signatures verify
    under it, so its signature proves nothing.  The sign bit is masked as
    libsodium masks it, so the sign-bit variants match too, among them the
    three that OpenSSL accepts and the firmware's decoder refuses (``x = 0``
    with the sign bit set): ``01 00..00 80``, ``ec ff..ff ff`` and
    ``ee ff..ff ff``.

    Parameters:
        pub_key: The advert's raw public key.

    Returns:
        ``True`` when the key is on :data:`_SMALL_ORDER_KEYS`.
    """
    return pub_key[:31] + bytes([pub_key[31] & 0x7F]) in _SMALL_ORDER_KEYS


def _rx_advert_signature_problem(frame: dict) -> str | None:
    """Return why an RX-log advert's signature does not hold, or ``None``.

    Checks what ``Mesh::onRecvPacket`` checks, on the raw payload the parser
    read its ``adv_*`` fields from: an Ed25519 signature by the advert's own
    public key over ``pub_key + timestamp + app_data`` (``Mesh::createAdvert``).
    The payload is laid out ``pub_key(32) + timestamp(4) + signature(64) +
    app_data``.  Three rules go past the firmware's, so that every field the
    ingestor posts is signed by a key some private key stands behind:

    * App data longer than 32 bytes is refused.  The firmware never sends
      more and verifies only the first 32 bytes of a longer frame, while the
      parser reads the name to the end of the frame.
    * The parsed ``adv_key``, which names the posted node, must be the key
      in the signed bytes.
    * A key of small order is refused (:func:`_has_small_order`, SPEC SG4).

    Parameters:
        frame: Parsed RX-log ``ADVERT`` frame.  Reads ``pkt_payload`` (the raw
            packet payload as ``bytes`` or ``bytearray``) and ``adv_key``.

    Returns:
        ``None`` when the signature holds, else the reason it does not:
        ``"no raw payload"``, ``"truncated signature"``, ``"app data over 32
        bytes"``, ``"key mismatch"``, ``"small-order key"`` or ``"invalid
        signature"``.
    """
    raw = frame.get("pkt_payload")
    if not isinstance(raw, (bytes, bytearray)):
        return "no raw payload"
    raw = bytes(raw)
    if len(raw) < _APP_DATA_OFFSET:
        return "truncated signature"
    if len(raw) - _APP_DATA_OFFSET > _MAX_ADVERT_DATA_SIZE:
        return "app data over 32 bytes"
    pub_key = raw[:_PUB_KEY_SIZE]
    if frame.get("adv_key") != pub_key.hex():
        return "key mismatch"
    if _has_small_order(pub_key):
        return "small-order key"
    # The signed message skips the signature itself: key, timestamp, app data.
    message = raw[:_SIGNATURE_OFFSET] + raw[_APP_DATA_OFFSET:]
    try:
        Ed25519PublicKey.from_public_bytes(pub_key).verify(
            raw[_SIGNATURE_OFFSET:_APP_DATA_OFFSET], message
        )
    except InvalidSignature:
        return "invalid signature"
    return None


def _rx_advert_signed_timestamp(frame: dict) -> int:
    """Return the sender-side timestamp an RX-log advert's signature covers.

    Reads the four little-endian bytes after the public key in ``pkt_payload``,
    the bytes the parser reports as ``adv_timestamp``.  Call it only for a
    frame whose signature holds (:func:`_rx_advert_signature_problem` returned
    ``None``): only then is the timestamp the advertiser's own.

    Parameters:
        frame: Parsed RX-log ``ADVERT`` frame whose signature holds.

    Returns:
        The signed ``uint32`` advert timestamp.
    """
    raw = bytes(frame["pkt_payload"])
    return int.from_bytes(raw[_PUB_KEY_SIZE:_SIGNATURE_OFFSET], "little")
