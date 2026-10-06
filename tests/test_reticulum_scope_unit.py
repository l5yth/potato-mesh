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
"""Unit tests for the Reticulum interface scope (SPEC RN4 as amended, RE3, RE4).

Unset, ``RETICULUM_INTERFACES`` ingests announces that arrived on an RNode only;
``*`` ingests every interface; any other value is a substring allowlist.

The real :class:`ReticulumProvider` and its real announce handlers run against
a fake shared-instance RNS stack.  Identities and destination hashes come from
the real RNS library, and every interface is a real RNS interface class created
without ``__init__`` (no serial port, no socket), so each one's ``str()`` is
exactly what ``rnsd`` returns over RPC and lists in ``get_interface_stats()``.
"""

from __future__ import annotations

import multiprocessing
import re
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import RNS as REAL_RNS  # noqa: E402 - path setup
from RNS.Interfaces.AutoInterface import (  # noqa: E402 - path setup
    AutoInterface,
    AutoInterfacePeer,
)
from RNS.Interfaces.BackboneInterface import (  # noqa: E402 - path setup
    BackboneClientInterface,
)
from RNS.Interfaces.LocalInterface import LocalClientInterface  # noqa: E402
from RNS.Interfaces.RNodeInterface import RNodeInterface  # noqa: E402
from RNS.Interfaces.RNodeMultiInterface import (  # noqa: E402 - path setup
    RNodeMultiInterface,
    RNodeSubInterface,
)
from RNS.Interfaces.TCPInterface import TCPClientInterface  # noqa: E402

import data.mesh_ingestor.config as config  # noqa: E402 - path setup
import data.mesh_ingestor.protocols.reticulum as mod  # noqa: E402 - path setup


def _bare(cls, **attrs):
    """Return a real RNS interface built without ``__init__``: no hardware, no I/O.

    Parameters:
        cls: RNS interface class.
        attrs: Attributes its ``__str__`` reads.

    Returns:
        The interface instance.
    """
    obj = object.__new__(cls)
    for key, value in attrs.items():
        setattr(obj, key, value)
    return obj


_MULTI = _bare(RNodeMultiInterface, name="Multi Radio")
_AUTO = _bare(AutoInterface, name="Default Interface")

IFACES = {
    "rnode": _bare(RNodeInterface, name="RNode LoRa Interface"),
    "tcp": _bare(
        TCPClientInterface,
        name="RNS Testnet Amsterdam",
        target_ip="amsterdam.connect.reticulum.network",
        target_port=4965,
    ),
    "backbone": _bare(
        BackboneClientInterface,
        name="Backbone Peer",
        target_ip="203.0.113.7",
        target_port=4242,
    ),
    "multi": _MULTI,
    "rnode_sub": _bare(RNodeSubInterface, name="868 Low", parent_interface=_MULTI),
    "auto": _AUTO,
    "auto_peer": _bare(
        AutoInterfacePeer, ifname="eth0", addr="fe80::1", parent_interface=_AUTO
    ),
    "local": _bare(LocalClientInterface, socket_path="\0rns/default"),
}
"""Real RNS interfaces, keyed by role.  ``local`` is this client's own socket."""

PEERS = (
    ("tcp_peer", "tcp", 3, "Amsterdam Hub User"),
    ("backbone_peer", "backbone", 2, "Backbone Peer User"),
    ("rnode_peer", "rnode", 1, "LoRa Neighbour"),
    ("rnode_sub_peer", "rnode_sub", 1, "Multi Radio Neighbour"),
    ("auto_peer", "auto_peer", 1, "LAN Peer"),
    ("own", "local", 0, "Operator Node"),
)
"""(label, arrival interface, hops, display name) per peer; ``own`` is this host."""

ALL = {label for label, *_ in PEERS}
"""Every peer label."""

FULL_STACK = ("rnode", "tcp", "backbone", "multi", "rnode_sub", "auto", "auto_peer")
"""The interfaces rnsd runs on the default fake stack."""

NO_RNODE_STACK = ("tcp", "backbone", "auto", "auto_peer")
"""A stack with IP interfaces only."""

_TCP = str(IFACES["tcp"])
"""The TCP interface's printed name, as rnsd reports it."""


def _stats_entry(iface) -> dict:
    """Return the ``get_interface_stats()`` entry RNS builds for *iface*.

    Only the keys the scope can read: ``name`` is ``str(interface)``, ``type``
    the class name, and a spawned interface also names its parent
    (``Reticulum.get_interface_stats``).

    Parameters:
        iface: A real RNS interface.

    Returns:
        The stats entry.
    """
    entry = {
        "name": str(iface),
        "short_name": str(getattr(iface, "name", None)),
        "type": type(iface).__name__,
    }
    parent = getattr(iface, "parent_interface", None)
    if parent is not None:
        entry["parent_interface_name"] = str(parent)
    return entry


class _Stack:
    """rnsd's state behind the fake RNS namespace.

    Holds the interfaces rnsd runs, the path to each peer's ``lxmf.delivery``
    destination, and who owns it.  The operator also runs a nomadnet node, so
    host discovery finds two local destinations of one identity (SPEC RE8).
    """

    def __init__(self, interfaces=FULL_STACK, *, stats="ok"):
        """Build the stack.

        Parameters:
            interfaces: Keys of :data:`IFACES` rnsd runs.
            stats: ``"ok"``, ``"missing"`` (the instance has no
                ``get_interface_stats``), or an exception every RPC raises.
        """
        self.interfaces = [IFACES[key] for key in interfaces]
        self.stats = stats
        self.stats_calls = 0
        self.registered: list = []
        self.paths: dict[bytes, tuple[int, object]] = {}
        self.owners: dict[bytes, object] = {}
        self.dests: dict[str, bytes] = {}
        self.transport_identity = REAL_RNS.Identity()
        self.identities = {label: REAL_RNS.Identity() for label, *_ in PEERS}
        for label, key, hops, _name in PEERS:
            dest = REAL_RNS.Destination.hash(self.identities[label], "lxmf", "delivery")
            self.dests[label] = dest
            self.paths[dest] = (hops, IFACES[key])
            self.owners[dest] = self.identities[label]
        own = self.identities["own"]
        nomad = REAL_RNS.Destination.hash(own, "nomadnetwork", "node")
        self.paths[nomad] = (0, IFACES["local"])
        self.owners[nomad] = own

    def _rpc(self):
        """Raise the configured RPC failure, if any."""
        if isinstance(self.stats, BaseException):
            raise self.stats

    def next_hop_if_name(self, dest) -> str:
        """Answer ``get_next_hop_if_name``: ``str()`` of rnsd's next-hop interface."""
        self._rpc()
        entry = self.paths.get(bytes(dest))
        return str(entry[1]) if entry else "None"

    def path_table(self, max_hops=None) -> list[dict]:
        """Answer ``get_path_table`` for paths within *max_hops*."""
        self._rpc()
        return [
            {"hash": dest, "hops": hops, "interface": str(iface)}
            for dest, (hops, iface) in self.paths.items()
            if max_hops is None or hops <= max_hops
        ]

    def interface_stats(self) -> dict:
        """Answer ``get_interface_stats``, counting the calls."""
        self.stats_calls += 1
        self._rpc()
        return {
            "interfaces": [_stats_entry(iface) for iface in self.interfaces],
            "transport_id": None,
        }


def _fake_rns(stack: _Stack):
    """Return a fake ``RNS`` namespace: a client attached to a shared ``rnsd``.

    Parameters:
        stack: The rnsd state the shared instance answers from.

    Returns:
        The namespace the provider reads as ``RNS``.
    """
    shared = types.SimpleNamespace(
        is_connected_to_shared_instance=True,
        get_next_hop_if_name=stack.next_hop_if_name,
        get_path_table=stack.path_table,
    )
    if stack.stats != "missing":
        shared.get_interface_stats = stack.interface_stats
    transport = types.SimpleNamespace(
        PATHFINDER_M=128,
        register_announce_handler=stack.registered.append,
        deregister_announce_handler=lambda _handler: None,
        hops_to=lambda dest: stack.paths.get(bytes(dest), (128, None))[0],
        # This client's own path table: everything reads as the local socket.
        next_hop_interface=lambda _dest: IFACES["local"],
        internal_identity=lambda: stack.transport_identity,
    )
    return types.SimpleNamespace(
        Reticulum=types.SimpleNamespace(
            get_instance=lambda: shared, transport_enabled=lambda: False
        ),
        Transport=transport,
        Identity=types.SimpleNamespace(
            recall=lambda dest, **_k: stack.owners.get(bytes(dest)),
            recall_app_data=lambda _dest: None,
        ),
        Destination=types.SimpleNamespace(hash=REAL_RNS.Destination.hash),
    )


class _Run:
    """The real provider on a fake stack, with what it logged, counted and posted."""

    def __init__(self, monkeypatch, tmp_path, scope, **stack_options):
        """Install the fake stack and the scope; nothing is connected yet.

        Parameters:
            monkeypatch: pytest fixture.
            tmp_path: Directory used as ``RETICULUM_CONFIG_DIR`` (no config).
            scope: Value for ``config.RETICULUM_INTERFACES``.
            stack_options: Keyword arguments for :class:`_Stack`.
        """
        self.stack = _Stack(**stack_options)
        self.logs: list = []
        self.upserts: list = []
        self.seen = 0
        self.iface = None
        monkeypatch.setattr(mod, "RNS", _fake_rns(self.stack))
        monkeypatch.setattr(config, "RETICULUM_INTERFACES", scope)
        monkeypatch.setattr(config, "RETICULUM_CONFIG_DIR", str(tmp_path))
        for name in ("RETICULUM_FREQ", "RETICULUM_PRESET", "INGESTOR_NODE_ID"):
            monkeypatch.setattr(config, name, None)
        monkeypatch.setattr(config, "CONNECTION", None)
        monkeypatch.setattr(config, "LORA_FREQ", 867)
        monkeypatch.setattr(config, "MODEM_PRESET", "SF8/BW125/CR5")
        monkeypatch.setattr(
            config, "_debug_log", lambda msg, **kw: self.logs.append((msg, kw))
        )
        monkeypatch.setattr(
            mod.handlers,
            "upsert_node",
            lambda nid, node: self.upserts.append((nid, node)),
        )
        monkeypatch.setattr(mod.handlers, "_mark_packet_seen", self._count)

    def _count(self) -> None:
        """Stand in for ``handlers._mark_packet_seen``."""
        self.seen += 1

    def connect(self) -> "_Run":
        """Connect the real provider; returns ``self`` for chaining."""
        self.iface, _target, _next = mod.ReticulumProvider().connect(
            active_candidate=None
        )
        return self

    def announce(self, *labels: str) -> None:
        """Dispatch each peer's ``lxmf.delivery`` announce (default: every peer)."""
        handler = next(
            h for h in self.stack.registered if h.aspect_filter == "lxmf.delivery"
        )
        names = {label: name for label, _key, _hops, name in PEERS}
        for label in labels or [label for label, *_ in PEERS]:
            handler.received_announce(
                destination_hash=self.stack.dests[label],
                announced_identity=self.stack.identities[label],
                app_data=names[label].encode("utf-8"),
            )

    def node_id(self, label: str) -> str:
        """Return the canonical node id of the peer *label*."""
        return mod._reticulum_node_id(self.stack.identities[label].hash)

    @property
    def ingested(self) -> set[str]:
        """Labels of the peers that were posted."""
        label_of = {self.node_id(label): label for label in ALL}
        return {label_of[node_id] for node_id, _node in self.upserts}

    def record(self, label: str) -> dict:
        """Return the node record last posted for *label*."""
        return [node for nid, node in self.upserts if nid == self.node_id(label)][-1]

    def warnings(self) -> list[str]:
        """Return every message logged at ``warn``."""
        return [msg for msg, kw in self.logs if kw.get("severity") == "warn"]

    def startup(self) -> dict:
        """Return the fields of the first "listener registered" line."""
        return next(kw for msg, kw in self.logs if "listener registered" in msg)


# ---------------------------------------------------------------------------
# The RNode default (SPEC RN4 as amended)
# ---------------------------------------------------------------------------


def test_unset_scope_drops_a_tcp_announce(monkeypatch, tmp_path):
    """Unset, a TCP announce from 3 hops out is neither posted nor counted."""
    run = _Run(monkeypatch, tmp_path, ()).connect()
    assert mod._announce_admitted(3, _TCP) is False
    run.announce("tcp_peer")
    assert run.upserts == []
    assert run.seen == 0


def test_unset_scope_drops_backbone_and_autointerface_announces(monkeypatch, tmp_path):
    """A Backbone peer and an AutoInterface peer are IP, not RNode: dropped."""
    run = _Run(monkeypatch, tmp_path, ()).connect()
    run.announce("backbone_peer", "auto_peer")
    assert run.ingested == set()
    assert run.seen == 0


def test_unset_scope_admits_an_rnode_announce(monkeypatch, tmp_path):
    """An announce heard on an RNodeInterface is ingested and counted."""
    run = _Run(monkeypatch, tmp_path, ()).connect()
    run.announce("rnode_peer")
    assert run.ingested == {"rnode_peer"}
    assert run.seen == 1
    assert run.record("rnode_peer")["interface"] == str(IFACES["rnode"])


def test_unset_scope_admits_an_rnode_multi_subinterface(monkeypatch, tmp_path):
    """A multi-radio RNode's sub-interface is an RNode, though its name says not.

    It prints as ``<parent>[<sub>]`` with no type text, so the class that
    ``get_interface_stats()`` reports for that name decides.
    """
    run = _Run(monkeypatch, tmp_path, ()).connect()
    run.announce("rnode_sub_peer")
    assert run.ingested == {"rnode_sub_peer"}
    assert run.record("rnode_sub_peer")["interface"] == "Multi Radio[868 Low]"


def test_unset_scope_keeps_this_machines_announces(monkeypatch, tmp_path):
    """0-hop announces and the host's own destinations stay in (SPEC RE4)."""
    run = _Run(monkeypatch, tmp_path, ()).connect()
    run.announce("own")
    assert run.ingested == {"own"}
    host = run.node_id("own")
    assert run.startup()["node_id"] == host
    snapshot = mod.ReticulumProvider().node_snapshot_items(run.iface)
    assert host in {node_id for node_id, _node in snapshot}


@pytest.mark.parametrize("raw", ["", '""', "''", "  "])
def test_compose_empty_value_is_the_rnode_scope(monkeypatch, tmp_path, raw):
    """What Compose, the image and a null NixOS option deliver is the default.

    ``${RETICULUM_INTERFACES:-}`` and both ``data/Dockerfile`` stages deliver an
    empty string; a quoted default would deliver ``""``.
    """
    run = _Run(monkeypatch, tmp_path, config._parse_reticulum_interfaces(raw))
    run.connect()
    assert mod._announce_admitted(3, _TCP) is False
    run.announce()
    assert run.ingested == {"rnode_peer", "rnode_sub_peer", "own"}


def test_star_ingests_every_interface(monkeypatch, tmp_path):
    """``*`` is the old default: every interface, IP included."""
    run = _Run(monkeypatch, tmp_path, config._parse_reticulum_interfaces("*"))
    run.connect().announce()
    assert run.ingested == ALL
    assert run.seen == len(PEERS)


def test_explicit_list_keeps_the_substring_rule(monkeypatch, tmp_path):
    """A list still matches names, so ``rnode`` misses a sub-interface."""
    run = _Run(monkeypatch, tmp_path, config._parse_reticulum_interfaces("RNode"))
    run.connect().announce()
    assert run.ingested == {"rnode_peer", "own"}
    assert run.warnings() == []


def test_the_scope_rules_apply_in_order(monkeypatch, tmp_path):
    """0 hops, then ``*``, then a missing name, then the default or the list."""
    _Run(monkeypatch, tmp_path, ())
    assert mod._announce_admitted(0, None) is True
    assert mod._announce_admitted(1, None) is False
    assert mod._announce_admitted(1, "") is False
    monkeypatch.setattr(config, "RETICULUM_INTERFACES", ("*",))
    assert mod._announce_admitted(1, None) is True
    assert mod._announce_admitted(None, _TCP) is True


# ---------------------------------------------------------------------------
# Connect-time warnings and the startup line
# ---------------------------------------------------------------------------


def test_connect_warns_once_when_the_stack_has_no_rnode(monkeypatch, tmp_path):
    """No RNode on the stack: one warning per connect, and only 0 hops survive."""
    run = _Run(monkeypatch, tmp_path, (), interfaces=NO_RNODE_STACK).connect()
    scope_warnings = [w for w in run.warnings() if "RETICULUM_INTERFACES=*" in w]
    assert len(scope_warnings) == 1
    assert "No RNode interface" in scope_warnings[0]
    # Classes, never names: a spawned interface's name can carry a peer address.
    [fields] = [kw for msg, kw in run.logs if "No RNode interface" in msg]
    assert fields["interface_classes"] == [
        "AutoInterface",
        "AutoInterfacePeer",
        "BackboneClientInterface",
        "TCPClientInterface",
    ]
    names = [str(IFACES[key]) for key in NO_RNODE_STACK]
    assert not any(name in str(fields) for name in names)
    run.announce("tcp_peer", "backbone_peer", "auto_peer", "own")
    # Never "fall back to all": the IP peers stay out.
    assert run.ingested == {"own"}
    assert len(run.warnings()) == 1
    run.connect()
    assert len(run.warnings()) == 2


def test_connect_warns_when_the_stats_rpc_is_rejected(monkeypatch, tmp_path):
    """A rejected RPC turns every name into LocalInterface[...]: say so.

    A shared instance authenticates RPC with a key from the config dir's
    identity, so an ingestor on another config dir is refused (SPEC RE3).
    """
    refused = multiprocessing.AuthenticationError("digest received was wrong")
    run = _Run(monkeypatch, tmp_path, (), stats=refused).connect()
    [(warning, fields)] = [
        (msg, kw) for msg, kw in run.logs if kw.get("severity") == "warn"
    ]
    assert "RETICULUM_CONFIG_DIR" in warning
    assert fields["error_class"] == "AuthenticationError"
    run.announce()
    assert run.ingested == {"own"}


def test_stack_without_stats_falls_back_to_the_rnode_name(monkeypatch, tmp_path):
    """No stats to read: the name decides, silently (no warning at connect)."""
    run = _Run(monkeypatch, tmp_path, (), stats="missing").connect()
    assert run.warnings() == []
    run.announce()
    # A single-radio RNode prints "RNodeInterface[...]"; a sub-interface does not.
    assert run.ingested == {"rnode_peer", "own"}


@pytest.mark.parametrize("raw", ["testnet", "*"])
def test_an_explicit_scope_never_warns_about_a_missing_rnode(
    monkeypatch, tmp_path, raw
):
    """A list or ``*`` is the operator's choice; only the default checks."""
    run = _Run(
        monkeypatch,
        tmp_path,
        config._parse_reticulum_interfaces(raw),
        interfaces=NO_RNODE_STACK,
    )
    assert run.connect().warnings() == []


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("", "rnode"), ("*", "*"), ("RNode, serial", ["rnode", "serial"])],
)
def test_startup_line_names_the_scope(monkeypatch, tmp_path, raw, expected):
    """The startup line says which scope is active, never "all"."""
    run = _Run(monkeypatch, tmp_path, config._parse_reticulum_interfaces(raw))
    assert run.connect().startup()["interfaces"] == expected


# ---------------------------------------------------------------------------
# The provider's radio-metadata tag follows the same class check (SPEC RL1)
# ---------------------------------------------------------------------------


def test_the_provider_tags_both_rnode_peers_with_radio_metadata(monkeypatch, tmp_path):
    """The provider tags both RNode peers' records with the LoRa values.

    ``run.record`` is the record the provider hands to ``handlers.upsert_node``,
    which ``_Run`` stubs.  The real one stamps the configured values on every
    posted record whatever the interface, a known gap outside this provider.
    """
    run = _Run(monkeypatch, tmp_path, ("*",)).connect()
    run.announce()
    stamped = {label for label in run.ingested if "lora_freq" in run.record(label)}
    assert stamped == {"rnode_peer", "rnode_sub_peer"}


# ---------------------------------------------------------------------------
# The name-to-class map (reticulum_interfaces)
# ---------------------------------------------------------------------------


class _Instance:
    """A stack whose interface list can change, or fail, between reads."""

    def __init__(self, *keys: str):
        """List the :data:`IFACES` named by *keys*."""
        self.entries = [_stats_entry(IFACES[key]) for key in keys]
        self.calls = 0
        self.error: BaseException | None = None

    def get_interface_stats(self) -> dict:
        """Return the stats, or raise :attr:`error`."""
        self.calls += 1
        if self.error is not None:
            raise self.error
        return {"interfaces": list(self.entries)}


@pytest.fixture
def classes():
    """Return :mod:`data.mesh_ingestor.protocols.reticulum_interfaces`.

    Reached through the provider module that imports it, so this file still
    imports, and its regression tests still run, on a tree without it.
    """
    return mod.reticulum_interfaces


def _cache(classes, serving, now=(0.0,)):
    """Return an ``InterfaceClassCache`` reading ``serving[0]`` as the instance.

    Parameters:
        classes: The :func:`classes` fixture.
        serving: One-item list holding the instance, so a test can swap it.
        now: One-item sequence holding the clock reading.
    """
    return classes.InterfaceClassCache(lambda: serving[0], clock=lambda: now[0])


def test_the_provider_reads_the_running_stack(monkeypatch, tmp_path):
    """The provider's map asks ``RNS.Reticulum.get_instance()`` (shared, RE3)."""
    run = _Run(monkeypatch, tmp_path, ())
    assert mod._running_instance() is mod.RNS.Reticulum.get_instance()
    assert mod._INTERFACE_CLASSES.class_of(_TCP) == "TCPClientInterface"
    assert run.stack.stats_calls == 1


def test_class_map_is_cached_and_reread_on_a_miss(classes):
    """A hit costs nothing; a miss re-reads, at most once per refresh window."""
    now = [100.0]
    stack = _Instance("rnode")
    cache = _cache(classes, [stack], now)
    rnode, sub = str(IFACES["rnode"]), str(IFACES["rnode_sub"])

    assert cache.class_of(rnode) == "RNodeInterface"
    assert cache.class_of(rnode) == "RNodeInterface"
    assert stack.calls == 1
    # rnsd spawns a sub-interface after the read: inside the window it is unknown.
    stack.entries.append(_stats_entry(IFACES["rnode_sub"]))
    now[0] += classes.REFRESH_SECONDS - 1
    assert cache.class_of(sub) is None
    assert stack.calls == 1
    now[0] += 1
    assert cache.class_of(sub) == "RNodeSubInterface"
    assert stack.calls == 2


def test_read_refreshes_now_and_reports_the_failure(classes):
    """``read`` ignores the window; an RPC error reaches the caller."""
    stack = _Instance("tcp")
    cache = _cache(classes, [stack])
    assert cache.read() == {_TCP: "TCPClientInterface"}
    assert cache.read() == {_TCP: "TCPClientInterface"}
    assert stack.calls == 2
    stack.error = multiprocessing.AuthenticationError("digest received was wrong")
    with pytest.raises(multiprocessing.AuthenticationError):
        cache.read()
    # The last good map still answers.
    assert cache.class_of(_TCP) == "TCPClientInterface"


def test_a_malformed_reply_keeps_the_previous_map(classes):
    """A reply without an interface list adds nothing and loses nothing."""
    stack = _Instance("tcp")
    cache = _cache(classes, [stack])
    assert cache.read() == {_TCP: "TCPClientInterface"}
    stack.get_interface_stats = lambda: {"transport_id": None}
    assert cache.read() is None
    assert cache.class_of(_TCP) == "TCPClientInterface"


def test_class_map_lookup_survives_a_dead_or_silent_stack(classes):
    """No instance, a raising accessor, no stats method, or a failing RPC: None."""
    serving: list = [None]
    cache = _cache(classes, serving)
    assert cache.class_of(_TCP) is None
    assert cache.read() is None

    def _gone():
        """Stand in for an accessor of a stack that has shut down."""
        raise RuntimeError("stack is gone")

    assert classes.InterfaceClassCache(_gone).class_of(_TCP) is None

    serving[0] = types.SimpleNamespace()
    assert cache.class_of(_TCP) is None
    assert cache.read() is None

    stack = _Instance("tcp")
    stack.error = OSError("rpc down")
    serving[0] = stack
    assert cache.class_of(_TCP) is None
    # The failed read starts the window too: no retry storm per announce.
    assert cache.class_of(_TCP) is None
    assert stack.calls == 1


def test_a_new_instance_discards_the_map(classes):
    """The map belongs to the stack it was read from."""
    serving = [_Instance("rnode")]
    cache = _cache(classes, serving)
    assert cache.class_of(str(IFACES["rnode"])) == "RNodeInterface"
    serving[0] = _Instance("tcp")
    assert cache.class_of(str(IFACES["rnode"])) is None
    assert cache.class_of(_TCP) == "TCPClientInterface"


def test_interface_classes_skips_malformed_stats(classes):
    """Anything but a list of name/type entries is skipped, never fatal."""
    parse = classes.interface_classes
    assert parse(None) is None
    assert parse({"transport_id": None}) is None
    assert parse({"interfaces": "nope"}) is None
    entries = [None, {"name": 1, "type": "X"}, {"name": "A[b]"}, _stats_entry(_MULTI)]
    assert parse({"interfaces": entries}) == {
        "RNodeMultiInterface[Multi Radio]": "RNodeMultiInterface"
    }


def test_every_rnode_class_counts_as_an_rnode(classes):
    """The three RNode classes RNS ships, and nothing else."""
    assert classes.RNODE_INTERFACE_CLASSES == {
        "RNodeInterface",
        "RNodeMultiInterface",
        "RNodeSubInterface",
    }
    rnodes = {type(IFACES[key]).__name__ for key in ("rnode", "multi", "rnode_sub")}
    assert rnodes == classes.RNODE_INTERFACE_CLASSES


# ---------------------------------------------------------------------------
# Operator docs (ACCEPTANCE RE-A16)
# ---------------------------------------------------------------------------

_OLD_DEFAULT = re.compile(
    r"empty ingests|ingests everything|from every interface|"
    r"\(the default\) ingests|admits everything"
)
"""Phrases that stated the old "empty ingests every interface" default."""


@pytest.mark.parametrize(
    "name",
    [
        "README.md",
        "flake.nix",
        "configure.sh",
        "data/mesh_ingestor/CONTRACTS.md",
        "data/mesh_ingestor/config.py",
        "data/mesh_ingestor/protocols/reticulum.py",
    ],
)
def test_docs_state_the_rnode_default(name):
    """No surface still says an unset scope ingests every interface."""
    text = (REPO_ROOT / name).read_text(encoding="utf-8")
    assert _OLD_DEFAULT.findall(text) == [], f"{name} still states the old default"


def test_readme_names_the_star_scope():
    """The README tells the operator how to get every interface back."""
    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
    assert "RETICULUM_INTERFACES=*" in readme
