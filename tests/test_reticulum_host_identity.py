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
"""Host discovery must outlive the shared-instance client's own clean (SPEC HI).

ACCEPTANCE Known gap RE-G1.  On a shared-instance client ``RNS.Identity.recall``
is a lookup in the ingestor's own ``known_destinations``: the file ``rnsd`` last
persisted, loaded at attach, plus the announces heard while attached.  Its
"used" mark goes to ``rnsd`` by RPC and never reaches the client's copy.  The
client's own clean, every 5 minutes, drops every entry it has no path to and
never used.  A local app that announced before the ingestor attached is
therefore found at connect and forgotten at the client's first clean, while its
0-hop path stays in ``rnsd``'s table for up to 7 days.

The provider now remembers what RNS told it, as a fallback that anything newer
replaces, and a full 32-hex ``INGESTOR_NODE_ID`` names the host identity unless
it fronts none of the announce aspects here and discovery elects another
(SPEC HI1-HI5).

RE-A14's fake stack recalls every identity on every call, so it cannot see
this.  The fake here keeps RNS's own ``recall``, ``recall_app_data`` and
``clean_known_destinations``, and replaces only what lives outside the
ingestor's process: ``rnsd``, reached by RPC as the shared instance, and the
file it persisted.
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
from RNS.vendor import umsgpack  # noqa: E402 - path setup

from daemon_fakes import make_state  # noqa: E402 - shared daemon doubles
from data.mesh_ingestor import config, handlers, queue  # noqa: E402 - path setup
from data.mesh_ingestor.protocols import reticulum_position  # noqa: E402
from data.mesh_ingestor.protocols.reticulum import ReticulumProvider  # noqa: E402
from test_reticulum_host_refresh import (  # noqa: E402,F401 - shared fixture
    _REMOTE_DEST,
    _REMOTE_IDENTITY,
    _WALL_OFFSET,
    _busy_pass,
    world,
)
from test_reticulum_position_unit import _CONFIG  # noqa: E402 - positioned config
from test_reticulum_unit import (  # noqa: E402 - shared Reticulum doubles
    _FIELD_TRANSPORT,
    _FakeIdentity,
)

_HOST_IDENTITY = RNS.Identity.from_bytes(bytes(range(64)))
"""A real identity with a fixed key, since RNS's own ``recall`` loads its key."""

_HOST = "!" + _HOST_IDENTITY.hash.hex()[:8]
"""Canonical node id of :data:`_HOST_IDENTITY`."""

_OTHER_IDENTITY = RNS.Identity.from_bytes(bytes(range(64, 128)))
"""A second local identity: re-keyed apps, or a pin naming the wrong identity."""

_OTHER = "!" + _OTHER_IDENTITY.hash.hex()[:8]
"""Canonical node id of :data:`_OTHER_IDENTITY`."""

_THIRD_IDENTITY = RNS.Identity.from_bytes(bytes(range(128, 192)))
"""A third local identity, for ties and an answer that keeps changing."""

_THIRD = "!" + _THIRD_IDENTITY.hash.hex()[:8]
"""Canonical node id of :data:`_THIRD_IDENTITY`."""

_ANNOUNCED = {
    "lxmf.delivery": b"afri-orion",
    "nomadnetwork.node": b"Department of Decentralization",
    "lxmf.propagation": umsgpack.packb([False, 1791009880]),
}
"""The host apps' aspects and the ``app_data`` each last announced, as in the field.

A propagation node announces metadata, not a name.
"""

_DESTINATIONS = sorted([*_ANNOUNCED, "rns.transport"])
"""The four destinations of a transport-enabled host (SPEC RE8/RE9)."""

_REAL_IDENTITY = {
    name: RNS.Identity.__dict__[name] for name in ("recall", "recall_app_data")
}
"""RNS's own lookups, captured before a fixture replaces them."""

_CLEAN_INTERVAL = 300.0
"""``RNS.Transport.known_destinations_interval``: the client cleans every 5 min."""


def _dest(identity, aspect: str) -> bytes:
    """Return the destination hash *identity* announces for *aspect*."""
    app, _, rest = aspect.partition(".")
    return RNS.Destination.hash(identity.hash, app, *rest.split("."))


def _known(identity, app_data, announced: float | None = None) -> list:
    """Return a ``known_destinations`` entry, never used, as RNS stores it."""
    when = time.time() if announced is None else announced
    return [when, bytes(32), identity.get_public_key(), app_data, 0]


class _Rnsd:
    """``rnsd`` as the ingestor's process reaches it: by RPC, as its client."""

    is_connected_to_shared_instance = True
    """Read through ``RNS.Transport.owner`` by RNS's clean, as on a client."""

    def __init__(self, local: dict[str, str]) -> None:
        """Hold the host apps' 0-hop paths, on a routing stack."""
        self.local = dict(local)
        self.routing = True
        self.used_marks: list[str] = []

    def get_path_table(self, max_hops=None):
        """Return ``rnsd``'s 0-hop entries, which outlive the client's clean."""
        return [
            {"hash": bytes.fromhex(dest), "hops": 0, "interface": interface}
            for dest, interface in self.local.items()
        ]

    def get_next_hop_if_name(self, _dest_hash):
        """Name the interface a remote announce arrived on."""
        return "RNodeInterface[RNode LoRa]"

    def get_interface_stats(self):
        """Report a ``transport_id`` while the stack routes (SPEC RA12)."""
        return {"transport_id": bytes.fromhex(_FIELD_TRANSPORT)} if self.routing else {}

    def _used_destination_data(self, dest_hash):
        """Take the RPC ``recall`` sends: it marks ``rnsd``'s copy, not the client's."""
        self.used_marks.append(bytes(dest_hash).hex())
        return True


@pytest.fixture
def client(world, monkeypatch, tmp_path):
    """Attach the ingestor to ``rnsd`` after the host's apps announced.

    The client never heard those announces, so it knows the host's
    destinations only from the file ``rnsd`` persisted, has no path to them
    and has never used them in its own memory.  ``rnsd`` keeps their 0-hop
    paths.  The RNS config positions the host (SPEC RP1), as on the field
    host, so every report also refreshes the node row (SPEC RP6).

    Returns:
        Namespace with ``rnsd`` (the fake shared instance), ``posts`` (every
        record of the host posted to ``/api/nodes``), ``cleans`` (the client
        cleans run so far) and ``next_clean`` (fake monotonic seconds).
    """
    announced = _WALL_OFFSET + world.clock["mono"] - 120.0  # 2 min before attach
    persisted = {
        _dest(_HOST_IDENTITY, aspect): _known(_HOST_IDENTITY, app_data, announced)
        for aspect, app_data in _ANNOUNCED.items()
    }
    storage = tmp_path / "storage"
    storage.mkdir()
    with open(storage / "known_destinations", "wb") as handle:
        umsgpack.dump(persisted, handle)
    (tmp_path / "config").write_text(_CONFIG)
    rnsd = _Rnsd({dest.hex(): "LocalInterface[rns/default]" for dest in persisted})

    monkeypatch.setattr(RNS.Reticulum, "get_instance", staticmethod(lambda: rnsd))
    monkeypatch.setattr(RNS.Reticulum, "storagepath", str(storage))
    monkeypatch.setattr(RNS.Transport, "owner", rnsd, raising=False)
    monkeypatch.setattr(RNS.Transport, "path_table", {})
    monkeypatch.setattr(RNS.Transport, "destinations", [])
    monkeypatch.setattr(RNS.Transport, "destinations_last_cleaned", 0.0)
    monkeypatch.setattr(
        RNS.Identity,
        "known_destinations",
        {dest: list(entry) for dest, entry in persisted.items()},
    )
    for name, implementation in _REAL_IDENTITY.items():
        monkeypatch.setattr(RNS.Identity, name, implementation)
    monkeypatch.setattr(
        RNS.Transport,
        "request_path",
        staticmethod(lambda *_a, **_k: world.sent.append("request_path")),
    )
    monkeypatch.setattr(reticulum_position, "_last_outcome", None)

    posts: list[dict] = []

    heartbeats: list[str] = []

    def _capture(path, payload, **_kw):
        """Keep the host's ``/api/nodes`` records and every heartbeat's node id."""
        if path == "/api/nodes" and _HOST in payload:
            posts.append(payload[_HOST])
        if path == "/api/ingestors":
            heartbeats.append(payload["node_id"])

    monkeypatch.setattr(queue, "_queue_post_json", _capture)
    return types.SimpleNamespace(
        rnsd=rnsd,
        posts=posts,
        heartbeats=heartbeats,
        cleans=0,
        next_clean=world.clock["mono"] + _CLEAN_INTERVAL,
    )


def _announce_here(client, identity) -> None:
    """Put *identity*'s three aspects in ``rnsd``'s table and the client's memory."""
    for aspect, app_data in _ANNOUNCED.items():
        dest = _dest(identity, aspect)
        client.rnsd.local[dest.hex()] = "LocalInterface[rns/default]"
        RNS.Identity.known_destinations[dest] = _known(identity, app_data)


def _leave(client, identity) -> None:
    """Take *identity*'s aspects out of ``rnsd``'s 0-hop table: its apps stopped."""
    for aspect in _ANNOUNCED:
        client.rnsd.local.pop(_dest(identity, aspect).hex(), None)


def _attached_pass(state, world, client) -> None:
    """Run one busy daemon pass, then the client's clean whenever it is due."""
    _busy_pass(state, world)
    if world.clock["mono"] >= client.next_clean:
        RNS.Identity.clean_known_destinations()
        client.cleans += 1
        client.next_clean += _CLEAN_INTERVAL


def _attach(provider: ReticulumProvider):
    """Connect *provider* and register its host id, as the daemon does.

    Returns:
        The interface ``connect`` returned.
    """
    iface, _target, _next = provider.connect(active_candidate=None)
    handlers.register_host_node_id(provider.extract_host_node_id(iface))
    return iface


def _by_aspect(records) -> dict[str, dict]:
    """Index node records, or ``(node_id, node)`` pairs, by destination aspect."""
    nodes = [item[1] if isinstance(item, tuple) else item for item in records]
    return {
        node["destination"]["aspect"]: node for node in nodes if "destination" in node
    }


def _name(records, aspect: str) -> str | None:
    """Return the name a report posts for *aspect*, or ``None`` when it posts none."""
    return _by_aspect(records).get(aspect, {}).get("user", {}).get("longName")


def _host_warnings(logged) -> list[dict]:
    """Return the fields of every host warning in *logged* (SPEC HI5)."""
    return [
        fields
        for _message, fields in logged
        if fields.get("context") == "reticulum.host"
        and fields.get("severity") == "warn"
    ]


def test_premise_the_client_forgets_what_it_never_used(client):
    """RNS's own clean drops a destination from the client, but not from ``rnsd``.

    The entry was announced 2 minutes ago, inside the 6-minute linger, and is
    dropped anyway: for an entry never used, RNS's clean measures the time
    unused from 0.  The "used" mark the recall sent went to ``rnsd`` only.
    Pins the RNS 1.5.7 behaviour the tests below rest on.
    """
    dest = next(iter(RNS.Identity.known_destinations))
    assert RNS.Identity.recall(dest).hash == _HOST_IDENTITY.hash

    RNS.Identity.clean_known_destinations()

    assert RNS.Identity.recall(dest) is None
    assert client.rnsd.used_marks == [dest.hex()]
    assert len(client.rnsd.get_path_table(max_hops=0)) == 3


@pytest.mark.parametrize(
    "pin",
    [_HOST, _HOST_IDENTITY.hash.hex(), None],
    ids=["pinned", "full-hash", "discovered"],
)
def test_hourly_report_refreshes_host_destinations_after_the_clients_clean(
    client, world, monkeypatch, pin
):
    """Every report re-posts the host's destinations while their paths last.

    The connect snapshot posts the four destinations, the client's first
    clean comes 5 minutes later, and every report after it posts only the
    positioned bare record (SPEC RP6): the node row stays fresh while its
    destinations freeze, the symptom potatomesh.net shows, though their 0-hop
    paths are in ``rnsd``'s table throughout.  The host id is pinned, as on
    the field host, pinned by the full identity hash (SPEC HI4), or
    discovered at connect; all three froze.  Against the unfixed provider
    this fails with ``assert {'lxmf.delivery': 1791010000, ...} == {}``: each
    destination was last posted at connect.
    """
    monkeypatch.setattr(config, "INGESTOR_NODE_ID", pin)
    state = make_state(provider=ReticulumProvider(), inactivity_reconnect_secs=3600.0)
    connected_at = int(time.time())
    _attached_pass(state, world, client)  # connect: the snapshot and first report
    first_iface = state.iface
    for _ in range(61):  # one report interval, plus one loop
        _attached_pass(state, world, client)

    newest: dict[str, int] = {}
    for node in client.posts:
        aspect = (node.get("destination") or {}).get("aspect")
        if aspect:
            newest[aspect] = max(newest.get(aspect, 0), node["lastHeard"])
    node_refreshed = max(node["lastHeard"] for node in client.posts)
    stale = {
        aspect: heard for aspect, heard in newest.items() if heard < connected_at + 3600
    }

    assert state.iface is first_iface  # no reconnect did the work
    assert client.cleans == 12
    assert sorted(newest) == _DESTINATIONS  # all four posted at connect
    assert node_refreshed >= connected_at + 3600  # the node row stays fresh
    assert stale == {}
    assert world.sent == []  # receive-only (SPEC RN5)


def test_the_remembered_names_are_posted_after_the_clients_clean(client):
    """A report after the clean names each destination as the one before it."""
    provider = ReticulumProvider()
    iface = _attach(provider)
    before = {
        a: n["user"]["longName"]
        for a, n in _by_aspect(provider.self_node_items(iface)).items()
    }
    RNS.Identity.clean_known_destinations()
    after = {
        a: n["user"]["longName"]
        for a, n in _by_aspect(provider.self_node_items(iface)).items()
    }

    assert after == before
    assert after["lxmf.delivery"] == "afri-orion"
    assert after["nomadnetwork.node"] == "Department of Decentralization"


# ---------------------------------------------------------------------------
# Anything newer replaces what the provider remembers (SPEC HI2)
# ---------------------------------------------------------------------------


def test_a_fresh_recall_replaces_the_remembered_name(client):
    """A name RNS answers with replaces the remembered one, which then outlives the clean."""
    provider = ReticulumProvider()
    iface = _attach(provider)
    assert _name(provider.self_node_items(iface), "lxmf.delivery") == "afri-orion"
    # The app re-announced under a new name, and the client heard it.
    RNS.Identity.known_destinations[_dest(_HOST_IDENTITY, "lxmf.delivery")][
        3
    ] = b"afri-orion v2"
    assert _name(provider.self_node_items(iface), "lxmf.delivery") == "afri-orion v2"

    RNS.Identity.clean_known_destinations()

    assert _name(provider.self_node_items(iface), "lxmf.delivery") == "afri-orion v2"


def test_a_fresh_recall_replaces_a_remembered_identity(client):
    """A destination RNS answers for takes RNS's identity, not the remembered one."""
    provider = ReticulumProvider()
    dest_hex = _dest(_HOST_IDENTITY, "lxmf.delivery").hex()
    provider._identities.learn(dest_hex, _OTHER_IDENTITY.hash.hex(), "Someone Else")

    records = provider.host_destination_nodes()

    assert {record["nodeId"] for record in records} == {_HOST}
    assert provider._identities.identity(dest_hex) == _HOST_IDENTITY.hash.hex()
    assert provider._identities.name(dest_hex) == "afri-orion"


def test_a_live_local_announce_replaces_what_the_provider_remembers(
    client, monkeypatch
):
    """A 0-hop announce updates the remembered name; a remote announce is not kept."""
    provider = ReticulumProvider()
    iface = _attach(provider)
    provider.self_node_items(iface)  # the report the daemon runs right after connect
    RNS.Identity.clean_known_destinations()  # the client forgets the host's destinations
    dest = _dest(_HOST_IDENTITY, "lxmf.delivery")
    monkeypatch.setattr(
        RNS.Transport, "hops_to", lambda dh: 0 if bytes(dh) == dest else 1
    )
    handler = next(
        h for h in iface._announce_handlers if h.aspect_filter == "lxmf.delivery"
    )

    handler.received_announce(dest, _HOST_IDENTITY, b"afri-orion renamed")
    handler.received_announce(
        bytes.fromhex(_REMOTE_DEST),
        _FakeIdentity(bytes.fromhex(_REMOTE_IDENTITY)),
        b"Remote Peer",
    )
    items = provider.self_node_items(iface)

    assert _name(items, "lxmf.delivery") == "afri-orion renamed"
    assert _name(items, "nomadnetwork.node") == "Department of Decentralization"
    assert provider._identities.identity(_REMOTE_DEST) is None


def test_a_new_primary_identity_replaces_the_old_one(client):
    """Re-keyed apps: the new identity is reported, the old one's are not."""
    provider = ReticulumProvider()
    assert {record["nodeId"] for record in provider.host_destination_nodes()} == {_HOST}
    RNS.Identity.clean_known_destinations()
    _leave(client, _HOST_IDENTITY)
    _announce_here(client, _OTHER_IDENTITY)

    records = provider.host_destination_nodes()

    assert {record["nodeId"] for record in records} == {_OTHER}
    assert sorted(_by_aspect(records)) == _DESTINATIONS


def test_a_destination_that_left_the_table_is_not_reported(client):
    """The memory never brings back a destination whose path is gone (SPEC RE8)."""
    provider = ReticulumProvider()
    iface = _attach(provider)
    RNS.Identity.clean_known_destinations()
    del client.rnsd.local[_dest(_HOST_IDENTITY, "nomadnetwork.node").hex()]

    assert sorted(_by_aspect(provider.self_node_items(iface))) == [
        "lxmf.delivery",
        "lxmf.propagation",
        "rns.transport",
    ]


# ---------------------------------------------------------------------------
# A full 32-hex INGESTOR_NODE_ID names the host identity (SPEC HI4, HI5)
# ---------------------------------------------------------------------------


def test_a_full_hash_pin_names_the_host_without_recall(client, monkeypatch):
    """The pinned identity's aspects come from rnsd's table, recomputed, not recalled.

    The apps announced after ``rnsd``'s last write, so the client never knew
    their destinations (the stale-file case): discovery finds nothing.
    """
    monkeypatch.setattr(config, "INGESTOR_NODE_ID", _HOST_IDENTITY.hash.hex().upper())
    RNS.Identity.known_destinations.clear()
    provider = ReticulumProvider()
    items = provider.self_node_items(_attach(provider))

    assert {node_id for node_id, _node in items} == {_HOST}
    assert sorted(_by_aspect(items)) == _DESTINATIONS


def test_a_full_hash_pin_keeps_rns_transport_after_the_paths_expire(
    client, monkeypatch
):
    """No 0-hop path is left, so only ``rns.transport`` and the position are posted."""
    logged: list = []
    monkeypatch.setattr(
        config, "_debug_log", lambda msg, **kw: logged.append((msg, kw))
    )
    monkeypatch.setattr(config, "INGESTOR_NODE_ID", _HOST_IDENTITY.hash.hex())
    client.rnsd.local.clear()  # a week without an announce: rnsd culled the paths
    provider = ReticulumProvider()
    items = provider.self_node_items(_attach(provider))

    assert sorted(_by_aspect(items)) == ["rns.transport"]
    assert {node_id for node_id, _node in items} == {_HOST}
    assert all("position" in node for _node_id, node in items)  # no bare record
    assert _host_warnings(logged) == []  # nothing contradicts the pin


def test_a_pin_that_fronts_nothing_here_follows_discovery(client, monkeypatch):
    """The one identity that announces here is reported and registered (SPEC HI5).

    The switch comes at connect, before the daemon registers anything, and
    logs one warning naming the pinned, the previous and the current id.
    """
    logged: list = []
    monkeypatch.setattr(
        config, "_debug_log", lambda msg, **kw: logged.append((msg, kw))
    )
    monkeypatch.setattr(config, "INGESTOR_NODE_ID", _OTHER_IDENTITY.hash.hex())
    provider = ReticulumProvider()
    iface = _attach(provider)

    first = provider.self_node_items(iface)
    second = provider.self_node_items(iface)

    assert handlers.host_node_id() == _HOST
    assert {node_id for node_id, _node in first} == {_HOST}
    assert sorted(_by_aspect(first)) == _DESTINATIONS
    assert sorted(_by_aspect(second)) == _DESTINATIONS
    assert _host_warnings(logged) == [
        {
            "context": "reticulum.host",
            "severity": "warn",
            "pinned": _OTHER,
            "previous": _OTHER,
            "current": _HOST,
        }
    ]


def test_a_changed_pin_takes_over_and_keeps_nothing_from_the_old_one(
    client, monkeypatch
):
    """The provider reads the pin on every call; the report follows the registered id."""
    _announce_here(client, _OTHER_IDENTITY)  # both identities announce here
    monkeypatch.setattr(config, "INGESTOR_NODE_ID", _OTHER_IDENTITY.hash.hex())
    provider = ReticulumProvider()
    assert {record["nodeId"] for record in provider.host_destination_nodes()} == {
        _OTHER
    }

    monkeypatch.setattr(config, "INGESTOR_NODE_ID", _HOST_IDENTITY.hash.hex())
    records = provider.host_destination_nodes()
    handlers.register_host_node_id(provider.extract_host_node_id(None))  # a restart

    assert {record["nodeId"] for record in records} == {_HOST}
    assert sorted(_by_aspect(records)) == _DESTINATIONS
    assert {node_id for node_id, _node in provider.self_node_items(None)} == {_HOST}


def test_a_short_pin_does_not_name_the_identity(client, monkeypatch):
    """``!`` plus eight hex pins the node id only; discovery still finds the identity."""
    monkeypatch.setattr(config, "INGESTOR_NODE_ID", _HOST)
    RNS.Identity.known_destinations.clear()  # nothing for discovery to recall
    provider = ReticulumProvider()

    assert provider.extract_host_node_id(None) == _HOST
    assert provider.host_destination_nodes() == []
