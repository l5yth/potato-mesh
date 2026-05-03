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

"""Sender-side fingerprinting and parsing helpers for MeshCore messages."""

from __future__ import annotations

import hashlib
import time

from ._constants import _MENTION_RE, _MESHCORE_ID_MASK


def _derive_message_id(
    sender_identity: str,
    sender_ts: int,
    discriminator: str,
    text: str,
) -> int:
    """Derive a stable 53-bit message ID from sender-side MeshCore fields.

    MeshCore does not assign firmware-side packet IDs.  This function produces
    a deterministic 53-bit integer fingerprint of a physical transmission so
    that the same packet heard by multiple ingestors collapses to a single
    ``messages`` row via the ``messages.id`` PRIMARY KEY upsert path.  Every
    component of the fingerprint is sender-side, ensuring two receivers with
    different clocks or roster state still compute the same value.

    Parameters:
        sender_identity: Stable sender identifier shared across receivers.
            For channel messages this is the lowercased+stripped sender name
            parsed from the message text via :func:`_parse_sender_name`; for
            direct messages it is the sender's MeshCore ``pubkey_prefix``.
            Must be a string (use ``""`` when unavailable).
        sender_ts: Unix timestamp from the sender's clock (identical across
            receivers regardless of receiver-side clock skew).
        discriminator: Namespace tag separating message classes that could
            otherwise collide.  ``"c<N>"`` is reserved for channel messages
            on channel ``N``; ``"dm"`` is reserved for direct messages.
        text: Message text exactly as transmitted by the sender.

    Returns:
        A non-negative 53-bit integer suitable for the ``id`` column.  The
        value is bounded by ``0 <= id <= (1 << 53) - 1`` so it survives the
        JSON → JavaScript number round-trip without precision loss.
    """
    # The ``v1:`` prefix lets us evolve the fingerprint format (e.g. add a
    # channel-secret hash) by bumping to ``v2:`` without colliding with
    # existing ids written under the v1 scheme.
    fingerprint = f"v1:{sender_identity}:{sender_ts}:{discriminator}:{text}"
    digest = hashlib.sha256(fingerprint.encode("utf-8", errors="replace")).digest()
    return int.from_bytes(digest[:7], "big") & _MESHCORE_ID_MASK


def _parse_sender_name(text: str) -> str | None:
    """Extract the sender name from a MeshCore channel message text.

    MeshCore channel messages use the convention ``"SenderName: body"``.
    Only the first colon is treated as the separator; colons that appear in the
    body are preserved.  The sender name is stripped of leading and trailing
    whitespace.

    Parameters:
        text: Raw message text as stored in the database.

    Returns:
        Stripped sender name string, or ``None`` when the text does not
        contain a colon or the portion before the colon is blank.
    """
    colon_idx = text.find(":")
    if colon_idx < 0:
        return None
    name = text[:colon_idx].strip()
    return name if name else None


def _extract_mention_names(text: str) -> list[str]:
    """Extract all ``@[Name]`` mention names from a MeshCore message body.

    Parameters:
        text: Raw message text that may contain ``@[Name]`` mention patterns.

    Returns:
        List of extracted name strings (may be empty).
    """
    return _MENTION_RE.findall(text)


def _synthetic_node_dict(long_name: str) -> dict:
    """Build a synthetic node dict for an unknown MeshCore channel sender.

    Synthetic nodes are placeholder entries created when a channel message
    arrives from a sender who is not yet in the connected device's contacts
    roster.  They carry ``role=COMPANION`` (the only role capable of sending
    channel messages).  The short name is intentionally omitted here — the
    Ruby web app derives it at query time via
    ``meshcore_companion_display_short_name`` for all COMPANION nodes.

    When the real contact advertisement is later received, the Ruby web app
    detects the matching long name, migrates all messages from the synthetic
    node ID to the real one, and removes the placeholder row.

    Parameters:
        long_name: Sender name parsed from the ``"SenderName: body"`` prefix.

    Returns:
        Node dict compatible with the ``POST /api/nodes`` payload format,
        with ``user.synthetic`` set to ``True``.
    """
    return {
        "lastHeard": int(time.time()),
        "protocol": "meshcore",
        "user": {
            "longName": long_name,
            "shortName": "",
            "role": "COMPANION",
            "synthetic": True,
        },
    }
