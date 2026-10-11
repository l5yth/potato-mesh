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
"""Interface classes of the running Reticulum stack (SPEC RN4, amended).

The default interface scope admits an announce only when it arrived on an
RNode, and the interface's **class** says so where its name cannot: an
``RNodeSubInterface`` of an ``RNodeMultiInterface`` prints as
``<parent>[<sub>]`` with no type text at all.

``get_interface_stats()`` lists every interface the stack runs, spawned ones
included, each with its printed name (``str(interface)``, the same string
``get_next_hop_if_name`` returns) and its class name.  A shared-instance client
RPCs it to ``rnsd``, the route SPEC RE3 uses for names, so the map describes
the stack that received the announce rather than this process.

**Printed names are posted without peer addresses (SPEC RI1).**  Several
classes print the address of the peer or of the socket into the name, such as
``TCPInterface[Client on Public Hub/203.0.113.77:51234]`` for a TCP server's
peer, and the web serves a posted name to anyone (``GET /api/destinations``).
:func:`public_interface_name` keeps the class and the operator-given name and
drops the address; the web scrubs stored names the same way.
"""

from __future__ import annotations

import re
import threading
import time
from collections.abc import Callable

RNODE_INTERFACE_CLASSES: frozenset[str] = frozenset(
    {"RNodeInterface", "RNodeMultiInterface", "RNodeSubInterface"}
)
"""RNS interface classes that drive an RNode radio."""

REFRESH_SECONDS = 30.0
"""Minimum seconds between two reads that a lookup miss triggers."""

ADDRESS_INTERFACE_PREFIXES: dict[str, str] = {
    "TCPInterface": "/",
    "TCPServerInterface": "/",
    "BackboneInterface": "/",
    "UDPInterface": "/",
    "AutoInterfacePeer": "/",
    "I2PInterfacePeer": " to ",
}
"""Printed class prefixes of names that end with an address (RNS 1.5.7),
each mapped to the text that comes before the address.

``TCPInterface`` is how ``TCPClientInterface`` prints, a TCP server's peers
included (``Client on <server>``); ``BackboneInterface`` covers the server and
``BackboneClientInterface``.  These end ``/<host>:<port>]`` (an IPv6 host in
brackets, except on UDP), and an ``AutoInterfacePeer`` ends with the peer's
link-local IPv6 address after the OS interface name.  An ``I2PInterfacePeer``
that connects out is named ``<I2PInterface name> to <peer>``, the peer being a
``.b32.i2p`` address, an ``.i2p`` name or a base64 destination; one that
connected in is named ``Connected peer on <I2PInterface name>``, no address.
"""

BARE_ADDRESS_INTERFACE_PREFIXES: frozenset[str] = frozenset({"WeaveInterfacePeer"})
"""Printed class prefixes whose brackets hold the peer's address alone."""

NAME_INTERFACE_PREFIXES: frozenset[str] = frozenset(
    {
        "AutoInterface",
        "AX25KISSInterface",
        "I2PInterface",
        "KISSInterface",
        "LocalInterface",
        "PipeInterface",
        "RNodeInterface",
        "RNodeMultiInterface",
        "SerialInterface",
        "Shared Instance",
        "WeaveInterface",
    }
)
"""Printed class prefixes of names that hold no address (RNS 1.5.7).

``Shared Instance`` is how ``LocalServerInterface`` prints; ``LocalInterface``
(``LocalClientInterface``) prints the shared instance's socket, as in
``LocalInterface[rns/default]``, whose ``/`` is no address.  An
``RNodeSubInterface`` prints ``<parent>[<sub>]`` with no class text; see
:data:`_CLASS_NAME`.
"""

_ADDRESSES: dict[str, re.Pattern[str]] = {
    "/": re.compile(r"\S*:\S*", re.ASCII),
    " to ": re.compile(r"\S+\.[iI]2[pP]|[A-Za-z0-9~-]{500,}={0,2}", re.ASCII),
}
"""What an address after each separator looks like.

After ``/``: no whitespace, and a colon, as every address those classes print
has (``host:port``, an IPv6 address).  After `` to ``: an I2P peer, a name
ending ``.i2p`` (``.b32.i2p`` included, any ASCII case of ``i`` and ``p``) or a
base64 destination, which is at least 516 characters.  A name segment that
looks like neither is never taken for an address, which keeps the rule
idempotent.  ASCII whitespace and explicit ASCII classes only, with no
case-insensitive flag, as in the web's copy: Ruby's ``/i`` would fold U+212A
(Kelvin) and U+017F (long s) into ``[A-Za-z]``.
"""

_CLASS_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*", re.ASCII)
"""An unknown prefix that names an interface class, as an external module's does.

An ``RNodeSubInterface`` prints ``<parent>[<sub>]``, where ``<parent>`` is its
``RNodeMultiInterface``'s operator-given name.  A prefix that is no identifier,
or that holds "rnode" in any case, is taken for that name, and RNode names
are never cut.
"""


def _external_class(head: str) -> bool:
    """Report whether a printed prefix belongs to an unknown interface class.

    Parameters:
        head: Text before the first ``[`` of a printed name.

    Returns:
        ``True`` for an identifier without "rnode" that no known class
        prints; ``False`` for a known class and for an RNode multi-interface's
        name (:data:`_CLASS_NAME`).
    """
    return (
        head not in NAME_INTERFACE_PREFIXES
        and _CLASS_NAME.fullmatch(head) is not None
        and "rnode" not in head.lower()
    )


def public_interface_name(name: object) -> object:
    """Return a printed interface name without its peer address (SPEC RI1).

    The name keeps its class prefix and the operator-given name; the address
    goes, along with the brackets when nothing is left in them:

    - an address-printing class (:data:`ADDRESS_INTERFACE_PREFIXES`) drops each
      trailing ``/<address>`` or, for an I2P peer, `` to <peer>``
      (:data:`_ADDRESSES`), so an operator-given name holding either survives:
      ``TCPInterface[Hub A/B/203.0.113.77:4242]`` posts
      ``TCPInterface[Hub A/B]``;
    - a Weave peer (:data:`BARE_ADDRESS_INTERFACE_PREFIXES`) posts its class;
    - a name-only class (:data:`NAME_INTERFACE_PREFIXES`) and an RNode
      sub-interface (:data:`_CLASS_NAME`) are unchanged;
    - an unknown class (:func:`_external_class`) whose bracket text holds
      ``/`` keeps the text before its first ``/``.  That is where dropping the
      text after the last ``/`` ends when the web scrub and the boot cleanup
      repeat it, so one pass is final.

    A name cut before its closing ``]``, as the web's 256-byte SL3 cap
    (``INTERFACE_BYTES``) leaves one before the web's copy of this rule runs,
    has an address that can no longer be recognised, so an address-printing
    class drops the text after its last separator there.  A value that is not a
    string, or not of the form ``<class>[...``, is returned unchanged.
    Applying the function to its own result changes nothing.

    Parameters:
        name: Interface name as RNS printed it, or any other value.

    Returns:
        The name without its address, or *name* itself.
    """
    if not isinstance(name, str):
        return name
    head, bracket, rest = name.partition("[")
    if not bracket:
        return name
    if head in BARE_ADDRESS_INTERFACE_PREFIXES:
        return head
    separator = ADDRESS_INTERFACE_PREFIXES.get(head)
    if separator is None and not _external_class(head):
        return name
    closed = rest.endswith("]")
    text = rest[:-1] if closed else rest
    if separator is None:
        kept = text.partition("/")[0]
    else:
        kept = text
        if not closed and separator in kept:
            kept = kept.rpartition(separator)[0]
        address = _ADDRESSES[separator]
        while separator in kept and address.fullmatch(kept.rpartition(separator)[2]):
            kept = kept.rpartition(separator)[0]
    if kept == text:
        return name
    return f"{head}[{kept}]" if kept else head


def interface_classes(stats: object) -> dict[str, str] | None:
    """Map each interface's printed name to its class name.

    Parameters:
        stats: A ``get_interface_stats()`` reply, whose ``interfaces`` entries
            carry ``name`` (the printed name) and ``type`` (the class name).

    Returns:
        ``{printed name: class name}`` without the malformed entries, or
        ``None`` when *stats* holds no interface list.
    """
    if not isinstance(stats, dict):
        return None
    entries = stats.get("interfaces")
    if not isinstance(entries, (list, tuple)):
        return None
    classes: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name, kind = entry.get("name"), entry.get("type")
        if isinstance(name, str) and isinstance(kind, str):
            classes[name] = kind
    return classes


class InterfaceClassCache:
    """Cached name-to-class map of the running stack's interfaces.

    :meth:`read` re-reads at once (the connect path).  :meth:`class_of`
    re-reads on a miss, at most once per refresh window, so announces from an
    interface spawned after the last read cost one RPC per window rather than
    one each.  A failed read keeps the previous map and still starts the
    window.  The map belongs to the instance it was read from: a different
    instance discards it.  Thread-safe, because RNS calls announce handlers on
    threads of its own.
    """

    def __init__(
        self,
        get_instance: Callable[[], object],
        *,
        clock: Callable[[], float] = time.monotonic,
        refresh_seconds: float = REFRESH_SECONDS,
    ) -> None:
        """Bind the cache to the running stack.

        Parameters:
            get_instance: Returns the running ``RNS.Reticulum``, or ``None``.
            clock: Monotonic seconds, for the refresh window.
            refresh_seconds: Minimum seconds between two miss-triggered reads.
        """
        self._get_instance = get_instance
        self._clock = clock
        self._refresh_seconds = refresh_seconds
        self._lock = threading.Lock()
        self._instance: object | None = None
        self._classes: dict[str, str] | None = None
        self._read_at: float | None = None

    def read(self) -> dict[str, str] | None:
        """Re-read the map now, whatever the refresh window.

        Returns:
            The fresh map, or ``None`` when no stack runs, it exposes no
            ``get_interface_stats``, or its reply holds no interface list.

        Raises:
            Exception: Whatever ``get_interface_stats`` raises, such as the
                ``AuthenticationError`` of an RPC the shared instance rejects.
        """
        with self._lock:
            instance = self._bind()
            return None if instance is None else self._refresh(instance)

    def class_of(self, interface_name: str) -> str | None:
        """Return the class of the interface printed as *interface_name*.

        Parameters:
            interface_name: The interface's printed name, as RE3 resolves it.

        Returns:
            Its class name, or ``None`` when the stack cannot say: no stack,
            no stats, a failed read, or a name the stack does not list.
        """
        with self._lock:
            instance = self._bind()
            if instance is None:
                return None
            if self._classes is not None and interface_name in self._classes:
                return self._classes[interface_name]
            if (
                self._read_at is not None
                and self._clock() - self._read_at < self._refresh_seconds
            ):
                return None
            try:
                classes = self._refresh(instance)
            except Exception:
                return None
            return None if classes is None else classes.get(interface_name)

    def _bind(self) -> object | None:
        """Return the running instance, discarding a map read from another one.

        Returns:
            The instance, or ``None`` when there is none or asking fails.
        """
        try:
            instance = self._get_instance()
        except Exception:
            return None
        if instance is not self._instance:
            self._instance, self._classes, self._read_at = instance, None, None
        return instance

    def _refresh(self, instance: object) -> dict[str, str] | None:
        """Read *instance*'s interface stats into the map.

        Parameters:
            instance: The running ``RNS.Reticulum``.

        Returns:
            The fresh map, or ``None`` when *instance* has no stats to read.
        """
        # Stamped before the read, so a failing read also starts the window.
        self._read_at = self._clock()
        reader = getattr(instance, "get_interface_stats", None)
        if reader is None:
            return None
        classes = interface_classes(reader())
        if classes is not None:
            self._classes = classes
        return classes


__all__ = [
    "ADDRESS_INTERFACE_PREFIXES",
    "BARE_ADDRESS_INTERFACE_PREFIXES",
    "NAME_INTERFACE_PREFIXES",
    "REFRESH_SECONDS",
    "RNODE_INTERFACE_CLASSES",
    "InterfaceClassCache",
    "interface_classes",
    "public_interface_name",
]
