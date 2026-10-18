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
"""A full-hash pin that fronts no announce aspect here follows discovery (SPEC HI5).

Maintainer decision (2026-10-18), "Follow discovery": when a full 32-hex
``INGESTOR_NODE_ID`` names an identity that fronts none of the three announce
aspects locally and discovery elects one primary, the provider reports that
identity and registers its node id, so heartbeats, ``/api/ingestors`` and the
hourly report follow it.  The pin wins again once its identity fronts an
aspect here.  A tie or an empty table changes nothing, and a change takes
effect only when two evaluations in a row give it, so an answer that keeps
changing never re-registers the host.

Runs on the client-shaped fake of ``tests/test_reticulum_host_identity.py``,
which keeps RNS's own lookups and clean.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:  # pragma: no cover - conftest adds it
    sys.path.insert(0, str(REPO_ROOT))

import RNS  # noqa: E402 - path setup

from daemon_fakes import make_state  # noqa: E402 - shared daemon doubles
from data.mesh_ingestor import config, handlers  # noqa: E402 - path setup
from data.mesh_ingestor.protocols.reticulum import ReticulumProvider  # noqa: E402
from test_reticulum_host_identity import (  # noqa: E402,F401 - shared fixtures
    _DESTINATIONS,
    _HOST,
    _HOST_IDENTITY,
    _OTHER,
    _OTHER_IDENTITY,
    _THIRD_IDENTITY,
    _announce_here,
    _attach,
    _attached_pass,
    _by_aspect,
    _host_warnings,
    _leave,
    client,
    world,
)


def _pin_other(monkeypatch) -> list:
    """Pin :data:`_OTHER_IDENTITY` by its full hash and capture the log.

    Returns:
        The ``(message, fields)`` pairs logged from now on.
    """
    logged: list = []
    monkeypatch.setattr(
        config, "_debug_log", lambda msg, **kw: logged.append((msg, kw))
    )
    monkeypatch.setattr(config, "INGESTOR_NODE_ID", _OTHER_IDENTITY.hash.hex())
    return logged


def _switches(logged) -> list[tuple[str, str]]:
    """Return ``(previous, current)`` for every host switch in *logged*."""
    return [
        (fields["previous"], fields["current"]) for fields in _host_warnings(logged)
    ]


def test_the_heartbeat_follows_the_switch_from_the_first_pass(
    client, world, monkeypatch
):
    """No heartbeat goes out under the pinned id: the switch comes at connect."""
    logged = _pin_other(monkeypatch)
    state = make_state(provider=ReticulumProvider(), inactivity_reconnect_secs=3600.0)
    for _ in range(2):
        _attached_pass(state, world, client)

    aspects = {
        node["destination"]["aspect"] for node in client.posts if "destination" in node
    }
    assert client.heartbeats and set(client.heartbeats) == {_HOST}
    assert handlers.host_node_id() == _HOST
    assert sorted(aspects) == _DESTINATIONS
    assert _switches(logged) == [(_OTHER, _HOST)]
    assert world.sent == []  # receive-only (SPEC RN5)


def test_the_pin_wins_again_once_its_identity_announces_here(client, monkeypatch):
    """Back to the pin at the second evaluation that sees it, with the same warning."""
    logged = _pin_other(monkeypatch)
    provider = ReticulumProvider()
    _attach(provider)  # follows the host's identity at once
    _announce_here(client, _OTHER_IDENTITY)

    waits = {record["nodeId"] for record in provider.host_destination_nodes()}
    back = {record["nodeId"] for record in provider.host_destination_nodes()}

    assert (waits, back) == ({_HOST}, {_OTHER})
    assert handlers.host_node_id() == _OTHER
    assert _switches(logged) == [(_OTHER, _HOST), (_HOST, _OTHER)]


def test_a_tie_keeps_the_pin(client, monkeypatch):
    """Two identities with three destinations each: no switch, no warning."""
    logged = _pin_other(monkeypatch)
    _announce_here(client, _THIRD_IDENTITY)
    provider = ReticulumProvider()
    items = provider.self_node_items(_attach(provider))

    assert handlers.host_node_id() == _OTHER
    assert {node_id for node_id, _node in items} == {_OTHER}
    assert sorted(_by_aspect(items)) == ["rns.transport"]
    assert _host_warnings(logged) == []


def test_an_answer_that_changes_every_report_never_re_registers(client, monkeypatch):
    """Discovery alternates between two identities: the host id stays put."""
    logged = _pin_other(monkeypatch)
    provider = ReticulumProvider()
    iface = _attach(provider)  # follows the host's identity at once
    registered: list[str] = []
    register = handlers.register_host_node_id
    monkeypatch.setattr(
        handlers,
        "register_host_node_id",
        lambda node_id: (registered.append(node_id), register(node_id)),
    )
    for _ in range(3):
        _leave(client, _HOST_IDENTITY)
        _announce_here(client, _THIRD_IDENTITY)
        provider.self_node_items(iface)
        _leave(client, _THIRD_IDENTITY)
        _announce_here(client, _HOST_IDENTITY)
        provider.self_node_items(iface)

    assert registered == []
    assert handlers.host_node_id() == _HOST
    assert _switches(logged) == [(_OTHER, _HOST)]


def test_a_reconnect_keeps_the_followed_identity(client, monkeypatch):
    """What the daemon registers at a reconnect is the identity followed, no warning."""
    logged = _pin_other(monkeypatch)
    provider = ReticulumProvider()
    iface = _attach(provider)

    assert provider.extract_host_node_id(iface) == _HOST
    assert _switches(logged) == [(_OTHER, _HOST)]


def test_a_switch_after_connect_re_registers_and_the_report_follows(
    client, monkeypatch
):
    """The pinned identity's apps leave after the client's clean; the host moves.

    While the pin fronts, the provider keeps learning the other local
    identities, so after the clean discovery can still elect one; the report
    after next registers it (SPEC HI5).
    """
    _announce_here(client, _OTHER_IDENTITY)
    logged = _pin_other(monkeypatch)
    provider = ReticulumProvider()
    iface = _attach(provider)  # the pinned identity announces here: the pin wins
    provider.self_node_items(iface)  # the report the daemon runs right after connect
    assert handlers.host_node_id() == _OTHER
    RNS.Identity.clean_known_destinations()  # 5 minutes on: the client forgets both
    _leave(client, _OTHER_IDENTITY)

    waits = provider.self_node_items(iface)
    moved = provider.self_node_items(iface)

    assert {node_id for node_id, _node in waits} == {_OTHER}
    assert handlers.host_node_id() == _HOST
    assert {node_id for node_id, _node in moved} == {_HOST}
    assert sorted(_by_aspect(moved)) == _DESTINATIONS
    assert _switches(logged) == [(_OTHER, _HOST)]
