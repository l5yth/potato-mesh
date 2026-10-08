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
"""End-to-end tests for the Reticulum stack diagnostics (SPEC RG1-RG4, RG-A1).

An ingestor that heard nothing logged the same lines whatever the cause: its
own stack instead of ``rnsd``'s, an ``rnsd`` that hears nothing usable,
announces of other aspects only, or announces the interface scope drops.  The
connect line and the hourly announce summary now tell the four apart, in
classes and counts only (Invariant II).

Each test drives the real :class:`ReticulumProvider` and the real daemon loop
against a fake RNS stack on a fake clock, and reads what an operator reads.
The diagnostics module is reached through the provider module, so this file
still imports, and its regression tests still run, on a tree without it.  Its
own unit tests live in ``test_reticulum_diagnostics_unit.py``.
"""

from __future__ import annotations

import io
import multiprocessing
import re
import sys
import time
import types
from contextlib import redirect_stdout
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:  # pragma: no cover - conftest adds it
    sys.path.insert(0, str(REPO_ROOT))

import RNS  # noqa: E402 - path setup
from RNS.Interfaces.LocalInterface import (  # noqa: E402 - path setup
    LocalClientInterface,
    LocalServerInterface,
)
from RNS.Interfaces.RNodeInterface import RNodeInterface  # noqa: E402

from daemon_fakes import make_state  # noqa: E402 - shared daemon doubles
from data.mesh_ingestor import (  # noqa: E402 - path setup
    activity,
    config,
    daemon,
    ingestors,
    queue,
)
from data.mesh_ingestor.handlers import _state as handler_state  # noqa: E402
from data.mesh_ingestor.protocols import reticulum as mod  # noqa: E402
from data.mesh_ingestor.protocols import reticulum_position  # noqa: E402
from test_reticulum_scope_unit import _bare  # noqa: E402 - shared RNS doubles
from test_reticulum_unit import _FakeIdentity  # noqa: E402 - shared RNS doubles

RNODE = "RNodeInterface[RNode LoRa]"
"""Printed name of rnsd's RNode, as ``get_next_hop_if_name`` returns it."""

PEER = _FakeIdentity(bytes.fromhex("aabbccdd" + "11" * 12))
"""A remote peer one hop out."""

PEER_DEST = bytes.fromhex("c0ffee00" + "22" * 12)
"""The destination hash the peer announces."""

TRANSPORT_HASH = bytes.fromhex("fbf8e338" + "44" * 12)
"""The host's persisted transport identity."""

SHARED = {
    "name": "Shared Instance[default]",
    "type": "LocalServerInterface",
    "clients": 2,
}
"""rnsd's shared instance, serving the ingestor and one other program."""

RNODE_DEAF = {
    "name": RNODE,
    "type": "RNodeInterface",
    "status": True,
    "rxb": 4_950_000,
    "txb": 0,
    "arxc": 0,
    "ifac_size": None,
    "protocol_violations": 2760,
    "ifac_violations": 12135,
    "packet_filter_hits": 2012,
}
"""The field's RNode in ``rnstatus``: 4.95 MB heard, no announce accepted."""

RNODE_OK = dict(RNODE_DEAF, arxc=40, ifac_violations=0, protocol_violations=0)
"""An RNode that accepts announces."""

REJECTED = multiprocessing.AuthenticationError("digest received was wrong")
"""What a shared instance answers an RPC from another config dir with (RE3)."""

_TIMESTAMP = re.compile(r"^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] ")
"""The timestamp ``config._debug_log`` prints first, which differs per run."""

_STATE_LINE = "Reticulum stack state"
"""Message of the connect line (SPEC RG1)."""

_SUMMARY_LINE = "Reticulum announce summary"
"""Message of the hourly summary (SPEC RG2)."""


class _Stack:
    """The running ``RNS.Reticulum`` as the ingestor process sees it.

    Parameters:
        role: ``client`` (attached to ``rnsd``), ``shared`` (this process runs
            the stack as the shared instance) or ``standalone``.
        interfaces: ``get_interface_stats()`` entries.
        stats_error: Exception every stats read raises (a refused RPC).
        next_hop: Name ``get_next_hop_if_name`` returns for any destination.
        next_hop_error: Exception ``get_next_hop_if_name`` raises.
        extra_stats: Further top-level keys of the stats reply.
    """

    def __init__(
        self,
        *,
        role="client",
        interfaces=(),
        stats_error=None,
        next_hop=RNODE,
        next_hop_error=None,
        extra_stats=None,
    ):
        """Build the stack; nothing on it announces, so the host id stays pending."""
        self.is_connected_to_shared_instance = role == "client"
        self.is_shared_instance = role == "shared"
        self.is_standalone_instance = role == "standalone"
        self.interfaces = [dict(entry) for entry in interfaces]
        self.stats_error = stats_error
        self.next_hop = next_hop
        self.next_hop_error = next_hop_error
        self.extra_stats = dict(extra_stats or {})
        self.stats_reads = 0
        self.path_table_reads = 0

    def get_interface_stats(self) -> dict:
        """Answer a stats read, counting it."""
        self.stats_reads += 1
        if self.stats_error is not None:
            raise self.stats_error
        entries = [dict(entry) for entry in self.interfaces]
        return {"interfaces": entries, **self.extra_stats}

    def get_next_hop_if_name(self, _dest_hash) -> str:
        """Name the interface an announce arrived on, as rnsd sees it."""
        if self.next_hop_error is not None:
            raise self.next_hop_error
        return self.next_hop

    def get_path_table(self, max_hops=None) -> list:
        """Answer an empty 0-hop table, counting the read."""
        self.path_table_reads += 1
        return []


def _client_socket():
    """Return this client's own ``LocalClientInterface``; forwards raise its ``arxc``."""
    return _bare(LocalClientInterface, socket_path="\0rns/default", arxc=0)


class _World:
    """The real provider in the real daemon loop, on a fake stack and clock.

    Parameters:
        monkeypatch: A pytest monkeypatch, undone when the test ends.
        tmp_path: The ``RETICULUM_CONFIG_DIR`` (it holds no config).
        stack: The :class:`_Stack` ``RNS.Reticulum.get_instance()`` returns.
        local: ``RNS.Transport.interfaces``, this process's own interfaces.
        scope: ``RETICULUM_INTERFACES``; the field set ``rnode``.
        debug: ``DEBUG``; the default level prints info and warn lines only.
    """

    def __init__(self, monkeypatch, tmp_path, stack, *, local, scope, debug=False):
        """Install the fakes; nothing is connected yet."""
        self.stack = stack
        self.local = list(local)
        self.clock = {"mono": 10_000.0}
        self.posts: list = []
        self.sent: list = []
        self.printed: list = []
        self._out = io.StringIO()
        mp = monkeypatch
        socket = self.local[0] if self.local else None
        mp.setattr(RNS.Reticulum, "get_instance", staticmethod(lambda: stack))
        mp.setattr(RNS.Reticulum, "transport_enabled", staticmethod(lambda: False))
        mp.setattr(RNS.Transport, "interfaces", self.local)
        for name in ("register_announce_handler", "deregister_announce_handler"):
            mp.setattr(RNS.Transport, name, staticmethod(lambda _handler: None))
        mp.setattr(RNS.Transport, "hops_to", staticmethod(lambda _dh: 1))
        mp.setattr(RNS.Transport, "next_hop_interface", staticmethod(lambda _d: socket))
        mp.setattr(
            RNS.Transport,
            "internal_identity",
            staticmethod(lambda: types.SimpleNamespace(hash=TRANSPORT_HASH)),
        )
        mp.setattr(RNS.Identity, "recall", staticmethod(lambda *_a, **_k: None))
        mp.setattr(
            RNS.Identity, "recall_app_data", staticmethod(lambda *_a, **_k: None)
        )
        mp.setattr(RNS.Packet, "send", lambda *_a, **_k: self.sent.append("send"))
        mp.setattr(
            RNS.Destination, "announce", lambda *_a, **_k: self.sent.append("announce")
        )
        for name, value in (
            ("PROTOCOL", "reticulum"),
            ("INGESTOR_NODE_ID", None),
            ("CONNECTION", None),
            ("RETICULUM_CONFIG_DIR", str(tmp_path)),
            ("RETICULUM_INTERFACES", scope),
            ("RETICULUM_FREQ", None),
            ("RETICULUM_PRESET", None),
            ("LORA_FREQ", None),
            ("MODEM_PRESET", None),
            ("DEBUG", debug),
            ("_RECONNECT_INITIAL_DELAY_SECS", 0.0),
            ("_SELF_NODE_REPORT_INTERVAL_SECS", 3600.0),
            ("_CLOSE_TIMEOUT_SECS", 0.0),
        ):
            mp.setattr(config, name, value)
        mp.setattr(time, "monotonic", lambda: self.clock["mono"])
        mp.setattr(time, "time", lambda: 1_791_000_000 + self.clock["mono"])
        real_log = config._debug_log

        def _log(message, **fields):
            """Print through the real logger and keep what it printed."""
            before = self._out.tell()
            with redirect_stdout(self._out):
                real_log(message, **fields)
            if self._out.tell() != before:
                self.printed.append((fields.get("severity", "debug"), message, fields))

        mp.setattr(config, "_debug_log", _log)
        mp.setattr(
            queue,
            "_queue_post_json",
            lambda path, payload, **_kw: self.posts.append((path, payload)),
        )
        mp.setattr(daemon, "_process_announcements", lambda s: s.last_announce)
        for name in (
            "_host_node_id",
            "_host_telemetry_last_rx",
            "_host_nodeinfo_last_seen",
            "_last_packet_monotonic",
        ):
            mp.setattr(handler_state, name, None)
        mp.setattr(ingestors.STATE, "node_id", None)
        mp.setattr(ingestors.STATE, "last_heartbeat", None)
        mp.setattr(activity, "_packet_count", 0)
        mp.setattr(reticulum_position, "_last_outcome", None)
        self.state = make_state(
            provider=mod.ReticulumProvider(), inactivity_reconnect_secs=3600.0
        )

    def run(self, passes: int, deliver=None) -> None:
        """Drive the loop as ``daemon.main`` does, for *passes* full passes.

        A pass that returns ``True`` runs again at once; one that returns
        ``False`` waits ``SNAPSHOT_SECS``, 60 s on the fake clock.  *deliver*
        runs at most once per 60 s, while connected, before the pass.
        """
        done, due = 0, True
        while done < passes:
            if deliver is not None and due and self.state.iface is not None:
                deliver(self)
                due = False
            if not daemon._loop_iteration(self.state):
                self.clock["mono"] += 60.0
                done, due = done + 1, True

    def lines(self) -> list[str]:
        """Return every printed line without its timestamp."""
        return [_TIMESTAMP.sub("", line) for line in self._out.getvalue().splitlines()]

    def fields(self, message: str) -> list[dict]:
        """Return the fields of every printed line logging *message*."""
        return [kw for _sev, msg, kw in self.printed if msg == message]

    def summary(self) -> tuple[str, dict]:
        """Return the severity and fields of the one hourly summary printed."""
        found = [(sev, kw) for sev, msg, kw in self.printed if msg == _SUMMARY_LINE]
        assert len(found) == 1, f"{len(found)} hourly summaries printed"
        return found[0]


def _forward(aspect: str):
    """Return a ``deliver`` callback: rnsd forwards one *aspect* announce per pass.

    RNS hands an announce only to the handlers whose aspect matches, so one
    of another aspect raises the client socket's ``arxc`` and runs nothing.
    """

    def deliver(world) -> None:
        for iface in world.local:
            if isinstance(iface, LocalClientInterface):
                iface.arxc += 1
        for handler in world.state.iface._announce_handlers:
            if handler.aspect_filter == aspect:
                handler.received_announce(PEER_DEST, PEER, b"Remote Peer")

    return deliver


def _own_stack():
    """(a) The ingestor runs its own stack, and its RNode is offline (rnsd holds it)."""
    rnode = dict(
        RNODE_DEAF,
        status=False,
        rxb=0,
        protocol_violations=0,
        ifac_violations=0,
        packet_filter_hits=0,
    )
    stack = _Stack(role="shared", interfaces=[dict(SHARED, clients=0), rnode])
    own = [_bare(LocalServerInterface, arxc=0), _bare(RNodeInterface, arxc=0)]
    return stack, own, None


def _rnsd_hears_nothing_usable():
    """(b) Attached to rnsd, whose RNode hears bytes but accepts no announce."""
    return _Stack(interfaces=[SHARED, RNODE_DEAF]), [_client_socket()], None


def _other_aspects_only():
    """(c) rnsd forwards announces, all of an aspect the ingestor does not read."""
    return _Stack(interfaces=[SHARED, RNODE_OK]), [_client_socket()], "call.audio"


def _dropped_by_scope():
    """(d) Announces reach a handler; the refused RPC makes each read LocalInterface."""
    stack = _Stack(
        interfaces=[SHARED, RNODE_OK], stats_error=REJECTED, next_hop_error=REJECTED
    )
    return stack, [_client_socket()], "lxmf.delivery"


_CAUSES = {
    "a_own_stack": _own_stack,
    "b_rnsd_hears_nothing_usable": _rnsd_hears_nothing_usable,
    "c_other_aspects_only": _other_aspects_only,
    "d_dropped_by_scope": _dropped_by_scope,
}
"""The four reasons the field ingestor heard nothing, from the diagnosis."""


def _cycle(tmp_path, cause: str) -> _World:
    """Run one cause for 62 passes: connect, an hour, the reconnect, one more pass.

    Nothing is admitted in any cause, so the 1 h inactivity reconnect fires,
    and the hourly summary follows the new connect line in the same pass.
    """
    stack, local, aspect = _CAUSES[cause]()
    with pytest.MonkeyPatch.context() as mp:
        world = _World(mp, tmp_path, stack, local=local, scope=("rnode",))
        world.run(62, deliver=None if aspect is None else _forward(aspect))
    return world


def _diag():
    """Return the diagnostics module, through the provider module that imports it."""
    return mod.reticulum_diagnostics


def _reads_own_stack(world) -> None:
    """(a) names the role and the offline RNode, and says to attach to rnsd."""
    first, _again = world.fields(_STATE_LINE)
    assert (first["role"], first["rnode_online"]) == ("shared", "0/1")
    severity, summary = world.summary()
    assert (severity, summary["received"], summary["delivered"]) == ("warn", 0, {})
    assert summary["hints"][0] == _diag().HINT_ROLE


def _reads_deaf_rnode(world) -> None:
    """(b) names the RNode's counters, and says to check IFAC and the radio."""
    first, _again = world.fields(_STATE_LINE)
    assert first["role"] == "client"
    assert (first["rnode_rxb"], first["rnode_arxc"]) == (4_950_000, 0)
    assert (first["rnode_ifac"], first["rnode_ifac_violations"]) == ("off", 12135)
    severity, summary = world.summary()
    assert (severity, summary["received"]) == ("warn", 0)
    assert summary["hints"][0] == _diag().HINT_RNODE


def _reads_other_aspects(world) -> None:
    """(c) shows announces arriving, none delivered, and stays info."""
    _first, again = world.fields(_STATE_LINE)
    assert again["received"] == 60
    severity, summary = world.summary()
    assert (severity, summary["received"], summary["delivered"]) == ("info", 60, {})
    assert "hints" not in summary


def _reads_scope_drops(world) -> None:
    """(d) names the refused RPC and the drops, and says to fix the config dir."""
    first, _again = world.fields(_STATE_LINE)
    assert first["stats"] == "AuthenticationError"
    severity, summary = world.summary()
    assert severity == "warn"
    assert summary["delivered"] == {"lxmf.delivery": 60}
    assert (summary["admitted"], summary["dropped"]) == ({}, {"scope": 60})
    assert summary["scope_classes"] == {"unknown": 60}
    assert summary["hints"][0] == _diag().HINT_STATS


_SIGNATURES = {
    "a_own_stack": _reads_own_stack,
    "b_rnsd_hears_nothing_usable": _reads_deaf_rnode,
    "c_other_aspects_only": _reads_other_aspects,
    "d_dropped_by_scope": _reads_scope_drops,
}
"""What each cause's transcript must say about itself."""


@pytest.mark.parametrize("cause", ["a", "b", "c", "d"])
def test_logs_tell_apart_why_nothing_arrives(tmp_path, cause):
    """At the default log level, each cause reads differently and names itself.

    The inverse of the diagnosis: with ``RETICULUM_INTERFACES=rnode`` as in the
    field, all four transcripts were identical, line for line, so the logs
    could not say which of the four was happening.  Each run still posts
    nothing and transmits nothing, and the diagnostics read no path table.
    """
    worlds = {name: _cycle(tmp_path, name) for name in _CAUSES}
    name = next(label for label in _CAUSES if label.startswith(f"{cause}_"))
    for other in _CAUSES:
        if other != name:
            assert (
                worlds[name].lines() != worlds[other].lines()
            ), f"{name} reads like {other}"
    _SIGNATURES[name](worlds[name])
    assert worlds[name].posts == []
    assert worlds[name].sent == []


# ---------------------------------------------------------------------------
# Privacy (Invariant II): classes and counts, never names or hashes
# ---------------------------------------------------------------------------

_SECRET_RNODE = "RNodeInterface[Garden Shed 52.5029N]"
"""An RNode whose configured name says where it is."""

_SECRET_PEER = "AutoInterfacePeer[eth0/fe80::dead:beef]"
"""A LAN peer whose printed name carries its address."""

_SECRET_FIELDS = {
    "short_name": "Garden Shed 52.5029N",
    "hash": "5ec2e75ec2e75ec2",
    "ifac_netname": "sentinel-netname",
    "ifac_signature": "sentinel-signature",
    "i2p_b32": "sentinelpeer.b32.i2p",
    "switch_id": "5e1f5w17c4",
    "endpoint_id": "5e1fe4d901",
    "parent_interface_name": "Sentinel Parent Interface",
    "autoconnect_source": "sentinel-autoconnect",
    "blocked_ip_list": "198.51.100.77",
}
"""Stats keys the diagnostics must never log, with recognisable values."""

_SECRET_STATS = {"transport_id": "7a4e5b0a7d1d", "network_id": "ne7w0rk1d5e1f"}
"""Top-level stats keys whose values must never be logged (presence only)."""


def _secrets() -> list[str]:
    """Return every string that must not appear in a logged line."""
    return [
        _SECRET_RNODE,
        _SECRET_PEER,
        "fe80::dead:beef",
        "Garden Shed",
        PEER_DEST.hex()[:8],
        *_SECRET_FIELDS.values(),
        *_SECRET_STATS.values(),
    ]


def _private_world(monkeypatch, tmp_path, debug: bool) -> _World:
    """Run an hour on a stack full of private values, half its announces dropped.

    The scope is the RNode default, so announces over the LAN peer are dropped
    and announces over the RNode are admitted, which keeps the connection up
    until the hourly summary.
    """
    stack = _Stack(
        interfaces=[
            SHARED,
            dict(RNODE_OK, name=_SECRET_RNODE, ifac_size=8, **_SECRET_FIELDS),
            {"name": _SECRET_PEER, "type": "AutoInterfacePeer", **_SECRET_FIELDS},
        ],
        next_hop=_SECRET_PEER,
        extra_stats=_SECRET_STATS,
    )
    world = _World(
        monkeypatch, tmp_path, stack, local=[_client_socket()], scope=(), debug=debug
    )
    forward = _forward("lxmf.delivery")

    def alternate(world) -> None:
        stack.next_hop = (
            _SECRET_RNODE if stack.next_hop == _SECRET_PEER else _SECRET_PEER
        )
        forward(world)

    world.run(61, deliver=alternate)
    return world


def test_diagnostics_log_classes_and_counts_never_names(monkeypatch, tmp_path):
    """No logged line carries a name, hash, IFAC value, id or destination hash.

    The stack lists an RNode named after its location and a LAN peer named by
    its address, every private stats key, a ``transport_id`` and a
    ``network_id``.  At the default level every line is checked; the
    diagnostics lines are there, and say what they say in classes.
    """
    world = _private_world(monkeypatch, tmp_path, debug=False)
    text = "\n".join(world.lines())
    assert [secret for secret in _secrets() if secret in text] == []
    states = world.fields(_STATE_LINE)
    assert len(states) == 1
    state = states[0]
    assert state["interfaces"] == {
        "AutoInterfacePeer": 1,
        "LocalServerInterface": 1,
        "RNodeInterface": 1,
    }
    assert state["rnode_ifac"] == "on"  # from ifac_size, never the netname
    severity, summary = world.summary()
    assert severity == "info"  # half the announces were admitted
    assert summary["scope_classes"] == {"AutoInterfacePeer": 30}
    assert summary["admitted"] == {"lxmf.delivery": 30}


def test_per_announce_lines_stay_debug(monkeypatch, tmp_path):
    """With ``DEBUG=1`` the per-announce lines print as before; ours stay private.

    The skip line names the interface it skipped, as it did before this
    change, and only at debug; the two diagnostics lines carry no secret.
    """
    world = _private_world(monkeypatch, tmp_path, debug=True)
    skips = [
        (severity, kw["interface"])
        for severity, msg, kw in world.printed
        if msg.startswith("Skipped Reticulum announce")
    ]
    assert skips and set(skips) == {("debug", _SECRET_PEER)}
    ours = [
        line for line in world.lines() if line.endswith((_STATE_LINE, _SUMMARY_LINE))
    ]
    assert len(ours) == 2
    assert [secret for secret in _secrets() if secret in "\n".join(ours)] == []
