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

"""Handler for node-information packets."""

from __future__ import annotations

import time
from collections.abc import Mapping

from .. import config, queue
from ..serialization import (
    _canonical_node_id,
    _coerce_int,
    _decode_nodeinfo_payload,
    _extract_payload_bytes,
    _first,
    _merge_mappings,
    _node_num_from_id,
    _node_to_dict,
    _nodeinfo_metrics_dict,
    _nodeinfo_position_dict,
    _nodeinfo_user_dict,
)
from . import _state
from .radio import _apply_radio_metadata_to_nodes


def store_nodeinfo_packet(packet: Mapping, decoded: Mapping) -> None:
    """Persist node information updates.

    Node info packets carry user profile data (short name, long name, hardware
    model, public key) together with optional position and device-metrics
    snapshots.  When a protobuf payload is present it is decoded first; any
    fields missing from the protobuf are filled in from the ``decoded`` dict
    so both firmware variants are handled.

    Parameters:
        packet: Raw packet metadata describing the update.
        decoded: Decoded payload that may include ``user`` and ``position``
            sections.

    Returns:
        ``None``. The node payload is merged into the API queue.
    """

    payload_bytes = _extract_payload_bytes(decoded)
    node_info = _decode_nodeinfo_payload(payload_bytes)
    decoded_user = decoded.get("user")
    user_dict = _nodeinfo_user_dict(node_info, decoded_user)

    node_info_fields = set()
    if node_info:
        node_info_fields = {field_desc.name for field_desc, _ in node_info.ListFields()}

    node_id = None
    if isinstance(user_dict, Mapping):
        node_id = _canonical_node_id(user_dict.get("id"))

    if node_id is None:
        node_id = _canonical_node_id(
            _first(packet, "fromId", "from_id", "from", default=None)
        )

    if node_id is None:
        return

    node_payload: dict = {}
    if user_dict:
        node_payload["user"] = user_dict

    # Resolve node_num from protobuf first, then decoded dict, then from the
    # canonical ID as a last resort.
    node_num = None
    if node_info and "num" in node_info_fields:
        try:
            node_num = int(node_info.num)
        except (TypeError, ValueError):
            node_num = None
    if node_num is None:
        decoded_num = decoded.get("num")
        if decoded_num is not None:
            try:
                node_num = int(decoded_num)
            except (TypeError, ValueError):
                try:
                    node_num = int(str(decoded_num).strip(), 0)
                except Exception:
                    node_num = None
    if node_num is None:
        node_num = _node_num_from_id(node_id)
    if node_num is not None:
        node_payload["num"] = node_num

    rx_time = int(_first(packet, "rxTime", "rx_time", default=time.time()))
    last_heard = None
    if node_info and "last_heard" in node_info_fields:
        try:
            last_heard = int(node_info.last_heard)
        except (TypeError, ValueError):
            last_heard = None
    if last_heard is None:
        decoded_last_heard = decoded.get("lastHeard")
        if decoded_last_heard is not None:
            try:
                last_heard = int(decoded_last_heard)
            except (TypeError, ValueError):
                last_heard = None
    if last_heard is None or last_heard < rx_time:
        last_heard = rx_time
    node_payload["lastHeard"] = last_heard

    snr = None
    if node_info and "snr" in node_info_fields:
        try:
            snr = float(node_info.snr)
        except (TypeError, ValueError):
            snr = None
    if snr is None:
        snr = _first(packet, "snr", "rx_snr", "rxSnr", default=None)
        if snr is not None:
            try:
                snr = float(snr)
            except (TypeError, ValueError):
                snr = None
    if snr is not None:
        node_payload["snr"] = snr

    hops = None
    if node_info and "hops_away" in node_info_fields:
        try:
            hops = int(node_info.hops_away)
        except (TypeError, ValueError):
            hops = None
    if hops is None:
        hops = decoded.get("hopsAway")
        if hops is not None:
            try:
                hops = int(hops)
            except (TypeError, ValueError):
                hops = None
    if hops is not None:
        node_payload["hopsAway"] = hops

    if node_info and "channel" in node_info_fields:
        try:
            node_payload["channel"] = int(node_info.channel)
        except (TypeError, ValueError):
            pass

    if node_info and "via_mqtt" in node_info_fields:
        node_payload["viaMqtt"] = bool(node_info.via_mqtt)

    if node_info and "is_favorite" in node_info_fields:
        node_payload["isFavorite"] = bool(node_info.is_favorite)
    elif "isFavorite" in decoded:
        node_payload["isFavorite"] = bool(decoded.get("isFavorite"))

    if node_info and "is_ignored" in node_info_fields:
        node_payload["isIgnored"] = bool(node_info.is_ignored)
    if node_info and "is_key_manually_verified" in node_info_fields:
        node_payload["isKeyManuallyVerified"] = bool(node_info.is_key_manually_verified)

    metrics = _nodeinfo_metrics_dict(node_info)
    decoded_metrics = decoded.get("deviceMetrics")
    if isinstance(decoded_metrics, Mapping):
        metrics = _merge_mappings(metrics, _node_to_dict(decoded_metrics))
    if metrics:
        node_payload["deviceMetrics"] = metrics

    position = _nodeinfo_position_dict(node_info)
    decoded_position = decoded.get("position")
    if isinstance(decoded_position, Mapping):
        position = _merge_mappings(position, _node_to_dict(decoded_position))
    if position:
        node_payload["position"] = position

    hop_limit = _first(packet, "hopLimit", "hop_limit", default=None)
    if hop_limit is not None and "hopLimit" not in node_payload:
        try:
            node_payload["hopLimit"] = int(hop_limit)
        except (TypeError, ValueError):
            pass

    nodes_payload = _apply_radio_metadata_to_nodes({node_id: node_payload})
    nodes_payload["ingestor"] = _state.host_node_id()
    queue._queue_post_json(
        "/api/nodes",
        nodes_payload,
        priority=queue._NODE_POST_PRIORITY,
    )

    if config.DEBUG:
        short = None
        long_name = None
        if isinstance(user_dict, Mapping):
            short = user_dict.get("shortName")
            long_name = user_dict.get("longName")
        config._debug_log(
            "Queued nodeinfo payload",
            context="handlers.store_nodeinfo",
            node_id=node_id,
            short_name=short,
            long_name=long_name,
        )


__all__ = ["store_nodeinfo_packet"]
