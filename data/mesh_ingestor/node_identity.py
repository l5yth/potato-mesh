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

"""Node identity helpers shared across ingestor providers.

The web application keys nodes by a canonical textual identifier of the form
``!%08x`` (lowercase hex). Both the Python collector and Ruby server accept
several input forms (ints, ``0x`` hex strings, ``!`` hex strings, decimal
strings). This module centralizes that normalization.

"""

from __future__ import annotations

from typing import Final

CANONICAL_PREFIX: Final[str] = "!"


def canonical_node_id(value: object) -> str | None:
    """Convert ``value`` into canonical ``!xxxxxxxx`` form.

    Parameters:
        value: Node reference which may be an int, float, or string.

    Returns:
        Canonical node id string or ``None`` when parsing fails.
    """

    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            num = int(value)
        except (TypeError, ValueError):
            return None
        if num < 0:
            return None
        return f"{CANONICAL_PREFIX}{num & 0xFFFFFFFF:08x}"
    if not isinstance(value, str):
        return None

    trimmed = value.strip()
    if not trimmed:
        return None
    if trimmed.startswith("^"):
        # Meshtastic special destinations like "^all" are not node ids; callers
        # that already accept them should keep passing them through unchanged.
        return trimmed
    if trimmed.startswith(CANONICAL_PREFIX):
        body = trimmed[1:]
    elif trimmed.lower().startswith("0x"):
        body = trimmed[2:]
    elif trimmed.isdigit():
        try:
            return f"{CANONICAL_PREFIX}{int(trimmed, 10) & 0xFFFFFFFF:08x}"
        except ValueError:
            return None
    else:
        body = trimmed

    if not body:
        return None
    try:
        return f"{CANONICAL_PREFIX}{int(body, 16) & 0xFFFFFFFF:08x}"
    except ValueError:
        return None


def node_num_from_id(node_id: object) -> int | None:
    """Extract the numeric node identifier from a canonical (or near-canonical) id."""

    if node_id is None:
        return None
    if isinstance(node_id, (int, float)):
        try:
            num = int(node_id)
        except (TypeError, ValueError):
            return None
        return num if num >= 0 else None
    if not isinstance(node_id, str):
        return None

    trimmed = node_id.strip()
    if not trimmed:
        return None
    if trimmed.startswith(CANONICAL_PREFIX):
        trimmed = trimmed[1:]
    if trimmed.lower().startswith("0x"):
        trimmed = trimmed[2:]
    try:
        return int(trimmed, 16)
    except ValueError:
        try:
            return int(trimmed, 10)
        except ValueError:
            return None


__all__ = [
    "CANONICAL_PREFIX",
    "canonical_node_id",
    "node_num_from_id",
]
