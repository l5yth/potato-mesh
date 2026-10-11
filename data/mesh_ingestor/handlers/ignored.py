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

"""Debug-mode capture of ignored packets, metadata only (SPEC DC1-DC3).

When :data:`config.DEBUG` is set the ingestor appends a JSON line for each
packet it drops (unsupported port, missing fields, a filtered channel, a
direct message, etc.) to a plain-text log file.  A line holds the drop
reason and the packet metadata :data:`_CAPTURE_FIELDS` lists, and nothing
else: never the text, the payload, the meshtastic library's ``raw`` packet,
other decoded content or a position's coordinates.  The file rotates at
:data:`_IGNORED_PACKET_LOG_MAX_BYTES` and keeps one previous file, so the
capture never fills a disk.  This aids offline debugging without adding
overhead in production.
"""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO

try:
    import fcntl
except ImportError:  # pragma: no cover - not POSIX: rotation is per process
    fcntl = None

from .. import config
from ..serialization import _canonical_node_id, _extract_payload_bytes, _first
from .sender import _packet_sender

_IGNORED_PACKET_LOG_PATH = (
    Path(__file__).resolve().parents[3] / "ignored-meshtastic.txt"
)
"""Filesystem path that stores ignored-packet metadata when debug mode is active."""

_IGNORED_PACKET_LOG_MAX_BYTES = 10_000_000
"""Size in bytes at which :data:`_IGNORED_PACKET_LOG_PATH` rotates (SPEC DC2).

The write that takes the file to this size renames it to the same name with
``.1`` appended, replacing the previous one, so the capture holds at most two
files of about this size."""

_IGNORED_PACKET_LOCK = threading.Lock()
"""Lock serialising appends to, and rotations of, :data:`_IGNORED_PACKET_LOG_PATH`."""

_LINE_ENCODER = json.JSONEncoder(ensure_ascii=False, sort_keys=True)
"""Encoder for capture lines, built once: ``json.dumps`` with these options
builds a new encoder on every call (SPEC DC3)."""


def _payload_size(packet: Mapping, decoded: Mapping) -> int | None:
    """Return the byte length of ``packet``'s payload, never the payload itself.

    The decoded payload counts first (raw bytes from the meshtastic library,
    Base64 from the UDP transport), then the ciphertext of a packet the radio
    could not decrypt, then the UTF-8 length of a handler-built text: a
    MeshCore message carries no payload bytes.

    Parameters:
        packet: Packet mapping, as the handlers receive it.
        decoded: The packet's ``decoded`` section, or ``{}``.

    Returns:
        The size in bytes, or ``None`` when the packet carries no payload.
    """

    payload = _extract_payload_bytes(decoded)
    if payload is None:
        payload = _extract_payload_bytes({"payload": _first(packet, "encrypted")})
    if payload is not None:
        return len(payload)
    text = decoded.get("text")
    if isinstance(text, str):
        return len(text.encode("utf-8", errors="replace"))
    return None


_CAPTURE_FIELDS: dict[str, Callable[[Mapping, Mapping], object]] = {
    "id": lambda packet, _decoded: _first(packet, "id", "packet_id", "packetId"),
    "rx_time": lambda packet, _decoded: _first(packet, "rxTime", "rx_time"),
    # The sender the handlers use: the numeric header ``from`` (SPEC NI1).
    "from_id": lambda packet, _decoded: _canonical_node_id(_packet_sender(packet)),
    "to_id": lambda packet, _decoded: _canonical_node_id(
        _first(packet, "toId", "to_id", "to")
    ),
    # The index the CF2 gate reads, or the channel hash of a packet the radio
    # could not decrypt.  Absent on a packet the meshtastic library delivers
    # from index 0 (proto3 omits it); UDP and MeshCore packets carry 0.
    "channel": lambda packet, decoded: _first(
        decoded, "channel", default=_first(packet, "channel")
    ),
    "portnum": lambda _packet, decoded: _first(decoded, "portnum"),
    "payload_size": _payload_size,
}
"""The capture's allowlist (SPEC DC1): every field a line may hold, in DC1's
order, with the function that reads it from ``(packet, decoded)``.

The capture never copies the packet, so a field a library or a handler adds
later stays out of the file until it is listed here.  A value that is not a
string or a number is left out as well."""


def _packet_metadata(packet: Mapping | object) -> dict:
    """Return ``packet``'s metadata: the :data:`_CAPTURE_FIELDS` values only.

    The capture writes it (DC1) and the DEBUG log lines that describe a
    packet print it (SPEC DC7), so neither can show the packet's content.

    Parameters:
        packet: Packet object or mapping.

    Returns:
        Each :data:`_CAPTURE_FIELDS` value that is a string or a number.
    """

    decoded = _first(packet, "decoded", default=None)
    if not isinstance(decoded, Mapping):
        decoded = {}
    metadata: dict = {}
    for name, read in _CAPTURE_FIELDS.items():
        value = read(packet, decoded)
        if isinstance(value, (str, int, float)):
            metadata[name] = value
    return metadata


def _capture_entry(packet: Mapping | object, reason: str) -> dict:
    """Return the line the capture writes for ``packet``: metadata only (DC1).

    Parameters:
        packet: Packet object or mapping that was dropped.
        reason: Why the packet was dropped.

    Returns:
        The capture time, ``reason`` and :func:`_packet_metadata`.
    """

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "reason": reason,
        **_packet_metadata(packet),
    }


def _open_for_append(path: Path) -> BinaryIO:
    """Open ``path`` for appending, creating its directory only when missing.

    Parameters:
        path: The capture file.

    Returns:
        The file opened in binary append mode.
    """

    try:
        return open(path, "ab")
    except FileNotFoundError:
        path.parent.mkdir(parents=True, exist_ok=True)
        return open(path, "ab")


def _rotated_while_waiting(path: Path, handle: BinaryIO) -> bool:
    """Return whether another process rotated the file this one has locked.

    A process sharing the checkout rotates a full file under its lock, so a
    writer that opened the file before and waited for the lock then holds the
    rotated file: full, and no longer the file at ``path`` (DC2).  Only a full
    file costs a look at ``path``.

    Parameters:
        path: The capture file.
        handle: The file this process opened and locked.

    Returns:
        ``True`` when ``handle`` is full and ``path`` names another file or none.
    """

    opened = os.fstat(handle.fileno())
    if opened.st_size < _IGNORED_PACKET_LOG_MAX_BYTES:
        return False
    try:
        current = os.stat(path)
    except FileNotFoundError:
        return True
    return (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino)


def _rotate(path: Path) -> None:
    """Rename the full file at ``path`` to ``path`` + ``.1``, replacing it (DC2).

    A refused rename is no error and leaves the file in place, so the next
    write tries again: Windows refuses while any process holds the file open
    (``PermissionError``), and a file already gone has nothing to move.

    Parameters:
        path: The capture file.
    """

    try:
        os.replace(path, path.with_name(f"{path.name}.1"))
    except (FileNotFoundError, PermissionError):
        pass


def _append_line(path: Path, line: bytes) -> None:
    """Append ``line`` to ``path`` and rotate the file once it is full (DC2).

    Both ``DEBUG=1`` captures write through it: this module's file and the
    MeshCore one, ``ignored-meshcore.txt``.  The caller holds the capture's
    in-process lock.  With ``fcntl``, processes that share one checkout take
    turns on the file itself with ``flock``; a writer that finds it locked a
    file another process rotated meanwhile reopens the file now at ``path``,
    so no line lands in a rotated file, and the write that takes the file to
    :data:`_IGNORED_PACKET_LOG_MAX_BYTES` renames it to ``path`` with ``.1``
    appended, replacing the previous file, under the lock: the renamed file is
    the one it filled.  Without ``fcntl`` (not POSIX) the file is closed before
    the rename, as Windows refuses to rename an open file, and a refused rename
    is retried at the next write.  The directory is created only when it is
    missing, so a write costs no directory check (SPEC DC3).

    Parameters:
        path: The capture file.
        line: One encoded JSON line, newline included.
    """

    if fcntl is None:
        with _open_for_append(path) as handle:
            handle.write(line)
            size = handle.tell()
        if size >= _IGNORED_PACKET_LOG_MAX_BYTES:
            _rotate(path)
        return
    while True:
        with _open_for_append(path) as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            if _rotated_while_waiting(path, handle):
                continue
            handle.write(line)
            # On disk before the size read, so the size is the file's.
            handle.flush()
            if handle.tell() >= _IGNORED_PACKET_LOG_MAX_BYTES:
                _rotate(path)
            return


def _record_ignored_packet(packet: Mapping | object, *, reason: str) -> None:
    """Persist a dropped packet's metadata to :data:`_IGNORED_PACKET_LOG_PATH`.

    Does nothing when :data:`config.DEBUG` is ``False``.  Each call appends a
    single newline-delimited JSON record with a timestamp, the drop reason
    and the packet's metadata (:func:`_capture_entry`); the line is built and
    encoded before the lock is taken.

    Parameters:
        packet: Packet object or mapping to record.
        reason: Short machine-readable label describing why the packet was
            ignored (e.g. ``"unsupported-port"``, ``"missing-packet-id"``).
    """

    if not config.DEBUG:
        return

    payload = _LINE_ENCODER.encode(_capture_entry(packet, reason))
    line = f"{payload}\n".encode("utf-8")
    with _IGNORED_PACKET_LOCK:
        _append_line(_IGNORED_PACKET_LOG_PATH, line)


__all__ = [
    "_CAPTURE_FIELDS",
    "_IGNORED_PACKET_LOCK",
    "_IGNORED_PACKET_LOG_MAX_BYTES",
    "_IGNORED_PACKET_LOG_PATH",
    "_LINE_ENCODER",
    "_append_line",
    "_capture_entry",
    "_open_for_append",
    "_packet_metadata",
    "_payload_size",
    "_record_ignored_packet",
    "_rotate",
    "_rotated_while_waiting",
]
