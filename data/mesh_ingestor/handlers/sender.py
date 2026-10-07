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

"""Which node sent a packet (SPEC NI1)."""

from __future__ import annotations

from ..serialization import _canonical_node_id, _first


def _packet_sender(packet: object, *, numeric: bool = False) -> object | None:
    """Return the node that sent ``packet``, read from its header ``from``.

    A Meshtastic packet carries its sender twice: the numeric ``from`` of the
    packet header, which the radio received, and the meshtastic library's
    ``fromId``, which the library looks up in its own node database.  A
    NodeInfo naming another node used to remap that database, after which the
    library reported the sender's later packets under the other node's
    ``fromId``.  Every handler therefore takes the sender from the numeric
    ``from``.  Packets without one, such as the MeshCore packets that carry
    only ``from_id``, keep the old lookup order.

    Parameters:
        packet: Packet mapping, as the ``store_*`` handlers receive it.
        numeric: Return the node number instead of its canonical id when the
            packet carries a numeric ``from`` (the traceroute ``src`` field
            is a number).

    Returns:
        The numeric ``from`` as a canonical ``!xxxxxxxx`` id (the number
        itself with ``numeric=True``); else the packet's ``fromId``,
        ``from_id`` or non-numeric ``from``, as given; ``None`` when the
        packet names no sender.
    """

    raw_from = _first(packet, "from", default=None)
    if isinstance(raw_from, int) and not isinstance(raw_from, bool) and raw_from >= 0:
        return raw_from if numeric else _canonical_node_id(raw_from)
    return _first(packet, "fromId", "from_id", "from", default=None)


__all__ = ["_packet_sender"]
