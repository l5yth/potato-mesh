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
registers one announce handler per aspect in :data:`_ANNOUNCE_ASPECTS`
(``lxmf.delivery``, ``lxmf.propagation`` and ``nomadnetwork.node``).  Every
admitted announce is converted into a ``POST /api/nodes`` upsert with
``protocol="reticulum"``.  The host's own destinations are also read from the
stack's 0-hop path table, and its ``rns.transport`` destination, when the stack
has transport enabled, from the transport identity (SPEC RE8/RE9).  No LXMF
message, position or telemetry is ingested; the host's own position comes from
the RNS config (:mod:`.reticulum_position`, SPEC RP1).

Like :class:`~data.mesh_ingestor.protocols.meshtastic_udp.MeshtasticUdpProvider`
this provider is receive-only: the provider itself never transmits and has no
roster to fetch.

**Own node id.**  Reticulum has no protocol-level handshake revealing "our"
node id, so the ingestor discovers it: the 0-hop entries of the running
stack's path table are the destinations announced by apps on this machine, and
:func:`RNS.Identity.recall` maps each back to its owning identity.  The
identity fronting the most of them is the host's **primary identity**, and its
first four bytes are the node id (SPEC RE8).  Nothing is found until a local
app announces; the daemon asks again on every loop until then.  Ties are not
guessed: path-table ordering is unstable, so an ambiguous host must set
:envvar:`INGESTOR_NODE_ID`.  So must a stack on which nothing announces, such
as Docker's default ``potatomesh_reticulum`` volume.  Everywhere else the
variable is an **override**.

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
announcing identity's **real public key**, and the destination the announce
arrived on rides as ``destination`` (``{id, aspect, role}``), one
``destinations`` row per aspect (SPEC RE2).  The mapping is deterministic and
sender-side, so the same announce heard by multiple ingestors collapses onto
one node row (the CONTRACTS.md cross-ingestor dedup requirement).

**Interface scope.**  An RNS stack may carry LoRa and IP interfaces at once,
and this listener hears every announce reachable over any of them — on a LAN
with an ``AutoInterface`` that is the entire local Reticulum network.
:data:`~data.mesh_ingestor.config.RETICULUM_INTERFACES` restricts ingestion to
announces whose path was received on a matching interface.  Unset, it admits
RNode interfaces only, recognised by their RNS class (:func:`_is_rnode_interface`);
``*`` admits every interface.

**Transmit policy (SPEC MA7).**  This provider is receive-only: it never sends
an announce, a message, or a poll, so it has no transmit site to gate.  Note
that the underlying RNS stack is *not* silent at the interface layer — an
``AutoInterface`` multicasts peer discovery, and a config with
``enable_transport`` set relays other nodes' traffic.  That is interface-level
behaviour owned by the Reticulum config, which the ingestor shares with the
operator's ``rnsd`` (``~/.reticulum`` by default, SPEC RE3; see
:func:`~data.mesh_ingestor.config._resolve_reticulum_config_dir`).  With no
shared instance running, :meth:`ReticulumProvider.connect` starts the stack in
this process, which then transmits whatever that config enables (SPEC RN5).

**Display names.**  ``lxmf.delivery`` announces carry the peer's display name
in ``app_data`` — either raw UTF-8 bytes (pre-0.5 LXMF) or a msgpack array
whose first element is the display name (LXMF >= 0.5, which appends the stamp
cost).  ``nomadnetwork.node`` announces carry the node name as raw UTF-8.
Undecodable ``app_data`` falls back to ``"Reticulum <SHORT>"`` — the protocol
label plus the upper-cased first four hex of the destination's own hash, or of
the node id when that hash is unusable (SPEC RA10).  It names the
*destination*, not the node: the web tier picks the node's headline (SPEC RE10).
"""

from __future__ import annotations

import math
import threading
import time

import RNS
from RNS.vendor import umsgpack

from .. import config, handlers
from . import reticulum_interfaces, reticulum_position

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


def _reticulum_placeholder_name(node_id: str | None) -> str:
    """Generic display name for a Reticulum row that announced none.

    Built from the **first** four hex digits — the head of the hash, which is
    what the badge shows and what identifies the row to a reader. The tail was
    used previously, so ``!27716218`` badged ``2771`` while its name read
    ``Reticulum 6218``.

    Must stay in lockstep with the web tier's ``placeholder_short_id``: that is
    what recognises a placeholder so a real name is never overwritten by one.

    Parameters:
        node_id: Canonical ``!xxxxxxxx`` id of the row being named.

    Returns:
        ``Reticulum XXXX``.
    """
    return f"Reticulum {_reticulum_short_name(node_id).upper()}"


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


def _running_instance() -> object | None:
    """Return the running :class:`RNS.Reticulum` for the interface-class map.

    Resolved via the module-level ``RNS`` name at call time, so test fakes
    installed with ``monkeypatch.setattr(_mod, "RNS", ...)`` apply.

    Returns:
        The instance, or ``None`` when no stack runs.
    """
    return RNS.Reticulum.get_instance()


_INTERFACE_CLASSES = reticulum_interfaces.InterfaceClassCache(_running_instance)
"""Interface classes of the running stack, read for the RNode default (RN4)."""


def _is_rnode_interface(interface_name: str) -> bool:
    """Report whether an interface drives an RNode radio (SPEC RN4, amended).

    The class decides, read from ``get_interface_stats()``: a multi-radio
    RNode receives on sub-interfaces printed as ``<parent>[<sub>]``, with no
    "rnode" in the name.  When the stack cannot say (no stats, a failed read,
    or a name it does not list) the name decides instead, since a single-radio
    RNode prints as ``RNodeInterface[...]``.

    Parameters:
        interface_name: Interface an announce arrived on.

    Returns:
        ``True`` for an ``RNodeInterface``, ``RNodeMultiInterface`` or
        ``RNodeSubInterface``.
    """
    kind = _INTERFACE_CLASSES.class_of(interface_name)
    if kind is None:
        return "rnode" in interface_name.lower()
    return kind in reticulum_interfaces.RNODE_INTERFACE_CLASSES


def _interface_scope() -> str | list[str]:
    """Describe the active interface scope for the logs (SPEC RN4).

    Returns:
        ``"rnode"`` for the default, ``"*"`` for every interface, or the
        allowlist's fragments.
    """
    allowlist = config.RETICULUM_INTERFACES
    if not allowlist:
        return "rnode"
    if config.RETICULUM_ALL_INTERFACES in allowlist:
        return config.RETICULUM_ALL_INTERFACES
    return list(allowlist)


def _check_rnode_scope() -> None:
    """Warn once per connect when the RNode default can only ingest 0 hops.

    Runs for the default scope only: a list or ``*`` is the operator's own
    choice.  A stack listing no RNode keeps this machine's announces alone,
    and the scope never widens to every interface by itself.  A stack that
    rejects the stats RPC (a shared instance authenticates it with the config
    dir's identity, SPEC RE3) rejects the name lookup as well, so every
    announce reads ``LocalInterface[...]`` and is dropped.  A stack without
    stats at all stays silent, because names then decide.
    """
    if config.RETICULUM_INTERFACES:
        return
    try:
        classes = _INTERFACE_CLASSES.read()
    except Exception as exc:
        config._debug_log(
            "Cannot read this RNS stack's interfaces, so announces from beyond "
            "this machine read LocalInterface and are dropped; point "
            "RETICULUM_CONFIG_DIR at the config dir rnsd uses, or set "
            "RETICULUM_INTERFACES=*",
            context="reticulum.connect",
            severity="warn",
            error_class=exc.__class__.__name__,
            error_message=str(exc),
        )
        return
    if classes is None:
        return
    if not reticulum_interfaces.RNODE_INTERFACE_CLASSES & set(classes.values()):
        config._debug_log(
            "No RNode interface on this RNS stack; add one or set "
            "RETICULUM_INTERFACES=*",
            context="reticulum.connect",
            severity="warn",
            # Classes, not names: a spawned interface's name can carry a
            # peer's address (a TCP server's clients, AutoInterface peers).
            interface_classes=sorted(set(classes.values())),
        )


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
    ``*`` admits every interface.  An unknown interface is rejected.  The
    default, an empty allowlist, admits an RNode interface only
    (:func:`_is_rnode_interface`); any other allowlist admits a name that
    contains one of its fragments.

    Parameters:
        hops: Hop count for the announce, or ``None`` when unknown.
        interface_name: Interface the announce arrived on, or ``None``.

    Returns:
        ``True`` when the announce may be ingested.
    """
    if hops == 0:
        return True
    allowlist = config.RETICULUM_INTERFACES
    if config.RETICULUM_ALL_INTERFACES in allowlist:
        return True
    if not interface_name:
        return False
    if not allowlist:
        return _is_rnode_interface(interface_name)
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

    One record per announce, keyed on the announcing **identity** (SPEC RE7):
    every aspect of a peer posts to the same node id.  The destination it
    arrived on rides as ``destination`` (``{id, aspect, role}``), which the web
    tier writes to the ``destinations`` table (SPEC RE2), and the full identity
    hash as ``identityHash``.

    Parameters:
        dest_hash: 16-byte destination hash the announce arrived for.  Becomes
            ``destination.id``; keys the node row only when no identity
            resolves.
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
        Node dict for the ``POST /api/nodes`` payload, or ``None`` when neither
        the identity nor *dest_hash* maps to a canonical node ID.
    """
    node_id = _announce_node_id(identity, dest_hash)
    if node_id is None:
        return None
    hash_hex = _reticulum_hash_hex(dest_hash)
    display_name = _decode_display_name(app_data)
    # The web stores this name on the destination row, so a placeholder is
    # built from the destination's own hash, as host discovery builds one
    # (SPEC RA10(b)). The node id stands in only for an unusable hash, which
    # writes no destination row; the node's headline comes from RE10.
    placeholder_id = _reticulum_node_id(dest_hash) or node_id
    user: dict = {
        "longName": (
            display_name
            if display_name
            else _reticulum_placeholder_name(placeholder_id)
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
    # Radio metadata rides on the node record (SPEC RL3). The web upsert already
    # reads these keys; a Reticulum node never received them because the other
    # protocols stamp them from position and telemetry payloads, and an announce
    # carries neither -- so the table's Frequency and LoRa Preset columns and the
    # chat/log tags all rendered blanks.
    #
    # After the interface is known: the values describe the host's LoRa radio
    # only, so a peer heard over an IP interface must not be stamped with them.
    # The posted record is stamped anyway: handlers.upsert_node applies the
    # configured values to every node (ACCEPTANCE Known gap RL-A3).
    _attach_radio_metadata(node)
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
        node dict in the interface snapshot, which the daemon's node snapshot
        reads once per connection, and queues an immediate ``POST /api/nodes``.
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
                    allowlist=_interface_scope(),
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
        # Read from the RNS config at connect (SPEC RP1); None publishes none.
        self.host_position: reticulum_position.HostPosition | None = None
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


_MESHTASTIC_PRESETS: dict[tuple[int, int, int], str] = {
    # (bandwidth kHz, spreading factor, coding-rate denominator) -> preset name.
    #
    # Hand-maintained (SPEC RL2): the Meshtastic Python package defines the
    # preset *enum* but not its radio parameters, which live in firmware, so
    # nothing in the dependency tree can verify this table.  Values are the
    # region-independent modem settings each preset selects.  A mismatch with
    # upstream firmware is a bug in this table, not in the test that pins it.
    (250, 7, 5): "ShortFast",
    (250, 8, 5): "ShortSlow",
    (250, 9, 5): "MediumFast",
    (250, 10, 5): "MediumSlow",
    (250, 11, 5): "LongFast",
    (125, 12, 8): "LongSlow",
    (125, 11, 8): "LongModerate",
    (500, 7, 5): "ShortTurbo",
}
"""Meshtastic modem presets keyed on their (BW kHz, SF, CR) triple.

**Deliberately partial.** The firmware enum carries fourteen presets
(``meshtastic.protobuf.config_pb2``); this table holds the eight whose radio
parameters could be stated with confidence.  Everything else -- ``LongTurbo``,
the ``Lite*`` and ``Narrow*`` families, and ``VeryLongSlow`` (whose 62.5 kHz
bandwidth does not key cleanly on integer kHz) -- falls through to the
``SF/BW/CR`` form, which is never *wrong*, only less friendly.  Adding a row
whose parameters cannot be verified would be worse than the fallback: it would
put a confident wrong name on a radio.
"""


def _reticulum_preset_label(
    bandwidth_khz: object, sf: object, cr: object
) -> str | None:
    """Name a radio configuration, preferring a Meshtastic preset (SPEC RL2).

    An **exact** parameter match yields that preset's name; anything else falls
    back to ``SF{sf}/BW{bw}/CR{cr}``, the format
    :func:`~data.mesh_ingestor.interfaces.radio._custom_preset_label` already
    produces, so no second radio-parameter format enters the codebase.

    The name is a label, **not** an interoperability claim: a Reticulum radio on
    ``LongFast`` parameters cannot talk to a Meshtastic ``LongFast`` mesh.

    Parameters:
        bandwidth_khz: Bandwidth in kHz.
        sf: Spreading factor.
        cr: Coding-rate denominator.

    Returns:
        Preset name, ``SF/BW/CR`` string, or ``None`` when a value is missing.
    """
    try:
        bw_i, sf_i, cr_i = int(bandwidth_khz), int(sf), int(cr)
    except (TypeError, ValueError):
        return None
    if not (bw_i and sf_i and cr_i):
        return None
    preset = _MESHTASTIC_PRESETS.get((bw_i, sf_i, cr_i))
    if preset:
        return preset
    return f"SF{sf_i}/BW{bw_i}/CR{cr_i}"


def _parse_rnode_radio_config(text: str) -> dict | None:
    """Extract radio parameters from the first ``RNodeInterface`` in *text*.

    The block is found by :func:`.reticulum_position.rnode_block_entries`, the
    reader the host position uses too (SPEC RP1), asked for the ``frequency`` /
    ``bandwidth`` / ``spreadingfactor`` / ``codingrate`` keys.  **Only those
    four keys are read** — the file also holds the shared-instance RPC key,
    which must never be logged or carried anywhere (SPEC RL1).

    RNS stores both frequencies in **Hz** (its own annotated example reads
    ``frequency = 867200000`` for 867.2 MHz and ``bandwidth = 125000`` for
    125 kHz), so they are converted to MHz and kHz here.

    Parameters:
        text: Contents of the RNS config file.

    Returns:
        ``{"frequency_mhz", "bandwidth_khz", "sf", "cr"}`` for the first
        RNodeInterface found, or ``None`` when there is none.
    """
    entries = reticulum_position.rnode_block_entries(
        text, frozenset({"frequency", "bandwidth", "spreadingfactor", "codingrate"})
    )
    if entries is None:
        return None
    best: dict = {}
    for key, value in entries:
        try:
            best[key] = int(value)
        except ValueError:
            continue
    frequency = best.get("frequency")
    bandwidth = best.get("bandwidth")
    return {
        # Integer MHz, floored. `nodes.lora_freq` and `ingestors.lora_freq` are
        # INTEGER columns and the field orients a reader in a band (433 vs 868)
        # rather than stating an exact frequency -- MeshCore's 869.525 is
        # likewise stored as 869. A float here was silently truncated on write.
        "frequency_mhz": int(frequency // 1_000_000) if frequency else None,
        "bandwidth_khz": int(bandwidth / 1000) if bandwidth else None,
        "sf": best.get("spreadingfactor"),
        "cr": best.get("codingrate"),
    }


def _coerce_band_mhz(value: object) -> int | None:
    """Coerce an operator-supplied frequency to floored integer MHz.

    Accepts a bare number or one carrying a unit suffix (``867.2MHz``), because
    that is the form the other frequency settings are written in and the form
    documented for this one.  Both floor to the same band: the column is
    ``INTEGER`` and a non-integer value was silently stored as ``NULL``, so the
    documented override did nothing at all.

    Parameters:
        value: Raw :envvar:`RETICULUM_FREQ` value.

    Returns:
        Integer MHz, or ``None`` when nothing usable was supplied.
    """
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    for suffix in ("mhz", "m"):
        if text.endswith(suffix):
            text = text[: -len(suffix)].strip()
            break
    try:
        parsed = float(text)
    except ValueError:
        return None
    if not math.isfinite(parsed) or parsed <= 0:
        return None
    return int(parsed)


def _read_reticulum_radio_metadata() -> tuple[object, str | None]:
    """Resolve the Reticulum frequency and preset label (SPEC RL1).

    Precedence: :envvar:`RETICULUM_FREQ` / :envvar:`RETICULUM_PRESET`, then the
    shared RNS config, then ``None`` — mirroring how :envvar:`FREQUENCY`
    overrides the auto-detected :data:`~data.mesh_ingestor.config.LORA_FREQ`.

    The config *file* is the only source available: ``get_interface_stats``
    carries no radio parameters at all, and a shared-instance client's own
    ``Transport.interfaces`` holds only its local-client interface.  It is
    therefore a snapshot, and goes stale if ``rnsd`` is reconfigured without
    restarting the ingestor (the RA12 caveat, with no RPC alternative).

    Returns:
        ``(frequency, preset)``, either of which may be ``None``.
    """
    frequency: object = _coerce_band_mhz(config.RETICULUM_FREQ)
    preset: str | None = config.RETICULUM_PRESET
    if frequency is not None and preset is not None:
        return frequency, preset
    # Absent or unreadable config: every downstream field keeps its dash
    # rather than inventing a number.
    text = reticulum_position.rns_config_text(config.RETICULUM_CONFIG_DIR)
    parsed = None if text is None else _parse_rnode_radio_config(text)
    if parsed:
        if frequency is None:
            frequency = parsed["frequency_mhz"]
        if preset is None:
            preset = _reticulum_preset_label(
                parsed["bandwidth_khz"], parsed["sf"], parsed["cr"]
            )
    return frequency, preset


def _is_lora_interface(interface: object) -> bool:
    """Report whether an interface name denotes the host's own LoRa radio.

    The resolved frequency and preset describe **one** interface -- the
    ``RNodeInterface`` they were parsed from.  A peer heard over
    ``AutoInterface``, ``TCPInterface`` or ``LocalInterface`` reached us with no
    LoRa involved, so attributing the operator's radio settings to it would
    publish (and federate) a claim about that peer that is simply untrue.

    The test is the RNode default scope's (:func:`_is_rnode_interface`): by
    class where the stack reports it, so a multi-radio RNode's sub-interface
    counts although its name carries no "rnode", and by name otherwise.  It
    tags the record this provider builds; ``handlers.upsert_node`` currently
    stamps the configured values on every posted record whatever the
    interface (a known gap outside this provider).

    Parameters:
        interface: Interface string an announce arrived on, if known.

    Returns:
        ``True`` only for an RNode interface.
    """
    return isinstance(interface, str) and _is_rnode_interface(interface)


def _attach_radio_metadata(node: dict) -> None:
    """Stamp the resolved LoRa frequency and preset onto a node record.

    The other protocols reach ``nodes.lora_freq`` / ``nodes.modem_preset``
    through their position and telemetry payloads; a Reticulum announce carries
    neither, so without this the values the ingestor resolved (SPEC RL1/RL2)
    never left the heartbeat and every per-node radio field stayed blank.

    Applied **only** to a record that arrived over the host's LoRa radio: these
    values describe that one interface, and an RNS stack routinely carries IP
    interfaces alongside it.  A record with no interface at all is the host's
    own (its destinations are discovered, not heard), so it keeps them.

    Mutates *node* in place, omitting either key that is unresolved so an absent
    value keeps its dash rather than being written as null.

    Parameters:
        node: Node dict destined for ``POST /api/nodes``.
    """
    interface = node.get("interface")
    if interface is not None and not _is_lora_interface(interface):
        return
    frequency = getattr(config, "LORA_FREQ", None)
    preset = getattr(config, "MODEM_PRESET", None)
    if frequency is not None:
        node["lora_freq"] = frequency
    if preset is not None:
        node["modem_preset"] = preset


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


def _local_identity_destinations() -> dict[str, dict[str, str | None]]:
    """Group local (0-hop) destinations by the identity that owns them.

    The transport identity is **excluded**: it fronts no destinations and is a
    separate identity, so counting it would distort the "most destinations"
    rule that picks the host's primary identity (SPEC RE8).

    Returns:
        Mapping of identity hash hex to ``{destination hex: interface name}``.
        The interface is the path-table entry's own, so a discovered host
        destination records where it lives exactly like an announced one does.
    """
    transport = _transport_identity_hash()
    groups: dict[str, dict[str, str | None]] = {}
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
        # dest is already bytes here, and _reticulum_hash_hex always returns
        # hex for bytes -- so no None guard, which would be unreachable.
        dest_hex = _reticulum_hash_hex(dest)
        interface = entry.get("interface")
        groups.setdefault(identity_hash, {})[dest_hex] = (
            str(interface) if interface else None
        )
    return groups


def _recalled_display_name(dest_hex: str) -> str | None:
    """Return the display name last announced on a destination, if any.

    A discovered destination comes from the path table, not from an announce,
    so it has no ``app_data`` of its own to decode: a local app's announce
    reaches this ingestor only while both are attached, and one made before
    connect is not replayed.  The stack kept the last one it heard, which is
    what ``rnsd`` recorded when the local app announced.  Without this a
    discovered destination would carry only its ``Reticulum <SHORT>``
    placeholder, which the RE10 headline rule skips, so a name announced
    before connect would reach neither the destination nor its node
    (SPEC RE8).

    Parameters:
        dest_hex: Destination hash as hex.

    Returns:
        Decoded display name, or ``None`` when the stack has none.
    """
    try:
        app_data = RNS.Identity.recall_app_data(bytes.fromhex(dest_hex))
    except Exception:
        return None
    return _decode_display_name(app_data)


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
    local = _local_identity_destinations().get(identity_hash, {})
    now = int(time.time())

    # A destination's generic name derives from the *destination* hash, not the
    # identity's: the field showed "Reticulum 6218" (the node) on destination
    # !fee521eb, which names the wrong thing entirely.
    def _destination_placeholder(dest_hex: str) -> str:
        return _reticulum_placeholder_name(_reticulum_node_id(dest_hex))

    records: list[dict] = []
    for aspect in _ANNOUNCE_ASPECTS:
        dest_hex = _aspect_destination_hex(identity_hash, aspect)
        if dest_hex is None or dest_hex not in local:
            continue
        record = {
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
                # A real announced name always wins; the placeholder is only
                # for a destination the stack has never heard a name for.
                "longName": _recalled_display_name(dest_hex)
                or _destination_placeholder(dest_hex),
                "role": _ASPECT_ROLES.get(aspect),
            },
        }
        interface = local.get(dest_hex)
        if interface:
            record["interface"] = interface
        _attach_radio_metadata(record)
        records.append(record)
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
                    "longName": _recalled_display_name(transport)
                    or _destination_placeholder(transport),
                    "role": "TRANSPORT",
                },
            }
        )
        _attach_radio_metadata(records[-1])
    return records


def _bare_host_record(node_id: str, report_time: int) -> dict:
    """Return the host's record when no destination carries its position.

    Nothing announces on Docker's default volume (SPEC RP6), so the record has
    no ``destination``, the node's own placeholder name (RA10(a)) and the
    Reticulum base role (RA9); without a role the node API would serve
    Meshtastic's ``CLIENT``.

    Parameters:
        node_id: The registered host node id.
        report_time: Unix seconds of the report.

    Returns:
        Node dict for ``POST /api/nodes``.
    """
    short, name = _reticulum_short_name(node_id), _reticulum_placeholder_name(node_id)
    record = {"nodeId": node_id, "lastHeard": report_time, "protocol": "reticulum"}
    return {**record, "user": {"shortName": short, "longName": name, "role": "PEER"}}


def _transport_enabled() -> bool:
    """Report whether the running stack relays other nodes' traffic.

    Gates the ``TRANSPORT`` role: the transport identity exists on every stack,
    but only a transport-enabled one actually relays, so reporting the role
    unconditionally would assert something false (SPEC RE8).

    ``Reticulum.transport_enabled()`` answers "does **this process** route",
    not "does this stack route": on connecting to a shared instance RNS forces
    the client's flag to ``False`` regardless of the config file (the
    ``is_connected_to_shared_instance`` branch of ``Reticulum.__init__``).  An
    ingestor attached to ``rnsd`` therefore always read ``False`` even with
    ``enable_transport = Yes`` set.  The stack's own answer comes from
    ``get_interface_stats``, which RPCs to the shared instance and reports a
    ``transport_id`` **only** when that instance is routing.

    Returns:
        ``True`` when the running stack relays other nodes' traffic.
    """
    try:
        if RNS.Reticulum.transport_enabled():
            return True
    except Exception:
        return False
    # Not this process -- but it may be a client of a transport-enabled one.
    try:
        instance = RNS.Reticulum.get_instance()
        if instance is None:
            return False
        stats = instance.get_interface_stats()
    except Exception:
        return False
    return bool(isinstance(stats, dict) and stats.get("transport_id"))


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
        :data:`~data.mesh_ingestor.config.RETICULUM_CONFIG_DIR`, by default the
        operator's ``~/.reticulum`` (SPEC RE3).  That attaches to a running
        ``rnsd`` as a client; with none running, this process runs the stack
        itself and opens every interface the config enables.  One announce
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
        # Radio metadata (SPEC RL1): Reticulum has no equivalent of the
        # Meshtastic localConfig read, so the shared RNS config supplies the
        # frequency and preset the heartbeat and every downstream column need.
        radio_freq, radio_preset = _read_reticulum_radio_metadata()
        if radio_freq is not None and getattr(config, "LORA_FREQ", None) is None:
            config.LORA_FREQ = radio_freq
        if radio_preset is not None and getattr(config, "MODEM_PRESET", None) is None:
            config.MODEM_PRESET = radio_preset
        # The host position (SPEC RP1/RP2): read once per connect, from the
        # same RNodeInterface block as the radio metadata.
        iface.host_position = reticulum_position.read_host_position(configdir)
        # Resolve the host id for the log rather than reading
        # +iface.host_node_id+, which is a constant None: the startup line
        # printed node_id=None on every run regardless of what discovery would
        # have found, which reads as a failure rather than a pending lookup.
        host_node_id = self.extract_host_node_id(iface)
        config._debug_log(
            "Reticulum announce listener registered",
            context="reticulum.connect",
            severity="info",
            aspects=list(_ANNOUNCE_ASPECTS),
            interfaces=_interface_scope(),
            node_id=host_node_id or "pending",
        )
        _check_rnode_scope()
        if not host_node_id:
            # Say so explicitly: a fresh stack has nothing 0-hop in its path
            # table yet, the daemon retries every loop, and an operator reading
            # only the line above would otherwise think it had failed.
            config._debug_log(
                "Host node id not resolved yet; retrying until a local "
                "destination is heard. Set INGESTOR_NODE_ID to pin it if two "
                "local identities tie or nothing on this RNS stack announces "
                "(e.g. Docker's default volume).",
                context="reticulum.connect",
                severity="info",
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

        Called by :meth:`node_snapshot_items` at connect and by
        :meth:`self_node_items` on every self-node report after it (1 h), so
        the host's aspects and ``rns.transport`` stay fresh while the
        connection lasts (SPEC RE8).  An aspect whose app disconnects leaves
        the 0-hop table and is no longer reported.

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
        # The host's own aspects are folded in from the path table: a local
        # app's announce reaches us only while both are attached, one made
        # before connect is not replayed, and rns.transport never announces.
        # The daemon takes this snapshot once per connection and re-posts the
        # host hourly through self_node_items (SPEC RE8).
        seen_destinations = {
            node.get("destination", {}).get("id")
            for _nid, node in items
            if isinstance(node, dict)
        }
        for node in self.host_destination_nodes():
            if node["destination"]["id"] in seen_destinations:
                continue
            items.append((node["nodeId"], node))
        # The host's position (SPEC RP4/RP6); the report at connect posts its row.
        return reticulum_position.with_host_position(items, iface, _bare_host_record)

    def self_node_items(self, iface: object) -> list[tuple[str, dict]]:
        """Return the host's own destinations for the periodic self-node report.

        An optional, duck-typed hook, the list sibling of ``self_node_item``:
        the daemon calls it right after the node snapshot and then once per
        self-node report interval (1 h), so ``rns.transport`` and the host's
        aspects stay fresh on a connection that never recycles (SPEC RE8). The
        transport gate is re-evaluated on every call (SPEC RE9). Local reads
        only, nothing is sent (SPEC RN5): at most two path-table reads and one
        interface-stats read.

        Tied to the registered host id: records are returned only while the
        primary identity's node id is the one the daemon registered. A second
        local identity that comes to front more destinations would otherwise
        move ``rns.transport`` onto its own node row, because the web tier's
        destination upsert takes the incoming node id.

        Each report also positions the host and posts its row (SPEC RP4-RP6).

        Parameters:
            iface: The active :class:`_ReticulumInterface`, for the position
                read at connect; the records are read from the running stack.

        Returns:
            ``(node_id, node_dict)`` pairs, or an empty list while no host id
            is registered or, with no position, none maps to it.
        """
        host_id = handlers.host_node_id()
        if not host_id:
            return []
        items = [
            (node["nodeId"], node)
            for node in self.host_destination_nodes()
            if node["nodeId"] == host_id
        ]
        return reticulum_position.report_host_position(items, iface, _bare_host_record)


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
    "_is_rnode_interface",
    "_reticulum_hash_hex",
    "_reticulum_node_id",
    "_reticulum_short_name",
]
