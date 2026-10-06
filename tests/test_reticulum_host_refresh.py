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
"""Tests for the periodic report that keeps a Reticulum host fresh (SPEC RE8).

The host's own destinations come from the running stack's 0-hop path table. A
local app's announce reaches the ingestor only while both are attached, one
made before connect is not replayed, and ``rns.transport`` never announces.
The node snapshot posts the host once per connection, and a busy mesh never
recycles the connection, because every announce resets the 1 h inactivity
reconnect. The daemon therefore re-posts the host on its self-node report,
through the optional ``self_node_items`` provider hook.

Covers the daemon side of the hook, the Reticulum provider's implementation of
it, and the end-to-end regression (ACCEPTANCE RE-A14).
"""

from __future__ import annotations

import sys
import time
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:  # pragma: no cover - conftest adds it
    sys.path.insert(0, str(REPO_ROOT))

import RNS  # noqa: E402 - path setup

from daemon_fakes import make_state  # noqa: E402 - shared daemon doubles
from data.mesh_ingestor import (  # noqa: E402 - path setup
    activity,
    config,
    daemon,
    handlers,
    ingestors,
    queue,
)
from data.mesh_ingestor.handlers import _state as handler_state  # noqa: E402
from data.mesh_ingestor.protocols.reticulum import ReticulumProvider  # noqa: E402
from test_reticulum_unit import (  # noqa: E402 - shared Reticulum doubles
    _FIELD_LXMF,
    _FIELD_NOMADNET,
    _FIELD_PRIMARY,
    _FIELD_TRANSPORT,
    _FakeIdentity,
)

_HOST = "!27716218"
"""Canonical node id of the field host's primary identity."""

_REMOTE_IDENTITY = "aabbccdd" + "11" * 12
"""Identity hash of a remote peer one hop out."""

_REMOTE_DEST = "c0ffee00" + "22" * 12
"""The remote peer's ``lxmf.delivery`` destination hash."""

_WALL_OFFSET = 1_791_000_000
"""Unix seconds added to the fake monotonic clock to give the wall clock."""


class _Stack:
    """The running RNS stack as a shared-instance client sees it.

    ``_local_stack`` in ``test_reticulum_unit`` patches a fixed path table and
    the process transport flag. The refresh needs a 0-hop table and a routing
    answer that change between loops, the stack's own transport answer through
    ``get_interface_stats`` (SPEC RA12), and a count of path-table reads, which
    is the cost the report must keep hourly.
    """

    def __init__(self) -> None:
        """Attach the field host's two aspects, not routing yet."""
        self.local = {_FIELD_LXMF: _FIELD_PRIMARY, _FIELD_NOMADNET: _FIELD_PRIMARY}
        self.routing = False
        self.path_table_reads = 0

    def get_path_table(self, max_hops=None):
        """Return the 0-hop entries and count the read."""
        self.path_table_reads += 1
        return [
            {
                "hash": bytes.fromhex(dest),
                "hops": 0,
                "interface": "LocalInterface[rns/default]",
            }
            for dest in self.local
        ]

    def get_next_hop_if_name(self, _dest_hash):
        """Name the interface a remote announce arrived on."""
        return "RNodeInterface[RNode LoRa]"

    def get_interface_stats(self):
        """Report a ``transport_id`` only while the stack routes (SPEC RA12)."""
        if not self.routing:
            return {}
        return {"transport_id": bytes.fromhex(_FIELD_TRANSPORT)}

    def recall(self, dest_hash, **_kw):
        """Map a 0-hop destination to its owner, as ``RNS.Identity.recall`` does.

        Only path-table entries are recalled: a remote announce hands its
        identity to the handler directly.
        """
        return _FakeIdentity(bytes.fromhex(self.local[bytes(dest_hash).hex()]))


@pytest.fixture
def world(monkeypatch, tmp_path):
    """Point RNS at a :class:`_Stack`, with a fake clock and no transmission.

    Returns:
        Namespace with ``stack`` (the fake), ``clock`` (``{"mono": seconds}``,
        driving both ``time.monotonic`` and ``time.time``), ``host_posts``
        (every record of the host node posted to ``/api/nodes``) and ``sent``
        (every transmission attempted, which must stay empty).
    """
    stack = _Stack()
    clock = {"mono": 10_000.0}
    host_posts: list[dict] = []
    sent: list[str] = []

    monkeypatch.setattr(RNS.Reticulum, "get_instance", staticmethod(lambda: stack))
    monkeypatch.setattr(RNS.Reticulum, "transport_enabled", staticmethod(lambda: False))
    monkeypatch.setattr(
        RNS.Transport,
        "internal_identity",
        staticmethod(lambda: _FakeIdentity(bytes.fromhex(_FIELD_TRANSPORT))),
    )
    monkeypatch.setattr(RNS.Transport, "register_announce_handler", lambda _h: None)
    monkeypatch.setattr(RNS.Transport, "deregister_announce_handler", lambda _h: None)
    monkeypatch.setattr(RNS.Transport, "hops_to", lambda _dh: 1)
    monkeypatch.setattr(RNS.Identity, "recall", staticmethod(stack.recall))
    monkeypatch.setattr(
        RNS.Identity, "recall_app_data", staticmethod(lambda _dh, **_k: None)
    )
    # Recorded, not raised: the provider and the daemon swallow exceptions, so
    # a raising fake could be called and the test still pass.
    monkeypatch.setattr(RNS.Packet, "send", lambda *_a, **_k: sent.append("send"))
    monkeypatch.setattr(
        RNS.Destination, "announce", lambda *_a, **_k: sent.append("announce")
    )

    for name, value in (
        ("PROTOCOL", "reticulum"),
        ("INGESTOR_NODE_ID", None),
        ("CONNECTION", None),
        ("RETICULUM_CONFIG_DIR", str(tmp_path)),
        ("RETICULUM_INTERFACES", ()),
        ("RETICULUM_FREQ", None),
        ("RETICULUM_PRESET", None),
        ("LORA_FREQ", None),
        ("MODEM_PRESET", None),
        ("_RECONNECT_INITIAL_DELAY_SECS", 0.0),
        ("_SELF_NODE_REPORT_INTERVAL_SECS", 3600.0),
    ):
        monkeypatch.setattr(config, name, value)
    monkeypatch.setattr(config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(time, "monotonic", lambda: clock["mono"])
    monkeypatch.setattr(time, "time", lambda: _WALL_OFFSET + clock["mono"])

    def _capture(path, payload, **_kw):
        """Keep the host node's record from each ``/api/nodes`` POST."""
        if path == "/api/nodes" and _HOST in payload:
            host_posts.append(payload[_HOST])

    monkeypatch.setattr(queue, "_queue_post_json", _capture)
    # Announcements are not under test, and transmit nothing by default.
    monkeypatch.setattr(daemon, "_process_announcements", lambda s: s.last_announce)

    # Process-wide state the loop writes; monkeypatch restores it afterwards.
    for name in (
        "_host_node_id",
        "_host_telemetry_last_rx",
        "_host_nodeinfo_last_seen",
        "_last_packet_monotonic",
    ):
        monkeypatch.setattr(handler_state, name, None)
    monkeypatch.setattr(ingestors.STATE, "node_id", None)
    monkeypatch.setattr(ingestors.STATE, "last_heartbeat", None)
    monkeypatch.setattr(activity, "_packet_count", 0)
    return types.SimpleNamespace(
        stack=stack, clock=clock, host_posts=host_posts, sent=sent
    )


def _busy_pass(state, world) -> None:
    """Run one daemon pass on a busy mesh, then advance the clock by 60 s.

    Once connected, a remote announce lands through the real handler before
    every pass, so the 1 h inactivity reconnect never fires.
    """
    if state.iface is not None:
        handler = next(
            h
            for h in state.iface._announce_handlers
            if h.aspect_filter == "lxmf.delivery"
        )
        handler.received_announce(
            bytes.fromhex(_REMOTE_DEST),
            _FakeIdentity(bytes.fromhex(_REMOTE_IDENTITY)),
            b"Remote Peer",
        )
    daemon._loop_iteration(state)
    world.clock["mono"] += 60.0


# ---------------------------------------------------------------------------
# End to end: the real provider in the real daemon loop (ACCEPTANCE RE-A14)
# ---------------------------------------------------------------------------


def test_host_destinations_are_refreshed_on_a_connection_that_never_recycles(world):
    """The host is re-posted hourly while the connection stays up (SPEC RE8/RE9).

    The busy mesh keeps the interface, so only the self-node report can refresh
    the host, and the stack starts routing after the snapshot, so only that
    report can post ``rns.transport``. Against the unfixed loop this fails with
    ``assert 'rns.transport' in {...}``: the host was posted once, at connect.
    """
    state = make_state(provider=ReticulumProvider(), inactivity_reconnect_secs=3600.0)
    connected_at = int(time.time())
    _busy_pass(state, world)  # connect; the snapshot posts the two aspects
    first_iface = state.iface
    world.stack.routing = True  # the operator enables transport on rnsd
    reads_before = world.stack.path_table_reads
    for _ in range(61):  # one report interval, plus one loop
        _busy_pass(state, world)

    newest: dict[str, int] = {}
    for node in world.host_posts:
        aspect = node["destination"]["aspect"]
        newest[aspect] = max(newest.get(aspect, 0), node["lastHeard"])

    assert state.iface is first_iface  # no reconnect did the work
    assert "rns.transport" in newest
    assert newest["lxmf.delivery"] >= connected_at + 3600
    assert newest["nomadnetwork.node"] >= connected_at + 3600
    assert world.stack.path_table_reads - reads_before <= 4  # hourly, not per loop
    assert world.sent == []  # local reads only (SPEC RN5, MA7)


# ---------------------------------------------------------------------------
# ReticulumProvider.self_node_items
# ---------------------------------------------------------------------------


def test_self_node_items_is_empty_until_a_host_id_is_registered(world):
    """No registered host id: nothing to report, and the stack is not asked."""
    assert ReticulumProvider().self_node_items(None) == []
    assert world.stack.path_table_reads == 0


def test_self_node_items_reports_the_registered_hosts_destinations(world):
    """The host's aspects, plus its transport instance on a routing stack."""
    world.stack.routing = True
    handlers.register_host_node_id(_HOST)
    items = ReticulumProvider().self_node_items(None)
    assert {node_id for node_id, _node in items} == {_HOST}
    assert sorted(node["destination"]["aspect"] for _nid, node in items) == [
        "lxmf.delivery",
        "nomadnetwork.node",
        "rns.transport",
    ]
    assert world.stack.path_table_reads == 2  # the primary pick, then the records


def test_self_node_items_is_tied_to_the_registered_host_id(world):
    """A second local identity fronting more destinations is not reported.

    It wins the primary pick, and the web's destination upsert takes the
    incoming node id on conflict, so reporting it would move ``rns.transport``
    onto ``!0be70000`` while the registered host stays ``!27716218``.
    """
    other = "0be70000" + "33" * 12
    for app, aspect in (
        ("lxmf", "delivery"),
        ("lxmf", "propagation"),
        ("nomadnetwork", "node"),
    ):
        dest = RNS.Destination.hash(bytes.fromhex(other), app, aspect).hex()
        world.stack.local[dest] = other
    world.stack.routing = True
    handlers.register_host_node_id(_HOST)
    provider = ReticulumProvider()
    assert {n["nodeId"] for n in provider.host_destination_nodes()} == {"!0be70000"}
    assert provider.self_node_items(None) == []


# ---------------------------------------------------------------------------
# daemon._try_send_self_node with the list hook
# ---------------------------------------------------------------------------


class _BothHooksProvider:
    """Provider stub exposing both self-node hooks."""

    def __init__(self, items=(), error: Exception | None = None) -> None:
        """Answer the list hook with *items*, or raise *error* from it."""
        self.items = list(items)
        self.error = error
        self.single_calls = 0

    def self_node_items(self, iface):
        """Return the configured records, or raise the configured error."""
        if self.error is not None:
            raise self.error
        return list(self.items)

    def self_node_item(self, iface):  # pragma: no cover - the list hook wins
        """Count the call: the list hook must win when both exist."""
        self.single_calls += 1
        return "!ffffffff", {}


@pytest.fixture
def report(monkeypatch):
    """Capture the upserts and log lines of a self-node report at a fixed time.

    Returns:
        Namespace with ``upserted`` (``(node_id, node)`` pairs) and ``logged``
        (``(message, fields)`` pairs).
    """
    upserted: list[tuple[str, dict]] = []
    logged: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        daemon.handlers, "upsert_node", lambda nid, node: upserted.append((nid, node))
    )
    monkeypatch.setattr(
        daemon.config, "_debug_log", lambda msg, **kw: logged.append((msg, kw))
    )
    monkeypatch.setattr(daemon.time, "monotonic", lambda: 5000.0)
    return types.SimpleNamespace(upserted=upserted, logged=logged)


def test_list_hook_is_preferred_and_every_record_is_upserted(report):
    """Every record is upserted, the single hook is skipped, the timer stamped."""
    records = [
        (_HOST, {"destination": {"aspect": "lxmf.delivery"}}),
        (_HOST, {"destination": {"aspect": "rns.transport"}}),
    ]
    provider = _BothHooksProvider(records)
    state = make_state(provider=provider, iface=object())
    daemon._try_send_self_node(state)

    assert report.upserted == records
    assert provider.single_calls == 0
    assert state.last_self_node_report == 5000.0
    assert report.logged == [
        (
            "Sent periodic self-node report",
            {
                "context": "daemon.self_node",
                "severity": "info",
                "node_ids": [_HOST],
                "records": 2,
            },
        )
    ]


def test_list_hook_stamps_the_timer_on_an_empty_answer(report):
    """Nothing to report still stamps, so the next try waits an interval."""
    provider = _BothHooksProvider([])
    state = make_state(provider=provider, iface=object())
    daemon._try_send_self_node(state)

    assert report.upserted == []
    assert report.logged == []
    assert provider.single_calls == 0
    assert state.last_self_node_report == 5000.0


def test_list_hook_error_is_logged_and_still_stamps_the_timer(report):
    """A failing hook is logged once and retried an interval later, not per loop."""
    provider = _BothHooksProvider(error=RuntimeError("stack gone"))
    state = make_state(provider=provider, iface=object())
    daemon._try_send_self_node(state)  # must not raise

    assert report.upserted == []
    assert provider.single_calls == 0
    assert state.last_self_node_report == 5000.0
    assert [(msg, kw["severity"]) for msg, kw in report.logged] == [
        ("Self-node re-report failed", "warn")
    ]
