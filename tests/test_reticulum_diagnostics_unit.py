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
"""Unit tests for :mod:`data.mesh_ingestor.protocols.reticulum_diagnostics`.

The stack role, the privacy-filtered stack facts the connect line prints, the
thread-safe announce tally, the hourly summary with its warning and hints, its
rate limit, and the provider's wiring of all four (SPEC RG1-RG4).  The module
is reached through the provider module (the :func:`diag` fixture), as the
end-to-end file reaches it.
"""

from __future__ import annotations

import sys
import threading
import time
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:  # pragma: no cover - conftest adds it
    sys.path.insert(0, str(REPO_ROOT))

from RNS.Interfaces.AutoInterface import (  # noqa: E402 - path setup
    AutoInterface,
    AutoInterfacePeer,
)
from RNS.Interfaces.LocalInterface import (  # noqa: E402 - path setup
    LocalClientInterface,
    LocalServerInterface,
)
from RNS.Interfaces.RNodeInterface import RNodeInterface  # noqa: E402

from data.mesh_ingestor import config  # noqa: E402 - path setup
from data.mesh_ingestor.handlers import _state as handler_state  # noqa: E402
from data.mesh_ingestor.protocols import reticulum as mod  # noqa: E402
from test_reticulum_diagnostics import (  # noqa: E402 - shared stack doubles
    PEER,
    PEER_DEST,
    REJECTED,
    RNODE_DEAF,
    RNODE_OK,
    SHARED,
    _STATE_LINE as _STATE,
    _SUMMARY_LINE as _SUMMARY,
    _Stack,
    _client_socket,
)
from test_reticulum_scope_unit import _bare  # noqa: E402 - shared RNS doubles
from test_reticulum_unit import (  # noqa: E402 - shared RNS doubles
    _fake_rns,
    _no_ingestor_node_id,
)

_FAILED = "Reticulum diagnostics failed"
"""Message of a diagnostics read that raised (SPEC RG4)."""

_LAN = "AutoInterfacePeer[eth0/fe80::1]"
"""A LAN peer's printed name."""


@pytest.fixture
def diag():
    """Return the diagnostics module, through the provider module that imports it."""
    return mod.reticulum_diagnostics


@pytest.fixture
def logged(monkeypatch):
    """Capture every ``config._debug_log`` call as ``(severity, message, fields)``.

    ``fields`` keeps ``context`` and drops ``severity``.
    """
    calls: list = []

    def _log(message, **fields):
        severity = fields.pop("severity", "debug")
        calls.append((severity, message, fields))

    monkeypatch.setattr(config, "_debug_log", _log)
    return calls


def _messages(logged) -> list[str]:
    """Return the message of every captured line, in order."""
    return [message for _severity, message, _fields in logged]


def _only(logged, message: str) -> tuple[str, dict]:
    """Return the severity and fields of the one captured *message* line."""
    found = [(sev, fields) for sev, msg, fields in logged if msg == message]
    assert len(found) == 1, f"{len(found)} {message!r} lines"
    return found[0]


class _Clock:
    """A settable monotonic clock."""

    def __init__(self) -> None:
        """Start at zero."""
        self.now = 0.0

    def __call__(self) -> float:
        """Return the current reading."""
        return self.now


def _hour(diag, stack, local, record=None):
    """Connect, let *record* change the stack and tally announces, then summarise.

    Parameters:
        diag: The diagnostics module.
        stack: The instance both reads see.
        local: What ``RNS.Transport.interfaces`` holds.
        record: Called with the diagnostics object inside the hour.

    Returns:
        The :class:`StackDiagnostics` after its first summary.
    """
    clock = _Clock()
    diagnostics = diag.StackDiagnostics(lambda: local, clock=clock)
    diagnostics.connected(stack)
    if record is not None:
        record(diagnostics)
    clock.now = diag.SUMMARY_INTERVAL_SECS
    diagnostics.tick(stack)
    return diagnostics


# ---------------------------------------------------------------------------
# The stack role and what reached this process (SPEC RG1)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("role", ["client", "shared", "standalone"])
def test_stack_role_reads_the_three_rns_flags(diag, role):
    """A client of rnsd, the shared instance itself, or a standalone stack."""
    assert diag.stack_role(_Stack(role=role)) == role


def test_stack_role_is_unknown_without_a_set_flag(diag):
    """A half-built instance sets no flag, a fake lacks them, and only ``True`` counts."""
    assert diag.stack_role(None) == "unknown"
    assert diag.stack_role(object()) == "unknown"
    assert diag.stack_role(_Stack(role="none")) == "unknown"
    truthy = types.SimpleNamespace(is_connected_to_shared_instance=1)
    assert diag.stack_role(truthy) == "unknown"


def test_received_is_what_rnsd_forwarded_to_a_client(diag):
    """A client's one interface is its socket to rnsd; its ``arxc`` is the count."""
    socket = _client_socket()
    socket.arxc = 7
    assert diag.received_announces([socket]) == 7


def test_received_counts_an_own_stack_once_per_announce(diag):
    """A parent is left out: some count their spawned interfaces' announces again."""
    auto = _bare(AutoInterface, arxc=9)
    peers = [
        _bare(AutoInterfacePeer, arxc=4, parent_interface=auto),
        _bare(AutoInterfacePeer, arxc=5, parent_interface=auto),
    ]
    server = _bare(LocalServerInterface, arxc=0)
    app = _bare(LocalClientInterface, arxc=2, parent_interface=server)
    rnode = _bare(RNodeInterface, arxc=3)
    assert diag.received_announces([auto, *peers, server, app, rnode]) == 14


def test_received_is_unknown_without_an_interface_list(diag):
    """No list is unknown; a missing or non-integer ``arxc`` counts nothing."""
    assert diag.received_announces(None) is None
    assert diag.received_announces("LocalInterface[rns/default]") is None
    odd = [
        _bare(LocalClientInterface),
        types.SimpleNamespace(arxc="7"),
        types.SimpleNamespace(arxc=True),
        types.SimpleNamespace(arxc=-3),
    ]
    assert diag.received_announces(odd) == 0


# ---------------------------------------------------------------------------
# The connect line: classes and counts (SPEC RG1)
# ---------------------------------------------------------------------------


def test_the_connect_line_summarises_classes_and_counts(diag):
    """Classes with counts, the RNode's counters and IFAC flag, the shared clients."""
    socket = _client_socket()
    socket.arxc = 3
    lan = {"name": _LAN, "type": "AutoInterfacePeer"}
    facts = diag.read_facts(_Stack(interfaces=[SHARED, RNODE_DEAF, lan]), [socket])
    assert diag.connect_fields(facts) == {
        "role": "client",
        "stats": "ok",
        "received": 3,
        "interfaces": {
            "AutoInterfacePeer": 1,
            "LocalServerInterface": 1,
            "RNodeInterface": 1,
        },
        "shared_clients": 2,
        "rnode_online": "1/1",
        "rnode_ifac": "off",
        "rnode_rxb": 4_950_000,
        "rnode_txb": 0,
        "rnode_arxc": 0,
        "rnode_protocol_violations": 2760,
        "rnode_ifac_violations": 12135,
        "rnode_filter_hits": 2012,
    }
    assert facts.classes[_LAN] == "AutoInterfacePeer"  # kept for the tally, not logged


def test_rnode_figures_count_each_radio_once(diag):
    """A multi-radio RNode counts its sub-interfaces; the device is not counted again."""
    multi = {
        "name": "RNodeMultiInterface[Multi]",
        "type": "RNodeMultiInterface",
        "status": True,
        "txb": 300,
    }
    low = dict(RNODE_OK, name="Multi[868]", type="RNodeSubInterface", txb=100)
    high = dict(low, name="Multi[433]", status=False, txb=200, ifac_size=8)
    fields = diag.connect_fields(
        diag.read_facts(_Stack(interfaces=[multi, low, high]), None)
    )
    assert fields["interfaces"] == {"RNodeMultiInterface": 1, "RNodeSubInterface": 2}
    assert (fields["rnode_online"], fields["rnode_ifac"]) == ("1/2", "mixed")
    assert (fields["rnode_txb"], fields["rnode_arxc"]) == (300, 80)
    assert "shared_clients" not in fields  # no shared instance listed
    assert fields["received"] is None  # no interface list to read


def test_ifac_is_on_when_every_radio_sets_a_size(diag):
    """``ifac_size`` alone says it; the network name is never read."""
    rnode = dict(RNODE_OK, ifac_size=8, ifac_netname="never-logged")
    fields = diag.connect_fields(diag.read_facts(_Stack(interfaces=[rnode]), []))
    assert fields["rnode_ifac"] == "on"
    assert "never-logged" not in repr(fields)


def test_a_stack_without_radios_has_no_rnode_figures(diag):
    """No RNode listed: the classes say so, and no RNode figure is invented."""
    tcp = {"name": "TCPInterface[Hub]", "type": "TCPClientInterface", "rxb": 9}
    fields = diag.connect_fields(diag.read_facts(_Stack(interfaces=[tcp]), []))
    assert fields == {
        "role": "client",
        "stats": "ok",
        "received": 0,
        "interfaces": {"TCPClientInterface": 1},
    }


def test_a_refused_stats_rpc_reports_its_class_only(diag):
    """The class names the failure; the message and the interfaces are not logged."""
    facts = diag.read_facts(_Stack(stats_error=REJECTED), [_client_socket()])
    fields = diag.connect_fields(facts)
    assert fields == {"role": "client", "stats": "AuthenticationError", "received": 0}
    assert facts.classes is None


@pytest.mark.parametrize(
    "instance",
    [None, object(), types.SimpleNamespace(get_interface_stats=None)],
    ids=["no_instance", "no_members", "not_callable"],
)
def test_a_stack_without_stats_is_unavailable(diag, instance):
    """Fakes and half-built instances lack the RNS members; ``getattr`` defaults apply."""
    fields = diag.connect_fields(diag.read_facts(instance, None))
    assert fields == {"role": "unknown", "stats": "unavailable", "received": None}


@pytest.mark.parametrize("reply", [None, [], {}, {"interfaces": "eth0"}])
def test_a_reply_without_an_interface_list_lists_none(diag, reply):
    """A read that answers with no list still succeeded: ``ok``, no classes."""
    instance = types.SimpleNamespace(get_interface_stats=lambda: reply)
    fields = diag.connect_fields(diag.read_facts(instance, []))
    assert (fields["stats"], fields["interfaces"]) == ("ok", {})


def test_malformed_entries_count_as_unknown_and_bad_counters_as_zero(diag):
    """Entries that are no mapping are skipped; a mapping without a class is unknown."""
    rnode = dict(RNODE_DEAF, rxb="4950000", arxc=None, txb=True, status="yes")
    reply = {"interfaces": [None, "eth0", {"name": "y"}, dict(rnode, ifac_size="8")]}
    instance = types.SimpleNamespace(get_interface_stats=lambda: reply)
    fields = diag.connect_fields(diag.read_facts(instance, []))
    assert fields["interfaces"] == {"RNodeInterface": 1, "unknown": 1}
    assert (fields["rnode_online"], fields["rnode_ifac"]) == ("0/1", "off")
    counters = (fields["rnode_rxb"], fields["rnode_txb"], fields["rnode_arxc"])
    assert counters == (0, 0, 0)


# ---------------------------------------------------------------------------
# The announce tally (SPEC RG2)
# ---------------------------------------------------------------------------


def test_the_tally_counts_each_outcome_by_aspect_and_reason(diag):
    """Delivered and admitted per aspect, drops per reason, scope drops per class."""
    tally = diag.AnnounceTally()
    tally.use_classes({_LAN: "AutoInterfacePeer"})
    tally.admitted("lxmf.delivery")
    tally.admitted("nomadnetwork.node")
    tally.out_of_scope("lxmf.delivery", _LAN)
    tally.out_of_scope("lxmf.delivery", "TCPInterface[Hub]")  # not in the map
    tally.out_of_scope("lxmf.propagation", None)
    tally.out_of_scope("lxmf.propagation", "")
    tally.dropped("lxmf.delivery", "unusable_hash")
    tally.dropped("nomadnetwork.node", "error")
    counts = tally.drain()
    assert counts.delivered == {
        "lxmf.delivery": 4,
        "lxmf.propagation": 2,
        "nomadnetwork.node": 2,
    }
    assert counts.admitted == {"lxmf.delivery": 1, "nomadnetwork.node": 1}
    assert counts.dropped == {
        "error": 1,
        "no_interface": 2,
        "scope": 2,
        "unusable_hash": 1,
    }
    assert counts.scope_classes == {"AutoInterfacePeer": 1, "unknown": 1}
    assert tally.drain() == diag.TallyCounts({}, {}, {}, {})  # drained


def test_the_tally_counts_every_announce_from_many_threads(diag):
    """RNS runs each handler on a thread of its own; no count is lost."""
    tally = diag.AnnounceTally()

    def work() -> None:
        for _ in range(2000):
            tally.admitted("lxmf.delivery")
            tally.out_of_scope("nomadnetwork.node", None)

    threads = [threading.Thread(target=work) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    counts = tally.drain()
    assert counts.delivered == {"lxmf.delivery": 16000, "nomadnetwork.node": 16000}
    assert counts.dropped == {"no_interface": 16000}


# ---------------------------------------------------------------------------
# The hourly summary, its warning and hints (SPEC RG2, RG3)
# ---------------------------------------------------------------------------


def test_an_hour_with_admitted_announces_is_info(diag, logged):
    """Counts per aspect and reason, the received delta and the RNode deltas."""
    socket = _client_socket()
    stack = _Stack(interfaces=[SHARED, RNODE_OK])

    def record(diagnostics) -> None:
        socket.arxc += 3
        stack.interfaces[1].update(rxb=RNODE_OK["rxb"] + 600, arxc=43, txb=12)
        diagnostics.tally.admitted("lxmf.delivery")
        diagnostics.tally.admitted("lxmf.delivery")
        diagnostics.tally.out_of_scope("lxmf.delivery", "AutoInterfacePeer[x]")

    _hour(diag, stack, [socket], record)
    assert _messages(logged) == [_STATE, _SUMMARY]
    assert _only(logged, _SUMMARY) == (
        "info",
        {
            "context": "reticulum.summary",
            "delivered": {"lxmf.delivery": 3},
            "admitted": {"lxmf.delivery": 2},
            "dropped": {"scope": 1},
            "scope_classes": {"unknown": 1},
            "received": 3,
            "stats": "ok",
            "rnode_rxb": 600,
            "rnode_txb": 12,
            "rnode_arxc": 3,
            "rnode_protocol_violations": 0,
            "rnode_ifac_violations": 0,
            "rnode_filter_hits": 0,
        },
    )
    assert _only(logged, _STATE)[0] == "info"


def test_an_hour_with_nothing_received_warns_with_hints(diag, logged, monkeypatch):
    """``received`` 0: a warning, with the hints the connect facts call for."""
    monkeypatch.setattr(handler_state, "_host_node_id", None)
    _hour(diag, _Stack(interfaces=[SHARED, RNODE_DEAF]), [_client_socket()])
    severity, fields = _only(logged, _SUMMARY)
    assert (severity, fields["received"], fields["delivered"]) == ("warn", 0, {})
    assert fields["hints"] == [diag.HINT_RNODE, diag.HINT_PATHS, diag.HINT_HOST_ID]


def test_an_hour_the_scope_dropped_entirely_warns(diag, logged, monkeypatch):
    """Scope and no-interface drops together: the scope dropped all it was given."""
    monkeypatch.setattr(handler_state, "_host_node_id", "!27716218")
    socket = _client_socket()

    def record(diagnostics) -> None:
        socket.arxc += 3
        diagnostics.tally.out_of_scope("lxmf.delivery", _LAN)
        diagnostics.tally.out_of_scope("lxmf.delivery", None)
        diagnostics.tally.out_of_scope("nomadnetwork.node", _LAN)

    lan = {"name": _LAN, "type": "AutoInterfacePeer"}
    _hour(diag, _Stack(interfaces=[SHARED, RNODE_OK, lan]), [socket], record)
    severity, fields = _only(logged, _SUMMARY)
    assert (severity, fields["received"]) == ("warn", 3)
    assert fields["dropped"] == {"no_interface": 1, "scope": 2}
    assert fields["scope_classes"] == {"AutoInterfacePeer": 2}
    assert fields["hints"] == [diag.HINT_PATHS]  # the host id is registered


def test_an_hour_with_other_drops_stays_info(diag, logged):
    """An unusable hash or an error is no scope drop and warns on its own line."""
    socket = _client_socket()

    def record(diagnostics) -> None:
        socket.arxc += 2
        diagnostics.tally.out_of_scope("lxmf.delivery", _LAN)
        diagnostics.tally.dropped("lxmf.delivery", "unusable_hash")

    _hour(diag, _Stack(interfaces=[SHARED, RNODE_OK]), [socket], record)
    severity, fields = _only(logged, _SUMMARY)
    assert severity == "info"
    assert "hints" not in fields


def test_an_unreadable_stack_never_warns_by_itself(diag, logged):
    """No stats, no interface list: the lines say so, at info."""
    _hour(diag, object(), None)
    assert _only(logged, _STATE) == (
        "info",
        {
            "context": "reticulum.connect",
            "role": "unknown",
            "stats": "unavailable",
            "received": None,
        },
    )
    severity, fields = _only(logged, _SUMMARY)
    assert (severity, fields["received"], fields["stats"]) == (
        "info",
        None,
        "unavailable",
    )
    assert "rnode_rxb" not in fields


def test_rnode_deltas_count_a_reset_counter_from_zero(diag, logged):
    """rnsd restarted inside the hour: a counter below its last reading counts anew."""
    socket = _client_socket()
    stack = _Stack(interfaces=[SHARED, dict(RNODE_OK, rxb=1000, arxc=40)])

    def record(_diagnostics) -> None:
        socket.arxc += 1
        stack.interfaces[1].update(rxb=1600, arxc=4)

    _hour(diag, stack, [socket], record)
    _severity, fields = _only(logged, _SUMMARY)
    assert (fields["rnode_rxb"], fields["rnode_arxc"]) == (600, 4)


def test_rnode_deltas_need_radios_in_both_reads(diag, logged, monkeypatch):
    """A refused read at connect leaves the first hour without RNode deltas."""
    monkeypatch.setattr(handler_state, "_host_node_id", "!27716218")
    stack = _Stack(interfaces=[SHARED, RNODE_OK], stats_error=REJECTED)

    def record(_diagnostics) -> None:
        stack.stats_error = None

    _hour(diag, stack, [_client_socket()], record)
    severity, fields = _only(logged, _SUMMARY)
    assert (severity, fields["stats"]) == ("warn", "ok")
    assert not any(key.startswith("rnode_") for key in fields)
    # The hints follow the connect facts, where the RPC was refused.
    assert fields["hints"] == [diag.HINT_STATS, diag.HINT_PATHS]


@pytest.mark.parametrize(
    ("stack", "pending", "expected"),
    [
        (_Stack(interfaces=[SHARED, RNODE_OK]), False, ["PATHS"]),
        (_Stack(interfaces=[SHARED, RNODE_DEAF]), True, ["RNODE", "PATHS", "HOST_ID"]),
        (
            _Stack(role="shared", interfaces=[SHARED, RNODE_OK]),
            False,
            ["ROLE", "PATHS"],
        ),
        (_Stack(stats_error=REJECTED), False, ["STATS", "PATHS"]),
        (_Stack(interfaces=[dict(RNODE_DEAF, rxb=0)]), False, ["PATHS"]),
        (object(), False, ["ROLE", "PATHS"]),
    ],
    ids=["working", "deaf_rnode", "own_stack", "refused", "silent_rnode", "unknown"],
)
def test_hints_follow_the_connect_facts(diag, stack, pending, expected):
    """Each hint answers one connect fact; ``rnpath -t`` is always worth a look."""
    facts = diag.read_facts(stack, [])
    chosen = diag.hints(facts, host_pending=pending)
    assert chosen == [getattr(diag, f"HINT_{name}") for name in expected]


def test_hints_are_short_operator_lines(diag):
    """Short imperative lines, no em-dash or en-dash (SPEC RG3)."""
    for name in ("ROLE", "STATS", "RNODE", "PATHS", "HOST_ID"):
        hint = getattr(diag, f"HINT_{name}")
        assert len(hint) <= 120, name
        assert "—" not in hint and "–" not in hint, name
        assert hint[0].isupper(), name


# ---------------------------------------------------------------------------
# The rate limit, the window and failures (SPEC RG4)
# ---------------------------------------------------------------------------


def test_the_summary_runs_once_per_interval(diag, logged):
    """Every loop asks; one summary per interval, one stats read each, no path table."""
    stack = _Stack(interfaces=[SHARED, RNODE_OK])
    clock = _Clock()
    diagnostics = diag.StackDiagnostics(lambda: [_client_socket()], clock=clock)
    diagnostics.tick(stack)  # nothing connected yet
    assert logged == []
    diagnostics.connected(stack)
    hour = diag.SUMMARY_INTERVAL_SECS
    for now in (60.0, hour - 1, hour, hour + 60, 2 * hour - 1, 2 * hour):
        clock.now = now
        diagnostics.tick(stack)
    assert _messages(logged) == [_STATE, _SUMMARY, _SUMMARY]
    assert (stack.stats_reads, stack.path_table_reads) == (3, 0)
    assert hour == 3600.0


def test_a_reconnect_refreshes_the_facts_and_keeps_the_window(
    diag, logged, monkeypatch
):
    """The summary covers the hour since the first connect, hinted from the latest."""
    monkeypatch.setattr(handler_state, "_host_node_id", "!27716218")
    stack = _Stack(interfaces=[SHARED, RNODE_OK], stats_error=REJECTED)
    clock = _Clock()
    diagnostics = diag.StackDiagnostics(lambda: [_client_socket()], clock=clock)
    diagnostics.connected(stack)
    clock.now, stack.stats_error = 1800.0, None
    diagnostics.connected(stack)  # the reconnect reads the stats this time
    clock.now = diag.SUMMARY_INTERVAL_SECS - 1
    diagnostics.tick(stack)
    clock.now = diag.SUMMARY_INTERVAL_SECS
    diagnostics.tick(stack)
    assert _messages(logged) == [_STATE, _STATE, _SUMMARY]
    severity, fields = _only(logged, _SUMMARY)
    assert (severity, fields["hints"]) == ("warn", [diag.HINT_PATHS])
    assert "rnode_rxb" not in fields  # the window's first read was refused


def test_a_failing_connect_read_logs_its_class_and_never_raises(diag, logged):
    """A diagnostics bug must not fail the connect it runs in (SPEC RG4, RG5)."""

    def broken():
        raise RuntimeError("RNodeInterface[Garden Shed]")

    clock = _Clock()
    diagnostics = diag.StackDiagnostics(broken, clock=clock)
    diagnostics.connected(_Stack())
    assert logged == [
        (
            "warn",
            _FAILED,
            {"context": "reticulum.connect", "error_class": "RuntimeError"},
        )
    ]
    clock.now = diag.SUMMARY_INTERVAL_SECS
    diagnostics.tick(_Stack())  # no window started, so no summary
    assert len(logged) == 1


def test_a_failing_summary_is_logged_once_per_interval(diag, logged):
    """The window advances, so a broken read repeats hourly, not every loop."""
    reads: list = []

    def interfaces():
        reads.append(1)
        if len(reads) > 1:
            raise RuntimeError("Garden Shed")
        return []

    clock = _Clock()
    diagnostics = diag.StackDiagnostics(interfaces, clock=clock)
    diagnostics.connected(_Stack())
    for now in (3600.0, 3601.0, 7200.0):
        clock.now = now
        diagnostics.tick(_Stack())
    failures = [fields for _sev, msg, fields in logged if msg == _FAILED]
    assert (
        failures
        == [{"context": "reticulum.summary", "error_class": "RuntimeError"}] * 2
    )
    assert "Garden Shed" not in repr(logged)


def test_the_module_reads_only_what_it_is_given(diag):
    """No RNS import: it cannot transmit or read the path table (RN5, MA7, RE-A14)."""
    assert not hasattr(diag, "RNS")


# ---------------------------------------------------------------------------
# The provider's wiring (SPEC RG2, RG4)
# ---------------------------------------------------------------------------


def test_reconnects_share_one_tally(diag, monkeypatch, tmp_path, logged):
    """The tally and window belong to the provider, so they outlive a connection."""
    fake, _state = _fake_rns()
    monkeypatch.setattr(mod, "RNS", fake)
    _no_ingestor_node_id(monkeypatch, tmp_path)
    provider = mod.ReticulumProvider()
    first, _target, _next = provider.connect(active_candidate=None)
    second, _target, _next = provider.connect(active_candidate=None)
    assert first.tally is second.tally
    assert isinstance(first.tally, diag.AnnounceTally)
    assert mod._ReticulumInterface(target=None).tally is not first.tally
    # The fakes lack the RNS members: the connect line says so and never warns.
    state = [fields for _sev, msg, fields in logged if msg == _STATE]
    assert (
        state
        == [
            {
                "context": "reticulum.connect",
                "role": "unknown",
                "stats": "unavailable",
                "received": None,
            }
        ]
        * 2
    )
    assert [sev for sev, _msg, _fields in logged if sev == "warn"] == []


def test_the_hook_summarises_the_connected_stack_once_due(
    diag, monkeypatch, tmp_path, logged
):
    """``log_diagnostics`` reads the interface's stack and keeps to the interval."""
    stack = _Stack(interfaces=[SHARED, RNODE_OK])
    fake, _state = _fake_rns(existing_instance=stack)
    fake.Transport.interfaces = [_client_socket()]
    monkeypatch.setattr(mod, "RNS", fake)
    _no_ingestor_node_id(monkeypatch, tmp_path)
    now = [0.0]
    monkeypatch.setattr(time, "monotonic", lambda: now[0])
    provider = mod.ReticulumProvider()
    provider.log_diagnostics(None)  # before any connect: nothing
    iface, _target, _next = provider.connect(active_candidate=None)
    provider.log_diagnostics(iface)
    now[0] = diag.SUMMARY_INTERVAL_SECS
    provider.log_diagnostics(iface)
    provider.log_diagnostics(iface)
    assert _messages(logged).count(_SUMMARY) == 1
    assert _only(logged, _STATE)[1]["role"] == "client"


def test_each_announce_outcome_reaches_the_tally(diag, monkeypatch):
    """Every handler outcome is tallied; only admitted announces count for MA1."""
    fake, _state = _fake_rns(hops=1, interface="TCPInterface[Hub]")
    monkeypatch.setattr(mod, "RNS", fake)
    monkeypatch.setattr(config, "RETICULUM_INTERFACES", ("rnode",))
    monkeypatch.setattr(config, "_debug_log", lambda *_a, **_k: None)
    seen: list = []
    monkeypatch.setattr(mod.handlers, "_mark_packet_seen", lambda: seen.append(1))
    monkeypatch.setattr(mod.handlers, "upsert_node", lambda *_a, **_k: None)
    iface = mod._ReticulumInterface(target=None)
    iface.tally.use_classes({"TCPInterface[Hub]": "TCPClientInterface"})
    handler = mod._ReticulumAnnounceHandler("lxmf.delivery", iface)

    handler.received_announce(PEER_DEST, PEER, b"Peer")  # TCP: out of scope
    fake.Transport.next_hop_interface = lambda _dh: None
    handler.received_announce(PEER_DEST, PEER, b"Peer")  # no interface
    fake.Transport.next_hop_interface = lambda _dh: "RNodeInterface[RNode LoRa]"
    handler.received_announce(PEER_DEST, PEER, b"Peer")  # admitted
    handler.received_announce(b"\x01\x02", None, b"Peer")  # unusable hash

    def _boom(*_args, **_kwargs):
        raise RuntimeError("queue down")

    monkeypatch.setattr(mod.handlers, "upsert_node", _boom)
    handler.received_announce(PEER_DEST, PEER, b"Peer")  # error

    counts = iface.tally.drain()
    assert counts.delivered == {"lxmf.delivery": 5}
    assert counts.admitted == {"lxmf.delivery": 1}
    assert counts.dropped == {
        "error": 1,
        "no_interface": 1,
        "scope": 1,
        "unusable_hash": 1,
    }
    assert counts.scope_classes == {"TCPClientInterface": 1}
    assert len(seen) == 3  # admitted, unusable hash, error; never a scope drop


def test_radio_facts_skip_an_interface_type_that_is_not_a_string(diag):
    """A stats entry whose ``type`` is unhashable is no radio and raises nothing."""
    radio = diag._radio_facts([{"type": ["RNodeInterface"]}, RNODE_OK])
    assert radio["rnode_online"] == "1/1"
