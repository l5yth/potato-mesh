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
"""Passive Reticulum (RNS) announce-listener ``MeshProtocol`` provider.

Attaches to a Reticulum stack via :class:`RNS.Reticulum` (joining an existing
shared instance when one is running, otherwise starting one from the config
directory in :data:`~data.mesh_ingestor.config.RETICULUM_CONFIG_DIR`) and
registers announce handlers for the ``lxmf.delivery`` and
``nomadnetwork.node`` destination aspects.  Every announce heard on the
network is converted into a ``POST /api/nodes`` upsert with
``protocol="reticulum"``.

Like :class:`~data.mesh_ingestor.protocols.meshtastic_udp.MeshtasticUdpProvider`
this provider is receive-only: it never transmits and has no roster to fetch.

**Own node id.**  Reticulum has no protocol-level handshake revealing "our"
node id, so the ingestor discovers it: the 0-hop entries of the running
stack's path table are the destinations announced by apps on this machine, and
:func:`RNS.Identity.recall` maps each back to its owning identity.  The
identity fronting the most of them is the host's **primary identity**, and its
first four bytes are the node id (SPEC RE8).  Ties are not guessed — path-table
ordering is unstable, so an ambiguous host must set
:envvar:`INGESTOR_NODE_ID`, which otherwise remains an **override**, not a
requirement.

The *transport* identity is deliberately **not** the node id.  RNS generates it
as an independent keypair in ``storage/transport_identity``, so it matches none
of the operator's announced destinations: a host whose primary identity was
``27716218…`` registered as ``!fbf8e338`` under the old rule.  It is instead
recorded as one more destination of the host — see :data:`_TRANSPORT_ASPECT`.
Note also that it is not the hash ``rnstatus`` prints as "Transport Instance":
``rnstatus`` reports ``Transport.identity``, which RNS replaces with a fresh
ephemeral identity on every start unless ``enable_transport`` is set, while
``internal_identity()`` returns the persisted ``Transport._identity``.  Nothing
is generated or written by this provider.

**Connection variables.**  :envvar:`CONNECTION` names a single serial, TCP, or
BLE endpoint and has no meaning for RNS, which is a stack of many interfaces
rather than one endpoint.  Its two Reticulum counterparts are disjoint rather
than overlapping: :data:`~data.mesh_ingestor.config.RETICULUM_CONFIG_DIR` says
*which stack*, :data:`~data.mesh_ingestor.config.RETICULUM_INTERFACES` says
*which of its interfaces to ingest from*.  A set :envvar:`CONNECTION` is
ignored here and said so at startup, because the shipped container image
carries a serial default for every protocol (SPEC RN10).

**Canonical node-id mapping.**  A Reticulum *destination* hash is a truncated
hash over the identity hash and the name hash — it is neither stable across a
peer's aspects nor a public key.  One physical peer announcing both
``lxmf.delivery`` and ``nomadnetwork.node`` therefore presents two unrelated
destination hashes.  The canonical ``!%08x`` node id is consequently derived
from the **identity hash** (first four bytes), which is one per peer, so both
aspects collapse onto a single node row.  ``user.publicKey`` carries the
announcing identity's **real public key**, and the destination hashes ride
their own ``destHash`` list, accumulating as further aspects are heard.  The
mapping is deterministic and sender-side, so the same announce heard by
multiple ingestors collapses onto one node row (the CONTRACTS.md
cross-ingestor dedup requirement).

**Interface scope.**  An RNS stack may carry LoRa and IP interfaces at once,
and this listener hears every announce reachable over any of them — on a LAN
with an ``AutoInterface`` that is the entire local Reticulum network.
:data:`~data.mesh_ingestor.config.RETICULUM_INTERFACES` restricts ingestion to
announces whose path was received on a matching interface; it is empty by
default, which ingests everything.

**Transmit policy (SPEC MA7).**  This provider is receive-only: it never sends
an announce, a message, or a poll, so it has no transmit site to gate.  Note
that the underlying RNS stack is *not* silent at the interface layer — an
``AutoInterface`` multicasts peer discovery, and a config with
``enable_transport`` set relays other nodes' traffic.  That is interface-level
behaviour owned by the Reticulum config, which is why the ingestor keeps its
own isolated config directory rather than adopting the operator's
(:func:`~data.mesh_ingestor.config._resolve_reticulum_config_dir`).

**Display names.**  ``lxmf.delivery`` announces carry the peer's display name
in ``app_data`` — either raw UTF-8 bytes (pre-0.5 LXMF) or a msgpack array
whose first element is the display name (LXMF >= 0.5, which appends the stamp
cost).  ``nomadnetwork.node`` announces carry the node name as raw UTF-8.
Undecodable ``app_data`` falls back to ``"Reticulum <SHORT>"`` — the protocol
label plus the upper-cased last four hex of the canonical node id.  It names the
*node*, not whichever destination announced, and matches the placeholder form the
web upsert refuses to overwrite a real name with.
"""

from __future__ import annotations

import os
import threading
import time

import RNS
from RNS.vendor import umsgpack

from .. import config, handlers

_ASPECT_ROLES: dict[str, str] = {
    "lxmf.propagation": "PROPAGATION",
    "nomadnetwork.node": "NODE",
    "lxmf.delivery": "PEER",
}
"""Announce aspect to the role it implies (SPEC RD4).

Reticulum has no role field: what a peer *is* can only be read from which
destinations it announces.  ``TRANSPORT`` is deliberately absent — no announce
exposes transport status, and deriving it from our own path table would make it
a property of this ingestor's vantage point rather than of the node, so two
ingestors would disagree (the CONTRACTS sender-side determinism rule).
"""

_ANNOUNCE_ASPECTS: tuple[str, ...] = tuple(_ASPECT_ROLES)
"""Destination aspects whose announces are ingested as node records."""

_TRANSPORT_ASPECT = "rns.transport"
"""Synthetic aspect naming the host's own transport instance (SPEC RE8).

Not a real announce aspect: RNS never announces transport status, and the
transport identity is an *independent* identity rather than a destination of
the operator's primary one.  It is recorded only for **this ingestor's own
host**, where the association is local fact rather than inference, so the
CONTRACTS sender-side determinism rule still holds for every remote peer.
"""

_MSGPACK_ARRAY_LEAD_BYTES = frozenset(range(0x90, 0xA0)) | {0xDC, 0xDD}
"""First-byte values identifying a msgpack-encoded announce ``app_data``.

``0x90``–``0x9f`` are msgpack fixarrays, ``0xdc``/``0xdd`` are array16/array32
— the same discrimination LXMF's ``display_name_from_app_data`` applies to
tell the >= 0.5 ``[display_name, stamp_cost]`` format from the original raw
UTF-8 name bytes.
"""


def _reticulum_node_id(identity_hash: object) -> str | None:
    """Derive a canonical ``!xxxxxxxx`` node ID from a Reticulum **identity** hash.

    Uses the first four bytes (eight hex characters) of the 16-byte identity
    hash, formatted as ``!xxxxxxxx`` — the same prefix-of-native-identifier
    scheme MeshCore uses for public keys.  Keying on the identity rather than
    on a destination hash is what merges a peer's ``lxmf.delivery`` and
    ``nomadnetwork.node`` announces into one node row (#888).

    Parameters:
        identity_hash: Identity hash as raw ``bytes`` (``RNS.Identity.hash``)
            or as a hex string.

    Returns:
        Canonical ``!xxxxxxxx`` node ID string, or ``None`` when the hash is
        absent or too short.
    """
    hash_hex = _reticulum_hash_hex(identity_hash)
    if hash_hex is None or len(hash_hex) < 8:
        return None
    return "!" + hash_hex[:8].lower()


def _reticulum_hash_hex(dest_hash: object) -> str | None:
    """Return the full lowercase hex form of a Reticulum destination hash.

    Parameters:
        dest_hash: Destination hash as raw ``bytes`` or a hex string.

    Returns:
        Lowercase hex string (32 chars for a full 16-byte hash), or ``None``
        when the value cannot be interpreted.
    """
    if isinstance(dest_hash, (bytes, bytearray)):
        return bytes(dest_hash).hex()
    if isinstance(dest_hash, str):
        stripped = dest_hash.strip().lower()
        return stripped or None
    return None


def _announce_node_id(identity: object, dest_hash: object) -> str | None:
    """Return the node ID an announce belongs to: the **identity**, not the
    destination.

    One peer is one node record; its destinations are aspects of that identity
    and are carried separately in the ``destinations`` table (SPEC RE2).  A
    destination hash is a truncated hash over the identity *and* the name hash,
    so keying rows on it splits one peer into a row per aspect.

    Falls back to the destination hash only when the identity cannot be
    resolved at all — without it there is nothing else to key on, and dropping
    the announce would lose a peer entirely.

    Parameters:
        identity: Announcing :class:`RNS.Identity`, or ``None``.
        dest_hash: Destination hash the announce arrived for.

    Returns:
        Canonical ``!xxxxxxxx`` node ID, or ``None`` when neither hash is usable.
    """
    node_id = _reticulum_node_id(getattr(identity, "hash", None))
    if node_id is not None:
        return node_id
    return _reticulum_node_id(dest_hash)


def _reticulum_short_name(node_id: str | None) -> str:
    """Derive a four-character short name from a canonical node ID.

    Uses the first two bytes (four hex characters) of the ``!xxxxxxxx`` node
    ID, matching the MeshCore convention so short names stay visually
    consistent across protocols.

    Parameters:
        node_id: Canonical ``!xxxxxxxx`` node ID string.

    Returns:
        Four lowercase hex characters (e.g. ``"cafe"``), or an empty string
        when the node ID is missing or too short.
    """
    if not node_id:
        return ""
    raw = node_id.lstrip("!")
    if len(raw) < 4:
        return ""
    return raw[:4].lower()


def _decode_display_name(app_data: object) -> str | None:
    """Decode a display name from Reticulum announce ``app_data``.

    Handles both LXMF conventions — raw UTF-8 name bytes (original format)
    and a msgpack array whose first element is the name (LXMF >= 0.5, which
    appends the stamp cost) — as well as nomadnet node-name announces (raw
    UTF-8).  Any undecodable payload yields ``None`` rather than raising, so
    a malformed announce can never kill the receive path.

    Parameters:
        app_data: Announce application data as delivered by the RNS announce
            callback (``bytes`` or ``None``; ``str`` is tolerated for tests).

    Returns:
        The decoded, stripped display name, or ``None`` when *app_data* is
        empty, undecodable, or decodes to an empty string.
    """
    if app_data is None:
        return None
    if isinstance(app_data, str):
        return app_data.strip() or None
    if not isinstance(app_data, (bytes, bytearray)) or len(app_data) == 0:
        return None
    data = bytes(app_data)
    try:
        if data[0] in _MSGPACK_ARRAY_LEAD_BYTES:
            unpacked = umsgpack.unpackb(data)
            if not isinstance(unpacked, (list, tuple)) or not unpacked:
                return None
            name = unpacked[0]
            if isinstance(name, (bytes, bytearray)):
                name = bytes(name).decode("utf-8")
            if not isinstance(name, str):
                return None
            return name.strip() or None
        return data.decode("utf-8").strip() or None
    except Exception:
        return None


def _identity_from_announce(
    announced_identity: object, dest_hash: object
) -> object | None:
    """Resolve the announcing :class:`RNS.Identity` for an announce.

    RNS hands the announcing identity straight to the handler (it needs it to
    evaluate ``aspect_filter``), so *announced_identity* is normally present.
    :func:`RNS.Identity.recall` is the fallback for a handler invoked without
    one.

    Parameters:
        announced_identity: Identity passed to the announce callback.
        dest_hash: Destination hash the announce arrived for.

    Returns:
        An identity-like object exposing ``hash``, or ``None`` when neither
        source yields one.
    """
    if announced_identity is not None and getattr(announced_identity, "hash", None):
        return announced_identity
    if not isinstance(dest_hash, (bytes, bytearray)):
        return None
    try:
        recalled = RNS.Identity.recall(bytes(dest_hash))
    except Exception:
        return None
    return recalled if getattr(recalled, "hash", None) else None


def _identity_public_key_hex(identity: object) -> str | None:
    """Return the announcing identity's public key as lowercase hex.

    Parameters:
        identity: Identity object exposing ``get_public_key()``.

    Returns:
        Hex-encoded public key, or ``None`` when it cannot be read.  Errors
        are swallowed so a peer with an unreadable key still yields a node row
        (without a key) rather than dropping the announce.
    """
    if identity is None:
        return None
    try:
        key = identity.get_public_key()
    except Exception:
        return None
    if isinstance(key, (bytes, bytearray)):
        return bytes(key).hex()
    if isinstance(key, str):
        return key.strip().lower() or None
    return None


def _announce_interface_name(dest_hash: object) -> str | None:
    """Return the name of the RNS interface an announce's path arrived on.

    RNS records the path-table entry (which carries the receiving interface)
    *before* dispatching announce handlers, so this resolves during the
    callback.  Resolved via the module-level ``RNS`` name so test fakes apply.

    Parameters:
        dest_hash: Destination hash from the announce callback.

    Returns:
        The interface's string form, or ``None`` when it cannot be determined.
    """
    if not isinstance(dest_hash, (bytes, bytearray)):
        return None
    # Ask the *running stack* which interface the path arrived on.  On a shared
    # instance ``get_next_hop_if_name`` RPCs to ``rnsd`` and returns its view;
    # ``RNS.Transport.next_hop_interface`` reads only this process's path table,
    # which for a local client answers ``LocalInterface[...]`` for everything and
    # is what made the allowlist look unanswerable (SPEC RE3).
    try:
        instance = RNS.Reticulum.get_instance()
    except Exception:
        instance = None
    if instance is not None:
        try:
            name = instance.get_next_hop_if_name(bytes(dest_hash))
            if name:
                return str(name)
        except Exception:
            pass
    try:
        iface = RNS.Transport.next_hop_interface(bytes(dest_hash))
    except Exception:
        return None
    if iface is None:
        return None
    try:
        return str(iface)
    except Exception:
        return None


def _announce_admitted(hops: int | None, interface_name: str | None) -> bool:
    """Decide whether an announce is in scope for this ingestor (SPEC RN4).

    Two rules, in order.

    **A 0-hop announce is always admitted.**  ``RNS.Transport.inbound`` adds a
    hop to every inbound packet and takes it back again for a local-client or
    shared-instance interface, so zero hops can only mean "announced by an app
    on this machine" — the operator's own nodes.  Scoping to a radio must never
    hide those; filtering purely on interface name did exactly that, because
    every local destination legitimately reads ``LocalInterface[rns/default]``.

    **Anything further out is scoped by interface.**  From one hop the
    receiving interface is a real one, so
    :data:`~data.mesh_ingestor.config.RETICULUM_INTERFACES` can discriminate.
    An empty allowlist — the default — admits everything.

    Parameters:
        hops: Hop count for the announce, or ``None`` when unknown.
        interface_name: Interface the announce arrived on, or ``None``.

    Returns:
        ``True`` when the announce may be ingested.
    """
    if hops == 0:
        return True
    allowlist = config.RETICULUM_INTERFACES
    if not allowlist:
        return True
    if not interface_name:
        return False
    lowered = interface_name.lower()
    return any(fragment in lowered for fragment in allowlist)


def _announce_hops(dest_hash: object) -> int | None:
    """Return the hop count to *dest_hash*, or ``None`` when unknown.

    Reads :func:`RNS.Transport.hops_to`, which reports
    ``RNS.Transport.PATHFINDER_M`` (the max-hops sentinel) when no path is
    known — that sentinel is normalised to ``None`` so ``hopsAway`` is simply
    omitted rather than stored as 128.  Resolved via the module-level ``RNS``
    name so test fakes installed with ``monkeypatch.setattr(_mod, "RNS", ...)``
    apply.

    Parameters:
        dest_hash: Destination hash ``bytes`` from the announce callback.

    Returns:
        Non-negative hop count, or ``None`` when unknown or unavailable.
    """
    if not isinstance(dest_hash, (bytes, bytearray)):
        return None
    try:
        hops = RNS.Transport.hops_to(bytes(dest_hash))
        sentinel = getattr(RNS.Transport, "PATHFINDER_M", 128)
        if not isinstance(hops, int) or hops < 0 or hops >= sentinel:
            return None
        return hops
    except Exception:
        return None


def _announce_to_node_dict(
    dest_hash: object,
    app_data: object,
    *,
    identity: object = None,
    aspect: str | None = None,
    interface: str | None = None,
    hops: int | None = None,
    last_heard: int | None = None,
) -> dict | None:
    """Convert a Reticulum announce into a ``POST /api/nodes`` node dict.

    One record per **announced destination** (SPEC RE-A5).  Each aspect carries
    its own display name and implies its own role, so a record names exactly the
    destination it came from.  The announcing identity rides along as
    ``identityHash`` — the rows for one peer are grouped by it, which is a
    separate design pass.

    Parameters:
        dest_hash: 16-byte destination hash the announce arrived for.  Keys the
            node row.
        app_data: Raw announce application data (see
            :func:`_decode_display_name`).
        identity: Announcing :class:`RNS.Identity`; supplies the real public key
            and the identity hash.
        aspect: Destination aspect this announce arrived on, e.g.
            ``lxmf.delivery``.  Maps to the role via :data:`_ASPECT_ROLES`.
        interface: Interface the announce was heard on, when known — the honest
            answer to "is this a LoRa peer" (SPEC RN4).
        hops: Hop count travelled by the announce, when known.
        last_heard: Unix seconds of announce receipt; defaults to now.

    Returns:
        Node dict for the ``POST /api/nodes`` payload, or ``None`` when
        *dest_hash* cannot be mapped to a canonical node ID.
    """
    node_id = _announce_node_id(identity, dest_hash)
    if node_id is None:
        return None
    hash_hex = _reticulum_hash_hex(dest_hash)
    display_name = _decode_display_name(app_data)
    user: dict = {
        "longName": (
            display_name if display_name else f"Reticulum {node_id[-4:].upper()}"
        ),
        "shortName": _reticulum_short_name(node_id),
        "publicKey": _identity_public_key_hex(identity),
    }
    role = _ASPECT_ROLES.get(aspect) if aspect else None
    if role:
        user["role"] = role
    node: dict = {
        "nodeId": node_id,
        "lastHeard": int(time.time()) if last_heard is None else int(last_heard),
        "protocol": "reticulum",
        "user": user,
    }
    identity_hash = _reticulum_hash_hex(getattr(identity, "hash", None))
    if identity_hash:
        node["identityHash"] = identity_hash
    # The node row can be keyed on the identity alone, so a malformed
    # destination hash no longer sinks the whole announce — but it must not
    # reach the destinations table either, where it would create a row keyed on
    # a truncated id.  Emit the mapping only when the hash is usable.
    if hash_hex is not None and len(hash_hex) >= 8:
        node["destination"] = {"id": hash_hex, "aspect": aspect, "role": role}
    if interface:
        node["interface"] = interface
    if hops is not None:
        node["hopsAway"] = hops
    return node


class _ReticulumAnnounceHandler:
    """Announce handler object registered with :func:`RNS.Transport.register_announce_handler`.

    One instance is registered per entry in :data:`_ANNOUNCE_ASPECTS`; RNS
    matches announces against :attr:`aspect_filter` and invokes
    :meth:`received_announce` on a dedicated thread for each hit.
    """

    def __init__(self, aspect: str, iface: "_ReticulumInterface") -> None:
        """Bind the handler to an *aspect* filter and its owning interface."""
        self.aspect_filter = aspect
        self._iface = iface

    def received_announce(
        self, destination_hash: object, announced_identity: object, app_data: object
    ) -> None:
        """Ingest one announce: record it locally and queue a node upsert.

        Counts the announce as a received frame (SPEC MA1) via
        :func:`~data.mesh_ingestor.handlers._mark_packet_seen`, stores the
        node dict in the interface snapshot so the daemon's periodic snapshot
        keeps re-reporting it, and queues an immediate ``POST /api/nodes``.
        Errors are logged and suppressed — a malformed announce must never
        kill the RNS callback thread or the transport.

        Parameters:
            destination_hash: 16-byte destination hash of the announcer.
            announced_identity: The announcing :class:`RNS.Identity`.  Its
                hash is the canonical identifier for the node row (SPEC RN1) —
                the destination hash is not, being a truncated hash over the
                identity and name hashes and therefore per-aspect rather than
                per-peer.  Resolved via :func:`_identity_from_announce`, which
                falls back to :func:`RNS.Identity.recall`.
            app_data: Raw announce application data (display name carrier).
        """
        try:
            hops = _announce_hops(destination_hash)
            interface_name = _announce_interface_name(destination_hash)
            if not _announce_admitted(hops, interface_name):
                config._debug_log(
                    "Skipped Reticulum announce from a non-allowlisted interface",
                    context="reticulum.announce",
                    aspect=self.aspect_filter,
                    hops=hops,
                    interface=interface_name,
                    allowlist=list(config.RETICULUM_INTERFACES),
                )
                return
            handlers._mark_packet_seen()
            identity = _identity_from_announce(announced_identity, destination_hash)
            # One row per *identity* (SPEC RE7, restoring RN1): a peer announcing
            # lxmf.delivery, lxmf.propagation and nomadnetwork.node is one node
            # with three destinations, not three nodes. The per-aspect names and
            # roles live in the destinations table (RE2), which is what made the
            # per-destination row split unnecessary.
            node_id = _announce_node_id(identity, destination_hash)
            if node_id is None:
                config._debug_log(
                    "Skipped Reticulum announce with an unusable destination hash",
                    context="reticulum.announce",
                    severity="warn",
                    aspect=self.aspect_filter,
                )
                return
            node = _announce_to_node_dict(
                destination_hash,
                app_data,
                identity=identity,
                aspect=self.aspect_filter,
                interface=interface_name,
                hops=hops,
            )
            self._iface._update_node(node_id, node)
            handlers.upsert_node(node_id, node)
            config._debug_log(
                "Reticulum announce ingested",
                context="reticulum.announce",
                aspect=self.aspect_filter,
                node_id=node_id,
                interface=interface_name,
                role=node["user"].get("role"),
                long_name=node["user"]["longName"],
            )
        except Exception as exc:
            config._debug_log(
                "Failed to ingest Reticulum announce",
                context="reticulum.announce",
                severity="warn",
                aspect=self.aspect_filter,
                error_class=exc.__class__.__name__,
                error_message=str(exc),
            )


class _ReticulumInterface:
    """Minimal interface object for the Reticulum announce listener.

    Supplies the surface the daemon loop expects — an ``isConnected`` flag, a
    thread-safe node snapshot, and a ``close()`` method — around the RNS
    shared-instance handle and the registered announce handlers.
    """

    host_node_id: str | None = None
    """Always ``None``: Reticulum has no handshake revealing "our" node id.

    :meth:`ReticulumProvider.extract_host_node_id` answers instead, from
    :envvar:`INGESTOR_NODE_ID` or the discovered primary identity (SPEC RE8).
    """

    def __init__(self, *, target: str | None) -> None:
        """Initialise an unconnected interface bound to *target*."""
        self._target = target
        self._rns: object | None = None
        self._announce_handlers: list[_ReticulumAnnounceHandler] = []
        self._nodes_lock = threading.Lock()
        self._nodes: dict[str, dict] = {}
        self.isConnected: bool = False

    def _update_node(self, node_id: str | None, node: dict) -> None:
        """Thread-safely record *node* in the local snapshot.

        Parameters:
            node_id: Canonical ``!xxxxxxxx`` node ID; ignored when falsy.
            node: Node dict built by :func:`_announce_to_node_dict`.
        """
        if not node_id:
            return
        with self._nodes_lock:
            self._nodes[node_id] = node

    def nodes_snapshot(self) -> list[tuple[str, dict]]:
        """Return a thread-safe snapshot of every announce heard this session.

        Returns:
            List of ``(canonical_node_id, node_dict)`` pairs.
        """
        with self._nodes_lock:
            return list(self._nodes.items())

    def close(self) -> None:
        """Deregister the announce handlers; safe to call multiple times.

        The RNS transport itself is deliberately left running: Reticulum is a
        process-wide singleton without a supported teardown, and a subsequent
        :meth:`ReticulumProvider.connect` re-attaches to it.  Deregistration
        errors are swallowed so shutdown stays best-effort.
        """
        self.isConnected = False
        handlers_to_remove, self._announce_handlers = self._announce_handlers, []
        for handler in handlers_to_remove:
            try:
                RNS.Transport.deregister_announce_handler(handler)
            except Exception:
                pass


def _local_path_entries() -> list[dict]:
    """Return the running stack's 0-hop path-table entries.

    ``get_path_table`` RPCs to ``rnsd`` on a shared instance, so this is the
    stack's own view rather than this process's, and 0 hops means "announced by
    an app on this machine" (SPEC RE4).

    Returns:
        List of path-table entry mappings; empty when the stack cannot be asked.
    """
    try:
        instance = RNS.Reticulum.get_instance()
    except Exception:
        return []
    if instance is None:
        return []
    try:
        entries = instance.get_path_table(max_hops=0)
    except Exception:
        return []
    if not isinstance(entries, (list, tuple)):
        return []
    return [entry for entry in entries if isinstance(entry, dict)]


def _transport_identity_hash() -> str | None:
    """Return the hex hash of this config dir's persisted transport identity.

    Returns:
        Lowercase hex identity hash, or ``None`` when it cannot be read.
    """
    try:
        identity = RNS.Transport.internal_identity()
    except Exception:
        return None
    return _reticulum_hash_hex(getattr(identity, "hash", None))


def _local_identity_destinations() -> dict[str, set[str]]:
    """Group local (0-hop) destinations by the identity that owns them.

    The transport identity is **excluded**: it fronts no destinations and is a
    separate identity, so counting it would distort the "most destinations"
    rule that picks the host's primary identity (SPEC RE8).

    Returns:
        Mapping of identity hash hex to the set of its 0-hop destination hashes.
    """
    transport = _transport_identity_hash()
    groups: dict[str, set[str]] = {}
    for entry in _local_path_entries():
        dest = entry.get("hash")
        if not isinstance(dest, (bytes, bytearray)):
            continue
        try:
            identity = RNS.Identity.recall(bytes(dest))
        except Exception:
            continue
        identity_hash = _reticulum_hash_hex(getattr(identity, "hash", None))
        if identity_hash is None or identity_hash == transport:
            continue
        dest_hex = _reticulum_hash_hex(dest)
        if dest_hex is None:
            continue
        groups.setdefault(identity_hash, set()).add(dest_hex)
    return groups


def _primary_local_identity() -> str | None:
    """Pick the host's primary identity: the one fronting the most destinations.

    A tie is not resolved by guessing — the id would then depend on path-table
    ordering and could change between restarts — so an ambiguous host must set
    :envvar:`INGESTOR_NODE_ID` (SPEC RE8).

    Returns:
        Identity hash hex, or ``None`` when none can be chosen.
    """
    groups = _local_identity_destinations()
    if not groups:
        return None
    ranked = sorted(groups.items(), key=lambda item: (-len(item[1]), item[0]))
    if len(ranked) > 1 and len(ranked[0][1]) == len(ranked[1][1]):
        return None
    return ranked[0][0]


def _aspect_destination_hex(identity_hash: str, aspect: str) -> str | None:
    """Compute the destination hash an identity would announce for *aspect*.

    A destination hash is one-way, so an aspect cannot be read back from a
    path-table entry.  It can be *recomputed*: ``RNS.Destination.hash`` accepts
    a raw 16-byte identity hash, so each known aspect is hashed and matched
    against the local destinations to label them.

    Parameters:
        identity_hash: Owning identity hash as hex.
        aspect: Dotted aspect name, e.g. ``lxmf.delivery``.

    Returns:
        Destination hash hex, or ``None`` when it cannot be computed.
    """
    app_name, _, rest = aspect.partition(".")
    if not app_name or not rest:
        return None
    try:
        return RNS.Destination.hash(
            bytes.fromhex(identity_hash), app_name, *rest.split(".")
        ).hex()
    except Exception:
        return None


def _host_destination_nodes(identity_hash: str) -> list[dict]:
    """Build node records for every local destination of the host's identity.

    One record per aspect the host actually announces, plus the transport
    instance when the stack has transport enabled — all keyed on the **same**
    node id, because they are aspects of one identity (SPEC RE7/RE8).

    Parameters:
        identity_hash: The host's primary identity hash, as hex.

    Returns:
        Node dicts ready for ``POST /api/nodes``; empty when none apply.
    """
    node_id = _reticulum_node_id(identity_hash)
    if node_id is None:
        return []
    local = _local_identity_destinations().get(identity_hash, set())
    now = int(time.time())
    records: list[dict] = []
    for aspect in _ANNOUNCE_ASPECTS:
        dest_hex = _aspect_destination_hex(identity_hash, aspect)
        if dest_hex is None or dest_hex not in local:
            continue
        records.append(
            {
                "nodeId": node_id,
                "lastHeard": now,
                "protocol": "reticulum",
                "identityHash": identity_hash,
                "destination": {
                    "id": dest_hex,
                    "aspect": aspect,
                    "role": _ASPECT_ROLES.get(aspect),
                },
                "user": {
                    "shortName": _reticulum_short_name(node_id),
                    "longName": f"Reticulum {node_id[-4:].upper()}",
                    "role": _ASPECT_ROLES.get(aspect),
                },
            }
        )
    transport = _transport_identity_hash()
    if transport and _transport_enabled():
        records.append(
            {
                "nodeId": node_id,
                "lastHeard": now,
                "protocol": "reticulum",
                "identityHash": identity_hash,
                "destination": {
                    "id": transport,
                    "aspect": _TRANSPORT_ASPECT,
                    "role": "TRANSPORT",
                },
                "user": {
                    "shortName": _reticulum_short_name(node_id),
                    "longName": f"Reticulum {node_id[-4:].upper()}",
                    "role": "TRANSPORT",
                },
            }
        )
    return records


def _transport_enabled() -> bool:
    """Report whether the running stack relays other nodes' traffic.

    Gates the ``TRANSPORT`` role: the transport identity exists on every stack,
    but only a transport-enabled one actually relays, so reporting the role
    unconditionally would assert something false (SPEC RE8).

    Returns:
        ``True`` when RNS reports transport enabled.
    """
    try:
        return bool(RNS.Reticulum.transport_enabled())
    except Exception:
        return False


class ReticulumProvider:
    """Reticulum announce-listener ``MeshProtocol`` implementation."""

    name = "reticulum"

    def subscribe(self) -> list[str]:
        """Return subscribed topic names.

        Reticulum announce handlers are registered per-connection in
        :meth:`connect` (RNS has no pubsub bus to subscribe at startup), so
        there are no topics to report.

        Returns:
            An empty list, always.
        """
        return []

    def connect(
        self, *, active_candidate: str | None
    ) -> tuple[object, str | None, str | None]:
        """Attach to the Reticulum stack and register announce handlers.

        Joins the already-running :class:`RNS.Reticulum` instance when one
        exists in this process (RNS is a singleton without teardown, so the
        daemon's reconnect path re-attaches rather than re-initialising),
        otherwise starts one from
        :data:`~data.mesh_ingestor.config.RETICULUM_CONFIG_DIR` — an app-owned
        directory, never the operator's ``~/.reticulum`` (#888).  One announce
        handler is registered per :data:`_ANNOUNCE_ASPECTS` entry.

        Parameters:
            active_candidate: Ignored (there is no serial/BLE candidate
                concept for an RNS listener); passed through unchanged as the
                next active candidate to satisfy the
                :class:`~data.mesh_ingestor.mesh_protocol.MeshProtocol`
                contract.

        Returns:
            ``(iface, resolved_target, next_active_candidate)`` where the
            resolved target is a ``reticulum://<configdir>`` description.
        """
        configdir = config.RETICULUM_CONFIG_DIR
        target = f"reticulum://{configdir}"
        config._debug_log(
            "Attaching to Reticulum stack",
            context="reticulum.connect",
            target=target,
        )

        # CONNECTION names one serial/TCP/BLE endpoint, which an RNS stack of
        # many interfaces does not have; the config dir and the interface
        # allowlist cover the same ground for Reticulum (SPEC RN10).  Said out
        # loud rather than passed over in silence because the shipped image
        # sets a serial default for every protocol, so an operator switching to
        # PROTOCOL=reticulum inherits one they never chose.
        if config.CONNECTION:
            config._debug_log(
                "CONNECTION is set but does not apply to PROTOCOL=reticulum; "
                "use RETICULUM_CONFIG_DIR for which RNS stack and "
                "RETICULUM_INTERFACES for which of its interfaces to ingest",
                context="reticulum.connect",
                severity="info",
                connection=config.CONNECTION,
            )

        iface = _ReticulumInterface(target=target)
        rns_instance = RNS.Reticulum.get_instance()
        if rns_instance is None:
            rns_instance = RNS.Reticulum(configdir=configdir)
        iface._rns = rns_instance

        for aspect in _ANNOUNCE_ASPECTS:
            handler = _ReticulumAnnounceHandler(aspect, iface)
            RNS.Transport.register_announce_handler(handler)
            iface._announce_handlers.append(handler)

        iface.isConnected = True
        config._debug_log(
            "Reticulum announce listener registered",
            context="reticulum.connect",
            severity="info",
            aspects=list(_ANNOUNCE_ASPECTS),
            interfaces=list(config.RETICULUM_INTERFACES) or "all",
            node_id=iface.host_node_id,
        )
        return iface, target, active_candidate

    def extract_host_node_id(self, iface: object) -> str | None:
        """Return the ingestor's own canonical node id.

        The operator's :data:`~data.mesh_ingestor.config.INGESTOR_NODE_ID` when
        set — canonicalised the Reticulum way, since a raw identity hash sent
        through the shared ``canonical_node_id`` truncates from the wrong end
        (SPEC RE5) — otherwise the id derived from the host's discovered
        primary identity (SPEC RE8).  *iface* is unused: there is no handshake
        to read.

        Parameters:
            iface: Active :class:`_ReticulumInterface` instance, or any object
                for the fallback path.

        Returns:
            Canonical ``!xxxxxxxx`` node id, or ``None`` when none was
            resolved.
        """
        return (
            self._canonical_host_node_id(config.INGESTOR_NODE_ID)
            or self._derived_host_node_id()
        )

    def host_destination_nodes(self) -> list[dict]:
        """Return node records for the host's own local destinations.

        Called by :meth:`node_snapshot_items` so the host's aspects are
        (re)reported on every snapshot — an hourly-or-better refresh that picks
        up an aspect the operator started announcing after the ingestor did,
        without a restart (SPEC RE8).

        Returns:
            Node dicts for the host's aspects, or empty when the host's
            identity is not resolvable.
        """
        identity_hash = self._host_identity_hash()
        if identity_hash is None:
            return []
        return _host_destination_nodes(identity_hash)

    @staticmethod
    def _host_identity_hash() -> str | None:
        """Resolve the host's primary identity hash.

        An explicit :envvar:`INGESTOR_NODE_ID` names a *node id*, not a full
        identity hash, so it cannot be expanded back into one; discovery is the
        only source of the full hash.

        Returns:
            Identity hash hex, or ``None`` when it cannot be determined.
        """
        return _primary_local_identity()

    @staticmethod
    def _canonical_host_node_id(value: object) -> str | None:
        """Canonicalise an operator-supplied host node id the Reticulum way.

        A raw 32-hex identity hash maps through :func:`_reticulum_node_id`
        (first four bytes), **not** through the shared ``canonical_node_id``,
        which parses hex as an integer and keeps the low 32 bits — right for a
        Meshtastic node num, wrong here, and truncating from the opposite end.
        In the field that registered the ingestor as ``!86c39940`` while its own
        peer row read ``!27716218``, from one identity (SPEC RE-A1).

        Parameters:
            value: :envvar:`INGESTOR_NODE_ID`, canonical or raw hex.

        Returns:
            Canonical ``!xxxxxxxx`` id, or ``None`` when unset or unusable.
        """
        text = str(value).strip() if value else ""
        if not text:
            return None
        if text.startswith("!"):
            return text.lower()
        return _reticulum_node_id(text)

    @staticmethod
    def _derived_host_node_id() -> str | None:
        """Derive the host node id from its **primary identity** (SPEC RE8).

        The identity is the node; its destinations are aspects of it (RE7).
        The *transport* identity is deliberately not used: RNS generates it as
        an independent keypair, so keying the host on it names the ingestor
        something matching none of the operator's announced destinations —
        which is precisely what registered ``!fbf8e338`` on a host whose
        primary identity was ``27716218…`` in the field.

        Returns ``None`` when no primary identity can be chosen (nothing local
        heard yet, or an unresolved tie); the daemon retries on its next loop
        rather than treating that as fatal.

        Returns:
            Canonical ``!xxxxxxxx`` id, or ``None`` when none can be derived.
        """
        return _reticulum_node_id(_primary_local_identity())

    def node_snapshot_items(self, iface: object) -> list[tuple[str, dict]]:
        """Return every announce heard this session as node entries.

        Parameters:
            iface: Active :class:`_ReticulumInterface` instance.  Any other
                object type causes an empty list to be returned.

        Returns:
            List of ``(canonical_node_id, node_dict)`` pairs suitable for
            :func:`~data.mesh_ingestor.handlers.upsert_node`.
        """
        if not isinstance(iface, _ReticulumInterface):
            return []
        items = iface.nodes_snapshot()
        # The host's own aspects are not learned from announces — nothing
        # relays our own announce back to us — so they are folded in here, on
        # every snapshot, which doubles as the periodic refresh (SPEC RE8).
        seen_destinations = {
            node.get("destination", {}).get("id")
            for _nid, node in items
            if isinstance(node, dict)
        }
        for node in self.host_destination_nodes():
            if node["destination"]["id"] in seen_destinations:
                continue
            items.append((node["nodeId"], node))
        return items


__all__ = [
    "ReticulumProvider",
    "_ANNOUNCE_ASPECTS",
    "_ASPECT_ROLES",
    "_ReticulumAnnounceHandler",
    "_ReticulumInterface",
    "_announce_hops",
    "_announce_interface_name",
    "_announce_to_node_dict",
    "_decode_display_name",
    "_identity_from_announce",
    "_identity_public_key_hex",
    "_announce_admitted",
    "_reticulum_hash_hex",
    "_reticulum_node_id",
    "_reticulum_short_name",
]
