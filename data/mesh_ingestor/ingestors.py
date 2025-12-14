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

"""Helpers for tracking ingestor identity and liveness announcements."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable

from .. import VERSION as INGESTOR_VERSION
from . import config, queue
from .serialization import _canonical_node_id

HEARTBEAT_INTERVAL_SECS = 60 * 60
"""Default interval between ingestor heartbeat announcements."""


@dataclass
class _IngestorState:
    """Mutable ingestor identity and heartbeat tracking data."""

    start_time: int = field(default_factory=lambda: int(time.time()))
    last_heartbeat: int | None = None
    node_id: str | None = None


STATE = _IngestorState()
"""Shared ingestor identity state."""


def ingestor_start_time() -> int:
    """Return the unix timestamp representing when the ingestor booted."""

    return STATE.start_time


def set_ingestor_node_id(node_id: str | None) -> str | None:
    """Record the canonical host node identifier for the ingestor.

    Parameters:
        node_id: Raw node identifier reported by the connected device.

    Returns:
        Canonical node identifier in ``!xxxxxxxx`` form or ``None`` when the
        provided value cannot be normalised.
    """

    canonical = _canonical_node_id(node_id)
    if canonical is None:
        return None

    if STATE.node_id != canonical:
        STATE.node_id = canonical
        STATE.last_heartbeat = None

    return canonical


def queue_ingestor_heartbeat(
    *,
    force: bool = False,
    send: Callable[[str, dict], None] | None = None,
    node_id: str | None = None,
) -> bool:
    """Queue a heartbeat payload advertising ingestor liveness.

    Parameters:
        force: When ``True``, bypasses the heartbeat interval guard so an
            announcement is queued immediately.
        send: Optional transport callable used for tests; defaults to the queue
            dispatcher.
        node_id: Optional node identifier to register before sending. When
            omitted the previously recorded identifier is reused.

    Returns:
        ``True`` when a heartbeat payload was queued, ``False`` otherwise.
    """

    canonical = _canonical_node_id(node_id) if node_id is not None else None
    if canonical:
        set_ingestor_node_id(canonical)
    canonical = STATE.node_id

    if canonical is None:
        return False

    now = int(time.time())
    interval = max(
        0, int(getattr(config, "_INGESTOR_HEARTBEAT_SECS", HEARTBEAT_INTERVAL_SECS))
    )
    last = STATE.last_heartbeat
    if not force and last is not None and now - last < interval:
        return False

    payload = {
        "node_id": canonical,
        "start_time": STATE.start_time,
        "last_seen_time": now,
        "version": INGESTOR_VERSION,
    }
    queue._queue_post_json(
        "/api/ingestors",
        payload,
        priority=getattr(
            queue, "_INGESTOR_POST_PRIORITY", queue._DEFAULT_POST_PRIORITY
        ),
        send=send,
    )
    STATE.last_heartbeat = now
    return True


__all__ = [
    "HEARTBEAT_INTERVAL_SECS",
    "STATE",
    "ingestor_start_time",
    "queue_ingestor_heartbeat",
    "set_ingestor_node_id",
]
