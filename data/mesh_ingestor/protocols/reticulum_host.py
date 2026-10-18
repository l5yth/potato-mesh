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
"""The Reticulum host's identity when RNS no longer answers for it (SPEC HI1-HI5).

On a shared-instance client ``RNS.Identity.recall`` reads the ingestor's own
``known_destinations``, and RNS's clean drops every entry that process has no
path to and never used, 5 minutes after it attaches (ACCEPTANCE Known gap
RE-G1).  The provider therefore remembers what it learned, as a fallback only:
an answer from RNS, or a live 0-hop announce, always replaces it.  A full
32-hex ``INGESTOR_NODE_ID`` names the host identity, and gives way to the one
discovery elects while the pinned identity fronts none of the announce
aspects here.

No RNS call is made here.  :mod:`.reticulum` asks RNS and hands the answers in,
so the test fakes that patch its ``RNS`` name keep working.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Callable, Iterable

from .. import config, handlers

MEMORY_LIMIT = 64
"""Most local destinations remembered; the least recently used goes first.

Only 0-hop destinations are learned, and a host announces a handful.
"""

_HEX_DIGITS = frozenset("0123456789abcdef")
"""The characters of a lowercase hex string."""


class IdentityMemory:
    """Bounded, thread-safe memory of local destination to identity and name.

    A fallback only: the provider consults it for a destination only when RNS
    has no answer, and every fresh answer replaces what it holds (SPEC HI2).
    Keys and identities are lowercase hex.  The announce handler writes from
    RNS's threads while the daemon reads, hence the lock.
    """

    def __init__(self, limit: int = MEMORY_LIMIT) -> None:
        """Start empty, holding at most *limit* destinations (at least one)."""
        self._limit = max(1, int(limit))
        self._entries: OrderedDict[str, dict[str, str | None]] = OrderedDict()
        self._lock = threading.Lock()

    def __len__(self) -> int:
        """Return the number of destinations held."""
        with self._lock:
            return len(self._entries)

    def learn(self, dest_hex: str, identity_hex: str, name: str | None) -> None:
        """Record a live announce: its identity and the name it carried.

        Parameters:
            dest_hex: Destination hash as hex.
            identity_hex: Announcing identity hash as hex.
            name: Decoded display name, or ``None`` when it announced none.
        """
        self.learn_identity(dest_hex, identity_hex)
        self.learn_name(dest_hex, name)

    def learn_identity(self, dest_hex: str, identity_hex: str) -> None:
        """Record the identity RNS or a live announce just gave for *dest_hex*.

        A different identity than the one held drops the held name too: the
        other identity announced it.

        Parameters:
            dest_hex: Destination hash as hex.
            identity_hex: Owning identity hash as hex.
        """
        with self._lock:
            entry = self._touch(dest_hex)
            held, entry["identity"] = entry["identity"], identity_hex
            if held is not None and held != identity_hex:
                entry["name"] = None

    def learn_name(self, dest_hex: str, name: str | None) -> None:
        """Record the display name *dest_hex* last announced, ``None`` for none.

        Parameters:
            dest_hex: Destination hash as hex.
            name: Decoded display name, or ``None``.
        """
        with self._lock:
            self._touch(dest_hex)["name"] = name

    def identity(self, dest_hex: str) -> str | None:
        """Return the identity held for *dest_hex*, or ``None``."""
        return self._lookup(dest_hex, "identity")

    def name(self, dest_hex: str) -> str | None:
        """Return the display name held for *dest_hex*, or ``None``."""
        return self._lookup(dest_hex, "name")

    def _touch(self, dest_hex: str) -> dict[str, str | None]:
        """Return *dest_hex*'s entry as the most recent, evicting past the limit.

        The caller holds the lock.
        """
        entry = self._entries.pop(dest_hex, None) or {"identity": None, "name": None}
        self._entries[dest_hex] = entry
        while len(self._entries) > self._limit:
            self._entries.popitem(last=False)
        return entry

    def _lookup(self, dest_hex: str, field: str) -> str | None:
        """Return one field of *dest_hex*'s entry and mark it the most recent."""
        with self._lock:
            entry = self._entries.get(dest_hex)
            if entry is None:
                return None
            self._entries.move_to_end(dest_hex)
            return entry[field]


def answered_name(
    memory: IdentityMemory | None,
    dest_hex: str,
    app_data: object,
    decode: Callable[[object], str | None],
) -> str | None:
    """Return the name RNS's ``app_data`` carries, else the one *memory* holds.

    RNS answers ``None`` for a destination this process forgot, and for one
    announced without ``app_data``; only the first can follow a clean, so
    ``None`` takes the newest name *memory* holds.  Any other answer is fresh
    and replaces it, even one that decodes to no name (SPEC HI2).

    Parameters:
        memory: The provider's :class:`IdentityMemory`, or ``None`` for none.
        dest_hex: Destination hash as hex.
        app_data: What ``RNS.Identity.recall_app_data`` returned.
        decode: Turns ``app_data`` into a display name or ``None``.

    Returns:
        The display name, or ``None`` when neither has one.
    """
    if app_data is None:
        return memory.name(dest_hex) if memory is not None else None
    name = decode(app_data)
    if memory is not None:
        memory.learn_name(dest_hex, name)
    return name


def remember_announce(
    memory: IdentityMemory | None, node: dict, name: str | None
) -> None:
    """Keep what a local app's live announce carried (SPEC HI2).

    Parameters:
        memory: The interface's :class:`IdentityMemory`, or ``None``.
        node: The node record built from the announce; one without an
            ``identityHash`` or a ``destination`` teaches nothing.
        name: The decoded display name, or ``None`` when it carried none.
    """
    identity_hex = node.get("identityHash")
    if memory is not None and identity_hex and "destination" in node:
        memory.learn(node["destination"]["id"], identity_hex, name)


def pinned_identity(value: object) -> str | None:
    """Return the host identity a full 32-hex ``INGESTOR_NODE_ID`` names (SPEC HI4).

    ``!`` plus eight hex names the node id only, and any other value names no
    identity, so discovery stays the source for those.

    Parameters:
        value: :envvar:`INGESTOR_NODE_ID`, or ``None``.

    Returns:
        The identity hash as lowercase hex, or ``None``.
    """
    text = str(value).strip().lower() if value else ""
    return text if len(text) == 32 and set(text) <= _HEX_DIGITS else None


def local_destinations(entries: Iterable[dict]) -> dict[str, str | None]:
    """Map 0-hop path-table entries to ``{destination hex: interface name}``.

    Parameters:
        entries: Path-table entry mappings; one without a ``bytes`` hash is
            skipped.

    Returns:
        Each usable entry's destination hash as hex, with its interface or
        ``None``.
    """
    local: dict[str, str | None] = {}
    for entry in entries:
        dest = entry.get("hash")
        if isinstance(dest, (bytes, bytearray)):
            interface = entry.get("interface")
            local[bytes(dest).hex()] = str(interface) if interface else None
    return local


def group_by_identity(
    local: dict[str, str | None],
    recall: Callable[[str], str | None],
    memory: IdentityMemory | None,
    excluded: str | None,
) -> dict[str, dict[str, str | None]]:
    """Group local destinations by owning identity, RNS first (SPEC RE8, HI1).

    *recall* answers first, and *memory* keeps each answer.  A destination it
    no longer answers for takes the identity *memory* holds.  A destination
    neither knows, or owned by *excluded* (the transport identity), is left
    out.

    Parameters:
        local: ``{destination hex: interface}`` from :func:`local_destinations`.
        recall: Returns a destination's identity hash as hex, or ``None``;
            raising counts as no answer.
        memory: The provider's :class:`IdentityMemory`, or ``None`` for none.
        excluded: Identity hash never grouped, or ``None``.

    Returns:
        Mapping of identity hash hex to ``{destination hex: interface}``.
    """
    groups: dict[str, dict[str, str | None]] = {}
    for dest_hex, interface in local.items():
        try:
            identity_hex = recall(dest_hex)
        except Exception:  # an RNS error, or a miss that has no hash
            identity_hex = None
        if memory is not None:
            if identity_hex:
                memory.learn_identity(dest_hex, identity_hex)
            else:
                identity_hex = memory.identity(dest_hex)
        if not identity_hex or identity_hex == excluded:
            continue
        groups.setdefault(identity_hex, {})[dest_hex] = interface
    return groups


class PinFollow:
    """Pick the identity a full-hash pin reports: the pin, or discovery's (SPEC HI5).

    The pin wins while its identity fronts a local aspect.  When it fronts
    none and discovery elects exactly one primary, that identity is followed;
    a tie or an empty table changes nothing.  A change takes effect only when
    two evaluations in a row give it, so an answer that alternates never
    re-registers the host; the first evaluation of a pin decides at once,
    having nothing to alternate with.  Each switch logs one warning naming
    the ids and, once the daemon has registered a host id, registers the new
    one in its place, since the daemon asks only while none is registered.
    """

    def __init__(self, node_id: Callable[[str], str | None]) -> None:
        """Start with no pin evaluated; *node_id* maps an identity to its node id."""
        self._node_id = node_id
        self._pinned: str | None = None
        self._active: str | None = None
        self._pending: str | None = None

    def choose(
        self, pinned: str, fronts_local: bool, discover: Callable[[], str | None]
    ) -> str:
        """Return the identity to report now, switching when the answer holds.

        Parameters:
            pinned: The identity a full ``INGESTOR_NODE_ID`` names.
            fronts_local: Whether the pinned identity fronts a local aspect.
            discover: Returns the one primary discovery elects, or ``None`` on
                a tie or an empty table; called only when the pinned identity
                fronts none.

        Returns:
            The identity hash hex to report.
        """
        if pinned != self._pinned:  # a new pin keeps nothing from the old one
            self._pinned, self._active, self._pending = pinned, None, None
        candidate = pinned if fronts_local else (discover() or self._active or pinned)
        previous = self._active or pinned
        if self._active is not None and (
            candidate == previous or candidate != self._pending
        ):
            self._pending = candidate  # a new answer waits for a second evaluation
            return previous
        self._active = self._pending = candidate
        if candidate != previous:
            self._switched(previous, candidate)
        return candidate

    def _switched(self, previous: str, current: str) -> None:
        """Warn once about a switch and register the new host id (SPEC HI5)."""
        node_id = self._node_id(current)
        config._debug_log(
            "Reticulum host identity switched",
            context="reticulum.host",
            severity="warn",
            pinned=self._node_id(self._pinned),
            previous=self._node_id(previous),
            current=node_id,
        )
        if handlers.host_node_id():
            handlers.register_host_node_id(node_id)
