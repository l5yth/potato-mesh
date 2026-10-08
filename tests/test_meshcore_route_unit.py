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
"""Unit tests for MeshCore channel-message route capture (#765).

Covers :mod:`data.mesh_ingestor.protocols.meshcore.route` and its wiring into
the runner and the event handlers: the bounded RX-log index (SPEC SC2), the
default-flood-scope read and the resolution by the default region and then the
built-in scope table (SC3/SC4), the redacted ``DEBUG`` capture and the
hidden-channel gate (SC8), and the degradations (SC9).
"""

from __future__ import annotations

import asyncio
import json
import sys
import threading
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import meshcore  # noqa: E402 - path setup
import meshcore_frames as frames  # noqa: E402 - pytest puts tests/ on sys.path

import data.mesh_ingestor.channels as _channels  # noqa: E402
import data.mesh_ingestor.protocols.meshcore as _mod  # noqa: E402
import data.mesh_ingestor.queue as _queue_mod  # noqa: E402
from data.mesh_ingestor.protocols.meshcore import route  # noqa: E402
from data.mesh_ingestor.protocols.meshcore import runner as _runner  # noqa: E402
from data.mesh_ingestor.protocols.meshcore import (  # noqa: E402
    _MeshcoreInterface,
    _make_event_handlers,
)

_REGION = "#de-be"
"""Default flood scope used by the scoped-message examples."""

_SCOPE_KEY_HEX = frames.region_key(_REGION).hex()
"""The region key a radio reports alongside the name; never to be logged."""

_UNLISTED = "#rhein-main"
"""A public hashtag region the built-in scope table does not list."""


class _Clock:
    """Settable monotonic clock for the index expiry tests."""

    def __init__(self) -> None:
        """Start at zero."""
        self.now = 0.0

    def __call__(self) -> float:
        """Return the current reading."""
        return self.now


def _frame(**overrides) -> dict:
    """Return an RX-log ``GRP_TXT`` payload as the library delivers it.

    Parameters:
        **overrides: Fields to replace or add.

    Returns:
        A plain-flood, decrypted (``msg_hash``) 3-hop copy.
    """
    frame = {
        "payload_type": 5,
        "payload_typename": "GRP_TXT",
        "route_type": 1,
        "msg_hash": 0xABCD,
        "path_len": 3,
        "path": "f0bf44",
        "rssi": -96,
        "snr": 10.0,
        "pkt_payload": b"\x01\x02",
    }
    frame.update(overrides)
    return frame


# ---------------------------------------------------------------------------
# RxLogIndex (SC2)
# ---------------------------------------------------------------------------


def test_index_keeps_hashed_flood_copies():
    """Plain and scoped flood copies with a ``msg_hash`` are indexed."""
    index = route.RxLogIndex()
    assert index.add(_frame()) is True
    assert index.add(_frame(route_type=0, transport_code="a1b20000")) is True
    assert len(index) == 2
    copy = index.match(0xABCD, 3)
    assert copy == route.RxCopy(
        msg_hash=0xABCD,
        hops=3,
        route_type=1,
        path="f0bf44",
        rssi=-96,
        code0=b"",
        payload=b"\x01\x02",
        seen_at=copy.seen_at,
    )


@pytest.mark.parametrize(
    "overrides",
    [
        {"payload_type": 4},
        {"msg_hash": None},
        {"msg_hash": True},
        {"msg_hash": "abcd"},
        {"path_len": None},
        {"route_type": 2},
        {"route_type": 3},
        {"route_type": None},
    ],
    ids=[
        "advert",
        "undecrypted",
        "bool-hash",
        "str-hash",
        "no-path-len",
        "direct",
        "scoped-direct",
        "no-route-type",
    ],
)
def test_index_skips_frames_no_message_can_match(overrides):
    """Non-text, undecrypted and direct-routed frames are not indexed."""
    index = route.RxLogIndex()
    assert index.add(_frame(**overrides)) is False
    assert len(index) == 0


def test_index_normalizes_copy_fields():
    """Path is lowercased (empty -> None), RSSI must be an int, the payload
    is kept as bytes, and ``transport_codes[0]`` is the first two bytes."""
    index = route.RxLogIndex()
    index.add(
        _frame(
            msg_hash=1,
            path="F0BF44",
            rssi=True,
            route_type=0,
            transport_code="A1B2C3D4",
            pkt_payload=bytearray(b"\x09"),
        )
    )
    index.add(_frame(msg_hash=2, path="", transport_code="zz", pkt_payload="x"))
    first, second = index.match(1, 3), index.match(2, 3)
    assert (first.path, first.rssi, first.code0, first.payload) == (
        "f0bf44",
        None,
        b"\xa1\xb2",
        b"\x09",
    )
    assert (second.path, second.code0, second.payload) == (None, b"", b"")


def test_index_holds_at_most_256_copies():
    """The 257th copy evicts the oldest one."""
    assert route.RX_LOG_INDEX_MAX_ENTRIES == 256
    index = route.RxLogIndex()
    for msg_hash in range(257):
        index.add(_frame(msg_hash=msg_hash))
    assert len(index) == 256
    assert index.match(0, 3) is None
    assert index.match(1, 3) is not None
    assert index.match(256, 3) is not None


def test_index_expires_copies_after_300_seconds():
    """A copy matches for 300 s after it was heard, then never again."""
    assert route.RX_LOG_INDEX_MAX_AGE_SECS == 300.0
    clock = _Clock()
    index = route.RxLogIndex(clock=clock)
    index.add(_frame(msg_hash=1))
    clock.now = 300.0
    assert index.match(1, 3) is not None
    clock.now = 300.5
    assert index.match(1, 3) is None
    assert len(index) == 0
    # Expiry also runs on insert, so a quiet channel never accumulates.
    index.add(_frame(msg_hash=2))
    clock.now = 700.0
    index.add(_frame(msg_hash=3))
    assert len(index) == 1


def test_index_match_takes_the_earliest_copy_with_equal_hops():
    """Hash and hop count must both match; the first such copy wins."""
    index = route.RxLogIndex()
    index.add(_frame(path="aaaaaa", path_len=3))
    index.add(_frame(path="bbbbbbbbbb", path_len=5))
    index.add(_frame(path="cccccc", path_len=3))
    assert index.match(0xABCD, 3).path == "aaaaaa"
    assert index.match(0xABCD, 5).path == "bbbbbbbbbb"
    assert index.match(0xABCD, 4) is None
    assert index.match(0x1234, 3) is None


# ---------------------------------------------------------------------------
# Scope (SC3/SC4)
# ---------------------------------------------------------------------------


def test_scope_label_strips_one_leading_hash():
    """The published name drops the ``#`` and nothing else."""
    assert route.scope_label("#de-be") == "de-be"
    assert route.scope_label("de-be") == "de-be"
    assert route.scope_label("##x") == "#x"


def test_region_key_follows_the_firmware_rule():
    """``#x`` and ``x`` both key on ``SHA256("#x")[:16]``."""
    assert route.region_key("#de-be") == frames.region_key("#de-be")
    assert route.region_key("de-be") == frames.region_key("#de-be")
    assert len(route.region_key("eu")) == 16


@pytest.mark.parametrize("name", [None, 7, "", "#", "*", "$private"])
def test_region_key_refuses_unnameable_regions(name):
    """No key for non-names, the wildcard, or a private ``$`` region."""
    assert route.region_key(name) is None


@pytest.mark.parametrize("payload", [b"", b"\x00", b"hello scope", bytes(range(64))])
def test_transport_code_matches_the_firmware_oracle(payload):
    """The recomputed code equals ``TransportKey::calcTransportCode``."""
    key = frames.region_key(_REGION)
    assert route.transport_code(key, 5, payload) == frames.transport_code(
        key, 5, payload
    )


@pytest.mark.parametrize(
    ("counter", "raw_prefix", "expected"),
    [(272_785, b"\x00\x00", b"\x01\x00"), (19_496, b"\xff\xff", b"\xfe\xff")],
    ids=["0000-to-0001", "ffff-to-fffe"],
)
def test_transport_code_moves_the_reserved_codes(counter, raw_prefix, expected):
    """HMAC prefixes ``0000`` and ``FFFF`` are reserved by the firmware."""
    import hashlib
    import hmac

    key = frames.region_key(_REGION)
    payload = counter.to_bytes(4, "big")
    raw = hmac.new(key, bytes([5]) + payload, hashlib.sha256).digest()[:2]
    assert raw == raw_prefix
    assert route.transport_code(key, 5, payload) == expected


def _copy(route_type: int, code0: bytes = b"", payload: bytes = b"pp") -> route.RxCopy:
    """Return a delivered copy for the scope-resolution tests.

    Parameters:
        route_type: Firmware route type.
        code0: ``transport_codes[0]`` bytes.
        payload: Packet payload.

    Returns:
        An :class:`route.RxCopy`.
    """
    return route.RxCopy(
        msg_hash=1,
        hops=2,
        route_type=route_type,
        path="aabb",
        rssi=-90,
        code0=code0,
        payload=payload,
        seen_at=0.0,
    )


def test_resolve_scope_of_a_plain_flood_is_unscoped():
    """``FLOOD`` reads ``*`` whatever the radio's default scope is."""
    assert route.resolve_scope(_copy(1), None) == "*"
    assert route.resolve_scope(_copy(1), _REGION) == "*"


@pytest.mark.parametrize("region", ["#de-be", "de-be"])
def test_resolve_scope_names_the_default_region(region):
    """A scoped flood keyed by the default region reads its name, no ``#``."""
    code0 = frames.transport_code(frames.region_key("de-be"), 5, b"pp")
    assert route.resolve_scope(_copy(0, code0), region) == "de-be"


@pytest.mark.parametrize("region", [None, "#eu", "*", "$rhein-main"])
def test_resolve_scope_of_an_unmatched_scoped_flood_is_unknown(region):
    """A scoped flood no candidate reproduces reads the reserved ``?``: an
    unlisted region, or a private ``$`` one, is never named."""
    code0 = frames.transport_code(frames.region_key(_UNLISTED), 5, b"pp")
    assert route.resolve_scope(_copy(0, code0), region) == "?"
    assert route.resolve_scope(_copy(0, b""), region) == "?"


def test_resolve_scope_of_a_direct_route_is_absent():
    """A route type that is not a flood has no flood scope."""
    assert route.resolve_scope(_copy(2), _REGION) is None
    assert route.resolve_scope(_copy(3), _REGION) is None


def test_reserved_scope_values():
    """``*`` is unscoped and ``?`` is scoped-unknown (CONTRACTS)."""
    assert route.SCOPE_UNSCOPED == "*"
    assert route.SCOPE_UNKNOWN == "?"


# ---------------------------------------------------------------------------
# Scope table fallback (SC3, amended 2026-10-08)
# ---------------------------------------------------------------------------

_OM_DE_BE = (161).to_bytes(4, "big")
"""Payload on which the table's ``om`` and ``de-be`` share one transport code.

Found offline: the first 4-byte counter on which ``de-be``'s code is
reproduced by exactly one other table name.
"""

_RHEIN_MAIN_BT = (186).to_bytes(4, "big")
"""Payload on which the unlisted ``rhein-main`` shares its code with ``bt``.

Found offline: the first 4-byte counter on which exactly one table name
reproduces the code of :data:`_UNLISTED`.
"""


def _scoped(region: str, payload: bytes) -> route.RxCopy:
    """Return a delivered copy of *payload* that a sender scoped to *region*.

    Parameters:
        region: Public hashtag region, with or without its ``#``.
        payload: Packet payload.

    Returns:
        A ``TRANSPORT_FLOOD`` :class:`route.RxCopy` carrying the region's code.
    """
    code0 = frames.transport_code(frames.region_key(region), 5, payload)
    return _copy(0, code0, payload)


@pytest.mark.parametrize("name", ["fr", "eu", "de-by", "at-9", "ch-zh"])
@pytest.mark.parametrize("region", [None, _UNLISTED, "$ops"])
def test_resolve_scope_names_a_table_region(name, region):
    """A default region that misses, or none, leaves the table to name the
    one listed region that reproduces the code."""
    assert route.resolve_scope(_scoped(name, b"pp"), region) == name


def test_resolve_scope_prefers_the_default_region_over_the_table():
    """The default region names every copy it reproduces, whatever the table
    holds; without it, an unlisted region takes a lone table match."""
    assert frames.transport_code(
        frames.region_key("om"), 5, _OM_DE_BE
    ) == frames.transport_code(frames.region_key("de-be"), 5, _OM_DE_BE)
    assert route.resolve_scope(_scoped("de-be", _OM_DE_BE), "#de-be") == "de-be"
    assert route.resolve_scope(_scoped("de-be", _OM_DE_BE), "#om") == "om"
    rhein_main = _scoped(_UNLISTED, _RHEIN_MAIN_BT)
    assert rhein_main.code0 == frames.transport_code(
        frames.region_key("bt"), 5, _RHEIN_MAIN_BT
    )
    assert route.resolve_scope(rhein_main, _UNLISTED) == "rhein-main"
    # The false match SC3 states: about N in 65,536 messages of a region the
    # table does not list read the one table name that shares their code.
    assert route.resolve_scope(rhein_main, None) == "bt"


@pytest.mark.parametrize("region", [None, "#eu", "$om", _UNLISTED])
def test_resolve_scope_of_two_matching_table_names_is_unknown(region):
    """Two table names reproduce the code: neither is stored, the copy reads
    ``?`` and a later copy may still name it (SC6)."""
    copy = _scoped("de-be", _OM_DE_BE)
    assert copy.code0 == frames.transport_code(frames.region_key("om"), 5, _OM_DE_BE)
    assert route.resolve_scope(copy, region) == "?"


def test_resolve_scope_costs_one_hmac_per_candidate(monkeypatch):
    """A scoped copy costs one HMAC per table name, plus one for a default
    region; a default match costs one, a plain flood none; nothing is logged."""
    calls: list = []
    logs: list = []
    real_transport_code = route.transport_code
    monkeypatch.setattr(
        route,
        "transport_code",
        lambda *args: calls.append(1) or real_transport_code(*args),
    )
    monkeypatch.setattr(route.config, "_debug_log", lambda *a, **k: logs.append(k))
    table_size = len(route.SCOPE_TABLE)
    unlisted = _scoped(_UNLISTED, b"pp")
    for region, cost in [(_UNLISTED, 1), (None, table_size), ("#eu", table_size + 1)]:
        calls.clear()
        route.resolve_scope(unlisted, region)
        assert len(calls) == cost, region
    calls.clear()
    assert route.resolve_scope(_copy(1), "#eu") == "*"
    assert calls == []
    assert logs == []


# ---------------------------------------------------------------------------
# Message hash and RouteTracker (SC2)
# ---------------------------------------------------------------------------


def test_message_hash_matches_the_library():
    """The recomputed hash is the reader's ``txt_hash``/``msg_hash``."""
    assert route.message_hash(frames.SENDER_TS, frames.TEXT) == frames.message_hash()


@pytest.mark.parametrize(
    ("sender_ts", "text"),
    [(None, "x"), (True, "x"), (-1, "x"), (2**32, "x"), ("1", "x"), (1, None)],
)
def test_message_hash_refuses_unusable_inputs(sender_ts, text):
    """No hash without a 32-bit timestamp and a text string."""
    assert route.message_hash(sender_ts, text) is None


def test_message_hash_tolerates_unencodable_text():
    """A lone surrogate never raises inside the message handler."""
    assert isinstance(route.message_hash(1, "a\ud800b"), int)


def test_channel_route_uses_the_events_txt_hash():
    """The V3 event's ``txt_hash`` selects the copy."""
    tracker = route.RouteTracker()
    tracker.observe(_frame(msg_hash=77))
    assert tracker.channel_route({"txt_hash": 77}, 3) == {
        "path": "f0bf44",
        "rssi": -96,
        "scope": "*",
    }


def test_channel_route_recomputes_a_missing_hash():
    """The older ``CHANNEL_MSG_RECV`` event carries no ``txt_hash``."""
    tracker = route.RouteTracker()
    tracker.observe(_frame(msg_hash=frames.message_hash()))
    payload = {"sender_timestamp": frames.SENDER_TS, "text": frames.TEXT}
    assert tracker.channel_route(payload, 3)["path"] == "f0bf44"


def test_channel_route_is_empty_without_a_match():
    """No hops, no usable hash, or no indexed copy: no route fields."""
    tracker = route.RouteTracker()
    tracker.observe(_frame(msg_hash=77))
    assert tracker.channel_route({"txt_hash": 77}, None) == {}
    assert tracker.channel_route({"text": "x"}, 3) == {}
    assert tracker.channel_route({"txt_hash": 78}, 3) == {}
    assert tracker.channel_route({"txt_hash": 77}, 4) == {}


def test_tracker_defaults():
    """A tracker starts with an empty default index and no scope candidate."""
    tracker = route.RouteTracker()
    assert len(tracker.index) == 0
    assert tracker.region is None
    index = route.RxLogIndex(max_entries=1)
    assert route.RouteTracker(index).index is index


def test_interface_owns_a_route_tracker():
    """Each connection's interface starts with its own tracker."""
    first, second = _MeshcoreInterface(target=None), _MeshcoreInterface(target=None)
    assert isinstance(first._route, route.RouteTracker)
    assert first._route is not second._route


# ---------------------------------------------------------------------------
# Library switches and reads (SC1/SC3/SC8)
# ---------------------------------------------------------------------------


def test_without_decrypted_text_drops_only_the_message():
    """The capture keeps the frame's metadata, never its decrypted text."""
    frame = _frame(message="Alice: secret")
    redacted = route.without_decrypted_text(frame)
    assert "message" not in redacted
    assert redacted["msg_hash"] == 0xABCD
    assert frame["message"] == "Alice: secret"
    assert route.without_decrypted_text({"a": 1}) == {"a": 1}


def test_enable_rx_log_join_uses_the_library_switch(monkeypatch):
    """The real ``MeshCore`` switch turns the reader's decryption on."""
    logs: list = []
    monkeypatch.setattr(route.config, "_debug_log", lambda *a, **k: logs.append(k))
    mc = meshcore.MeshCore(frames.FakeConnection())
    assert route.enable_rx_log_join(mc) is True
    assert mc._reader.decrypt_channels is True
    assert logs == []


def test_enable_rx_log_join_warns_on_a_library_without_the_switch(monkeypatch):
    """An older library still connects; the gap is logged once, loudly."""
    logs: list = []
    monkeypatch.setattr(route.config, "_debug_log", lambda *a, **k: logs.append(k))
    assert route.enable_rx_log_join(types.SimpleNamespace()) is False
    assert logs == [
        {"context": "meshcore.rx_log_join", "severity": "warning", "always": True}
    ]


def _scope_reply(payload) -> types.SimpleNamespace:
    """Return a ``DEFAULT_FLOOD_SCOPE`` reply event.

    Parameters:
        payload: Event payload.

    Returns:
        The reply.
    """
    return types.SimpleNamespace(
        type=meshcore.EventType.DEFAULT_FLOOD_SCOPE, payload=payload
    )


def _read_scope(monkeypatch, reply) -> tuple:
    """Run :func:`route.read_default_flood_scope` against one reply.

    Parameters:
        monkeypatch: pytest fixture.
        reply: The radio's reply event.

    Returns:
        ``(region, logged kwargs)``.
    """
    logs: list = []
    monkeypatch.setattr(route.config, "_debug_log", lambda *a, **k: logs.append(k))
    mc = types.SimpleNamespace(
        commands=frames.QuietCommands({"get_default_flood_scope": reply})
    )
    return asyncio.run(route.read_default_flood_scope(mc)), logs


def test_read_default_flood_scope_returns_the_radio_name(monkeypatch):
    """The name is returned as stored; the key is neither kept nor logged."""
    region, logs = _read_scope(
        monkeypatch, _scope_reply({"scope_name": _REGION, "scope_key": _SCOPE_KEY_HEX})
    )
    assert region == _REGION
    assert logs == [{"context": "meshcore.scope", "scope": "de-be"}]
    assert _SCOPE_KEY_HEX not in repr(logs)


@pytest.mark.parametrize(
    "reply",
    [
        _scope_reply({}),
        _scope_reply({"scope_name": ""}),
        _scope_reply(None),
        _scope_reply(["#de-be"]),
        types.SimpleNamespace(type=meshcore.EventType.ERROR, payload={"code": 1}),
    ],
    ids=["no-scope", "empty-name", "no-payload", "odd-payload", "old-firmware"],
)
def test_read_default_flood_scope_without_a_scope(monkeypatch, reply):
    """No configured scope, or firmware before 1.15: no candidate."""
    region, logs = _read_scope(monkeypatch, reply)
    assert region is None
    assert logs == [{"context": "meshcore.scope", "scope": None}]


def test_read_default_flood_scope_keeps_a_private_name_unlogged(monkeypatch):
    """A private ``$`` region is returned for resolution but never logged."""
    region, logs = _read_scope(monkeypatch, _scope_reply({"scope_name": "$ops"}))
    assert region == "$ops"
    assert logs == [{"context": "meshcore.scope", "scope": None}]


# ---------------------------------------------------------------------------
# Runner wiring (SC1/SC3)
# ---------------------------------------------------------------------------


async def _idle_poll(_mc, _iface) -> None:
    """Telemetry loop stand-in that returns at once."""


def _run_runner(monkeypatch, mesh_core_cls) -> tuple:
    """Drive ``_run_meshcore`` once with *mesh_core_cls* and stop it.

    Parameters:
        monkeypatch: pytest fixture.
        mesh_core_cls: ``MeshCore`` stand-in the runner instantiates.

    Returns:
        ``(iface, error_holder, logs)``.
    """
    logs: list = []
    monkeypatch.setattr(
        _mod.config, "_debug_log", lambda msg, **k: logs.append((msg, k))
    )
    monkeypatch.setattr(_mod, "MeshCore", mesh_core_cls)
    monkeypatch.setattr(
        _runner, "_make_connection", lambda *_a, **_k: frames.FakeConnection()
    )
    monkeypatch.setattr(_runner, "_telemetry_poll_loop", _idle_poll)
    monkeypatch.setattr(_channels, "_CHANNEL_LOOKUP", {})

    async def _drive(iface):
        connected = threading.Event()
        error_holder: list = [None]
        task = asyncio.create_task(
            _mod._run_meshcore(iface, "/dev/ttyUSB0", connected, error_holder)
        )
        for _ in range(1000):
            await asyncio.sleep(0)
            if connected.is_set():
                break
        iface._stop_event.set()
        await task
        return error_holder

    iface = _MeshcoreInterface(target=None)
    return iface, asyncio.run(_drive(iface)), logs


def test_runner_reads_the_default_flood_scope_without_transmitting(monkeypatch):
    """SC3: the scope is read after connect; every command used is a read."""
    reply = _scope_reply({"scope_name": _REGION, "scope_key": _SCOPE_KEY_HEX})
    iface, error_holder, _logs = _run_runner(
        monkeypatch, frames.offline_meshcore({"get_default_flood_scope": reply})
    )
    assert error_holder[0] is None
    assert iface._route.region == _REGION
    calls = set(iface._mc.commands.calls)
    assert "get_default_flood_scope" in calls
    assert calls <= {
        "send_device_query",
        "get_channel",
        "get_default_flood_scope",
        "get_autoadd_config",
    }


def test_runner_survives_a_failing_scope_read(monkeypatch):
    """A timeout leaves the scope unset and the connection up."""
    iface, error_holder, logs = _run_runner(
        monkeypatch,
        frames.offline_meshcore({"get_default_flood_scope": TimeoutError("slow")}),
    )
    assert error_holder[0] is None
    assert iface.isConnected is True
    assert iface._route.region is None
    assert (
        "Failed to read default flood scope",
        {"context": "meshcore.scope", "severity": "warning", "error": "slow"},
    ) in logs


def test_runner_connects_with_a_library_lacking_the_join_switch(monkeypatch):
    """SC1: a library without ``set_decrypt_channel_logs`` warns, connects."""

    class _OldLibrary(frames.offline_meshcore()):
        """``MeshCore`` from before the join switch existed."""

        set_decrypt_channel_logs = None

    iface, error_holder, logs = _run_runner(monkeypatch, _OldLibrary)
    assert error_holder[0] is None
    assert iface.isConnected is True
    assert iface._mc._reader.decrypt_channels is False
    assert any(kw.get("context") == "meshcore.rx_log_join" for _msg, kw in logs)


# ---------------------------------------------------------------------------
# Handlers over the real reader (SC2-SC4, SC8, SC9)
# ---------------------------------------------------------------------------


def _payload() -> bytes:
    """Return the shared message's encrypted ``GRP_TXT`` payload."""
    return frames.grp_txt_payload(frames.channel_secret())


def _scoped_copy(region: str, path: bytes, *, rssi: int = -96) -> bytes:
    """Return the RX-log push of a copy scoped to *region*.

    Parameters:
        region: Region the sender scoped the flood to.
        path: Repeater hashes, one byte each.
        rssi: Reception RSSI.

    Returns:
        A ``LOG_RX_DATA`` frame with route type ``TRANSPORT_FLOOD``.
    """
    payload = _payload()
    code0 = frames.transport_code(frames.region_key(region), 5, payload)
    raw = frames.raw_packet(
        payload, route_type=frames.ROUTE_TRANSPORT_FLOOD, path=path, code0=code0
    )
    return frames.rx_log_frame(raw, snr=10.0, rssi=rssi)


def _plain_copy(path: bytes, *, rssi: int = -96, route_type: int = 1) -> bytes:
    """Return the RX-log push of an unscoped copy.

    Parameters:
        path: Repeater hashes, one byte each.
        rssi: Reception RSSI.
        route_type: Firmware route type (plain flood by default).

    Returns:
        A ``LOG_RX_DATA`` frame.
    """
    raw = frames.raw_packet(_payload(), route_type=route_type, path=path)
    return frames.rx_log_frame(raw, snr=10.0, rssi=rssi)


def _deliver(monkeypatch, raw_frames: list, *, region: str | None = None) -> list:
    """Feed frames through the real reader into stubbed handlers.

    Parameters:
        monkeypatch: pytest fixture.
        raw_frames: Frames after the ``CHANNEL_INFO`` that registers ``#test``.
        region: The radio's default flood scope.

    Returns:
        Packets handed to ``store_packet_dict``.
    """
    captured: list = []
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(_mod.config, "DEBUG", False)
    frames.install_stub_handlers(monkeypatch, captured)
    monkeypatch.setattr(_channels, "_CHANNEL_LOOKUP", {})
    iface = _MeshcoreInterface(target=None)
    iface._route.region = region
    hmap = _make_event_handlers(iface, "/dev/ttyUSB0")
    asyncio.run(frames.feed_reader([frames.channel_info_frame(), *raw_frames], hmap))
    return captured


def test_scoped_message_names_the_default_region(monkeypatch):
    """SC4: a flood scoped to the radio's default region reads its name."""
    captured = _deliver(
        monkeypatch,
        [
            _scoped_copy(_REGION, bytes.fromhex("f0bf44")),
            frames.channel_msg_v3_frame(path_len=3),
        ],
        region=_REGION,
    )
    assert [(p["hops"], p["path"], p["rssi"], p["scope"]) for p in captured] == [
        (3, "f0bf44", -96, "de-be")
    ]


@pytest.mark.parametrize("region", [None, "#eu"])
def test_scoped_message_of_another_region_is_scoped_unknown(monkeypatch, region):
    """SC4: a scoped flood neither the default region nor the table
    reproduces reads ``?``."""
    captured = _deliver(
        monkeypatch,
        [
            _scoped_copy(_UNLISTED, bytes.fromhex("f0bf44")),
            frames.channel_msg_v3_frame(path_len=3),
        ],
        region=region,
    )
    assert captured[0]["scope"] == "?"
    assert captured[0]["path"] == "f0bf44"


@pytest.mark.parametrize("region", [None, "#eu"])
def test_scoped_message_of_a_listed_region_is_named_by_the_table(monkeypatch, region):
    """SC3: a flood scoped to a listed region reads its name without the
    radio's default naming it."""
    captured = _deliver(
        monkeypatch,
        [
            _scoped_copy(_REGION, bytes.fromhex("f0bf44")),
            frames.channel_msg_v3_frame(path_len=3),
        ],
        region=region,
    )
    assert (captured[0]["path"], captured[0]["scope"]) == ("f0bf44", "de-be")


@pytest.mark.parametrize(
    ("region", "scope"),
    [(None, "?"), ("#eu", "?"), ("#de-by", "de-by"), ("#li", "li")],
)
def test_scoped_message_matched_by_two_table_names_is_scoped_unknown(
    monkeypatch, region, scope
):
    """SC3: ``de-by`` and ``li`` share this message's transport code, so the
    table names neither; a default region that reproduces it still wins."""
    assert frames.transport_code(
        frames.region_key("de-by"), 5, _payload()
    ) == frames.transport_code(frames.region_key("li"), 5, _payload())
    captured = _deliver(
        monkeypatch,
        [
            _scoped_copy("#de-by", bytes.fromhex("f0bf44")),
            frames.channel_msg_v3_frame(path_len=3),
        ],
        region=region,
    )
    assert captured[0]["scope"] == scope


def test_plain_flood_message_is_unscoped(monkeypatch):
    """SC4: a plain flood reads ``*`` (also: senders before firmware 1.10)."""
    captured = _deliver(
        monkeypatch,
        [_plain_copy(bytes.fromhex("f0bf")), frames.channel_msg_v3_frame(path_len=2)],
        region=_REGION,
    )
    assert (captured[0]["path"], captured[0]["scope"]) == ("f0bf", "*")


def test_zero_hop_copy_has_rssi_but_no_path(monkeypatch):
    """A message heard straight from the sender has no repeater path."""
    captured = _deliver(
        monkeypatch,
        [_plain_copy(b"", rssi=-50), frames.channel_msg_v3_frame(path_len=0)],
    )
    assert [(p["hops"], p["path"], p["rssi"], p["scope"]) for p in captured] == [
        (0, None, -50, "*")
    ]


def test_message_without_an_rx_log_copy_keeps_only_hops(monkeypatch):
    """SC9: no logged frame (over 173 bytes, say): hops, no path/rssi/scope."""
    captured = _deliver(monkeypatch, [frames.channel_msg_v3_frame(path_len=4)])
    assert [(p["hops"], p["path"], p["rssi"], p["scope"]) for p in captured] == [
        (4, None, None, None)
    ]


def test_direct_routed_message_has_no_hops_and_no_route(monkeypatch):
    """RF1 (amended): ``path_len`` 255 is a direct route, hop count unknown."""
    captured = _deliver(
        monkeypatch,
        [
            _plain_copy(bytes.fromhex("f0bf"), route_type=frames.ROUTE_DIRECT),
            frames.channel_msg_v3_frame(path_len=0xFF),
        ],
    )
    assert [(p["hops"], p["path"], p["rssi"], p["scope"]) for p in captured] == [
        (None, None, None, None)
    ]


def _post_once(monkeypatch, *, hidden: tuple) -> list:
    """Deliver one scoped message through the real ``store_packet_dict``.

    Parameters:
        monkeypatch: pytest fixture.
        hidden: ``HIDDEN_CHANNELS`` value.

    Returns:
        ``(path, payload)`` pairs queued for the web app.
    """
    sent: list = []
    monkeypatch.setattr(
        _queue_mod,
        "_queue_post_json",
        lambda path, payload, *, priority, **_kw: sent.append((path, payload)),
    )
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(_mod.config, "DEBUG", False)
    monkeypatch.setattr(_mod.config, "HIDDEN_CHANNELS", hidden)
    monkeypatch.setattr(_mod.config, "ALLOWED_CHANNELS", ())
    monkeypatch.setattr(_mod.config, "PRIMARY_CHANNEL_ONLY", False)
    monkeypatch.setattr(_channels, "_CHANNEL_LOOKUP", {})
    monkeypatch.setattr(_channels, "_CHANNEL_MAPPINGS", ())
    iface = _MeshcoreInterface(target=None)
    iface._route.region = _REGION
    hmap = _make_event_handlers(iface, "/dev/ttyUSB0")
    raw_frames = [
        frames.channel_info_frame(),
        _scoped_copy(_REGION, bytes.fromhex("f0bf44")),
        frames.channel_msg_v3_frame(path_len=3),
    ]
    asyncio.run(frames.feed_reader(raw_frames, hmap))
    return sent


def test_route_fields_reach_the_message_post(monkeypatch):
    """The queued ``POST /api/messages`` carries hops, path, rssi and scope."""
    sent = _post_once(monkeypatch, hidden=())
    messages = [payload for path, payload in sent if path == "/api/messages"]
    assert len(messages) == 1
    assert {k: messages[0][k] for k in ("hops", "path", "rssi", "scope", "snr")} == {
        "hops": 3,
        "path": "f0bf44",
        "rssi": -96,
        "scope": "de-be",
        "snr": 10.0,
    }


def test_hidden_channel_posts_no_route(monkeypatch):
    """SC8/CF2: a hidden channel's message, route included, never leaves."""
    assert _post_once(monkeypatch, hidden=(frames.CHANNEL_NAME,)) == []


def test_debug_capture_never_keeps_decrypted_text(monkeypatch, tmp_path):
    """SC8: the ``DEBUG=1`` RX-log capture drops the library's ``message``."""
    log_path = tmp_path / "ignored-meshcore.txt"
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(_mod.config, "DEBUG", True)
    monkeypatch.setattr(_mod, "_IGNORED_MESSAGE_LOG_PATH", log_path)
    frames.install_stub_handlers(monkeypatch, [])
    monkeypatch.setattr(_channels, "_CHANNEL_LOOKUP", {})
    hmap = _make_event_handlers(_MeshcoreInterface(target=None), "/dev/ttyUSB0")
    raw_frames = [frames.channel_info_frame(), _plain_copy(bytes.fromhex("f0"))]
    asyncio.run(frames.feed_reader(raw_frames, hmap))

    content = log_path.read_text(encoding="utf-8")
    entries = [json.loads(line) for line in content.splitlines()]
    rx_logs = [e for e in entries if e["source"].endswith(":RX_LOG_DATA")]
    assert len(rx_logs) == 1
    assert rx_logs[0]["message"]["msg_hash"] == frames.message_hash()
    assert "message" not in rx_logs[0]["message"]
    assert "hello path" not in content
