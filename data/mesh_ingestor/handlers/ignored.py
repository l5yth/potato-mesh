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

"""Debug-mode logging of ignored Meshtastic packets.

When :data:`config.DEBUG` is set the ingestor appends a JSON record for each
packet that is filtered out (unsupported port, missing fields, disallowed
channel, etc.) to a plain-text log file.  This aids offline debugging without
adding overhead in production.
"""

from __future__ import annotations

import base64
import json
import threading
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path

from .. import config

_IGNORED_PACKET_LOG_PATH = (
    Path(__file__).resolve().parents[3] / "ignored-meshtastic.txt"
)
"""Filesystem path that stores ignored Meshtastic packets when debug mode is active."""

_IGNORED_PACKET_LOCK = threading.Lock()
"""Lock serialising concurrent appends to :data:`_IGNORED_PACKET_LOG_PATH`."""


def _ignored_packet_default(value: object) -> object:
    """Return a JSON-serialisable representation for an ignored packet value.

    Called as the ``default`` argument to :func:`json.dumps` when serialising
    ignored packet entries.  Handles container types and raw bytes so the log
    file contains readable text rather than ``repr()`` fragments.

    Parameters:
        value: Arbitrary value encountered during packet serialisation.

    Returns:
        A JSON-compatible object derived from ``value``.
    """

    if isinstance(value, (list, tuple, set)):
        return list(value)
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, Mapping):
        return {
            str(key): _ignored_packet_default(sub_value)
            for key, sub_value in value.items()
        }
    return str(value)


def _record_ignored_packet(packet: Mapping | object, *, reason: str) -> None:
    """Persist packet details to :data:`_IGNORED_PACKET_LOG_PATH` during debugging.

    Does nothing when :data:`config.DEBUG` is ``False``.  Each call appends a
    single newline-delimited JSON record with a timestamp, drop reason, and a
    sanitised copy of the packet.

    Parameters:
        packet: Packet object or mapping to record.
        reason: Short machine-readable label describing why the packet was
            ignored (e.g. ``"unsupported-port"``, ``"missing-packet-id"``).
    """

    if not config.DEBUG:
        return

    timestamp = datetime.now(timezone.utc).isoformat()
    entry = {
        "timestamp": timestamp,
        "reason": reason,
        "packet": _ignored_packet_default(packet),
    }
    payload = json.dumps(entry, ensure_ascii=False, sort_keys=True)
    with _IGNORED_PACKET_LOCK:
        _IGNORED_PACKET_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with _IGNORED_PACKET_LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(f"{payload}\n")


__all__ = [
    "_IGNORED_PACKET_LOCK",
    "_IGNORED_PACKET_LOG_PATH",
    "_ignored_packet_default",
    "_record_ignored_packet",
]
