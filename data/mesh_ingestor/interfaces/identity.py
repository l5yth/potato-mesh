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

"""Mapping/identifier helpers for Meshtastic interface objects."""

from __future__ import annotations

import contextlib
import re
from collections.abc import Mapping
from typing import Any

from .. import serialization


def _ensure_mapping(value) -> Mapping | None:
    """Return ``value`` as a mapping when conversion is possible."""

    if isinstance(value, Mapping):
        return value
    if hasattr(value, "__dict__") and isinstance(value.__dict__, Mapping):
        return value.__dict__
    with contextlib.suppress(Exception):
        converted = serialization._node_to_dict(value)
        if isinstance(converted, Mapping):
            return converted
    return None


def _is_nodeish_identifier(value: Any) -> bool:
    """Return ``True`` when ``value`` resembles a Meshtastic node identifier."""

    if isinstance(value, (int, float)):
        return False
    if not isinstance(value, str):
        return False

    trimmed = value.strip()
    if not trimmed:
        return False
    if trimmed.startswith("^"):
        return True
    if trimmed.startswith("!"):
        trimmed = trimmed[1:]
    elif trimmed.lower().startswith("0x"):
        trimmed = trimmed[2:]
    elif not re.search(r"[a-fA-F]", trimmed):
        # Bare decimal strings should not be treated as node ids when labelled "id".
        return False

    return bool(re.fullmatch(r"[0-9a-fA-F]{1,8}", trimmed))


def _candidate_node_id(mapping: Mapping | None) -> str | None:
    """Extract a canonical node identifier from ``mapping`` when present."""

    if mapping is None:
        return None

    node_keys = (
        "fromId",
        "from_id",
        "from",
        "nodeId",
        "node_id",
        "nodeNum",
        "node_num",
        "num",
        "userId",
        "user_id",
    )

    for key in node_keys:
        with contextlib.suppress(Exception):
            node_id = serialization._canonical_node_id(mapping.get(key))
            if node_id:
                return node_id

    with contextlib.suppress(Exception):
        value = mapping.get("id")
        if _is_nodeish_identifier(value):
            node_id = serialization._canonical_node_id(value)
            if node_id:
                return node_id

    user_section = _ensure_mapping(mapping.get("user"))
    if user_section is not None:
        for key in ("userId", "user_id", "num", "nodeNum", "node_num"):
            with contextlib.suppress(Exception):
                node_id = serialization._canonical_node_id(user_section.get(key))
                if node_id:
                    return node_id
        with contextlib.suppress(Exception):
            user_id_value = user_section.get("id")
            if _is_nodeish_identifier(user_id_value):
                node_id = serialization._canonical_node_id(user_id_value)
                if node_id:
                    return node_id

    decoded_section = _ensure_mapping(mapping.get("decoded"))
    if decoded_section is not None:
        node_id = _candidate_node_id(decoded_section)
        if node_id:
            return node_id

    payload_section = _ensure_mapping(mapping.get("payload"))
    if payload_section is not None:
        node_id = _candidate_node_id(payload_section)
        if node_id:
            return node_id

    for key in ("packet", "meta", "info"):
        node_id = _candidate_node_id(_ensure_mapping(mapping.get(key)))
        if node_id:
            return node_id

    for value in mapping.values():
        if isinstance(value, (list, tuple)):
            for item in value:
                node_id = _candidate_node_id(_ensure_mapping(item))
                if node_id:
                    return node_id
        else:
            node_id = _candidate_node_id(_ensure_mapping(value))
            if node_id:
                return node_id

    return None


def _extract_host_node_id(iface) -> str | None:
    """Return the canonical node identifier for the connected host device.

    Searches a sequence of well-known attribute names (``myInfo``,
    ``my_node_info``, etc.) on ``iface`` for a mapping that contains a
    recognisable node identifier, then falls back to the raw ``myNodeNum``
    integer attribute.

    Parameters:
        iface: Live Meshtastic interface object, or any object that exposes
            node-identity attributes in one of the expected forms.

    Returns:
        A canonical ``!xxxxxxxx`` node identifier, or ``None`` when no
        identifiable host node information is available.
    """

    if iface is None:
        return None

    def _as_mapping(candidate) -> Mapping | None:
        mapping = _ensure_mapping(candidate)
        if mapping is not None:
            return mapping
        if callable(candidate):
            with contextlib.suppress(Exception):
                return _ensure_mapping(candidate())
        return None

    candidates: list[Mapping] = []
    for attr in ("myInfo", "my_node_info", "myNodeInfo", "my_node", "localNode"):
        mapping = _as_mapping(getattr(iface, attr, None))
        if mapping is None:
            continue
        candidates.append(mapping)
        nested_info = _ensure_mapping(mapping.get("info"))
        if nested_info:
            candidates.append(nested_info)

    for mapping in candidates:
        node_id = _candidate_node_id(mapping)
        if node_id:
            return node_id
        for key in ("myNodeNum", "my_node_num", "myNodeId", "my_node_id"):
            node_id = serialization._canonical_node_id(mapping.get(key))
            if node_id:
                return node_id

    node_id = serialization._canonical_node_id(getattr(iface, "myNodeNum", None))
    if node_id:
        return node_id

    return None
