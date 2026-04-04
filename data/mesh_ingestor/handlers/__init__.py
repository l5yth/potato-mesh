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

"""Packet handlers that serialise mesh data and push it to the HTTP queue.

This package is organised into focused submodules:

- :mod:`._state` — shared mutable state (host node ID, packet timestamps)
- :mod:`.radio` — radio metadata enrichment helpers
- :mod:`.ignored` — debug-mode logging of dropped packets
- :mod:`.position` — GPS position and traceroute handlers
- :mod:`.telemetry` — device/environment telemetry and router heartbeat handlers
- :mod:`.nodeinfo` — node information update handler
- :mod:`.neighborinfo` — neighbour topology snapshot handler
- :mod:`.generic` — packet dispatcher, node upsert, and the main receive callback

All public names from the original flat ``handlers`` module are re-exported
here so existing callers (e.g. ``daemon.py``, ``providers/``) require no
changes.
"""

from __future__ import annotations

from .. import queue as _queue
from ._state import (
    host_node_id,
    last_packet_monotonic,
    register_host_node_id,
)
from .generic import (
    _is_encrypted_flag,
    _portnum_candidates,
    on_receive,
    store_packet_dict,
    upsert_node,
)
from .ignored import (
    _IGNORED_PACKET_LOCK,
    _IGNORED_PACKET_LOG_PATH,
    _record_ignored_packet,
)
from .neighborinfo import store_neighborinfo_packet
from .nodeinfo import store_nodeinfo_packet
from .position import (
    _normalize_trace_hops,
    base64_payload,
    store_position_packet,
    store_traceroute_packet,
)
from .radio import (
    _apply_radio_metadata,
    _apply_radio_metadata_to_nodes,
    _radio_metadata_fields,
)
from .telemetry import (
    _VALID_TELEMETRY_TYPES,
    store_router_heartbeat_packet,
    store_telemetry_packet,
)

# Re-export the queue alias for any callers that reference handlers._queue_post_json
_queue_post_json = _queue._queue_post_json

__all__ = [
    "_IGNORED_PACKET_LOCK",
    "_IGNORED_PACKET_LOG_PATH",
    "_VALID_TELEMETRY_TYPES",
    "_apply_radio_metadata",
    "_apply_radio_metadata_to_nodes",
    "_is_encrypted_flag",
    "_normalize_trace_hops",
    "_portnum_candidates",
    "_queue_post_json",
    "_radio_metadata_fields",
    "_record_ignored_packet",
    "base64_payload",
    "host_node_id",
    "last_packet_monotonic",
    "on_receive",
    "register_host_node_id",
    "store_neighborinfo_packet",
    "store_nodeinfo_packet",
    "store_packet_dict",
    "store_position_packet",
    "store_router_heartbeat_packet",
    "store_telemetry_packet",
    "store_traceroute_packet",
    "upsert_node",
]
