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

"""Forward MeshCore advertised positions to ``POST /api/positions``."""

from __future__ import annotations

import hashlib
import time

from ... import queue as _queue
from ...serialization import _iso, _node_num_from_id


def _store_meshcore_position(
    node_id: str,
    lat: float,
    lon: float,
    position_time: int | None,
    ingestor: str | None,
) -> None:
    """Enqueue a ``POST /api/positions`` for a MeshCore contact's advertised position.

    MeshCore does not issue dedicated position packets; position data is embedded
    in contact advertisements.  A stable pseudo-ID is derived from the node
    identity and the position timestamp so repeated advertisements of the same
    position are idempotently de-duplicated by the web app's ``ON CONFLICT``
    clause.

    Parameters:
        node_id: Canonical ``!xxxxxxxx`` node identifier.
        lat: Latitude in decimal degrees.
        lon: Longitude in decimal degrees.
        position_time: Unix timestamp from the contact's ``last_advert`` field,
            or ``None`` to fall back to the current wall-clock time.
        ingestor: Canonical node ID of the host ingestor, or ``None``.
    """
    rx_time = int(time.time())
    pt = position_time or rx_time
    # Stable 63-bit pseudo-ID unique to (node, position_time) so that the web
    # app ON CONFLICT clause de-duplicates repeated advertisements of the same
    # position without collisions between different nodes.
    digest = hashlib.sha256(f"{node_id}:{pt}".encode()).digest()
    pos_id = int.from_bytes(digest[:8], "big") & 0x7FFFFFFFFFFFFFFF
    node_num = _node_num_from_id(node_id)
    payload = {
        "id": pos_id,
        "rx_time": rx_time,
        "rx_iso": _iso(rx_time),
        "node_id": node_id,
        "node_num": node_num,
        "from_id": node_id,
        "latitude": lat,
        "longitude": lon,
        "position_time": pt,
        "ingestor": ingestor,
    }
    _queue._queue_post_json("/api/positions", payload)
