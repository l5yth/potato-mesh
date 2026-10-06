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
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

RNODE_INTERFACE_CLASSES: frozenset[str] = frozenset(
    {"RNodeInterface", "RNodeMultiInterface", "RNodeSubInterface"}
)
"""RNS interface classes that drive an RNode radio."""

REFRESH_SECONDS = 30.0
"""Minimum seconds between two reads that a lookup miss triggers."""


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
    "REFRESH_SECONDS",
    "RNODE_INTERFACE_CLASSES",
    "InterfaceClassCache",
    "interface_classes",
]
