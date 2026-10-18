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
"""Unit tests for :mod:`data.mesh_ingestor.protocols.reticulum_host` (SPEC HI1-HI5)."""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:  # pragma: no cover - conftest adds it
    sys.path.insert(0, str(REPO_ROOT))

from data.mesh_ingestor import config, handlers  # noqa: E402 - path setup
from data.mesh_ingestor.handlers import _state as handler_state  # noqa: E402
from data.mesh_ingestor.protocols.reticulum_host import (  # noqa: E402 - path setup
    MEMORY_LIMIT,
    IdentityMemory,
    PinFollow,
    answered_name,
    group_by_identity,
    local_destinations,
    pinned_identity,
    remember_announce,
)

_PRIMARY = "27716218762cfd2864141ef286c39940"
_OTHER = "0be70000" + "33" * 12
_THIRD = "11c00000" + "44" * 12
_TRANSPORT = "fbf8e3389bc79a4fe9ed22eae97fc268"
_LXMF = "4cf985bf933c21b1aa8dabd407d4ef69"
_NOMADNET = "9c59da5e1516745d74cc908243e0ba2b"


# ---------------------------------------------------------------------------
# IdentityMemory
# ---------------------------------------------------------------------------


def test_memory_starts_empty_and_answers_none():
    """Nothing learned: no identity, no name, no entry created by asking."""
    memory = IdentityMemory()
    assert memory.identity(_LXMF) is None
    assert memory.name(_LXMF) is None
    assert len(memory) == 0


def test_memory_keeps_what_a_live_announce_carried():
    """``learn`` records the identity and the name together."""
    memory = IdentityMemory()
    memory.learn(_LXMF, _PRIMARY, "afri-orion")
    assert (memory.identity(_LXMF), memory.name(_LXMF)) == (_PRIMARY, "afri-orion")


def test_a_newer_name_replaces_the_held_one_even_when_it_is_none():
    """The newest answer wins, including "this destination announces no name"."""
    memory = IdentityMemory()
    memory.learn(_LXMF, _PRIMARY, "old name")
    memory.learn_name(_LXMF, "new name")
    assert memory.name(_LXMF) == "new name"
    memory.learn_name(_LXMF, None)
    assert memory.name(_LXMF) is None
    assert memory.identity(_LXMF) == _PRIMARY


def test_a_different_identity_drops_the_name_the_old_one_announced():
    """The held name belonged to the old identity, so it goes with it."""
    memory = IdentityMemory()
    memory.learn(_LXMF, _OTHER, "someone else")
    memory.learn_identity(_LXMF, _PRIMARY)
    assert (memory.identity(_LXMF), memory.name(_LXMF)) == (_PRIMARY, None)


def test_the_same_identity_or_a_first_one_keeps_the_name():
    """Confirming the held identity, or learning one after the name, keeps it."""
    memory = IdentityMemory()
    memory.learn_name(_LXMF, "afri-orion")  # the name arrived first
    memory.learn_identity(_LXMF, _PRIMARY)
    memory.learn_identity(_LXMF, _PRIMARY)
    assert memory.name(_LXMF) == "afri-orion"


def test_memory_is_bounded_and_drops_the_least_recently_used():
    """Past the limit the oldest goes; a lookup counts as use."""
    memory = IdentityMemory(limit=2)
    memory.learn_identity("aa", _PRIMARY)
    memory.learn_identity("bb", _PRIMARY)
    assert memory.identity("aa") == _PRIMARY  # "aa" is now the most recent
    memory.learn_name("cc", "third")
    assert len(memory) == 2
    assert memory.identity("bb") is None
    assert memory.identity("aa") == _PRIMARY
    assert memory.name("cc") == "third"


def test_memory_holds_at_least_one_and_defaults_to_the_module_limit():
    """A limit below one is raised to one; the default is :data:`MEMORY_LIMIT`."""
    tiny = IdentityMemory(limit=0)
    tiny.learn_identity("aa", _PRIMARY)
    tiny.learn_identity("bb", _PRIMARY)
    assert len(tiny) == 1
    default = IdentityMemory()
    for index in range(MEMORY_LIMIT + 5):
        default.learn_identity(f"{index:032x}", _PRIMARY)
    assert len(default) == MEMORY_LIMIT


# ---------------------------------------------------------------------------
# answered_name and remember_announce
# ---------------------------------------------------------------------------


def _decode(data):
    """Decode test ``app_data``: UTF-8 text, or ``None`` for an empty name."""
    return data.decode() or None


def test_answered_name_prefers_rns_and_keeps_its_answer():
    """Fresh ``app_data`` wins and is remembered, even when it names nothing."""
    memory = IdentityMemory()
    memory.learn(_LXMF, _PRIMARY, "old name")
    assert answered_name(memory, _LXMF, b"new name", _decode) == "new name"
    assert memory.name(_LXMF) == "new name"
    assert answered_name(memory, _LXMF, b"", _decode) is None
    assert memory.name(_LXMF) is None


def test_answered_name_falls_back_to_the_memory_when_rns_has_nothing():
    """``None`` from RNS takes the held name; without a memory there is none."""
    memory = IdentityMemory()
    memory.learn(_LXMF, _PRIMARY, "afri-orion")
    assert answered_name(memory, _LXMF, None, _decode) == "afri-orion"
    assert answered_name(None, _LXMF, None, _decode) is None
    assert answered_name(None, _LXMF, b"afri-orion", _decode) == "afri-orion"


def test_remember_announce_keeps_identity_and_name():
    """A record with an identity and a destination teaches the memory both."""
    memory = IdentityMemory()
    node = {"identityHash": _PRIMARY, "destination": {"id": _LXMF}}
    remember_announce(memory, node, "afri-orion")
    assert (memory.identity(_LXMF), memory.name(_LXMF)) == (_PRIMARY, "afri-orion")


@pytest.mark.parametrize(
    "node",
    [
        {"destination": {"id": _LXMF}},
        {"identityHash": _PRIMARY},
        {"identityHash": "", "destination": {"id": _LXMF}},
    ],
    ids=["no-identity", "no-destination", "empty-identity"],
)
def test_remember_announce_learns_nothing_from_an_incomplete_record(node):
    """Without both an identity and a destination nothing is kept."""
    memory = IdentityMemory()
    remember_announce(memory, node, "afri-orion")
    remember_announce(None, node, "afri-orion")  # no memory: a no-op
    assert len(memory) == 0


# ---------------------------------------------------------------------------
# pinned_identity
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value, expected",
    [
        (_PRIMARY, _PRIMARY),
        (f"  {_PRIMARY.upper()}\n", _PRIMARY),
        ("!27716218", None),
        (_PRIMARY[:31], None),
        (_PRIMARY + "0", None),
        ("z" * 32, None),
        ("!" + _PRIMARY[:31], None),
        ("", None),
        (None, None),
    ],
    ids=[
        "full-hash",
        "case-and-space",
        "short-id",
        "31-hex",
        "33-hex",
        "not-hex",
        "bang-prefixed",
        "empty",
        "unset",
    ],
)
def test_only_a_full_32_hex_value_names_an_identity(value, expected):
    """``!`` plus eight hex pins the node id only; other values pin nothing."""
    assert pinned_identity(value) == expected


# ---------------------------------------------------------------------------
# local_destinations and group_by_identity
# ---------------------------------------------------------------------------


def test_local_destinations_maps_hashes_to_interfaces_and_skips_the_unusable():
    """A ``str`` hash is skipped; a missing or empty interface reads ``None``."""
    entries = [
        {"hash": "not-bytes"},
        {"hash": bytes.fromhex(_LXMF), "interface": "LocalInterface[rns/default]"},
        {"hash": bytearray.fromhex(_NOMADNET), "interface": ""},
        {"hash": bytes.fromhex(_TRANSPORT)},
    ]
    assert local_destinations(entries) == {
        _LXMF: "LocalInterface[rns/default]",
        _NOMADNET: None,
        _TRANSPORT: None,
    }


def test_group_by_identity_prefers_recall_and_keeps_its_answers():
    """Recall answers first, and the memory keeps each answer it gives."""
    memory = IdentityMemory()
    memory.learn_identity(_LXMF, _OTHER)  # stale: recall knows better
    groups = group_by_identity(
        {_LXMF: "LocalInterface[x]", _NOMADNET: None},
        {_LXMF: _PRIMARY, _NOMADNET: _PRIMARY}.get,
        memory,
        _TRANSPORT,
    )
    assert groups == {_PRIMARY: {_LXMF: "LocalInterface[x]", _NOMADNET: None}}
    assert memory.identity(_LXMF) == _PRIMARY


def test_group_by_identity_falls_back_to_the_memory_only_when_recall_misses():
    """A forgotten destination takes the held identity; an unknown one is skipped."""
    memory = IdentityMemory()
    memory.learn_identity(_LXMF, _PRIMARY)
    groups = group_by_identity(
        {_LXMF: None, _NOMADNET: None}, lambda _dest: None, memory, _TRANSPORT
    )
    assert groups == {_PRIMARY: {_LXMF: None}}


def test_group_by_identity_leaves_out_the_excluded_identity():
    """The transport identity is never grouped, whether recalled or remembered."""
    memory = IdentityMemory()
    memory.learn_identity(_NOMADNET, _TRANSPORT)
    groups = group_by_identity(
        {_LXMF: None, _NOMADNET: None},
        {_LXMF: _TRANSPORT}.get,
        memory,
        _TRANSPORT,
    )
    assert groups == {}


def test_group_by_identity_without_a_memory_uses_recall_alone():
    """No memory: what recall misses is skipped, as before SPEC HI1."""
    groups = group_by_identity(
        {_LXMF: None, _NOMADNET: None}, {_LXMF: _PRIMARY}.get, None, None
    )
    assert groups == {_PRIMARY: {_LXMF: None}}


# ---------------------------------------------------------------------------
# PinFollow (SPEC HI5)
# ---------------------------------------------------------------------------


def _node_id(identity: str) -> str:
    """Map an identity hash to its node id, as the provider's mapping does."""
    return "!" + identity[:8]


def _never() -> str:
    """Stand in for discovery where it must not be asked."""
    raise AssertionError("discovery was asked")


@pytest.fixture
def follow(monkeypatch):
    """A :class:`PinFollow` with its warnings captured and no host registered.

    Returns:
        Namespace with ``pin`` (the follower) and ``logged`` (log calls).
    """
    logged: list = []
    monkeypatch.setattr(
        config, "_debug_log", lambda msg, **kw: logged.append((msg, kw))
    )
    for name in (
        "_host_node_id",
        "_host_telemetry_last_rx",
        "_host_nodeinfo_last_seen",
    ):
        monkeypatch.setattr(handler_state, name, None)
    return types.SimpleNamespace(pin=PinFollow(_node_id), logged=logged)


def _switches(logged) -> list[tuple[str, str]]:
    """Return ``(previous, current)`` for every switch warning in *logged*."""
    return [
        (fields["previous"], fields["current"])
        for message, fields in logged
        if message == "Reticulum host identity switched"
    ]


def test_a_pin_that_fronts_a_local_aspect_is_reported_without_discovery(follow):
    """The pin wins while its identity announces here; discovery is not asked."""
    assert follow.pin.choose(_OTHER, True, _never) == _OTHER
    assert follow.pin.choose(_OTHER, True, _never) == _OTHER
    assert follow.logged == []


def test_the_first_evaluation_follows_discovery_at_once(follow):
    """Nothing to alternate with yet: the first answer is taken, with one warning."""
    assert follow.pin.choose(_OTHER, False, lambda: _PRIMARY) == _PRIMARY
    assert follow.logged == [
        (
            "Reticulum host identity switched",
            {
                "context": "reticulum.host",
                "severity": "warn",
                "pinned": "!0be70000",
                "previous": "!0be70000",
                "current": "!27716218",
            },
        )
    ]
    assert handlers.host_node_id() is None  # the daemon registers what it is told


def test_a_switch_registers_the_new_id_once_a_host_is_registered(follow):
    """The daemon asks only while no host id is registered, so the switch registers."""
    handlers.register_host_node_id("!0be70000")
    follow.pin.choose(_OTHER, False, lambda: _PRIMARY)
    assert handlers.host_node_id() == "!27716218"


def test_a_new_answer_takes_effect_at_its_second_evaluation(follow):
    """Either way: to the discovered identity, and back to the pin."""
    pin = follow.pin
    assert pin.choose(_OTHER, True, _never) == _OTHER
    assert pin.choose(_OTHER, False, lambda: _PRIMARY) == _OTHER
    assert pin.choose(_OTHER, False, lambda: _PRIMARY) == _PRIMARY
    assert pin.choose(_OTHER, True, _never) == _PRIMARY
    assert pin.choose(_OTHER, True, _never) == _OTHER
    assert _switches(follow.logged) == [
        ("!0be70000", "!27716218"),
        ("!27716218", "!0be70000"),
    ]


def test_an_answer_that_alternates_never_switches(follow):
    """No answer repeats, so the reported identity and the host id stay put."""
    pin = follow.pin
    assert pin.choose(_OTHER, False, lambda: _PRIMARY) == _PRIMARY
    for answer in [_THIRD, _PRIMARY] * 3:
        assert pin.choose(_OTHER, False, lambda answer=answer: answer) == _PRIMARY
    for fronts in [True, False] * 3:
        assert pin.choose(_OTHER, fronts, lambda: _THIRD) == _PRIMARY
    assert len(_switches(follow.logged)) == 1


def test_a_tie_or_an_empty_table_changes_nothing(follow):
    """No single answer keeps what is reported: the pin, or the identity followed."""
    pin = follow.pin
    assert pin.choose(_OTHER, False, lambda: None) == _OTHER
    assert pin.choose(_OTHER, False, lambda: None) == _OTHER
    assert pin.choose(_OTHER, False, lambda: _PRIMARY) == _OTHER
    assert pin.choose(_OTHER, False, lambda: _PRIMARY) == _PRIMARY
    assert pin.choose(_OTHER, False, lambda: None) == _PRIMARY
    assert pin.choose(_OTHER, False, lambda: None) == _PRIMARY
    assert _switches(follow.logged) == [("!0be70000", "!27716218")]


def test_a_changed_pin_starts_over(follow):
    """Nothing is kept from an earlier pin: each new one decides at once."""
    pin = follow.pin
    assert pin.choose(_OTHER, False, lambda: _PRIMARY) == _PRIMARY
    assert pin.choose(_THIRD, True, _never) == _THIRD
    assert pin.choose(_OTHER, False, lambda: _PRIMARY) == _PRIMARY
    assert _switches(follow.logged) == [
        ("!0be70000", "!27716218"),
        ("!0be70000", "!27716218"),
    ]
