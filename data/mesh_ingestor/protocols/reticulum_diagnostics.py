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
"""What reached the Reticulum ingestor, and why nothing did (SPEC RG1-RG4).

An ingestor that heard nothing used to log the same lines whatever the cause:
it ran its own stack instead of attaching to ``rnsd``, ``rnsd`` heard nothing
usable, announces arrived for other aspects only, or the interface scope
dropped them all.  Two lines now tell the causes apart.

**The connect line** (:meth:`StackDiagnostics.connected`, SPEC RG1), at info
after each connect: the stack role, the interface classes with counts, the
RNode figures, the shared instance's clients, the outcome of the stats read
and ``received``, the announces that reached this process.

**The hourly summary** (:meth:`StackDiagnostics.tick`, SPEC RG2): the
announces delivered and admitted per aspect, the drops per reason with the
interface classes of scope drops, and the growth of ``received`` and of the
RNode counters since the last summary.  It is a warning, with hints chosen
from the connect facts, when nothing reached this process or the interface
scope dropped everything delivered (SPEC RG3).

**Classes and counts only** (Invariant II, SPEC RG4).  Nothing logged carries
an interface's ``name``, ``short_name`` or ``hash``, its IFAC network name or
signature, a ``transport_id`` or ``network_id``, a peer address or a
destination hash: a printed interface name can hold an IP address and port or
a LAN peer's link-local address.  A name is read only to look its class up,
and the lookup table never leaves this module.  The module imports no RNS: it
reads what the provider hands it, plus the ingestor's host id for one hint
(``handlers.host_node_id``), so it cannot transmit or read the path table
(SPEC RN5, MA7, RE8).
"""

from __future__ import annotations

import threading
import time
from collections import Counter
from collections.abc import Callable, Mapping
from typing import NamedTuple

from .. import config, handlers
from . import reticulum_interfaces

SUMMARY_INTERVAL_SECS = 3600.0
"""Seconds between two hourly summaries (SPEC RG4); a constant, not a setting."""

UNKNOWN = "unknown"
"""Label for a class the stack cannot name, and for a role no flag sets."""

RADIO_CLASSES: frozenset[str] = frozenset({"RNodeInterface", "RNodeSubInterface"})
"""Interface classes whose figures are the RNode figures.

An ``RNodeMultiInterface`` is the device its ``RNodeSubInterface`` radios
receive on.  It counts no announce of its own and sends what they send, so
counting it as well would count the same bytes twice.
"""

SHARED_INSTANCE_CLASS = "LocalServerInterface"
"""Class of the shared instance's interface, which counts its ``clients``."""

RNODE_COUNTERS: tuple[tuple[str, str], ...] = (
    ("rxb", "rnode_rxb"),
    ("txb", "rnode_txb"),
    ("arxc", "rnode_arxc"),
    ("protocol_violations", "rnode_protocol_violations"),
    ("ifac_violations", "rnode_ifac_violations"),
    ("packet_filter_hits", "rnode_filter_hits"),
)
"""``(stats key, logged field)`` of each RNode counter, summed over the radios."""

_ROLE_FLAGS: tuple[tuple[str, str], ...] = (
    ("is_connected_to_shared_instance", "client"),
    ("is_shared_instance", "shared"),
    ("is_standalone_instance", "standalone"),
)
"""``RNS.Reticulum`` flags, in order, and the role each one names."""

HINT_ROLE = (
    "Start rnsd before the ingestor, or set RETICULUM_CONFIG_DIR to the "
    "config dir rnsd uses"
)
"""Hint when this process is no client of ``rnsd`` (SPEC RG3)."""

HINT_STATS = (
    "Set RETICULUM_CONFIG_DIR to the config dir rnsd uses; this stack refused "
    "the stats RPC"
)
"""Hint when the stats read failed, as a refused RPC does (SPEC RG3)."""

HINT_RNODE = (
    "The RNode receives but accepts no announce: check rnstatus -a, IFAC "
    "network_name and passphrase, and radio parameters"
)
"""Hint when the RNode has received bytes and no announce (SPEC RG3)."""

HINT_PATHS = "Run rnpath -t to list the paths this stack knows"
"""Hint on every warning (SPEC RG3)."""

HINT_HOST_ID = "Set INGESTOR_NODE_ID if nothing on this host announces"
"""Hint while the host id is not resolved (SPEC RG3, RE8)."""


def _count(value: object) -> int:
    """Return *value* as a counter.

    Parameters:
        value: A counter read from RNS.

    Returns:
        *value* when it is a non-negative ``int``, else ``0``; a ``bool`` is no
        counter.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return max(value, 0)


def _sorted_counts(counts: Mapping[str, int]) -> dict[str, int]:
    """Return the non-zero *counts*, sorted by key, for a stable log line.

    Parameters:
        counts: Counts by label.

    Returns:
        A new mapping without the zero counts.
    """
    return {key: counts[key] for key in sorted(counts) if counts[key]}


def stack_role(instance: object) -> str:
    """Name the role of the running stack (SPEC RG1).

    Parameters:
        instance: The running ``RNS.Reticulum``, or anything else.

    Returns:
        ``client`` when attached to a shared instance (``rnsd``), ``shared``
        when this process is that shared instance, ``standalone`` when it runs
        an unshared stack, and ``unknown`` when no flag is ``True``, as on a
        half-built instance or a fake without the flags.
    """
    for flag, role in _ROLE_FLAGS:
        if getattr(instance, flag, False) is True:
            return role
    return UNKNOWN


def received_announces(interfaces: object) -> int | None:
    """Count the announces this process's own interfaces received (SPEC RG1).

    ``RNS.Transport.interfaces`` lives in this process and is read with no
    RPC.  On a client of ``rnsd`` it holds one ``LocalClientInterface``, whose
    ``arxc`` counts exactly what ``rnsd`` forwarded here.  On a stack this
    process runs itself it holds that stack's interfaces, spawned ones too: an
    ``AutoInterfacePeer``, a client of the shared instance, an RNode
    sub-interface.  Those count, and the parent each one names does not,
    because some parents count their children's announces again.

    Parameters:
        interfaces: ``RNS.Transport.interfaces``, or ``None`` when the
            transport has none.

    Returns:
        The sum of ``arxc`` over the interfaces that no other one names as its
        parent, or ``None`` when *interfaces* is not a list.
    """
    if not isinstance(interfaces, (list, tuple)):
        return None
    listed = list(interfaces)
    parents = {id(getattr(iface, "parent_interface", None)) for iface in listed}
    return sum(
        _count(getattr(iface, "arxc", 0))
        for iface in listed
        if id(iface) not in parents
    )


class StackFacts(NamedTuple):
    """What one read of the stack says, in classes and counts (SPEC RG1).

    Only ``role``, ``stats`` and ``received`` are known without the stats;
    the rest is ``None`` unless the read succeeded, and the RNode fields stay
    ``None`` while no radio is listed.
    """

    role: str
    """The :func:`stack_role`."""

    stats: str
    """``ok``, ``unavailable`` (no stats to read) or the failure's class name."""

    received: int | None
    """:func:`received_announces` at the read."""

    interfaces: dict[str, int] | None = None
    """Listed interfaces per class, sorted by class."""

    shared_clients: int | None = None
    """The shared instance's ``clients``, when one is listed."""

    rnode_online: str | None = None
    """``<online>/<listed>`` over the :data:`RADIO_CLASSES` entries."""

    rnode_ifac: str | None = None
    """``on``, ``off`` or ``mixed``: which radios set an IFAC size."""

    rnodes: dict[str, int] | None = None
    """The :data:`RNODE_COUNTERS`, summed over the radios."""

    classes: dict[str, str] | None = None
    """Printed name to class, for the tally's scope drops; never logged."""


def _entries(stats: object) -> list[dict]:
    """Return the mapping entries of a ``get_interface_stats()`` reply.

    Parameters:
        stats: The reply, whatever its shape.

    Returns:
        The ``interfaces`` entries that are mappings; empty when the reply
        holds no interface list.
    """
    listed = stats.get("interfaces") if isinstance(stats, dict) else None
    if not isinstance(listed, (list, tuple)):
        return []
    return [entry for entry in listed if isinstance(entry, dict)]


def _radio_facts(entries: list[dict]) -> dict:
    """Return the RNode fields of :class:`StackFacts` for the listed *entries*.

    Parameters:
        entries: The stats entries of one read.

    Returns:
        ``rnode_online``, ``rnode_ifac`` and ``rnodes`` over the
        :data:`RADIO_CLASSES` entries, or nothing when none is listed.
    """
    # A ``type`` that is not a string (malformed stats) is no radio; testing an
    # unhashable one against the set would raise ``TypeError``.
    radios = [
        entry
        for entry in entries
        if isinstance(entry.get("type"), str) and entry["type"] in RADIO_CLASSES
    ]
    if not radios:
        return {}
    online = sum(1 for entry in radios if entry.get("status") is True)
    # ``get_interface_stats`` reports ``ifac_size`` only for an interface with
    # IFAC configured, so the size alone says on or off.
    with_ifac = sum(1 for entry in radios if _count(entry.get("ifac_size")) > 0)
    ifac = "on" if with_ifac == len(radios) else "off" if not with_ifac else "mixed"
    counters = {
        field: sum(_count(entry.get(key)) for entry in radios)
        for key, field in RNODE_COUNTERS
    }
    return {
        "rnode_online": f"{online}/{len(radios)}",
        "rnode_ifac": ifac,
        "rnodes": counters,
    }


def read_facts(instance: object, interfaces: object) -> StackFacts:
    """Read the stack once: its role, ``received`` and one stats read (SPEC RG1).

    A client's stats read is an RPC to ``rnsd``; any other read here is local.

    Parameters:
        instance: The running ``RNS.Reticulum``; a fake may lack its members.
        interfaces: ``RNS.Transport.interfaces`` (see
            :func:`received_announces`).

    Returns:
        The :class:`StackFacts`.
    """
    role, received = stack_role(instance), received_announces(interfaces)
    reader = getattr(instance, "get_interface_stats", None)
    if not callable(reader):
        return StackFacts(role, "unavailable", received)
    try:
        stats = reader()
    except Exception as exc:
        # The class says what failed (a refused RPC raises
        # AuthenticationError); the message is not kept.
        return StackFacts(role, exc.__class__.__name__, received)
    entries = _entries(stats)
    kinds = Counter(
        entry["type"] if isinstance(entry.get("type"), str) else UNKNOWN
        for entry in entries
    )
    servers = [e for e in entries if e.get("type") == SHARED_INSTANCE_CLASS]
    return StackFacts(
        role,
        "ok",
        received,
        interfaces=_sorted_counts(kinds),
        shared_clients=(
            sum(_count(e.get("clients")) for e in servers) if servers else None
        ),
        classes=reticulum_interfaces.interface_classes(stats) or {},
        **_radio_facts(entries),
    )


def connect_fields(facts: StackFacts) -> dict:
    """Return the fields of the connect line (SPEC RG1).

    Parameters:
        facts: The connect read.

    Returns:
        ``role``, ``stats`` and ``received``, then whatever the stats said.
    """
    fields: dict = {
        "role": facts.role,
        "stats": facts.stats,
        "received": facts.received,
    }
    if facts.interfaces is not None:
        fields["interfaces"] = facts.interfaces
    if facts.shared_clients is not None:
        fields["shared_clients"] = facts.shared_clients
    if facts.rnodes is not None:
        fields["rnode_online"] = facts.rnode_online
        fields["rnode_ifac"] = facts.rnode_ifac
        fields.update(facts.rnodes)
    return fields


class TallyCounts(NamedTuple):
    """One window of the announce tally, each mapping sorted and non-zero."""

    delivered: dict[str, int]
    """Announces any handler received, per aspect."""

    admitted: dict[str, int]
    """Announces ingested, per aspect."""

    dropped: dict[str, int]
    """Drops per reason: ``scope``, ``no_interface``, ``unusable_hash``, ``error``."""

    scope_classes: dict[str, int]
    """``scope`` drops per interface class."""


class AnnounceTally:
    """Thread-safe count of every announce outcome (SPEC RG2).

    RNS runs each announce handler on a thread of its own.  The tally is
    separate from the merged packet counter (SPEC MA1): an announce the scope
    drops is counted here and still never reaches ``_mark_packet_seen``.
    """

    def __init__(self) -> None:
        """Start an empty tally with no class table."""
        self._lock = threading.Lock()
        self._classes: dict[str, str] = {}
        self._delivered: Counter = Counter()
        self._admitted: Counter = Counter()
        self._dropped: Counter = Counter()
        self._scope_classes: Counter = Counter()

    def use_classes(self, classes: Mapping[str, str]) -> None:
        """Take the printed-name-to-class table of the latest stats read.

        Parameters:
            classes: The table; it is copied and never logged.
        """
        with self._lock:
            self._classes = dict(classes)

    def admitted(self, aspect: str) -> None:
        """Count an announce that was ingested.

        Parameters:
            aspect: The handler's aspect.
        """
        with self._lock:
            self._delivered[aspect] += 1
            self._admitted[aspect] += 1

    def out_of_scope(self, aspect: str, interface_name: str | None) -> None:
        """Count an announce the interface scope dropped.

        Parameters:
            aspect: The handler's aspect.
            interface_name: The interface it arrived on.  Without one the
                reason is ``no_interface``; with one it is ``scope``, counted
                under the interface's class, or ``unknown`` when the latest
                stats read did not list it.
        """
        with self._lock:
            self._delivered[aspect] += 1
            if not interface_name:
                self._dropped["no_interface"] += 1
                return
            self._dropped["scope"] += 1
            self._scope_classes[self._classes.get(interface_name, UNKNOWN)] += 1

    def dropped(self, aspect: str, reason: str) -> None:
        """Count an announce dropped after the scope admitted it.

        Parameters:
            aspect: The handler's aspect.
            reason: ``unusable_hash`` or ``error``.
        """
        with self._lock:
            self._delivered[aspect] += 1
            self._dropped[reason] += 1

    def drain(self) -> TallyCounts:
        """Return the counts so far and start the next window from zero.

        Returns:
            The window's :class:`TallyCounts`.
        """
        with self._lock:
            counts = TallyCounts(
                _sorted_counts(self._delivered),
                _sorted_counts(self._admitted),
                _sorted_counts(self._dropped),
                _sorted_counts(self._scope_classes),
            )
            for counter in (
                self._delivered,
                self._admitted,
                self._dropped,
                self._scope_classes,
            ):
                counter.clear()
        return counts


def _delta(now: int, then: int) -> int:
    """Return a counter's growth since an earlier reading.

    Parameters:
        now: The current reading.
        then: The earlier reading.

    Returns:
        ``now - then``, or ``now`` when the counter went back, as it does when
        ``rnsd`` restarts and counts from zero again.
    """
    return now - then if now >= then else now


def summary_fields(
    counts: TallyCounts, facts: StackFacts, baseline: StackFacts
) -> dict:
    """Return the fields of the hourly summary (SPEC RG2).

    Parameters:
        counts: The window's tally.
        facts: The summary's own read.
        baseline: The read the window started from.

    Returns:
        The tally, the growth of ``received``, the read's ``stats`` outcome,
        and the growth of each RNode counter when both reads list radios.
    """
    received = None
    if facts.received is not None and baseline.received is not None:
        received = _delta(facts.received, baseline.received)
    fields: dict = {
        "delivered": counts.delivered,
        "admitted": counts.admitted,
        "dropped": counts.dropped,
        "scope_classes": counts.scope_classes,
        "received": received,
        "stats": facts.stats,
    }
    if facts.rnodes is not None and baseline.rnodes is not None:
        for field, value in facts.rnodes.items():
            fields[field] = _delta(value, baseline.rnodes[field])
    return fields


def needs_warning(counts: TallyCounts, received: int | None) -> bool:
    """Decide whether the summary is a warning (SPEC RG3).

    Parameters:
        counts: The window's tally.
        received: The growth of ``received``, or ``None`` when unknown.

    Returns:
        ``True`` when nothing reached this process, or when the interface
        scope dropped every announce delivered, with or without an interface.
    """
    if received == 0:
        return True
    delivered = sum(counts.delivered.values())
    scoped = counts.dropped.get("scope", 0) + counts.dropped.get("no_interface", 0)
    return delivered > 0 and scoped == delivered


def hints(facts: StackFacts, *, host_pending: bool) -> list[str]:
    """Choose the hints of a warning from the connect facts (SPEC RG3).

    Parameters:
        facts: The latest connect read.
        host_pending: Whether the host id is still unresolved.

    Returns:
        The hints, most specific first; ``rnpath -t`` is always among them.
    """
    chosen = []
    if facts.role != "client":
        chosen.append(HINT_ROLE)
    if facts.stats not in ("ok", "unavailable"):
        chosen.append(HINT_STATS)
    rnodes = facts.rnodes or {}
    if rnodes.get("rnode_rxb", 0) > 0 and rnodes.get("rnode_arxc", 0) == 0:
        chosen.append(HINT_RNODE)
    chosen.append(HINT_PATHS)
    if host_pending:
        chosen.append(HINT_HOST_ID)
    return chosen


def _log_failure(context: str, exc: Exception) -> None:
    """Log one warning for a diagnostics read that raised.

    The class is logged and the message is not: a message can carry an
    interface name (Invariant II).

    Parameters:
        context: The log context of the line that failed.
        exc: What the read raised.
    """
    config._debug_log(
        "Reticulum diagnostics failed",
        context=context,
        severity="warn",
        error_class=exc.__class__.__name__,
    )


class StackDiagnostics:
    """The connect line, the tally and the hourly summary of one provider.

    One per :class:`~.reticulum.ReticulumProvider`, so the tally and the
    window outlive the hourly inactivity reconnect: the summary covers the
    hour since the last one, however often the connection recycled.  Neither
    entry point raises: a failing read logs one warning by class.

    Parameters:
        transport_interfaces: Returns ``RNS.Transport.interfaces``, resolved
            at call time.
        clock: Monotonic seconds; ``time.monotonic`` when omitted.
    """

    def __init__(
        self,
        transport_interfaces: Callable[[], object],
        *,
        clock: Callable[[], float] | None = None,
    ) -> None:
        """Start with an empty tally; the window opens at the first connect."""
        self.tally = AnnounceTally()
        self._transport_interfaces = transport_interfaces
        self._clock = clock
        self._connect_facts: StackFacts | None = None
        self._baseline: StackFacts | None = None
        self._window_start: float | None = None

    def _now(self) -> float:
        """Return the monotonic time.

        Returns:
            The injected clock's reading, or ``time.monotonic()`` looked up at
            call time, so a patched clock applies.
        """
        return (self._clock or time.monotonic)()

    def _read(self, instance: object) -> StackFacts:
        """Read the stack and hand its class table to the tally.

        Parameters:
            instance: The running ``RNS.Reticulum``.

        Returns:
            The read's :class:`StackFacts`.
        """
        facts = read_facts(instance, self._transport_interfaces())
        self.tally.use_classes(facts.classes or {})
        return facts

    def connected(self, instance: object) -> None:
        """Log the connect line; the first one opens the summary window (RG1).

        Parameters:
            instance: The stack the connection attached to.
        """
        try:
            facts = self._read(instance)
            config._debug_log(
                "Reticulum stack state",
                context="reticulum.connect",
                severity="info",
                **connect_fields(facts),
            )
        except Exception as exc:
            _log_failure("reticulum.connect", exc)
            return
        self._connect_facts = facts
        if self._window_start is None:
            self._window_start, self._baseline = self._now(), facts

    def tick(self, instance: object) -> None:
        """Log the hourly summary when due; the daemon calls this every loop (RG2).

        Parameters:
            instance: The connected stack.
        """
        if self._window_start is None:
            return
        now = self._now()
        if now - self._window_start < SUMMARY_INTERVAL_SECS:
            return
        try:
            self._summarise(instance)
        except Exception as exc:
            _log_failure("reticulum.summary", exc)
        finally:
            # A failing read repeats hourly, not on every loop.
            self._window_start = now

    def _summarise(self, instance: object) -> None:
        """Read the stack once more, drain the tally and log the summary.

        The read's facts become the next window's baseline.  The hints come
        from the latest connect read (SPEC RG3).

        Parameters:
            instance: The connected stack.
        """
        facts = self._read(instance)
        counts = self.tally.drain()
        fields = summary_fields(counts, facts, self._baseline)
        self._baseline = facts
        severity = "info"
        if needs_warning(counts, fields["received"]):
            severity = "warn"
            fields["hints"] = hints(
                self._connect_facts, host_pending=not handlers.host_node_id()
            )
        config._debug_log(
            "Reticulum announce summary",
            context="reticulum.summary",
            severity=severity,
            **fields,
        )


__all__ = [
    "AnnounceTally",
    "HINT_HOST_ID",
    "HINT_PATHS",
    "HINT_RNODE",
    "HINT_ROLE",
    "HINT_STATS",
    "RADIO_CLASSES",
    "RNODE_COUNTERS",
    "SHARED_INSTANCE_CLASS",
    "SUMMARY_INTERVAL_SECS",
    "StackDiagnostics",
    "StackFacts",
    "TallyCounts",
    "UNKNOWN",
    "connect_fields",
    "hints",
    "needs_warning",
    "read_facts",
    "received_announces",
    "stack_role",
    "summary_fields",
]
