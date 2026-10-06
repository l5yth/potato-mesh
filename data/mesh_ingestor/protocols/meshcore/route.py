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

"""Route capture for MeshCore channel messages: path, RSSI and flood scope.

SPEC SC1-SC4 and SC8 (#765).  The companion firmware pushes every over-air
frame it receives as an ``RX_LOG_DATA`` event before parsing or
de-duplicating it, then delivers a flood channel message from the **first**
copy it hears; later copies are dropped as already seen, and the message
event's ``path_len`` is that first copy's hop count.  The ``meshcore``
library's own join (``set_decrypt_channel_logs``) decrypts each ``GRP_TXT``
frame and stamps it with ``msg_hash``, but then copies the **newest** matching
frame onto the message, so a 3-hop message can carry a later 5-hop copy's
path and RSSI.

This module therefore keeps its own short, bounded index of the hashed
``GRP_TXT`` flood copies (:class:`RxLogIndex`) and matches each channel
message to the earliest copy whose hop count equals the message's
``path_len`` (:meth:`RouteTracker.channel_route`).  From that copy it takes
the repeater path, the RSSI, and the flood scope: ``transport_codes[0]`` of a
scoped flood is an HMAC keyed by the region, so the region can only be named
by recomputing the code for a candidate - here the radio's own default flood
scope (:func:`read_default_flood_scope`), and nothing else.  No region key is
ever posted or logged.
"""

from __future__ import annotations

import hashlib
import hmac
import time
from collections import deque
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from ... import config
from .messages import _normalize_path

RX_LOG_INDEX_MAX_ENTRIES = 256
"""Most ``GRP_TXT`` copies the index holds; the oldest is evicted first."""

RX_LOG_INDEX_MAX_AGE_SECS = 300.0
"""Seconds an indexed copy stays matchable after it was heard."""

SCOPE_UNSCOPED = "*"
"""``scope`` of a message delivered by a plain, unscoped ``FLOOD``.

The same token the firmware uses for its wildcard (null) region.
"""

SCOPE_UNKNOWN = "?"
"""``scope`` of a scoped flood whose region the ingestor cannot name.

Reserved: ``?`` is not a legal region-name character in the firmware
(``RegionMap::is_name_char``), so it never collides with a real region.
"""

_ROUTE_TYPE_TRANSPORT_FLOOD = 0
"""Firmware ``ROUTE_TYPE_TRANSPORT_FLOOD``: a flood carrying transport codes."""

_ROUTE_TYPE_FLOOD = 1
"""Firmware ``ROUTE_TYPE_FLOOD``: a plain flood without transport codes."""

_FLOOD_ROUTE_TYPES = frozenset({_ROUTE_TYPE_TRANSPORT_FLOOD, _ROUTE_TYPE_FLOOD})
"""Route types whose ``path_len`` is a hop count.

The firmware reports a direct-routed message's ``path_len`` as ``0xFF``, so
only flood copies can match a message by hop count.
"""

_PAYLOAD_TYPE_GRP_TXT = 0x05
"""Firmware ``PAYLOAD_TYPE_GRP_TXT``: a group-channel text message."""

_REGION_KEY_BYTES = 16
"""Length of a region transport key (``TransportKey::key``)."""


@dataclass(frozen=True)
class RxCopy:
    """One received flood copy of a channel message, taken from an RX-log frame.

    Attributes:
        msg_hash: Library hash of the decrypted message (``SHA256`` of the
            sender timestamp and text, first four bytes, little-endian).
        hops: Repeater hops the copy travelled (``path_len`` of the frame).
        route_type: Firmware route type, ``0`` (scoped) or ``1`` (plain).
        path: Lowercase hex repeater hashes in travel order, or ``None`` for
            a copy heard straight from the sender.
        rssi: Reception RSSI in dBm, or ``None`` when the frame lacked it.
        code0: On-air bytes of ``transport_codes[0]``; empty for a plain flood.
        payload: Encrypted packet payload, kept to recompute the code.
        seen_at: :attr:`RxLogIndex.clock` reading when the copy was indexed.
    """

    msg_hash: int
    hops: int
    route_type: int
    path: str | None
    rssi: int | None
    code0: bytes
    payload: bytes
    seen_at: float


def _as_int(value: object) -> int | None:
    """Return *value* when it is a real ``int``, otherwise ``None``.

    Parameters:
        value: Untyped payload field.

    Returns:
        The integer, or ``None`` for absent values, booleans and non-integers.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _code0(transport_code: object) -> bytes:
    """Return the two on-air bytes of ``transport_codes[0]``.

    Parameters:
        transport_code: The parser's ``transport_code`` field, the hex string
            of both transport codes, or ``None`` for a plain flood.

    Returns:
        The first two bytes, or ``b""`` when absent or malformed.
    """
    if not isinstance(transport_code, str):
        return b""
    try:
        return bytes.fromhex(transport_code)[:2]
    except ValueError:
        return b""


class RxLogIndex:
    """Bounded, arrival-ordered index of hashed ``GRP_TXT`` flood copies (SC2).

    Holds at most :data:`RX_LOG_INDEX_MAX_ENTRIES` copies, each for at most
    :data:`RX_LOG_INDEX_MAX_AGE_SECS`.  Only the ``meshcore`` event loop's
    thread touches it, so it needs no lock.
    """

    def __init__(
        self,
        *,
        max_entries: int = RX_LOG_INDEX_MAX_ENTRIES,
        max_age: float = RX_LOG_INDEX_MAX_AGE_SECS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """Create an empty index.

        Parameters:
            max_entries: Capacity; the oldest copy is evicted beyond it.
            max_age: Seconds after which a copy expires.
            clock: Monotonic clock, injectable for tests.
        """
        self._entries: deque[RxCopy] = deque()
        self._max_entries = max_entries
        self._max_age = max_age
        self.clock = clock

    def __len__(self) -> int:
        """Return the number of copies held, expired ones included."""
        return len(self._entries)

    def add(self, frame: Mapping) -> bool:
        """Index one ``RX_LOG_DATA`` payload when it is a hashed flood copy.

        Parameters:
            frame: The library's RX-log payload.

        Returns:
            ``True`` when the frame was indexed; ``False`` for any other
            payload type, a direct route, or a frame the library could not
            decrypt (no ``msg_hash``: unknown channel, or the join is off).
        """
        msg_hash = _as_int(frame.get("msg_hash"))
        hops = _as_int(frame.get("path_len"))
        route_type = frame.get("route_type")
        if (
            frame.get("payload_type") != _PAYLOAD_TYPE_GRP_TXT
            or msg_hash is None
            or hops is None
            or route_type not in _FLOOD_ROUTE_TYPES
        ):
            return False
        payload = frame.get("pkt_payload")
        now = self.clock()
        self._expire(now)
        self._entries.append(
            RxCopy(
                msg_hash=msg_hash,
                hops=hops,
                route_type=route_type,
                path=_normalize_path(frame.get("path")),
                rssi=_as_int(frame.get("rssi")),
                code0=_code0(frame.get("transport_code")),
                payload=(
                    bytes(payload) if isinstance(payload, (bytes, bytearray)) else b""
                ),
                seen_at=now,
            )
        )
        while len(self._entries) > self._max_entries:
            self._entries.popleft()
        return True

    def match(self, msg_hash: int, hops: int) -> RxCopy | None:
        """Return the earliest unexpired copy of a message with *hops* hops.

        Parameters:
            msg_hash: The message's library hash.
            hops: The message's hop count (its ``path_len``).

        Returns:
            The delivered copy, or ``None`` when no indexed copy matches.
        """
        self._expire(self.clock())
        for copy in self._entries:
            if copy.msg_hash == msg_hash and copy.hops == hops:
                return copy
        return None

    def _expire(self, now: float) -> None:
        """Drop copies older than the age limit.

        Copies are appended in arrival order, so the expired ones sit at the
        left end.

        Parameters:
            now: Current :attr:`clock` reading.
        """
        while self._entries and now - self._entries[0].seen_at > self._max_age:
            self._entries.popleft()


def scope_label(name: str) -> str:
    """Return a region name as published: without its leading ``#``.

    Parameters:
        name: Region name as the radio reports it.

    Returns:
        The name, minus one leading ``#``.
    """
    return name[1:] if name.startswith("#") else name


def region_key(name: object) -> bytes | None:
    """Return the transport key of a public hashtag region (SC3).

    Mirrors the firmware (``RegionMap::getTransportKeysFor``): ``#x`` and a
    bare ``x`` both key on ``SHA256("#x")[:16]``.

    Parameters:
        name: Region name, with or without its ``#``.

    Returns:
        The 16-byte key, or ``None`` for a non-string or empty name, the
        wildcard ``*`` (unscoped), and a private ``$`` region, whose key is
        not derivable from its name and which is therefore never named.
    """
    if not isinstance(name, str) or name == SCOPE_UNSCOPED or name.startswith("$"):
        return None
    if not scope_label(name):
        return None
    hashtag = name if name.startswith("#") else "#" + name
    return hashlib.sha256(hashtag.encode("utf-8")).digest()[:_REGION_KEY_BYTES]


def transport_code(key: bytes, payload_type: int, payload: bytes) -> bytes:
    """Recompute the on-air bytes of ``transport_codes[0]`` for a region key.

    Mirrors ``TransportKey::calcTransportCode``: the first two bytes of
    ``HMAC-SHA256(key, payload_type || payload)``, read as a little-endian
    ``uint16``, with the reserved codes ``0000`` and ``FFFF`` moved to
    ``0001`` and ``FFFE``.

    Parameters:
        key: Region key from :func:`region_key`.
        payload_type: Packet payload type.
        payload: Packet payload bytes.

    Returns:
        Two little-endian bytes, comparable with :attr:`RxCopy.code0`.
    """
    digest = hmac.new(key, bytes([payload_type]) + payload, hashlib.sha256).digest()
    code = int.from_bytes(digest[:2], "little")
    if code == 0x0000:
        code = 0x0001
    elif code == 0xFFFF:
        code = 0xFFFE
    return code.to_bytes(2, "little")


def resolve_scope(copy: RxCopy, region: str | None) -> str | None:
    """Name the flood scope of a delivered copy (SC4).

    Parameters:
        copy: The delivered copy.
        region: The radio's default flood scope, the only candidate (SC3).

    Returns:
        :data:`SCOPE_UNSCOPED` for a plain flood; the region name without its
        ``#`` when *region* reproduces the copy's transport code;
        :data:`SCOPE_UNKNOWN` for any other scoped flood; ``None`` for a route
        type that is not a flood.
    """
    if copy.route_type == _ROUTE_TYPE_FLOOD:
        return SCOPE_UNSCOPED
    if copy.route_type != _ROUTE_TYPE_TRANSPORT_FLOOD:
        return None
    key = region_key(region)
    if (
        key is not None
        and transport_code(key, _PAYLOAD_TYPE_GRP_TXT, copy.payload) == copy.code0
    ):
        return scope_label(region)
    return SCOPE_UNKNOWN


def message_hash(sender_ts: object, text: object) -> int | None:
    """Recompute the library's message hash for a channel message.

    The ``CHANNEL_MSG_RECV_V3`` event carries it as ``txt_hash`` while the
    join is on; the older ``CHANNEL_MSG_RECV`` event does not, so the hash is
    rebuilt from the same inputs: ``SHA256(sender_ts || text)``, first four
    bytes, little-endian.

    Parameters:
        sender_ts: Sender timestamp from the event.
        text: Message text from the event.

    Returns:
        The 32-bit hash, or ``None`` when either input is unusable.
    """
    ts = _as_int(sender_ts)
    if ts is None or not 0 <= ts <= 0xFFFFFFFF or not isinstance(text, str):
        return None
    data = ts.to_bytes(4, "little") + text.encode("utf-8", "surrogatepass")
    return int.from_bytes(hashlib.sha256(data).digest()[:4], "little")


class RouteTracker:
    """Per-connection route state: the RX-log index and the scope candidate.

    Attributes:
        index: The :class:`RxLogIndex` fed by ``RX_LOG_DATA``.
        region: The radio's default flood scope name as read after connect,
            or ``None`` when unset, unsupported or not read yet.
    """

    def __init__(self, index: RxLogIndex | None = None) -> None:
        """Create the tracker.

        Parameters:
            index: Index to use; a default-sized one when omitted.
        """
        self.index = index if index is not None else RxLogIndex()
        self.region: str | None = None

    def observe(self, frame: Mapping) -> None:
        """Index an ``RX_LOG_DATA`` payload (only hashed flood copies stick).

        Parameters:
            frame: The library's RX-log payload.
        """
        self.index.add(frame)

    def channel_route(self, payload: Mapping, hops: int | None) -> dict:
        """Return the route fields of a channel message from its delivered copy.

        The library's own join fields on *payload* (``path``, ``RSSI``) come
        from the newest copy and are ignored.

        Parameters:
            payload: ``CHANNEL_MSG_RECV`` payload.
            hops: The message's normalized hop count; ``None`` (direct route,
                or no ``path_len``) never matches.

        Returns:
            ``{"path", "rssi", "scope"}`` from the delivered copy, or an empty
            dict when no indexed copy matches (frame never logged, expired,
            or the join is off).
        """
        if hops is None:
            return {}
        msg_hash = _as_int(payload.get("txt_hash"))
        if msg_hash is None:
            msg_hash = message_hash(
                payload.get("sender_timestamp"), payload.get("text")
            )
        if msg_hash is None:
            return {}
        copy = self.index.match(msg_hash, hops)
        if copy is None:
            return {}
        return {
            "path": copy.path,
            "rssi": copy.rssi,
            "scope": resolve_scope(copy, self.region),
        }


def without_decrypted_text(frame: Mapping) -> dict:
    """Return an RX-log payload minus the library-decrypted ``message`` (SC8).

    With the join on, the library adds every decrypted channel text to the
    RX-log payload - hidden channels included.  The ``DEBUG=1`` capture keeps
    the frame's metadata but never that text.

    Parameters:
        frame: The library's RX-log payload.

    Returns:
        A shallow copy without the ``message`` key.
    """
    return {key: value for key, value in frame.items() if key != "message"}


def enable_rx_log_join(mc: object) -> bool:
    """Turn on the library's RX-log decryption (SC1).

    ``meshcore`` exposes the switch as ``set_decrypt_channel_logs``; a library
    without it still connects, and channel messages then carry no path, RSSI
    or scope.

    Parameters:
        mc: ``MeshCore`` instance, before ``connect()``.

    Returns:
        ``True`` when the join was enabled.
    """
    setter = getattr(mc, "set_decrypt_channel_logs", None)
    if not callable(setter):
        config._debug_log(
            "meshcore library cannot decrypt channel RX-log frames; "
            "channel messages carry no path, RSSI or scope",
            context="meshcore.rx_log_join",
            severity="warning",
            always=True,
        )
        return False
    setter(True)
    return True


async def read_default_flood_scope(mc: object) -> str | None:
    """Read the radio's default flood scope name (SC3).

    A companion-link read (``CMD_GET_DEFAULT_FLOOD_SCOPE``), never a
    transmission.  Firmware before 1.15 answers ``ERROR``; a radio without a
    default scope answers an empty frame.  The reply's region key is ignored:
    resolution recomputes the key from the name.

    Parameters:
        mc: Connected ``MeshCore`` instance.

    Returns:
        The region name as stored on the radio, or ``None``.
    """
    evt = await mc.commands.get_default_flood_scope()
    payload = getattr(evt, "payload", None)
    name = payload.get("scope_name") if isinstance(payload, Mapping) else None
    region = name if isinstance(name, str) and name else None
    config._debug_log(
        "MeshCore default flood scope read",
        context="meshcore.scope",
        scope=scope_label(region) if region_key(region) is not None else None,
    )
    return region


__all__ = [
    "RX_LOG_INDEX_MAX_AGE_SECS",
    "RX_LOG_INDEX_MAX_ENTRIES",
    "SCOPE_UNKNOWN",
    "SCOPE_UNSCOPED",
    "RouteTracker",
    "RxCopy",
    "RxLogIndex",
    "enable_rx_log_join",
    "message_hash",
    "read_default_flood_scope",
    "region_key",
    "resolve_scope",
    "scope_label",
    "transport_code",
    "without_decrypted_text",
]
