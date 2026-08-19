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
"""Unit tests for :mod:`data.mesh_ingestor.protocols.reticulum`."""

from __future__ import annotations

import inspect
import sys
import time
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from RNS.vendor import umsgpack  # noqa: E402 - path setup

import data.mesh_ingestor.config as config  # noqa: E402 - path setup
import data.mesh_ingestor.protocols.reticulum as _mod  # noqa: E402 - path setup
from data.mesh_ingestor.protocols.reticulum import (  # noqa: E402 - path setup
    ReticulumProvider,
    _ANNOUNCE_ASPECTS,
    _ReticulumAnnounceHandler,
    _ReticulumInterface,
    _announce_hops,
    _announce_to_node_dict,
    _decode_display_name,
    _reticulum_hash_hex,
    _reticulum_node_id,
    _reticulum_short_name,
)

_DEST_HASH = bytes.fromhex("aabbccdd" + "00" * 12)
"""A full 16-byte Reticulum destination hash used across tests."""


def _fake_rns(*, existing_instance=None, hops=128):
    """Build a fake ``RNS`` module namespace for provider tests.

    Returns:
        ``(fake_module, state)`` where ``state`` records constructed
        Reticulum configdirs and (de)registered announce handlers.
    """
    state = {"created": [], "registered": [], "deregistered": []}

    class FakeReticulum:
        def __init__(self, configdir=None):
            state["created"].append(configdir)

        @staticmethod
        def get_instance():
            return existing_instance

    transport = types.SimpleNamespace(
        PATHFINDER_M=128,
        register_announce_handler=lambda h: state["registered"].append(h),
        deregister_announce_handler=lambda h: state["deregistered"].append(h),
        hops_to=lambda _dh: hops,
    )
    fake = types.SimpleNamespace(Reticulum=FakeReticulum, Transport=transport)
    return fake, state


# ---------------------------------------------------------------------------
# _reticulum_node_id / _reticulum_hash_hex / _reticulum_short_name
# ---------------------------------------------------------------------------


def test_reticulum_node_id_from_bytes():
    """The node ID is the first four bytes of the destination hash."""
    assert _reticulum_node_id(_DEST_HASH) == "!aabbccdd"


def test_reticulum_node_id_from_hex_string():
    """A hex-string destination hash is accepted and lowercased."""
    assert _reticulum_node_id("AABBCCDD" + "00" * 12) == "!aabbccdd"


def test_reticulum_node_id_none_on_short_or_invalid():
    """Too-short or non-hash inputs yield None."""
    assert _reticulum_node_id(b"\xaa\xbb") is None
    assert _reticulum_node_id("abc") is None
    assert _reticulum_node_id(None) is None
    assert _reticulum_node_id(12345) is None


def test_reticulum_hash_hex_roundtrip():
    """_reticulum_hash_hex returns the full lowercase hex of the hash."""
    assert _reticulum_hash_hex(_DEST_HASH) == _DEST_HASH.hex()
    assert _reticulum_hash_hex("AABB") == "aabb"
    assert _reticulum_hash_hex("") is None
    assert _reticulum_hash_hex(None) is None


def test_reticulum_short_name_first_two_bytes():
    """_reticulum_short_name returns the first four hex chars of the node ID."""
    assert _reticulum_short_name("!aabbccdd") == "aabb"
    assert _reticulum_short_name("cafef00d") == "cafe"


def test_reticulum_short_name_empty_when_too_short():
    """Missing or too-short node IDs yield an empty short name."""
    assert _reticulum_short_name("") == ""
    assert _reticulum_short_name("!ab") == ""
    assert _reticulum_short_name(None) == ""


# ---------------------------------------------------------------------------
# _decode_display_name
# ---------------------------------------------------------------------------


def test_decode_display_name_raw_utf8():
    """Pre-0.5 LXMF and nomadnet announces carry raw UTF-8 name bytes."""
    assert _decode_display_name("Alice Node".encode("utf-8")) == "Alice Node"


def test_decode_display_name_msgpack_array():
    """LXMF >= 0.5 announces pack [display_name, stamp_cost] with msgpack."""
    app_data = umsgpack.packb(["Bob's LXMF".encode("utf-8"), 8])
    assert _decode_display_name(app_data) == "Bob's LXMF"


def test_decode_display_name_msgpack_str_element():
    """A msgpack array whose first element is already a str is accepted."""
    app_data = umsgpack.packb(["StrName", None])
    assert _decode_display_name(app_data) == "StrName"


def test_decode_display_name_msgpack_none_element():
    """A msgpack array with a None display name yields None."""
    assert _decode_display_name(umsgpack.packb([None, 8])) is None


def test_decode_display_name_invalid_utf8_returns_none():
    """Undecodable raw bytes must be handled gracefully."""
    assert _decode_display_name(b"\xff\xfe\xfd") is None


def test_decode_display_name_empty_inputs():
    """None, empty bytes, and whitespace-only names all yield None."""
    assert _decode_display_name(None) is None
    assert _decode_display_name(b"") is None
    assert _decode_display_name(b"   ") is None
    assert _decode_display_name("   ") is None


def test_decode_display_name_non_bytes_returns_none():
    """Non-bytes, non-str app_data yields None."""
    assert _decode_display_name(1234) is None
    assert _decode_display_name(["not", "bytes"]) is None


def test_decode_display_name_truncated_msgpack_returns_none():
    """A byte string that looks like msgpack but fails to unpack yields None."""
    assert _decode_display_name(b"\xdc\xff") is None


def test_decode_display_name_unicode():
    """Unicode display names survive decoding."""
    assert _decode_display_name("pete 🍁".encode("utf-8")) == "pete 🍁"


# ---------------------------------------------------------------------------
# _announce_hops
# ---------------------------------------------------------------------------


def test_announce_hops_returns_known_count(monkeypatch):
    """A known path yields its hop count."""
    fake, _state = _fake_rns(hops=3)
    monkeypatch.setattr(_mod, "RNS", fake)
    assert _announce_hops(_DEST_HASH) == 3


def test_announce_hops_none_on_pathfinder_sentinel(monkeypatch):
    """The PATHFINDER_M max-hops sentinel (unknown path) maps to None."""
    fake, _state = _fake_rns(hops=128)
    monkeypatch.setattr(_mod, "RNS", fake)
    assert _announce_hops(_DEST_HASH) is None


def test_announce_hops_none_on_error(monkeypatch):
    """Transport errors are swallowed and yield None."""
    fake, _state = _fake_rns()
    fake.Transport.hops_to = lambda _dh: (_ for _ in ()).throw(RuntimeError("boom"))
    monkeypatch.setattr(_mod, "RNS", fake)
    assert _announce_hops(_DEST_HASH) is None


def test_announce_hops_none_for_non_bytes():
    """Non-bytes destination hashes never touch the transport."""
    assert _announce_hops("aabbccdd") is None
    assert _announce_hops(None) is None


# ---------------------------------------------------------------------------
# _announce_to_node_dict
# ---------------------------------------------------------------------------


def test_announce_to_node_dict_basic_fields():
    """The node dict carries lastHeard, protocol, and the derived user block."""
    node = _announce_to_node_dict(_DEST_HASH, b"Alice", hops=2, last_heard=1700000000)
    assert node["lastHeard"] == 1700000000
    assert node["protocol"] == "reticulum"
    assert node["hopsAway"] == 2
    assert node["user"]["longName"] == "Alice"
    assert node["user"]["shortName"] == "aabb"
    assert node["user"]["publicKey"] == _DEST_HASH.hex()


def test_announce_to_node_dict_long_name_falls_back_to_hash_prefix():
    """Undecodable app_data falls back to the 8-hex hash prefix."""
    node = _announce_to_node_dict(_DEST_HASH, b"\xff\xfe", last_heard=1)
    assert node["user"]["longName"] == "aabbccdd"


def test_announce_to_node_dict_omits_hops_when_unknown():
    """hopsAway is absent (not None) when the hop count is unknown."""
    node = _announce_to_node_dict(_DEST_HASH, b"Alice", hops=None, last_heard=1)
    assert "hopsAway" not in node


def test_announce_to_node_dict_defaults_last_heard_to_now():
    """Without an explicit receipt time, lastHeard is the wall clock."""
    before = int(time.time())
    node = _announce_to_node_dict(_DEST_HASH, b"Alice")
    after = int(time.time())
    assert before <= node["lastHeard"] <= after


def test_announce_to_node_dict_none_for_invalid_hash():
    """An unmappable destination hash yields None instead of a node dict."""
    assert _announce_to_node_dict(b"\xaa", b"Alice") is None
    assert _announce_to_node_dict(None, b"Alice") is None


def test_announce_to_node_dict_id_matches_node_id_helper():
    """The snapshot key derivation and the payload stay consistent."""
    node = _announce_to_node_dict(_DEST_HASH, None, last_heard=1)
    node_id = _reticulum_node_id(_DEST_HASH)
    assert node["user"]["publicKey"].startswith(node_id.lstrip("!"))


# ---------------------------------------------------------------------------
# _ReticulumAnnounceHandler
# ---------------------------------------------------------------------------


def test_announce_handler_signature_matches_rns_dispatch():
    """RNS dispatches on parameter count; the bound method must expose 3."""
    handler = _ReticulumAnnounceHandler(
        "lxmf.delivery", _ReticulumInterface(target=None)
    )
    params = inspect.signature(handler.received_announce).parameters
    assert len(params) == 3
    assert list(params) == ["destination_hash", "announced_identity", "app_data"]


def test_received_announce_upserts_node(monkeypatch):
    """A valid announce queues a node upsert and updates the snapshot."""
    fake, _state = _fake_rns(hops=1)
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    upserts: list = []
    seen = {"count": 0}
    monkeypatch.setattr(
        _mod.handlers, "upsert_node", lambda nid, node: upserts.append((nid, node))
    )
    monkeypatch.setattr(
        _mod.handlers,
        "_mark_packet_seen",
        lambda: seen.__setitem__("count", seen["count"] + 1),
    )

    iface = _ReticulumInterface(target=None)
    handler = _ReticulumAnnounceHandler("lxmf.delivery", iface)
    handler.received_announce(
        destination_hash=_DEST_HASH, announced_identity=object(), app_data=b"Alice"
    )

    assert seen["count"] == 1
    assert len(upserts) == 1
    node_id, node = upserts[0]
    assert node_id == "!aabbccdd"
    assert node["protocol"] == "reticulum"
    assert node["user"]["longName"] == "Alice"
    assert node["hopsAway"] == 1
    assert iface.nodes_snapshot() == [(node_id, node)]


def test_received_announce_counts_frame_even_when_unmappable(monkeypatch):
    """An announce with an unusable hash is still counted as a received frame."""
    fake, _state = _fake_rns()
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    upserts: list = []
    seen = {"count": 0}
    monkeypatch.setattr(
        _mod.handlers, "upsert_node", lambda nid, node: upserts.append((nid, node))
    )
    monkeypatch.setattr(
        _mod.handlers,
        "_mark_packet_seen",
        lambda: seen.__setitem__("count", seen["count"] + 1),
    )

    iface = _ReticulumInterface(target=None)
    handler = _ReticulumAnnounceHandler("nomadnetwork.node", iface)
    handler.received_announce(
        destination_hash=b"\xaa", announced_identity=None, app_data=None
    )

    assert seen["count"] == 1
    assert upserts == []
    assert iface.nodes_snapshot() == []


def test_received_announce_swallows_handler_errors(monkeypatch):
    """An exception inside the ingest path must never escape to RNS."""
    fake, _state = _fake_rns()
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(_mod.handlers, "_mark_packet_seen", lambda: None)

    def _boom(*_a, **_k):
        raise RuntimeError("queue down")

    monkeypatch.setattr(_mod.handlers, "upsert_node", _boom)

    iface = _ReticulumInterface(target=None)
    handler = _ReticulumAnnounceHandler("lxmf.delivery", iface)
    # Must not raise.
    handler.received_announce(
        destination_hash=_DEST_HASH, announced_identity=None, app_data=b"X"
    )


def test_received_announce_latest_announce_wins_in_snapshot(monkeypatch):
    """A re-announce replaces the snapshot entry for the same node id."""
    fake, _state = _fake_rns()
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(_mod.handlers, "upsert_node", lambda *_a, **_k: None)
    monkeypatch.setattr(_mod.handlers, "_mark_packet_seen", lambda: None)

    iface = _ReticulumInterface(target=None)
    handler = _ReticulumAnnounceHandler("lxmf.delivery", iface)
    handler.received_announce(
        destination_hash=_DEST_HASH, announced_identity=None, app_data=b"Old"
    )
    handler.received_announce(
        destination_hash=_DEST_HASH, announced_identity=None, app_data=b"New"
    )

    snapshot = iface.nodes_snapshot()
    assert len(snapshot) == 1
    assert snapshot[0][1]["user"]["longName"] == "New"


# ---------------------------------------------------------------------------
# ReticulumProvider.connect / close
# ---------------------------------------------------------------------------


def test_connect_starts_reticulum_with_config_dir(monkeypatch):
    """connect() instantiates RNS.Reticulum with RETICULUM_CONFIG_DIR."""
    fake, state = _fake_rns(existing_instance=None)
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(_mod.config, "RETICULUM_CONFIG_DIR", "/tmp/rns-config")
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    iface, resolved, next_candidate = ReticulumProvider().connect(active_candidate=None)

    assert state["created"] == ["/tmp/rns-config"]
    assert resolved == "reticulum:///tmp/rns-config"
    assert next_candidate is None
    assert iface.isConnected is True
    assert iface._rns is not None


def test_connect_reuses_running_instance(monkeypatch):
    """connect() attaches to an existing RNS instance without re-initialising."""
    existing = object()
    fake, state = _fake_rns(existing_instance=existing)
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(_mod.config, "RETICULUM_CONFIG_DIR", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    iface, resolved, _ = ReticulumProvider().connect(active_candidate=None)

    assert state["created"] == []
    assert iface._rns is existing
    assert resolved == "reticulum://~/.reticulum"


def test_connect_registers_announce_handlers_per_aspect(monkeypatch):
    """One announce handler per aspect is registered with RNS.Transport."""
    fake, state = _fake_rns()
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(_mod.config, "RETICULUM_CONFIG_DIR", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    iface, _, _ = ReticulumProvider().connect(active_candidate=None)

    aspects = [h.aspect_filter for h in state["registered"]]
    assert aspects == list(_ANNOUNCE_ASPECTS)
    assert "lxmf.delivery" in aspects
    assert "nomadnetwork.node" in aspects
    assert iface._announce_handlers == state["registered"]


def test_connect_passes_active_candidate_through(monkeypatch):
    """The candidate string is returned unchanged (no serial-candidate concept)."""
    fake, _state = _fake_rns()
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(_mod.config, "RETICULUM_CONFIG_DIR", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    _iface, _resolved, next_candidate = ReticulumProvider().connect(
        active_candidate="whatever"
    )
    assert next_candidate == "whatever"


def test_connect_warns_when_ingestor_node_id_unset(monkeypatch):
    """connect() warns once when INGESTOR_NODE_ID is missing.

    Without the operator-supplied id the daemon's heartbeat never registers
    and the reticulum packets/hour stats scope silently stays dead, so the
    provider must surface a startup warning.
    """
    fake, _state = _fake_rns()
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(_mod.config, "RETICULUM_CONFIG_DIR", None)
    monkeypatch.setattr(_mod.config, "INGESTOR_NODE_ID", None)
    calls = []
    monkeypatch.setattr(
        _mod.config,
        "_debug_log",
        lambda message, **kwargs: calls.append((message, kwargs)),
    )

    ReticulumProvider().connect(active_candidate=None)

    warnings = [call for call in calls if call[1].get("severity") == "warn"]
    assert len(warnings) == 1
    assert "INGESTOR_NODE_ID" in warnings[0][0]
    assert warnings[0][1]["context"] == "reticulum.connect"


def test_connect_does_not_warn_when_ingestor_node_id_set(monkeypatch):
    """connect() emits no INGESTOR_NODE_ID warning when the id is supplied."""
    fake, _state = _fake_rns()
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(_mod.config, "RETICULUM_CONFIG_DIR", None)
    monkeypatch.setattr(_mod.config, "INGESTOR_NODE_ID", "!aabbccdd")
    calls = []
    monkeypatch.setattr(
        _mod.config,
        "_debug_log",
        lambda message, **kwargs: calls.append((message, kwargs)),
    )

    ReticulumProvider().connect(active_candidate=None)

    assert not any("INGESTOR_NODE_ID" in call[0] for call in calls)


def test_close_deregisters_announce_handlers(monkeypatch):
    """close() deregisters every announce handler and marks disconnected."""
    fake, state = _fake_rns()
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(_mod.config, "RETICULUM_CONFIG_DIR", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    iface, _, _ = ReticulumProvider().connect(active_candidate=None)
    registered = list(state["registered"])
    iface.close()

    assert state["deregistered"] == registered
    assert iface.isConnected is False
    assert iface._announce_handlers == []
    # Second close is a no-op, not a double-deregister.
    iface.close()
    assert state["deregistered"] == registered


def test_close_swallows_deregistration_errors(monkeypatch):
    """A deregistration failure must not escape close()."""
    fake, _state = _fake_rns()
    fake.Transport.deregister_announce_handler = lambda _h: (_ for _ in ()).throw(
        RuntimeError("transport gone")
    )
    monkeypatch.setattr(_mod, "RNS", fake)

    iface = _ReticulumInterface(target=None)
    iface._announce_handlers.append(_ReticulumAnnounceHandler("lxmf.delivery", iface))
    iface.close()  # must not raise
    assert iface.isConnected is False


# ---------------------------------------------------------------------------
# ReticulumProvider.node_snapshot_items
# ---------------------------------------------------------------------------


def test_node_snapshot_items_returns_heard_announces(monkeypatch):
    """Announces recorded on the interface surface through the snapshot."""
    fake, _state = _fake_rns(hops=2)
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(_mod.handlers, "upsert_node", lambda *_a, **_k: None)
    monkeypatch.setattr(_mod.handlers, "_mark_packet_seen", lambda: None)

    iface = _ReticulumInterface(target=None)
    handler = _ReticulumAnnounceHandler("lxmf.delivery", iface)
    other_hash = bytes.fromhex("11223344" + "00" * 12)
    handler.received_announce(
        destination_hash=_DEST_HASH, announced_identity=None, app_data=b"Alice"
    )
    handler.received_announce(
        destination_hash=other_hash, announced_identity=None, app_data=None
    )

    items = ReticulumProvider().node_snapshot_items(iface)
    as_dict = dict(items)
    assert set(as_dict) == {"!aabbccdd", "!11223344"}
    assert as_dict["!aabbccdd"]["user"]["longName"] == "Alice"
    # Name-less announce falls back to the hash prefix.
    assert as_dict["!11223344"]["user"]["longName"] == "11223344"


def test_node_snapshot_items_empty_before_any_announce():
    """A fresh interface yields an empty snapshot."""
    iface = _ReticulumInterface(target=None)
    assert ReticulumProvider().node_snapshot_items(iface) == []


# ---------------------------------------------------------------------------
# config / daemon wiring
# ---------------------------------------------------------------------------


def test_known_protocols_includes_reticulum():
    """PROTOCOL=reticulum must pass config validation."""
    assert "reticulum" in config._KNOWN_PROTOCOLS


def test_config_exports_reticulum_config_dir():
    """RETICULUM_CONFIG_DIR is part of the config surface (None by default)."""
    assert "RETICULUM_CONFIG_DIR" in config.__all__
    assert hasattr(config, "RETICULUM_CONFIG_DIR")


def test_daemon_main_selects_reticulum_provider(monkeypatch):
    """PROTOCOL=reticulum makes daemon.main() build a ReticulumProvider."""
    from data.mesh_ingestor import daemon

    monkeypatch.setattr(daemon.config, "PROTOCOL", "reticulum")
    # No instances configured -> main() exits right after provider selection,
    # exercising only the branch under test.
    monkeypatch.setattr(daemon.config, "INSTANCES", ())
    monkeypatch.setattr(daemon.config, "INSTANCE", "")

    subscribed: list = []
    real_subscribe = ReticulumProvider.subscribe

    def _tracking_subscribe(self):
        subscribed.append(type(self).__name__)
        return real_subscribe(self)

    monkeypatch.setattr(ReticulumProvider, "subscribe", _tracking_subscribe)
    daemon.main()
    assert subscribed == ["ReticulumProvider"]
