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
"""The Reticulum provider publishes its host's position (SPEC RP1-RP6).

Drives :class:`ReticulumProvider` at connect, through the node snapshot and the
self-node report, and end to end through the daemon loop on the fake stack of
``tests/test_reticulum_host_refresh.py``: the host's records carry the position
from the RNS config, peers never do, every report posts one positions row, and
a host with nothing announcing rides on one bare record.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:  # pragma: no cover - conftest adds it
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.protocols.reticulum as _mod  # noqa: E402
import data.mesh_ingestor.protocols.reticulum_position as rp  # noqa: E402
from daemon_fakes import make_state  # noqa: E402 - shared daemon doubles
from data.mesh_ingestor import config, handlers, queue  # noqa: E402
from data.mesh_ingestor.handlers import _state as handler_state  # noqa: E402
from data.mesh_ingestor.protocols.reticulum import (  # noqa: E402
    ReticulumProvider,
    _ReticulumInterface,
)
from test_reticulum_host_refresh import (  # noqa: E402,F401 - shared fixture
    _HOST,
    _WALL_OFFSET,
    _busy_pass,
    world,
)
from test_reticulum_position_unit import (  # noqa: E402 - shared config text
    _CONFIG,
    _PASSPHRASE,
    _SECRET,
)
from test_reticulum_unit import (  # noqa: E402 - shared Reticulum doubles
    _FIELD_LXMF,
    _FIELD_NOMADNET,
    _FIELD_PRIMARY,
    _fake_rns,
    _local_stack,
)

_PEER = "!aabbccdd"
"""Node id of the remote peer ``_busy_pass`` lands an announce from."""

_POSITION = rp.HostPosition(52.5029, 13.4042, 34.0)
"""The position :data:`_CONFIG` sets."""

_WITHOUT_POSITION = "\n".join(
    line
    for line in _CONFIG.splitlines()
    if not line.strip().startswith(("latitude", "longitude", "height"))
)
""":data:`_CONFIG` with the position keys deleted."""


@pytest.fixture(autouse=True)
def quiet(monkeypatch):
    """Silence the logs and start each test with no logged position outcome."""
    monkeypatch.setattr(rp, "_last_outcome", None)
    monkeypatch.setattr(config, "_debug_log", lambda *_a, **_k: None)


@pytest.fixture
def registered(monkeypatch):
    """Register :data:`_HOST` as the host, restoring the handler state after."""
    for name in (
        "_host_node_id",
        "_host_telemetry_last_rx",
        "_host_nodeinfo_last_seen",
    ):
        monkeypatch.setattr(handler_state, name, None)
    handlers.register_host_node_id(_HOST)


def _positioned_iface() -> _ReticulumInterface:
    """Return an interface holding the position read at connect.

    Returns:
        A fresh :class:`_ReticulumInterface` with :data:`_POSITION`.
    """
    iface = _ReticulumInterface(target=None)
    iface.host_position = _POSITION
    return iface


# ---------------------------------------------------------------------------
# connect: read once, onto the connection (SPEC RP1/RP2)
# ---------------------------------------------------------------------------


def test_connect_reads_the_host_position_from_the_rns_config(monkeypatch, tmp_path):
    """The position in the first RNode block lands on the new interface."""
    fake, _state = _fake_rns(existing_instance=object())
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(config, "RETICULUM_CONFIG_DIR", str(tmp_path))
    for name in (
        "RETICULUM_FREQ",
        "RETICULUM_PRESET",
        "LORA_FREQ",
        "MODEM_PRESET",
        "INGESTOR_NODE_ID",
        "CONNECTION",
    ):
        monkeypatch.setattr(config, name, None)

    iface, _target, _next = ReticulumProvider().connect(active_candidate=None)
    assert iface.host_position is None  # no config file: no position

    (tmp_path / "config").write_text(_CONFIG, encoding="utf-8")
    iface, _target, _next = ReticulumProvider().connect(active_candidate=None)
    assert iface.host_position == _POSITION
    assert config.LORA_FREQ == 867  # the radio metadata reads the same block


def test_quotes_and_a_bad_height_still_publish_the_coordinates(
    monkeypatch, tmp_path, registered
):
    """Quoted keys read as RNS reads them; a bad height drops the altitude only."""
    fake, _state = _fake_rns(existing_instance=object())
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(config, "RETICULUM_CONFIG_DIR", str(tmp_path))
    monkeypatch.setattr(config, "INGESTOR_NODE_ID", _HOST)
    monkeypatch.setattr(config, "CONNECTION", None)
    posts: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        queue,
        "_queue_post_json",
        lambda path, payload, **_k: posts.append((path, payload)),
    )
    quoted = (
        _CONFIG.replace("latitude = 52.5029", 'latitude = "52.5029"')
        .replace("longitude = 13.4042", "longitude = '13.4042'")
        .replace("height = 34", "height = sky-high")
    )
    (tmp_path / "config").write_text(quoted, encoding="utf-8")
    provider = ReticulumProvider()
    iface, _target, _next = provider.connect(active_candidate=None)
    assert iface.host_position == rp.HostPosition(52.5029, 13.4042, None)
    position = provider.self_node_items(iface)[0][1]["position"]
    assert (position["latitude"], position["longitude"]) == (52.5029, 13.4042)
    assert "altitude" not in position
    assert "altitude" not in posts[0][1]


def test_removing_the_keys_stops_the_refresh(monkeypatch, tmp_path, registered):
    """Delete the keys and reconnect: the reports post no position (SPEC RP8)."""
    fake, _state = _fake_rns(existing_instance=object())
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(config, "RETICULUM_CONFIG_DIR", str(tmp_path))
    monkeypatch.setattr(config, "INGESTOR_NODE_ID", _HOST)
    monkeypatch.setattr(config, "CONNECTION", None)
    posts: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        queue,
        "_queue_post_json",
        lambda path, payload, **_k: posts.append((path, payload)),
    )
    (tmp_path / "config").write_text(_CONFIG, encoding="utf-8")
    provider = ReticulumProvider()
    iface, _target, _next = provider.connect(active_candidate=None)
    assert provider.self_node_items(iface)[0][1]["position"]["latitude"] == 52.5029
    assert [path for path, _payload in posts] == ["/api/positions"]

    (tmp_path / "config").write_text(_WITHOUT_POSITION, encoding="utf-8")
    iface, _target, _next = provider.connect(active_candidate=None)
    assert iface.host_position is None
    assert provider.self_node_items(iface) == []
    assert len(posts) == 1  # no second row


# ---------------------------------------------------------------------------
# The node snapshot (SPEC RP4/RP6)
# ---------------------------------------------------------------------------


def test_snapshot_positions_the_host_records_and_never_a_peer(monkeypatch, registered):
    """Every record keyed on the host carries the position; a peer's never does.

    The host's ``lxmf.delivery`` was also heard live at 0 hops, so one host
    record comes from the stored announces and one from discovery.
    """
    _local_stack(
        monkeypatch, {_FIELD_LXMF: _FIELD_PRIMARY, _FIELD_NOMADNET: _FIELD_PRIMARY}
    )
    monkeypatch.setattr(_mod.time, "time", lambda: 1_791_000_000.0)
    iface = _positioned_iface()
    peer = {"nodeId": _PEER, "user": {"longName": "Remote Peer"}}
    heard = {"nodeId": _HOST, "lastHeard": 1, "destination": {"id": _FIELD_LXMF}}
    iface._update_node(_PEER, peer)
    iface._update_node(_HOST, heard)

    items = ReticulumProvider().node_snapshot_items(iface)

    by_id: dict[str, list[dict]] = {}
    for node_id, node in items:
        by_id.setdefault(node_id, []).append(node)
    assert len(by_id[_HOST]) == 2  # the heard lxmf.delivery, the found nomadnet
    for node in by_id[_HOST]:
        assert node["position"] == rp.node_position(_POSITION, 1_791_000_000)
    assert by_id[_PEER] == [peer]
    assert "position" not in heard  # the stored announce is not mutated


def test_snapshot_is_unchanged_without_a_position(monkeypatch, registered):
    """No keys in the RNS config: the records are exactly what they were."""
    _local_stack(monkeypatch, {_FIELD_LXMF: _FIELD_PRIMARY})
    items = ReticulumProvider().node_snapshot_items(_ReticulumInterface(target=None))
    assert len(items) == 1
    assert "position" not in items[0][1]


def test_a_host_with_nothing_announcing_gets_one_bare_record(monkeypatch, registered):
    """Docker's default volume: a pinned host id and no destination (SPEC RP6)."""
    _local_stack(monkeypatch, {})
    monkeypatch.setattr(_mod.time, "time", lambda: 1_791_000_000.0)
    items = ReticulumProvider().node_snapshot_items(_positioned_iface())
    assert items == [
        (
            _HOST,
            {
                "nodeId": _HOST,
                "lastHeard": 1_791_000_000,
                "protocol": "reticulum",
                # The node's own placeholder (RA10(a)): the head of its id.
                "user": {
                    "shortName": "2771",
                    "longName": "Reticulum 2771",
                    "role": "PEER",
                },
                "position": rp.node_position(_POSITION, 1_791_000_000),
            },
        )
    ]
    # Without a position the snapshot stays empty, as before.
    assert (
        ReticulumProvider().node_snapshot_items(_ReticulumInterface(target=None)) == []
    )


def test_the_snapshot_posts_no_row(monkeypatch, registered):
    """The row is the report's job, so connect posts one row, not two."""
    _local_stack(monkeypatch, {_FIELD_LXMF: _FIELD_PRIMARY})
    posts: list[str] = []
    monkeypatch.setattr(
        queue, "_queue_post_json", lambda path, *_a, **_k: posts.append(path)
    )
    ReticulumProvider().node_snapshot_items(_positioned_iface())
    assert posts == []


# ---------------------------------------------------------------------------
# The self-node report (SPEC RP4-RP6)
# ---------------------------------------------------------------------------


def test_the_report_positions_the_host_and_posts_its_row(monkeypatch, registered):
    """Each report: positioned host records and one positions row."""
    _local_stack(monkeypatch, {_FIELD_LXMF: _FIELD_PRIMARY})
    posts: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        queue,
        "_queue_post_json",
        lambda path, payload, **_k: posts.append((path, payload)),
    )
    items = ReticulumProvider().self_node_items(_positioned_iface())
    assert [node["destination"]["aspect"] for _nid, node in items] == ["lxmf.delivery"]
    assert items[0][1]["position"]["altitude"] == 34.0
    assert [(path, payload["node_id"]) for path, payload in posts] == [
        ("/api/positions", _HOST)
    ]


def test_the_report_still_needs_a_registered_host_id(monkeypatch):
    """No host id yet: nothing to report, positioned or not."""
    monkeypatch.setattr(handler_state, "_host_node_id", None)
    assert ReticulumProvider().self_node_items(_positioned_iface()) == []


# ---------------------------------------------------------------------------
# End to end through the daemon loop (SPEC RP4-RP6, ACCEPTANCE RP-A3)
# ---------------------------------------------------------------------------


@pytest.fixture
def mesh(world, monkeypatch, tmp_path):
    """The RE-A14 world with the host position in its RNS config.

    Returns:
        The ``world`` namespace plus ``posts``: every ``(path, payload)``
        queued, in order.
    """
    (tmp_path / "config").write_text(_CONFIG, encoding="utf-8")
    posts: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        queue,
        "_queue_post_json",
        lambda path, payload, **_k: posts.append((path, payload)),
    )
    world.posts = posts
    return world


def _records(posts, node_id: str) -> list[dict]:
    """Return every posted node record of *node_id*, in order.

    Parameters:
        posts: Captured ``(path, payload)`` pairs.
        node_id: Node whose records to collect.

    Returns:
        The node dicts.
    """
    return [p[node_id] for path, p in posts if path == "/api/nodes" and node_id in p]


def _rows(posts) -> list[dict]:
    """Return every posted positions row, in order.

    Parameters:
        posts: Captured ``(path, payload)`` pairs.

    Returns:
        The positions payloads.
    """
    return [payload for path, payload in posts if path == "/api/positions"]


def test_the_host_is_positioned_at_connect_and_every_hour(mesh):
    """One row at connect and one per report; the peer is never positioned.

    Against the tree before this feature it fails with ``assert [] == [...]``:
    no positions row is posted and no host record carries a position.
    """
    state = make_state(provider=ReticulumProvider(), inactivity_reconnect_secs=3600.0)
    connected_at = _WALL_OFFSET + int(mesh.clock["mono"])
    _busy_pass(state, mesh)  # connect: snapshot, then the first report
    assert [row["position_time"] for row in _rows(mesh.posts)] == [connected_at]
    for _ in range(61):  # one report interval, plus one loop
        _busy_pass(state, mesh)

    rows = _rows(mesh.posts)
    assert [row["position_time"] for row in rows] == [connected_at, connected_at + 3600]
    assert {(row["node_id"], row["protocol"], row["latitude"]) for row in rows} == {
        (_HOST, "reticulum", 52.5029)
    }
    host = _records(mesh.posts, _HOST)
    assert len(host) == 6  # two aspects: snapshot, connect report, hourly report
    assert all(node["position"]["longitude"] == 13.4042 for node in host)
    peer = _records(mesh.posts, _PEER)
    assert peer and all("position" not in node for node in peer)
    assert mesh.sent == []  # local reads only (SPEC RN5, MA7)


def test_a_host_with_nothing_announcing_is_positioned_hourly(mesh, monkeypatch):
    """Docker: the bare record latches the snapshot, so the report runs hourly."""
    mesh.stack.local.clear()  # nothing announces on the default volume
    monkeypatch.setattr(config, "INGESTOR_NODE_ID", _HOST)
    state = make_state(provider=ReticulumProvider(), inactivity_reconnect_secs=3600.0)
    _busy_pass(state, mesh)

    assert state.initial_snapshot_sent  # before this feature: nothing to latch on
    host = _records(mesh.posts, _HOST)
    assert len(host) == 2  # the snapshot and the connect report
    for node in host:
        assert node["user"] == {
            "shortName": "2771",
            "longName": "Reticulum 2771",
            "role": "PEER",
        }
        assert "destination" not in node
        assert node["position"]["latitude"] == 52.5029
    assert len(_rows(mesh.posts)) == 1
    for _ in range(61):
        _busy_pass(state, mesh)
    assert len(_rows(mesh.posts)) == 2


def test_no_secret_from_the_rns_config_reaches_a_post(mesh):
    """``rpc_key`` and an interface ``passphrase`` never leave the parser (RP1)."""
    state = make_state(provider=ReticulumProvider(), inactivity_reconnect_secs=3600.0)
    _busy_pass(state, mesh)
    flat = json.dumps(mesh.posts)
    assert _rows(mesh.posts)  # the position was published...
    assert _SECRET not in flat and _PASSPHRASE not in flat  # ...and nothing else


def test_without_the_keys_the_loop_posts_no_position(mesh, tmp_path):
    """A config with no position keys behaves exactly as before (SPEC RP2)."""
    (tmp_path / "config").write_text(
        "[interfaces]\n  [[RNode]]\n    type = RNodeInterface\n", encoding="utf-8"
    )
    state = make_state(provider=ReticulumProvider(), inactivity_reconnect_secs=3600.0)
    for _ in range(3):
        _busy_pass(state, mesh)
    assert _rows(mesh.posts) == []
    assert all("position" not in node for node in _records(mesh.posts, _HOST))
    assert _records(mesh.posts, _HOST)  # the host is still reported (SPEC RE8)


def test_the_bare_record_is_wired_into_the_provider():
    """The provider's own builder, as the integration tests above exercise it."""
    record = _mod._bare_host_record(_HOST, 7)
    assert record == {
        "nodeId": _HOST,
        "lastHeard": 7,
        "protocol": "reticulum",
        "user": {"shortName": "2771", "longName": "Reticulum 2771", "role": "PEER"},
    }
