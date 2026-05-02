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

"""Pure helpers that derive canonical MeshCore node identifiers.

These helpers are deterministic and side-effect-free so they can be imported
from anywhere in the MeshCore package without circular concerns.
"""

from __future__ import annotations

import hashlib

from ._constants import _MESHCORE_ADV_TYPE_ROLE


def _meshcore_node_id(public_key_hex: str | None) -> str | None:
    """Derive a canonical ``!xxxxxxxx`` node ID from a MeshCore public key.

    Uses the first four bytes (eight hex characters) of the 32-byte public
    key, formatted as ``!xxxxxxxx``.

    Parameters:
        public_key_hex: 64-character lowercase hex string for the node's
            public key as returned by the MeshCore library.

    Returns:
        Canonical ``!xxxxxxxx`` node ID string, or ``None`` when the key is
        absent or too short.
    """
    if not public_key_hex or len(public_key_hex) < 8:
        return None
    return "!" + public_key_hex[:8].lower()


def _meshcore_short_name(node_id: str | None) -> str:
    """Derive a four-character short name from a canonical node ID.

    Uses the first two bytes (four hex characters) of the ``!xxxxxxxx`` node
    ID.  This keeps the short name consistent with the node ID itself — if the
    node ID is later replaced when the real public key is heard, the short name
    will update alongside it.

    Parameters:
        node_id: Canonical ``!xxxxxxxx`` node ID string (as returned by
            :func:`_meshcore_node_id`).

    Returns:
        Four lowercase hex characters (e.g. ``"cafe"``), or an empty string
        when the node ID is missing or too short.
    """
    if not node_id:
        return ""
    raw = node_id.lstrip("!")
    if len(raw) < 4:
        return ""
    return raw[:4].lower()


def _meshcore_adv_type_to_role(adv_type: object) -> str | None:
    """Map MeshCore ``ADV_TYPE_*`` (contact ``type`` / self ``adv_type``) to ingest role.

    Values match MeshCore firmware ``AdvertDataHelpers.h`` (``ADV_TYPE_CHAT``,
    ``ADV_TYPE_REPEATER``, …).  Role strings match the MeshCore palette keys
    used by the web dashboard (``COMPANION``, ``REPEATER``, …).

    Parameters:
        adv_type: Raw type byte from meshcore_py (typically ``int`` 0–4).
            Non-integer values (e.g. ``float``, ``None``) are rejected and
            return ``None``.  Future firmware type codes not yet in the mapping
            also return ``None`` until the table is updated.

    Returns:
        Uppercase role string, or ``None`` when the value is unknown or should
        not override the web default (``ADV_TYPE_NONE`` / unrecognised).
    """
    if not isinstance(adv_type, int):
        return None
    return _MESHCORE_ADV_TYPE_ROLE.get(adv_type)


def _derive_synthetic_node_id(long_name: str) -> str:
    """Derive a deterministic synthetic ``!xxxxxxxx`` node ID from a long name.

    Uses the first four bytes of SHA-256(UTF-8 encoded name), formatted as
    ``!xxxxxxxx``.  The same long name always produces the same ID across
    restarts.  The probability of collision with a real public-key-derived ID
    is ~1 in 4 billion per pair, which is negligible in practice.

    Parameters:
        long_name: Node long name used as the hash input.

    Returns:
        Canonical ``!xxxxxxxx`` node ID string.
    """
    return "!" + hashlib.sha256(long_name.encode("utf-8")).hexdigest()[:8]


def _pubkey_prefix_to_node_id(contacts: dict, pubkey_prefix: str) -> str | None:
    """Look up a canonical node ID by six-byte public-key prefix.

    Parameters:
        contacts: Mapping of full ``public_key`` hex strings to contact dicts.
        pubkey_prefix: Twelve-character hex string (six bytes) as used in
            MeshCore direct-message events.

    Returns:
        Canonical ``!xxxxxxxx`` node ID for the first matching contact, or
        ``None`` when no contact's public key starts with *pubkey_prefix*.
    """
    for pub_key in contacts:
        if pub_key.startswith(pubkey_prefix):
            return _meshcore_node_id(pub_key)
    return None
