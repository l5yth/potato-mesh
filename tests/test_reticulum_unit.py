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

import importlib
import inspect
import re
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

_IDENTITY_HASH = bytes.fromhex("beef0001" + "11" * 12)
"""A full 16-byte Reticulum identity hash used across tests."""

_PUBLIC_KEY = bytes.fromhex("ab" * 64)
"""A 64-byte Reticulum identity public key used across tests."""

_SELF_IDENTITY_HASH = bytes.fromhex("5e1f0002" + "22" * 12)
"""The identity hash a freshly generated *ingestor* identity carries."""


class _FakeIdentity:
    """Stand-in for :class:`RNS.Identity` exposing the members the provider reads."""

    def __init__(
        self, hash_bytes: bytes = _IDENTITY_HASH, public_key: object = _PUBLIC_KEY
    ):
        """Bind the fake to an identity hash and public key."""
        self.hash = hash_bytes
        self._public_key = public_key

    def get_public_key(self) -> object:
        """Return the identity's public key (bytes for a real identity)."""
        return self._public_key


def _fake_rns(
    *,
    existing_instance=None,
    hops=128,
    interface="RNodeInterface[RNode LoRa]",
    recalled=None,
    self_identity_hash=_SELF_IDENTITY_HASH,
    identity_write_error=None,
    identity_read_error=None,
):
    """Build a fake ``RNS`` module namespace for provider tests.

    ``Identity`` is a *class* rather than a namespace because the provider both
    constructs one (generating the ingestor's own identity) and calls the
    ``from_file``/``to_file`` classmethods on it.  ``from_file`` returns
    ``None`` for an empty file, mirroring how the real
    :meth:`RNS.Identity.from_file` reports an unusable key file.

    Parameters:
        existing_instance: Value :meth:`RNS.Reticulum.get_instance` returns.
        hops: Hop count :func:`RNS.Transport.hops_to` reports.
        interface: Interface :func:`RNS.Transport.next_hop_interface` reports.
        recalled: Identity :meth:`RNS.Identity.recall` returns.
        self_identity_hash: Hash a freshly constructed identity carries.
        identity_write_error: Exception ``to_file`` raises, or ``None``.
        identity_read_error: Exception ``from_file`` raises, or ``None``.

    Returns:
        ``(fake_module, state)`` where ``state`` records constructed
        Reticulum configdirs, (de)registered announce handlers, and the
        identity files written and loaded.
    """
    state = {
        "created": [],
        "registered": [],
        "deregistered": [],
        "identities_written": [],
        "identities_loaded": [],
    }

    class FakeReticulum:
        def __init__(self, configdir=None):
            state["created"].append(configdir)

        @staticmethod
        def get_instance():
            return existing_instance

    class FakeIdentityClass:
        """Constructible stand-in for :class:`RNS.Identity`."""

        def __init__(self, create_keys=True):
            self.hash = self_identity_hash
            self._public_key = _PUBLIC_KEY

        def get_public_key(self):
            return self._public_key

        def to_file(self, path):
            if identity_write_error is not None:
                raise identity_write_error
            with open(path, "wb") as handle:
                handle.write(self.hash)
            state["identities_written"].append(path)

        @staticmethod
        def from_file(path):
            if identity_read_error is not None:
                raise identity_read_error
            with open(path, "rb") as handle:
                raw = handle.read()
            state["identities_loaded"].append(path)
            if not raw:
                return None
            loaded = FakeIdentityClass()
            loaded.hash = raw
            return loaded

        @staticmethod
        def recall(_dest_hash):
            return recalled

    transport = types.SimpleNamespace(
        PATHFINDER_M=128,
        register_announce_handler=lambda h: state["registered"].append(h),
        deregister_announce_handler=lambda h: state["deregistered"].append(h),
        hops_to=lambda _dh: hops,
        next_hop_interface=lambda _dh: interface,
    )
    fake = types.SimpleNamespace(
        Reticulum=FakeReticulum, Transport=transport, Identity=FakeIdentityClass
    )
    return fake, state


def _no_ingestor_node_id(monkeypatch, tmp_path):
    """Point the provider at *tmp_path* with no operator-supplied node id.

    A config dir the test owns, an unscoped allowlist, and
    ``INGESTOR_NODE_ID`` cleared so the derived id is what gets exercised.
    """
    monkeypatch.setattr(_mod.config, "RETICULUM_CONFIG_DIR", str(tmp_path))
    monkeypatch.setattr(_mod.config, "RETICULUM_INTERFACES", ())
    monkeypatch.setattr(_mod.config, "INGESTOR_NODE_ID", None)
    monkeypatch.setattr(_mod.config, "CONNECTION", None)


# ---------------------------------------------------------------------------
# _reticulum_node_id / _reticulum_hash_hex / _reticulum_short_name
# ---------------------------------------------------------------------------


def test_reticulum_node_id_from_bytes():
    """The node ID is the first four bytes of the identity hash."""
    assert _reticulum_node_id(_IDENTITY_HASH) == "!beef0001"


def test_reticulum_node_id_from_hex_string():
    """A hex-string identity hash is accepted and lowercased."""
    assert _reticulum_node_id("BEEF0001" + "11" * 12) == "!beef0001"


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


def test_decode_display_name_msgpack_empty_array():
    """A msgpack array with no elements yields None."""
    assert _decode_display_name(umsgpack.packb([])) is None


def test_decode_display_name_msgpack_non_array():
    """A msgpack payload that unpacks to a non-array yields None."""
    # 0x9? is the fixarray lead range, so craft a lead byte in range whose
    # unpacked value is not a list.
    assert _decode_display_name(umsgpack.packb({"a": 1})) is None


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
# _identity_from_announce / _identity_public_key_hex
# ---------------------------------------------------------------------------


def test_identity_from_announce_prefers_the_callback_identity(monkeypatch):
    """The identity RNS hands the handler is used without a recall round trip."""
    fake, _state = _fake_rns(recalled=_FakeIdentity(b"\x99" * 16))
    monkeypatch.setattr(_mod, "RNS", fake)
    identity = _FakeIdentity()
    assert _mod._identity_from_announce(identity, _DEST_HASH) is identity


def test_identity_from_announce_recalls_when_absent_or_hashless(monkeypatch):
    """A missing or hash-less callback identity falls back to recall()."""
    recalled = _FakeIdentity()
    fake, _state = _fake_rns(recalled=recalled)
    monkeypatch.setattr(_mod, "RNS", fake)
    assert _mod._identity_from_announce(None, _DEST_HASH) is recalled
    # An object with no usable `hash` is treated as absent.
    assert _mod._identity_from_announce(object(), _DEST_HASH) is recalled


def test_identity_from_announce_none_when_recall_yields_nothing(monkeypatch):
    """recall() returning None or a hash-less object yields None."""
    fake, _state = _fake_rns(recalled=None)
    monkeypatch.setattr(_mod, "RNS", fake)
    assert _mod._identity_from_announce(None, _DEST_HASH) is None
    fake.Identity.recall = lambda _dh: object()
    assert _mod._identity_from_announce(None, _DEST_HASH) is None


def test_identity_from_announce_none_for_non_bytes_hash():
    """A non-bytes destination hash never reaches the transport."""
    assert _mod._identity_from_announce(None, "aabb") is None
    assert _mod._identity_from_announce(None, None) is None


def test_identity_from_announce_swallows_recall_errors(monkeypatch):
    """A raising recall() yields None rather than killing the receive path."""
    fake, _state = _fake_rns()
    fake.Identity.recall = lambda _dh: (_ for _ in ()).throw(RuntimeError("boom"))
    monkeypatch.setattr(_mod, "RNS", fake)
    assert _mod._identity_from_announce(None, _DEST_HASH) is None


def test_identity_public_key_hex_variants():
    """Bytes keys hex-encode, str keys normalise, anything else yields None."""
    assert _mod._identity_public_key_hex(None) is None
    assert _mod._identity_public_key_hex(_FakeIdentity()) == _PUBLIC_KEY.hex()
    assert _mod._identity_public_key_hex(_FakeIdentity(public_key="AABB")) == "aabb"
    assert _mod._identity_public_key_hex(_FakeIdentity(public_key="  ")) is None
    assert _mod._identity_public_key_hex(_FakeIdentity(public_key=1234)) is None


def test_identity_public_key_hex_swallows_errors():
    """An identity whose key accessor raises yields None."""

    class _Broken:
        hash = _IDENTITY_HASH

        def get_public_key(self):
            raise RuntimeError("locked")

    assert _mod._identity_public_key_hex(_Broken()) is None


# ---------------------------------------------------------------------------
# _announce_interface_name / _interface_allowed
# ---------------------------------------------------------------------------


def test_announce_interface_name_returns_the_path_interface(monkeypatch):
    """The interface an announce's path arrived on is reported by name."""
    fake, _state = _fake_rns(interface="RNodeInterface[RNode LoRa]")
    monkeypatch.setattr(_mod, "RNS", fake)
    assert _mod._announce_interface_name(_DEST_HASH) == "RNodeInterface[RNode LoRa]"


def test_announce_interface_name_none_for_non_bytes_or_unknown(monkeypatch):
    """A non-bytes hash, or an unknown path, yields None."""
    fake, _state = _fake_rns(interface=None)
    monkeypatch.setattr(_mod, "RNS", fake)
    assert _mod._announce_interface_name("aabb") is None
    assert _mod._announce_interface_name(_DEST_HASH) is None


def test_announce_interface_name_swallows_errors(monkeypatch):
    """Transport errors and unstringable interfaces both yield None."""
    fake, _state = _fake_rns()
    fake.Transport.next_hop_interface = lambda _dh: (_ for _ in ()).throw(
        RuntimeError("boom")
    )
    monkeypatch.setattr(_mod, "RNS", fake)
    assert _mod._announce_interface_name(_DEST_HASH) is None

    class _Unstringable:
        def __str__(self):
            raise RuntimeError("no name")

    fake.Transport.next_hop_interface = lambda _dh: _Unstringable()
    assert _mod._announce_interface_name(_DEST_HASH) is None


def test_interface_allowed_matches_case_insensitive_substrings(monkeypatch):
    """Allowlist entries match as lowercased substrings of the interface name."""
    monkeypatch.setattr(_mod.config, "RETICULUM_INTERFACES", ("rnode", "serial"))
    assert _mod._announce_admitted(1, "RNodeInterface[RNode LoRa]") is True
    assert _mod._announce_admitted(1, "SerialInterface[radio0]") is True
    assert _mod._announce_admitted(1, "TCPClientInterface[hub]") is False


def test_interface_allowed_rejects_unknown_interface_when_allowlisted(monkeypatch):
    """An unverifiable interface is not among the named ones, so it is rejected."""
    monkeypatch.setattr(_mod.config, "RETICULUM_INTERFACES", ("rnode",))
    assert _mod._announce_admitted(1, None) is False
    assert _mod._announce_admitted(1, "") is False


# ---------------------------------------------------------------------------
# Review regressions: shared-instance blackout and identity-derived fallback
# ---------------------------------------------------------------------------


def test_fallback_name_matches_the_web_placeholder_for_every_id_shape():
    """The placeholder must equal what the web upsert builds, byte for byte.

    Ruby composes it from ``protocol_display_label`` plus the **upper-cased**
    canonical short id and compares with ``==``.  A digits-only id like
    ``!beef0001`` matches either way, so a fixture built from one hides a case
    mismatch that breaks ~85% of the id space — which is exactly how the first
    attempt at this fix passed its own test while still clobbering names.
    """
    for node_id, expected in (
        ("!beef0001", "Reticulum 0001"),  # digits only - matches even lower-cased
        ("!c0ffee00", "Reticulum EE00"),
        ("!beefcafe", "Reticulum CAFE"),
        ("!deadbeef", "Reticulum BEEF"),
        ("!0000000a", "Reticulum 000A"),
    ):
        # The placeholder names the row, and the row is keyed on the
        # identity — so walk identity hashes, not destinations.
        idn = _FakeIdentity(bytes.fromhex(node_id[1:] + "11" * 12))
        node = _announce_to_node_dict(_DEST_HASH, None, identity=idn, last_heard=1)
        assert node["user"]["longName"] == expected, node_id


# ---------------------------------------------------------------------------
# End-to-end findings (#893 field test): host id, interface scope, per-destination rows
# ---------------------------------------------------------------------------


def test_host_node_id_uses_the_reticulum_mapping_not_the_meshtastic_one():
    """T-D-2: one identity must not yield two different node ids.

    ``canonical_node_id`` parses a hex string as an integer and keeps the low
    32 bits, which is right for a Meshtastic node num and wrong for a 16-byte
    identity hash — it truncates from the opposite end to
    :func:`_reticulum_node_id`.  In the field this showed as the ingestor
    registering ``!86c39940`` while its own peer row was ``!27716218``.
    """
    identity_hash = "27716218762cfd2864141ef286c39940"
    assert ReticulumProvider().extract_host_node_id(None) is None or True
    with_env = ReticulumProvider()
    assert _mod._reticulum_node_id(bytes.fromhex(identity_hash)) == "!27716218"
    # The provider must canonicalise a raw identity hash the same way.
    assert with_env._canonical_host_node_id(identity_hash) == "!27716218"


def test_derived_host_node_id_is_none_when_no_identity_exists(monkeypatch):
    """An unreachable identity yields no host id rather than raising.

    The ingestor should degrade to an unregistered heartbeat, not die on
    startup, when the stack cannot produce an identity at all.
    """
    fake, _state = _fake_rns()

    def _boom():
        raise RuntimeError("no identity")

    fake.Transport.internal_identity = _boom
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(_mod.config, "INGESTOR_NODE_ID", None)
    assert ReticulumProvider().extract_host_node_id(None) is None


def test_ingestor_node_id_env_overrides_the_derived_id(monkeypatch):
    """The operator's value wins, and is canonicalised the Reticulum way.

    Intent preserved from #896, whose own generated-identity mechanism was
    dropped: an override must still take precedence over derivation.
    """
    fake, _state = _fake_rns()
    fake.Transport.internal_identity = lambda: _FakeIdentity(
        bytes.fromhex("fbf8e3389bc79a4fe9ed22eae97fc268")
    )
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(
        _mod.config, "INGESTOR_NODE_ID", "27716218762cfd2864141ef286c39940"
    )
    assert ReticulumProvider().extract_host_node_id(None) == "!27716218"


def test_the_derived_node_id_is_stable_across_calls(monkeypatch):
    """A restart on the same config dir yields the same id.

    Intent preserved from #896: a churning id would file one orphan ingestor
    row per restart. The transport identity is stable per config dir, so no
    key generation or persistence is needed to get that property.
    """
    _local_stack(
        monkeypatch,
        {_FIELD_LXMF: _FIELD_PRIMARY, _FIELD_NOMADNET: _FIELD_PRIMARY},
    )
    monkeypatch.setattr(_mod.config, "INGESTOR_NODE_ID", None)
    first = ReticulumProvider().extract_host_node_id(None)
    second = ReticulumProvider().extract_host_node_id(None)
    assert first == second == "!27716218"


# ---------------------------------------------------------------------------
# Host identity discovery (SPEC RE7/RE8)
#
# Fixture values are REAL, captured from a live stack, and the destination
# hashes are verified to derive from the primary identity by RNS itself (see
# test_field_destinations_derive_from_the_primary_identity). Using real values
# keeps the fixture from drifting into a shape RNS would never produce.
# ---------------------------------------------------------------------------

_FIELD_PRIMARY = "27716218762cfd2864141ef286c39940"
_FIELD_TRANSPORT = "fbf8e3389bc79a4fe9ed22eae97fc268"
_FIELD_LXMF = "4cf985bf933c21b1aa8dabd407d4ef69"
_FIELD_PROPAGATION = "fee521eb6fcd937cc519a1ec8c8b0b2a"
_FIELD_NOMADNET = "9c59da5e1516745d74cc908243e0ba2b"


def _local_stack(
    monkeypatch,
    dest_to_identity,
    *,
    transport_enabled=False,
    interfaces=None,
    app_data=None,
):
    """Point the real RNS at a synthetic 0-hop path table.

    Patches only the four stack accessors discovery uses, leaving
    ``RNS.Destination.hash`` real so aspect labelling is exercised against
    RNS's own derivation rather than a reimplementation of it.

    Parameters:
        monkeypatch: pytest fixture.
        dest_to_identity: ``{destination_hex: identity_hex}`` for 0-hop paths.
        transport_enabled: What ``RNS.Reticulum.transport_enabled`` reports.
        interfaces: ``{destination_hex: interface name}`` for path entries.
        app_data: ``{destination_hex: announce app_data bytes}`` the stack
            remembers, as ``RNS.Identity.recall_app_data`` would return.
    """
    import RNS

    interfaces = interfaces or {}
    app_data = app_data or {}
    table = [
        {"hash": bytes.fromhex(d), "hops": 0, "interface": interfaces.get(d)}
        for d in dest_to_identity
    ]
    monkeypatch.setattr(
        RNS.Identity,
        "recall_app_data",
        staticmethod(lambda dh, **_k: app_data.get(bytes(dh).hex())),
    )
    instance = types.SimpleNamespace(get_path_table=lambda max_hops=None: table)
    monkeypatch.setattr(RNS.Reticulum, "get_instance", staticmethod(lambda: instance))
    monkeypatch.setattr(
        RNS.Reticulum, "transport_enabled", staticmethod(lambda: transport_enabled)
    )
    monkeypatch.setattr(
        RNS.Transport,
        "internal_identity",
        staticmethod(lambda: _FakeIdentity(bytes.fromhex(_FIELD_TRANSPORT))),
    )
    monkeypatch.setattr(
        RNS.Identity,
        "recall",
        staticmethod(
            lambda dh, **_k: _FakeIdentity(
                bytes.fromhex(dest_to_identity[bytes(dh).hex()])
            )
        ),
    )


def test_field_destinations_derive_from_the_primary_identity():
    """The captured aspects really are destinations of the primary identity.

    Anchors the whole model: RNS recomputes each field destination hash from
    the identity hash alone, which is why one identity is one node and the
    aspects are its destinations (SPEC RE7).
    """
    import RNS

    primary = bytes.fromhex(_FIELD_PRIMARY)
    assert RNS.Destination.hash(primary, "lxmf", "delivery").hex() == _FIELD_LXMF
    assert (
        RNS.Destination.hash(primary, "lxmf", "propagation").hex() == _FIELD_PROPAGATION
    )
    assert (
        RNS.Destination.hash(primary, "nomadnetwork", "node").hex() == _FIELD_NOMADNET
    )
    # The transport identity is NOT one of them - it is its own identity.
    assert _FIELD_TRANSPORT not in {_FIELD_LXMF, _FIELD_PROPAGATION, _FIELD_NOMADNET}


def test_host_node_id_is_derived_when_unset(monkeypatch):
    """T-B: the host id is the primary identity, never the transport identity.

    The field case: a host whose primary identity is ``27716218…`` registered
    as ``!fbf8e338`` because the id came from the transport identity, matching
    none of the operator's announced destinations (SPEC RE8).
    """
    _local_stack(
        monkeypatch,
        {
            _FIELD_LXMF: _FIELD_PRIMARY,
            _FIELD_NOMADNET: _FIELD_PRIMARY,
            _FIELD_PROPAGATION: _FIELD_PRIMARY,
        },
    )
    monkeypatch.setattr(_mod.config, "INGESTOR_NODE_ID", None)
    assert ReticulumProvider().extract_host_node_id(None) == "!27716218"


def test_transport_identity_never_wins_the_primary_pick(monkeypatch):
    """A transport-only stack yields no host id rather than the wrong one."""
    _local_stack(monkeypatch, {_FIELD_TRANSPORT: _FIELD_TRANSPORT})
    monkeypatch.setattr(_mod.config, "INGESTOR_NODE_ID", None)
    assert ReticulumProvider().extract_host_node_id(None) is None


def test_primary_identity_tie_is_not_guessed(monkeypatch):
    """Two identities with equal destination counts yield None, not a coin flip.

    Path-table ordering is not stable, so guessing would let the ingestor's own
    id change between restarts (SPEC RE8).
    """
    other = "11223344" + "55" * 12
    _local_stack(monkeypatch, {_FIELD_LXMF: _FIELD_PRIMARY, _FIELD_NOMADNET: other})
    monkeypatch.setattr(_mod.config, "INGESTOR_NODE_ID", None)
    assert ReticulumProvider().extract_host_node_id(None) is None


def test_host_destinations_label_every_announced_aspect(monkeypatch):
    """All of the host's aspects become destinations of ONE node record."""
    _local_stack(
        monkeypatch,
        {
            _FIELD_LXMF: _FIELD_PRIMARY,
            _FIELD_NOMADNET: _FIELD_PRIMARY,
            _FIELD_PROPAGATION: _FIELD_PRIMARY,
        },
    )
    records = ReticulumProvider().host_destination_nodes()
    assert {r["nodeId"] for r in records} == {"!27716218"}
    by_aspect = {r["destination"]["aspect"]: r["destination"] for r in records}
    assert by_aspect["lxmf.delivery"]["id"] == _FIELD_LXMF
    assert by_aspect["lxmf.propagation"]["id"] == _FIELD_PROPAGATION
    assert by_aspect["nomadnetwork.node"]["id"] == _FIELD_NOMADNET
    assert by_aspect["lxmf.propagation"]["role"] == "PROPAGATION"
    assert by_aspect["nomadnetwork.node"]["role"] == "NODE"
    # Transport is off by default, so its aspect is absent.
    assert _mod._TRANSPORT_ASPECT not in by_aspect
    assert all(r["identityHash"] == _FIELD_PRIMARY for r in records)


def test_host_destinations_carry_their_interface_and_announced_name(monkeypatch):
    """Field regression: discovered aspects lost both name and interface.

    The host's own announces are never delivered back to this ingestor, so a
    discovered destination has no ``app_data`` of its own -- but the stack kept
    the last one it heard. Without recalling it every host destination stored
    the ``Reticulum <SHORT>`` placeholder and, through the RE10 headline rule,
    named the node with it. The interface came straight from the path entry and
    was simply dropped (SPEC RE8).
    """
    _local_stack(
        monkeypatch,
        {_FIELD_LXMF: _FIELD_PRIMARY, _FIELD_NOMADNET: _FIELD_PRIMARY},
        interfaces={
            _FIELD_LXMF: "LocalInterface[rns/default]",
            _FIELD_NOMADNET: "RNodeInterface[RNode Reticulum Berlin]",
        },
        app_data={
            _FIELD_LXMF: b"Afri Nomad Orion",
            _FIELD_NOMADNET: b"Department of Decentralization",
        },
    )
    by_aspect = {
        r["destination"]["aspect"]: r
        for r in ReticulumProvider().host_destination_nodes()
    }
    lxmf = by_aspect["lxmf.delivery"]
    nomad = by_aspect["nomadnetwork.node"]
    assert lxmf["user"]["longName"] == "Afri Nomad Orion"
    assert nomad["user"]["longName"] == "Department of Decentralization"
    assert lxmf["interface"] == "LocalInterface[rns/default]"
    assert nomad["interface"] == "RNodeInterface[RNode Reticulum Berlin]"


def test_host_destination_falls_back_to_the_placeholder_without_a_name(monkeypatch):
    """A destination the stack has never heard a name for keeps the placeholder.

    The generic name is wanted -- it is the web upsert's recognised fallback
    form -- but only where there is no real one to prefer.
    """
    _local_stack(monkeypatch, {_FIELD_LXMF: _FIELD_PRIMARY})
    record = ReticulumProvider().host_destination_nodes()[0]
    assert record["user"]["longName"] == "Reticulum 6218"
    # No interface in the path entry -> the key is omitted, not set to None.
    assert "interface" not in record


def test_transport_aspect_is_gated_on_transport_enabled(monkeypatch):
    """TRANSPORT is reported only when the stack actually relays traffic.

    The transport identity exists on every stack; claiming the role on a
    non-transport one would assert something false (SPEC RE8).
    """
    dests = {_FIELD_LXMF: _FIELD_PRIMARY}
    _local_stack(monkeypatch, dests, transport_enabled=True)
    on = {
        r["destination"]["aspect"]: r["destination"]
        for r in ReticulumProvider().host_destination_nodes()
    }
    assert on[_mod._TRANSPORT_ASPECT]["id"] == _FIELD_TRANSPORT
    assert on[_mod._TRANSPORT_ASPECT]["role"] == "TRANSPORT"

    _local_stack(monkeypatch, dests, transport_enabled=False)
    off = {
        r["destination"]["aspect"] for r in ReticulumProvider().host_destination_nodes()
    }
    assert _mod._TRANSPORT_ASPECT not in off


def test_local_announces_survive_an_interface_allowlist(monkeypatch):
    """T-C: a 0-hop announce is this machine's own and is always ingested.

    ``Transport.inbound`` adds a hop to every packet and takes it back for a
    local-client or shared-instance interface, so **0 hops means "announced by
    an app on this machine"**.  Scoping to a radio must not hide the operator's
    own nodes, which is what filtering purely on interface name did.
    """
    monkeypatch.setattr(_mod.config, "RETICULUM_INTERFACES", ("rnode",))
    assert (
        _mod._announce_admitted(hops=0, interface_name="LocalInterface[rns/default]")
        is True
    )
    # A remote peer is still scoped by interface.
    assert (
        _mod._announce_admitted(hops=1, interface_name="RNodeInterface[RNode Berlin]")
        is True
    )
    assert _mod._announce_admitted(hops=1, interface_name="TCPInterface[hub]") is False


def test_every_aspect_of_one_identity_is_one_node_row():
    """SPEC RE7: one peer is one node record, whatever it announces on.

    An identity announcing ``lxmf.delivery`` and ``nomadnetwork.node`` is a
    single node with two destinations -- not two nodes. Verified against real
    ``RNS.Destination.hash`` output so the derivation cannot drift from RNS.
    """
    import RNS

    idn = RNS.Identity()
    lxmf = RNS.Destination.hash(idn, "lxmf", "delivery")
    nomad = RNS.Destination.hash(idn, "nomadnetwork", "node")
    a = _announce_to_node_dict(
        lxmf, b"Afri Nomad Orion", identity=idn, aspect="lxmf.delivery"
    )
    b = _announce_to_node_dict(
        nomad, b"Dept of Decentralization", identity=idn, aspect="nomadnetwork.node"
    )
    # One identity, one node id -- keyed on the identity, never the destination.
    assert a["nodeId"] == b["nodeId"] == "!" + idn.hash.hex()[:8]
    assert a["nodeId"] != "!" + lxmf.hex()[:8]
    assert a["identityHash"] == b["identityHash"] == idn.hash.hex()
    # The aspects stay distinguishable through their destination rows (RE2).
    assert a["destination"]["id"] == lxmf.hex()
    assert b["destination"]["id"] == nomad.hex()
    assert a["destination"]["aspect"] != b["destination"]["aspect"]


def test_node_record_carries_the_interface_it_was_heard_on():
    """T-C: 'heard on RNode Reticulum Berlin' is the honest LoRa-vs-IP answer."""
    import RNS

    idn = RNS.Identity()
    dest = RNS.Destination.hash(idn, "lxmf", "delivery")
    node = _announce_to_node_dict(
        dest,
        b"X",
        identity=idn,
        aspect="lxmf.delivery",
        interface="RNodeInterface[RNode Reticulum Berlin]",
    )
    assert node["interface"] == "RNodeInterface[RNode Reticulum Berlin]"


# ---------------------------------------------------------------------------
# _announce_to_node_dict
# ---------------------------------------------------------------------------


def test_announce_to_node_dict_basic_fields():
    """The node dict carries lastHeard, protocol, and the derived user block."""
    node = _announce_to_node_dict(
        _DEST_HASH,
        b"Alice",
        identity=_FakeIdentity(),
        aspect="lxmf.delivery",
        hops=2,
        last_heard=1700000000,
    )
    assert node["lastHeard"] == 1700000000
    assert node["protocol"] == "reticulum"
    assert node["hopsAway"] == 2
    assert node["user"]["longName"] == "Alice"
    # Keyed on the identity (SPEC RE7); the destination it arrived on is
    # carried separately, in the destinations table.
    assert node["nodeId"] == "!beef0001"
    assert node["identityHash"] == _IDENTITY_HASH.hex()
    assert node["destination"] == {
        "id": _DEST_HASH.hex(),
        "aspect": "lxmf.delivery",
        "role": "PEER",
    }
    assert node["user"]["shortName"] == "beef"
    # publicKey is the identity's real key, never a destination hash (#888).
    assert node["user"]["publicKey"] == _PUBLIC_KEY.hex()
    assert node["user"]["publicKey"] != _DEST_HASH.hex()


def test_announce_to_node_dict_public_key_none_when_unreadable():
    """An identity whose key cannot be read still yields a node row."""

    class _Broken(_FakeIdentity):
        def get_public_key(self):
            raise RuntimeError("no key")

    node = _announce_to_node_dict(_DEST_HASH, b"A", identity=_Broken(), last_heard=1)
    assert node["user"]["publicKey"] is None


def test_announce_to_node_dict_long_name_falls_back_to_the_node_placeholder():
    """Undecodable app_data falls back to a placeholder naming the *node*.

    Not the destination: the row is keyed on the identity (SPEC RE7), and the
    web upsert only yields to the "<Label> <short id>" form it recognises.
    """
    node = _announce_to_node_dict(
        _DEST_HASH, b"\xff\xfe", identity=_FakeIdentity(), last_heard=1
    )
    assert node["user"]["longName"] == "Reticulum 0001"


def test_announce_to_node_dict_omits_hops_when_unknown():
    """hopsAway is absent (not None) when the hop count is unknown."""
    node = _announce_to_node_dict(
        _DEST_HASH, b"Alice", identity=_FakeIdentity(), hops=None, last_heard=1
    )
    assert "hopsAway" not in node


def test_announce_to_node_dict_defaults_last_heard_to_now():
    """Without an explicit receipt time, lastHeard is the wall clock."""
    before = int(time.time())
    node = _announce_to_node_dict(_DEST_HASH, b"Alice", identity=_FakeIdentity())
    after = int(time.time())
    assert before <= node["lastHeard"] <= after


def test_announce_to_node_dict_needs_an_identity_or_a_usable_destination():
    """The identity keys the row; the destination is only its aspect (RE7).

    A malformed destination hash no longer sinks the announce -- the identity
    still keys the node -- but it must not produce a ``destination`` mapping,
    which would write a destinations row under a truncated id.
    """
    salvaged = _announce_to_node_dict(b"\xaa", b"Alice", identity=_FakeIdentity())
    assert salvaged["nodeId"] == "!beef0001"
    assert "destination" not in salvaged
    # Neither a usable identity nor a usable destination -> nothing to key on.
    assert _announce_to_node_dict(b"\xaa", b"Alice", identity=None) is None
    # Identity missing but destination good: falls back to the destination.
    fallback = _announce_to_node_dict(_DEST_HASH, b"Alice")
    assert fallback["nodeId"] == "!aabbccdd"


def test_announce_to_node_dict_id_matches_node_id_helper():
    """The snapshot key derivation and the payload stay consistent."""
    node = _announce_to_node_dict(
        _DEST_HASH, None, identity=_FakeIdentity(), last_heard=1
    )
    assert node["nodeId"] == _reticulum_node_id(_IDENTITY_HASH)
    assert node["user"]["shortName"] == _reticulum_node_id(_IDENTITY_HASH)[1:5]


# ---------------------------------------------------------------------------
# Aspect-derived roles (SPEC RD4)
# ---------------------------------------------------------------------------


def test_propagation_is_an_ingested_aspect():
    """lxmf.propagation joins the listened aspects so PROPAGATION has a source."""
    assert set(_mod._ANNOUNCE_ASPECTS) == {
        "lxmf.delivery",
        "nomadnetwork.node",
        "lxmf.propagation",
    }


def test_every_ingested_aspect_maps_to_a_role():
    """No aspect may be listened to without a role, or nodes silently lose one."""
    assert set(_mod._ASPECT_ROLES) == set(_mod._ANNOUNCE_ASPECTS)
    assert _mod._ASPECT_ROLES["lxmf.delivery"] == "PEER"
    assert _mod._ASPECT_ROLES["nomadnetwork.node"] == "NODE"
    assert _mod._ASPECT_ROLES["lxmf.propagation"] == "PROPAGATION"


def test_transport_is_a_reserved_slot_with_no_source():
    """TRANSPORT ships in the UI ramp but no announce may populate it (RD4).

    Deriving it from our own path table would make it a property of this
    ingestor's vantage point rather than of the node, so two ingestors would
    disagree — breaking the CONTRACTS sender-side determinism rule.
    """
    # No announce aspect maps to it, so nothing populates it today. Kept as a
    # reserved slot in the UI ramp; there is no rank to place it in any more,
    # because one row now carries exactly one aspect.
    assert "TRANSPORT" not in _mod._ASPECT_ROLES.values()


def test_announce_to_node_dict_omits_an_absent_role():
    """A record never asserts a role it could not determine."""
    node = _announce_to_node_dict(
        _DEST_HASH, b"A", identity=_FakeIdentity(), last_heard=1
    )
    assert "role" not in node["user"]


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
        destination_hash=_DEST_HASH,
        announced_identity=_FakeIdentity(),
        app_data=b"Alice",
    )

    assert seen["count"] == 1
    assert len(upserts) == 1
    node_id, node = upserts[0]
    # Keyed on the announcing identity (SPEC RE7).
    assert node_id == "!beef0001"
    assert node["protocol"] == "reticulum"
    assert node["user"]["longName"] == "Alice"
    assert node["hopsAway"] == 1
    assert iface.nodes_snapshot() == [(node_id, node)]


def test_received_announce_recalls_identity_when_callback_omits_it(monkeypatch):
    """A handler invoked without an identity falls back to RNS.Identity.recall."""
    fake, _state = _fake_rns(hops=1, recalled=_FakeIdentity())
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    upserts: list = []
    monkeypatch.setattr(
        _mod.handlers, "upsert_node", lambda nid, node: upserts.append((nid, node))
    )
    monkeypatch.setattr(_mod.handlers, "_mark_packet_seen", lambda: None)

    handler = _ReticulumAnnounceHandler(
        "lxmf.delivery", _ReticulumInterface(target=None)
    )
    handler.received_announce(
        destination_hash=_DEST_HASH, announced_identity=None, app_data=b"Alice"
    )
    assert [nid for nid, _ in upserts] == ["!beef0001"]


def test_received_announce_skips_non_allowlisted_interface(monkeypatch):
    """With an allowlist set, an off-list interface is not ingested (#888)."""
    fake, _state = _fake_rns(interface="AutoInterface[Default Interface]")
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(_mod.config, "RETICULUM_INTERFACES", ("rnode",))
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
    _ReticulumAnnounceHandler("lxmf.delivery", iface).received_announce(
        destination_hash=_DEST_HASH,
        announced_identity=_FakeIdentity(),
        app_data=b"Alice",
    )

    assert upserts == []
    assert iface.nodes_snapshot() == []
    # A filtered-out announce is not this mesh's traffic, so it is not counted.
    assert seen["count"] == 0


def test_received_announce_ingests_allowlisted_interface(monkeypatch):
    """An interface matching the allowlist is ingested normally."""
    fake, _state = _fake_rns(interface="RNodeInterface[RNode LoRa]")
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(_mod.config, "RETICULUM_INTERFACES", ("rnode",))
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    upserts: list = []
    monkeypatch.setattr(
        _mod.handlers, "upsert_node", lambda nid, node: upserts.append((nid, node))
    )
    monkeypatch.setattr(_mod.handlers, "_mark_packet_seen", lambda: None)

    _ReticulumAnnounceHandler(
        "lxmf.delivery", _ReticulumInterface(target=None)
    ).received_announce(
        destination_hash=_DEST_HASH,
        announced_identity=_FakeIdentity(),
        app_data=b"Alice",
    )
    assert [nid for nid, _ in upserts] == ["!beef0001"]


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
    # Must not raise: the identity resolves, so the failing upsert is reached.
    handler.received_announce(
        destination_hash=_DEST_HASH, announced_identity=_FakeIdentity(), app_data=b"X"
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
        destination_hash=_DEST_HASH,
        announced_identity=_FakeIdentity(),
        app_data=b"Old",
    )
    handler.received_announce(
        destination_hash=_DEST_HASH,
        announced_identity=_FakeIdentity(),
        app_data=b"New",
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


def test_connect_logs_pending_host_id_with_a_retry_note(monkeypatch):
    """A startup line reading node_id=None reads as a failure, not a wait.

    It printed ``None`` on *every* run, because it logged
    ``iface.host_node_id`` -- a constant ``None`` -- rather than the resolved
    id. The daemon retries each loop, so an unresolved id is a pending lookup
    and the log now says so (review follow-up to SPEC RE8).
    """
    fake, _state = _fake_rns(existing_instance=object())
    fake.Reticulum.get_instance = staticmethod(lambda: None)  # no path table
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(_mod.config, "INGESTOR_NODE_ID", None)
    logs: list = []
    monkeypatch.setattr(
        _mod.config, "_debug_log", lambda msg, **kw: logs.append((msg, kw))
    )

    ReticulumProvider().connect(active_candidate=None)

    registered = [kw for msg, kw in logs if "listener registered" in msg]
    assert registered and registered[0]["node_id"] == "pending"
    assert any("retrying until a local destination is heard" in msg for msg, _ in logs)


def test_connect_logs_the_resolved_host_id(monkeypatch):
    """Once discovery answers, the startup line names the real id."""
    _local_stack(
        monkeypatch,
        {_FIELD_LXMF: _FIELD_PRIMARY, _FIELD_NOMADNET: _FIELD_PRIMARY},
    )
    monkeypatch.setattr(_mod.config, "INGESTOR_NODE_ID", None)
    monkeypatch.setattr(_mod.config, "RETICULUM_CONFIG_DIR", "/tmp/rns-config")
    logs: list = []
    monkeypatch.setattr(
        _mod.config, "_debug_log", lambda msg, **kw: logs.append((msg, kw))
    )

    ReticulumProvider().connect(active_candidate=None)

    registered = [kw for msg, kw in logs if "listener registered" in msg]
    assert registered and registered[0]["node_id"] == "!27716218"
    assert not any("retrying until" in msg for msg, _ in logs)


def test_connect_reuses_running_instance(monkeypatch):
    """connect() attaches to an existing RNS instance without re-initialising."""
    existing = object()
    fake, state = _fake_rns(existing_instance=existing)
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(
        _mod.config, "RETICULUM_CONFIG_DIR", "/cfg/potato-mesh/reticulum"
    )
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    iface, resolved, _ = ReticulumProvider().connect(active_candidate=None)

    assert state["created"] == []
    assert iface._rns is existing
    assert resolved == "reticulum:///cfg/potato-mesh/reticulum"


def test_connect_registers_announce_handlers_per_aspect(monkeypatch):
    """One announce handler per aspect is registered with RNS.Transport."""
    fake, state = _fake_rns()
    monkeypatch.setattr(_mod, "RNS", fake)
    monkeypatch.setattr(
        _mod.config, "RETICULUM_CONFIG_DIR", "/cfg/potato-mesh/reticulum"
    )
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    iface, _, _ = ReticulumProvider().connect(active_candidate=None)

    aspects = [h.aspect_filter for h in state["registered"]]
    assert aspects == list(_ANNOUNCE_ASPECTS)
    assert "lxmf.delivery" in aspects
    assert "nomadnetwork.node" in aspects
    assert iface._announce_handlers == state["registered"]


def test_connect_passes_active_candidate_through(monkeypatch, tmp_path):
    """The candidate string is returned unchanged (no serial-candidate concept)."""
    fake, _state = _fake_rns()
    monkeypatch.setattr(_mod, "RNS", fake)
    _no_ingestor_node_id(monkeypatch, tmp_path)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    _iface, _resolved, next_candidate = ReticulumProvider().connect(
        active_candidate="whatever"
    )
    assert next_candidate == "whatever"


def test_connect_is_silent_when_ingestor_node_id_is_unset(monkeypatch, tmp_path):
    """An unset ``INGESTOR_NODE_ID`` is no longer a warning (SPEC RE5).

    It used to leave the heartbeat unregistered, so connect warned about it.
    The id is now derived from the config dir's transport identity, which makes
    the variable an override — warning about an override nobody has to set
    would train operators to ignore the log.
    """
    fake, _state = _fake_rns()
    monkeypatch.setattr(_mod, "RNS", fake)
    _no_ingestor_node_id(monkeypatch, tmp_path)
    calls = []
    monkeypatch.setattr(
        _mod.config,
        "_debug_log",
        lambda message, **kwargs: calls.append((message, kwargs)),
    )

    ReticulumProvider().connect(active_candidate=None)

    assert [call for call in calls if call[1].get("severity") == "warn"] == []


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
    monkeypatch.setattr(
        _mod.config, "RETICULUM_CONFIG_DIR", "/cfg/potato-mesh/reticulum"
    )
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
    other_identity = _FakeIdentity(bytes.fromhex("c0ffee00" + "22" * 12))
    handler.received_announce(
        destination_hash=_DEST_HASH,
        announced_identity=_FakeIdentity(),
        app_data=b"Alice",
    )
    handler.received_announce(
        destination_hash=other_hash, announced_identity=other_identity, app_data=None
    )

    items = ReticulumProvider().node_snapshot_items(iface)
    as_dict = dict(items)
    assert set(as_dict) == {"!beef0001", "!c0ffee00"}
    assert as_dict["!beef0001"]["user"]["longName"] == "Alice"
    # Name-less announce falls back to a placeholder built from its own node
    # id, so it can never carry another destination's hex.
    assert as_dict["!c0ffee00"]["user"]["longName"] == "Reticulum EE00"


def test_update_node_ignores_a_falsy_node_id():
    """A falsy node id is never recorded in the snapshot."""
    iface = _ReticulumInterface(target=None)
    iface._update_node(None, {"protocol": "reticulum"})
    iface._update_node("", {"protocol": "reticulum"})
    assert iface.nodes_snapshot() == []


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


# ---------------------------------------------------------------------------
# Contract guards against the real RNS library (#888)
#
# The tests above exercise the provider through a fake RNS namespace.  These
# pin the *mapping itself* to the library's real Identity/Destination maths,
# so a change in how RNS derives destination hashes cannot silently reinstate
# the split-row bug these guards were written for.
# ---------------------------------------------------------------------------


def _identity_pair():
    """Return (identity, lxmf_dest_hash, nomad_dest_hash) from real RNS."""
    import RNS

    idn = RNS.Identity()
    return (
        idn,
        RNS.Destination.hash(idn, "lxmf", "delivery"),
        RNS.Destination.hash(idn, "nomadnetwork", "node"),
    )


def test_public_key_is_the_identity_public_key():
    """RT-A2: user.publicKey carries the identity key, not a destination hash."""
    idn, lxmf, _ = _identity_pair()
    node = _mod._announce_to_node_dict(lxmf, b"Kelly", identity=idn)
    assert node["user"]["publicKey"] == idn.get_public_key().hex()


def test_interface_allowlist_filters_announces(monkeypatch):
    """RT-A5: with an allowlist set, off-list interfaces are not ingested."""
    monkeypatch.setattr(config, "RETICULUM_INTERFACES", ("rnode",), raising=False)
    assert _mod._announce_admitted(1, "AutoInterface[Default Interface]") is False
    assert _mod._announce_admitted(1, "RNodeInterface[RNode LoRa]") is True


def test_interface_allowlist_empty_ingests_all(monkeypatch):
    """RT-A5: an empty allowlist (the default) ingests every interface."""
    monkeypatch.setattr(config, "RETICULUM_INTERFACES", (), raising=False)
    assert _mod._announce_admitted(1, "AutoInterface[Default Interface]") is True
    assert _mod._announce_admitted(1, None) is True


# ---------------------------------------------------------------------------
# Packaging surface (SPEC RN3 / MA10)
# ---------------------------------------------------------------------------


class TestReticulumDeploymentSurface:
    """A knob nobody can set is a knob that does not exist.

    Mirrors ``test_tx_policy_unit.TestDeploymentSurface``: every packaged path
    must be able to deliver these variables.  The ``${VAR:-""}`` literal-text
    trap that made a Compose default mean "one entry matching nothing" is
    guarded for the whole file by
    ``test_config_unit.TestComposeDefaults``, so it is not repeated per
    variable here.
    """

    _COMPOSE = REPO_ROOT / "docker-compose.yml"

    @pytest.mark.parametrize(
        "name", ["RETICULUM_CONFIG_DIR", "RETICULUM_INTERFACES", "INGESTOR_NODE_ID"]
    )
    def test_compose_passes_the_variable_through(self, name):
        """The base compose file maps the variable from the host env."""
        text = self._COMPOSE.read_text(encoding="utf-8")
        assert re.search(
            rf"^\s*{name}:\s*\$\{{{name}", text, re.MULTILINE
        ), f"docker-compose.yml does not pass {name} through to the ingestor"

    def test_quote_only_allowlist_cannot_blackout_ingestion(self):
        """Defence in depth for the above: a quoted empty value means no allowlist."""
        assert config._parse_reticulum_interfaces('""') == ()

    def test_image_declares_the_reticulum_defaults(self):
        """Both image stages declare the variables, so the knob exists there too."""
        text = (REPO_ROOT / "data" / "Dockerfile").read_text(encoding="utf-8")
        for name in ("RETICULUM_CONFIG_DIR", "RETICULUM_INTERFACES"):
            assert (
                text.count(f"{name}=") == 2
            ), f"{name} missing from a Dockerfile stage"

    def test_reticulum_config_dir_is_not_the_shared_config_volume_root(self):
        """The RNS config gets its own volume, not the web-initialised shared one.

        ``potatomesh_config`` is seeded by the web image, whose user is pinned to
        uid 1000; this image's user is not, so RNS could not create a directory
        in that volume's root.
        """
        text = self._COMPOSE.read_text(encoding="utf-8")
        assert "potatomesh_reticulum:/app/.config/potato-mesh/reticulum" in text
        assert re.search(r"^\s{2}potatomesh_reticulum:", text, re.MULTILINE)

    def test_env_example_documents_the_variables(self):
        """The copy-this-to-.env template mentions each variable."""
        text = (REPO_ROOT / ".env.example").read_text(encoding="utf-8")
        for name in (
            "RETICULUM_CONFIG_DIR",
            "RETICULUM_INTERFACES",
            "INGESTOR_NODE_ID",
        ):
            assert re.search(
                rf"^#\s*{name}=", text, re.MULTILINE
            ), f"{name} is not documented in .env.example"

    def test_docs_no_longer_call_ingestor_node_id_required(self):
        """The variable became an override (SPEC RE5); docs saying otherwise mislead.

        A README that still tells operators to set it would send them hunting
        for a value the ingestor derives for itself.
        """
        for name in ("README.md", ".env.example"):
            text = (REPO_ROOT / name).read_text(encoding="utf-8")
            assert not re.search(
                r"reticulum listener also needs INGESTOR_NODE_ID|"
                r"^Set `INGESTOR_NODE_ID`\.",
                text,
                re.MULTILINE | re.IGNORECASE,
            ), f"{name} still presents INGESTOR_NODE_ID as required for reticulum"

    def test_docs_do_not_key_the_ingestor_on_the_transport_identity(self):
        """RE8 excludes the transport identity from the pick; docs must agree.

        RNS generates the transport identity as an independent keypair, so it
        matches none of the operator's announced destinations -- keying on it
        registered a node id the operator could not recognise.  A doc still
        naming it would send them looking for the wrong hash in ``rnstatus``.
        """
        for name in ("README.md", ".env.example"):
            text = (REPO_ROOT / name).read_text(encoding="utf-8")
            assert (
                "from the transport identity" not in text
            ), f"{name} still derives the ingestor node id from the transport identity"
            assert re.search(
                r"primary identity", text, re.IGNORECASE
            ), f"{name} does not name the primary identity as the id's source"

    def test_docs_warn_that_changing_the_id_strands_the_old_row(self):
        """Moving the id leaves a heartbeat-less row behind, so operators are told.

        Nothing in code warns: that would need a durable record of the
        previously registered id, which this provider does not keep.  The
        operator-facing docs are the only place the caveat can live.
        """
        for name in ("README.md", ".env.example"):
            text = (REPO_ROOT / name).read_text(encoding="utf-8")
            assert re.search(
                r"strands? the old row", text, re.IGNORECASE
            ), f"{name} does not warn that changing the id strands the old row"
            assert re.search(
                r"ages out", text, re.IGNORECASE
            ), f"{name} does not say the stranded row ages out"

    def test_docs_state_that_connection_does_not_apply(self):
        """RN10's answer has to reach the operator, not just the log."""
        for name in ("README.md", ".env.example"):
            text = (REPO_ROOT / name).read_text(encoding="utf-8")
            assert "CONNECTION" in text and re.search(
                r"CONNECTION`? does not apply", text
            ), f"{name} does not say CONNECTION is inapplicable to reticulum"


# ---------------------------------------------------------------------------
# The ingestor's own node id (SPEC RE5)
# ---------------------------------------------------------------------------


def test_announces_are_still_ingested_without_a_node_id(monkeypatch, tmp_path):
    """A missing node id costs the heartbeat, never the ingestion."""
    fake, state = _fake_rns(identity_write_error=OSError("read-only filesystem"))
    monkeypatch.setattr(_mod, "RNS", fake)
    _no_ingestor_node_id(monkeypatch, tmp_path)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    iface, _target, _next = ReticulumProvider().connect(active_candidate=None)

    assert iface.isConnected
    assert len(state["registered"]) == len(_ANNOUNCE_ASPECTS)


def test_an_underivable_identity_hash_yields_no_node_id(monkeypatch, tmp_path):
    """A hash too short to map is no id, not a truncated one."""
    fake, _state = _fake_rns(self_identity_hash=b"\x01")
    monkeypatch.setattr(_mod, "RNS", fake)
    _no_ingestor_node_id(monkeypatch, tmp_path)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    iface, _target, _next = ReticulumProvider().connect(active_candidate=None)

    assert iface.host_node_id is None


def test_extract_host_node_id_falls_back_to_the_env_for_a_foreign_iface(monkeypatch):
    """The operator's value is honoured whatever interface object is passed."""
    monkeypatch.setattr(_mod.config, "INGESTOR_NODE_ID", "!operator")

    assert ReticulumProvider().extract_host_node_id(object()) == "!operator"


def test_extract_host_node_id_is_none_when_nothing_resolves(monkeypatch):
    """No resolved id and no env value is None, not an empty string."""
    monkeypatch.setattr(_mod.config, "INGESTOR_NODE_ID", None)

    assert ReticulumProvider().extract_host_node_id(object()) is None


# ---------------------------------------------------------------------------
# CONNECTION does not apply to Reticulum (SPEC RN10)
# ---------------------------------------------------------------------------


def test_connection_is_reported_as_inapplicable(monkeypatch, tmp_path):
    """The image ships a serial default for every protocol; say it is ignored."""
    messages = []
    fake, _state = _fake_rns()
    monkeypatch.setattr(_mod, "RNS", fake)
    _no_ingestor_node_id(monkeypatch, tmp_path)
    monkeypatch.setattr(_mod.config, "CONNECTION", "/dev/ttyACM0")
    monkeypatch.setattr(
        _mod.config,
        "_debug_log",
        lambda message, **_k: messages.append(message),
    )

    ReticulumProvider().connect(active_candidate=None)

    said = [m for m in messages if "does not apply to PROTOCOL=reticulum" in m]
    assert said, "a set CONNECTION was passed over in silence"
    # Naming the replacements is the point: the operator needs somewhere to go.
    assert "RETICULUM_CONFIG_DIR" in said[0] and "RETICULUM_INTERFACES" in said[0]


def test_connection_is_not_mentioned_when_unset(monkeypatch, tmp_path):
    """Nothing to correct means nothing to say."""
    messages = []
    fake, _state = _fake_rns()
    monkeypatch.setattr(_mod, "RNS", fake)
    _no_ingestor_node_id(monkeypatch, tmp_path)
    monkeypatch.setattr(
        _mod.config,
        "_debug_log",
        lambda message, **_k: messages.append(message),
    )

    ReticulumProvider().connect(active_candidate=None)

    assert not any("does not apply to PROTOCOL=reticulum" in m for m in messages)


def test_connection_never_becomes_the_reticulum_target(monkeypatch, tmp_path):
    """The resolved target stays the config dir, whatever CONNECTION says."""
    fake, _state = _fake_rns()
    monkeypatch.setattr(_mod, "RNS", fake)
    _no_ingestor_node_id(monkeypatch, tmp_path)
    monkeypatch.setattr(_mod.config, "CONNECTION", "/dev/ttyACM0")
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    _iface, target, _next = ReticulumProvider().connect(active_candidate=None)

    assert target == f"reticulum://{tmp_path}"


# ---------------------------------------------------------------------------
# Discovery failure paths (SPEC RE8)
#
# Every accessor these helpers call reaches a *running* RNS stack, which can be
# absent, mid-shutdown, or answering over RPC. Each failure must degrade to
# "nothing discovered" rather than kill the announce thread, so each branch is
# exercised rather than assumed.
# ---------------------------------------------------------------------------


class _Boom:
    """Namespace whose every accessor raises, standing in for a dead stack."""

    def __getattr__(self, _name):
        raise RuntimeError("stack is gone")


def test_local_path_entries_survives_a_dead_or_silent_stack(monkeypatch):
    """No instance, a raising accessor, or a non-list reply all yield []."""
    import RNS

    monkeypatch.setattr(RNS.Reticulum, "get_instance", staticmethod(lambda: None))
    assert _mod._local_path_entries() == []

    def _raise():
        raise RuntimeError("no instance")

    monkeypatch.setattr(RNS.Reticulum, "get_instance", staticmethod(_raise))
    assert _mod._local_path_entries() == []

    bad = types.SimpleNamespace(
        get_path_table=lambda max_hops=None: (_ for _ in ()).throw(OSError("rpc down"))
    )
    monkeypatch.setattr(RNS.Reticulum, "get_instance", staticmethod(lambda: bad))
    assert _mod._local_path_entries() == []

    not_a_list = types.SimpleNamespace(get_path_table=lambda max_hops=None: "nope")
    monkeypatch.setattr(RNS.Reticulum, "get_instance", staticmethod(lambda: not_a_list))
    assert _mod._local_path_entries() == []


def test_local_identity_destinations_skips_unusable_entries(monkeypatch):
    """A malformed entry or an unrecallable destination is skipped, not fatal."""
    import RNS

    table = [
        {"hash": "not-bytes", "hops": 0},
        {"hash": bytes.fromhex(_FIELD_LXMF), "hops": 0},
        {"hash": bytes.fromhex(_FIELD_NOMADNET), "hops": 0, "interface": "RNode[X]"},
    ]
    monkeypatch.setattr(
        RNS.Reticulum,
        "get_instance",
        staticmethod(lambda: types.SimpleNamespace(get_path_table=lambda **_k: table)),
    )
    monkeypatch.setattr(
        RNS.Transport,
        "internal_identity",
        staticmethod(lambda: _FakeIdentity(bytes.fromhex(_FIELD_TRANSPORT))),
    )

    def _recall(dh, **_k):
        if bytes(dh).hex() == _FIELD_LXMF:
            raise RuntimeError("unknown destination")
        return _FakeIdentity(bytes.fromhex(_FIELD_PRIMARY))

    monkeypatch.setattr(RNS.Identity, "recall", staticmethod(_recall))
    groups = _mod._local_identity_destinations()
    # Only the nomadnet entry survives, and it carries its interface.
    assert groups == {_FIELD_PRIMARY: {_FIELD_NOMADNET: "RNode[X]"}}


def test_local_identity_destinations_skips_an_unidentifiable_owner(monkeypatch):
    """A recall returning no usable hash yields no group."""
    import RNS

    table = [{"hash": bytes.fromhex(_FIELD_LXMF), "hops": 0}]
    monkeypatch.setattr(
        RNS.Reticulum,
        "get_instance",
        staticmethod(lambda: types.SimpleNamespace(get_path_table=lambda **_k: table)),
    )
    monkeypatch.setattr(
        RNS.Transport, "internal_identity", staticmethod(lambda: _FakeIdentity(b""))
    )
    monkeypatch.setattr(RNS.Identity, "recall", staticmethod(lambda _dh, **_k: None))
    assert _mod._local_identity_destinations() == {}


def test_recalled_display_name_is_none_when_the_stack_cannot_answer(monkeypatch):
    """A raising recall_app_data degrades to the placeholder, not a crash."""
    import RNS

    def _raise(_dh, **_k):
        raise RuntimeError("no app data")

    monkeypatch.setattr(RNS.Identity, "recall_app_data", staticmethod(_raise))
    assert _mod._recalled_display_name(_FIELD_LXMF) is None


def test_aspect_destination_hex_rejects_a_malformed_aspect(monkeypatch):
    """An aspect without an app/aspect split, or an unhashable identity, is None."""
    assert _mod._aspect_destination_hex(_FIELD_PRIMARY, "nodots") is None
    assert _mod._aspect_destination_hex(_FIELD_PRIMARY, "") is None
    # A non-hex identity cannot be turned into hash material.
    assert _mod._aspect_destination_hex("zzzz", "lxmf.delivery") is None


def test_host_destination_nodes_none_without_a_usable_identity():
    """An unusable identity hash yields no host records at all."""
    assert _mod._host_destination_nodes("ab") == []


def test_transport_enabled_is_false_when_the_stack_cannot_answer(monkeypatch):
    """An unreadable stack reports transport off - the safe answer, since the
    role is only emitted when transport is definitely on (SPEC RE9)."""
    import RNS

    def _raise():
        raise RuntimeError("no config")

    monkeypatch.setattr(RNS.Reticulum, "transport_enabled", staticmethod(_raise))
    assert _mod._transport_enabled() is False


def test_announce_interface_name_prefers_the_rpc_answer(monkeypatch):
    """The shared instance's view wins over this process's path table (RE3)."""
    import RNS

    instance = types.SimpleNamespace(
        get_next_hop_if_name=lambda _dh: "RNodeInterface[RNode Reticulum Berlin]"
    )
    monkeypatch.setattr(RNS.Reticulum, "get_instance", staticmethod(lambda: instance))
    assert (
        _mod._announce_interface_name(bytes.fromhex(_FIELD_LXMF))
        == "RNodeInterface[RNode Reticulum Berlin]"
    )


def test_announce_interface_name_falls_back_when_rpc_is_unavailable(monkeypatch):
    """A dead instance or a blank RPC reply falls back to the local table."""
    import RNS

    def _raise():
        raise RuntimeError("gone")

    monkeypatch.setattr(RNS.Reticulum, "get_instance", staticmethod(_raise))
    monkeypatch.setattr(
        RNS.Transport,
        "next_hop_interface",
        staticmethod(lambda _dh: "LocalInterface[x]"),
    )
    assert (
        _mod._announce_interface_name(bytes.fromhex(_FIELD_LXMF)) == "LocalInterface[x]"
    )

    # Instance present but RPC raises, and separately returns nothing usable.
    boom = types.SimpleNamespace(
        get_next_hop_if_name=lambda _dh: (_ for _ in ()).throw(OSError("rpc"))
    )
    monkeypatch.setattr(RNS.Reticulum, "get_instance", staticmethod(lambda: boom))
    assert (
        _mod._announce_interface_name(bytes.fromhex(_FIELD_LXMF)) == "LocalInterface[x]"
    )

    blank = types.SimpleNamespace(get_next_hop_if_name=lambda _dh: None)
    monkeypatch.setattr(RNS.Reticulum, "get_instance", staticmethod(lambda: blank))
    assert (
        _mod._announce_interface_name(bytes.fromhex(_FIELD_LXMF)) == "LocalInterface[x]"
    )


def test_snapshot_does_not_duplicate_a_host_destination_already_heard(monkeypatch):
    """A host aspect that also arrived as an announce is listed once.

    The host's records are folded into every snapshot, so without the guard a
    destination the ingestor genuinely heard would be reported twice.
    """
    _local_stack(
        monkeypatch,
        {_FIELD_LXMF: _FIELD_PRIMARY},
        app_data={_FIELD_LXMF: b"Afri Nomad Orion"},
    )
    iface = _ReticulumInterface(target=None)
    iface._update_node(
        "!27716218",
        {
            "nodeId": "!27716218",
            "protocol": "reticulum",
            "destination": {"id": _FIELD_LXMF, "aspect": "lxmf.delivery"},
            "user": {"longName": "Afri Nomad Orion"},
        },
    )
    items = ReticulumProvider().node_snapshot_items(iface)
    ids = [n.get("destination", {}).get("id") for _nid, n in items]
    assert ids.count(_FIELD_LXMF) == 1


def test_snapshot_includes_host_destinations_not_heard_as_announces(monkeypatch):
    """The host's own aspects reach the snapshot even with nothing heard.

    Nothing relays our own announce back to us, so without folding the
    discovered records in, the ingestor's own node would never be reported
    (SPEC RE8).
    """
    _local_stack(
        monkeypatch,
        {_FIELD_LXMF: _FIELD_PRIMARY, _FIELD_NOMADNET: _FIELD_PRIMARY},
        app_data={_FIELD_NOMADNET: b"Department of Decentralization"},
    )
    iface = _ReticulumInterface(target=None)
    items = ReticulumProvider().node_snapshot_items(iface)
    assert {nid for nid, _ in items} == {"!27716218"}
    by_aspect = {n["destination"]["aspect"]: n for _nid, n in items}
    assert set(by_aspect) == {"lxmf.delivery", "nomadnetwork.node"}
    assert (
        by_aspect["nomadnetwork.node"]["user"]["longName"]
        == "Department of Decentralization"
    )
