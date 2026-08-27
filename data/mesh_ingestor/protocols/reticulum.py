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
this provider is receive-only: it never transmits, has no roster to fetch, and
has no protocol-level handshake that reveals "our" node id (the operator may
supply :envvar:`INGESTOR_NODE_ID` for the heartbeat).

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

_ANNOUNCE_ASPECTS: tuple[str, ...] = ("lxmf.delivery", "nomadnetwork.node")
"""Destination aspects whose announces are ingested as node records."""

_SHARED_INSTANCE_INTERFACE_PREFIXES: tuple[str, ...] = (
    "localinterface[",
    "shared instance[",
)
"""Interface names that mean "attached to a shared RNS instance".

``RNS.Interfaces.LocalInterface`` renders the client side as
``LocalInterface[rns/<name>]`` and the server side as
``Shared Instance[rns/<name>]``.  When the ingestor is attached to an external
``rnsd`` every announce arrives over that one socket, whatever interface
actually received it, so a per-interface allowlist cannot discriminate.
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


_allowlist_ignored_warned = False
"""Whether the fail-open warning has already been emitted this session."""


def _warn_allowlist_ignored_once(interface_name: str) -> None:
    """Warn, once, that the interface allowlist cannot be honoured.

    Emitted on the fail-open path: the ingestor is attached to a shared RNS
    instance, so every announce arrives over one socket and
    :data:`~data.mesh_ingestor.config.RETICULUM_INTERFACES` cannot discriminate.
    Ingesting everything is the safe failure, but it **widens** what the
    operator asked for, so it must not be silent — this is the upgrade path for
    a deployment whose config dir already exists and therefore was never seeded
    (see :func:`_seed_config_dir`).

    Once per process: this sits on the per-announce path.

    Parameters:
        interface_name: The shared-instance interface the announce arrived on.
    """
    global _allowlist_ignored_warned
    if _allowlist_ignored_warned:
        return
    _allowlist_ignored_warned = True
    config._debug_log(
        "RETICULUM_INTERFACES cannot be honoured on a shared Reticulum instance; "
        "ingesting every announce instead. Set share_instance = No in the "
        "ingestor's own config dir to scope it",
        context="reticulum.announce",
        severity="warn",
        interface=interface_name,
        allowlist=list(config.RETICULUM_INTERFACES),
    )


def _interface_allowed(interface_name: str | None) -> bool:
    """Test *interface_name* against :data:`config.RETICULUM_INTERFACES`.

    An empty allowlist — the default — admits every interface, preserving the
    behaviour the provider shipped with.  When an allowlist *is* configured,
    an announce whose interface cannot be determined is rejected: the operator
    asked to ingest from named interfaces only, and an unverifiable one is not
    among them.

    A shared-instance socket is the one exception and admits everything: see
    :data:`_SHARED_INSTANCE_INTERFACE_PREFIXES`.

    Parameters:
        interface_name: Interface string form, or ``None`` when unknown.

    Returns:
        ``True`` when announces from this interface may be ingested.
    """
    allowlist = config.RETICULUM_INTERFACES
    if not allowlist:
        return True
    if not interface_name:
        return False
    lowered = interface_name.lower()
    # Fail *open* on a shared-instance socket.  Every announce reaches us over
    # that one interface, so the allowlist cannot tell them apart; rejecting
    # them all would silently ingest nothing, which is the worse failure by far
    # (:func:`ReticulumProvider.connect` refuses to share precisely so this
    # path is not reached, and warns when it is).
    if lowered.startswith(_SHARED_INSTANCE_INTERFACE_PREFIXES):
        _warn_allowlist_ignored_once(interface_name)
        return True
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
    dest_hashes: "list[str] | tuple[str, ...] | None" = None,
    hops: int | None = None,
    last_heard: int | None = None,
) -> dict | None:
    """Convert a Reticulum announce into a ``POST /api/nodes`` node dict.

    The record is keyed on the announcing **identity** (see
    :func:`_reticulum_node_id`), so a peer's several destination aspects merge
    into one node row.  The destination hashes themselves are carried in the
    ``destHash`` list — a destination hash is a truncated hash over the
    identity and name hashes, not a key, and never belongs in ``publicKey``.

    Parameters:
        dest_hash: 16-byte destination hash (or hex string) the announce
            arrived for; used for the display-name fallback and as the sole
            ``destHash`` entry when *dest_hashes* is omitted.
        app_data: Raw announce application data carrying the display name
            (see :func:`_decode_display_name`).
        identity: Announcing :class:`RNS.Identity`; its hash keys the node row
            and its public key populates ``user.publicKey``.
        dest_hashes: Every destination hash known for this identity, so far.
            Defaults to just *dest_hash*.
        hops: Hop count travelled by the announce, when known.
        last_heard: Unix seconds of announce receipt; defaults to now.

    Returns:
        Node dict compatible with the ``POST /api/nodes`` payload format, or
        ``None`` when no identity hash is available to key the record.  The
        canonical node id is *not* embedded: the payload envelope is keyed by
        it (``routes/ingest.rb``), and :meth:`_ReticulumInterface.nodes_snapshot`
        carries it alongside.
    """
    node_id = _reticulum_node_id(getattr(identity, "hash", None))
    if node_id is None:
        return None
    hash_hex = _reticulum_hash_hex(dest_hash)
    hashes = sorted(
        {h for h in (dest_hashes if dest_hashes is not None else [hash_hex]) if h}
    )
    display_name = _decode_display_name(app_data)
    # Name the *node*, not whichever destination happened to announce.  The row
    # is keyed on the identity (SPEC RN1), so a per-aspect destination-hash
    # prefix names the wrong thing entirely — and the web upsert only yields to
    # a placeholder it recognises, which is the "<Label> <short id>" form its
    # +generic_fallback_name?+ builds.  A bare hex string reads as a real name
    # and overwrites the stored one.
    # Upper-case is load-bearing: the Ruby side builds the placeholder as
    # +protocol_display_label+ plus +canonical_node_parts(...)[2]+, and that
    # short id is +.upcase+d (identity.rb:129) then compared with +==+.  A
    # lower-case tail matches only when all four hex digits are decimal — about
    # 15% of ids — and every other node's stored name gets overwritten.
    fallback_name = f"Reticulum {node_id[-4:].upper()}"
    node: dict = {
        "lastHeard": int(time.time()) if last_heard is None else int(last_heard),
        "protocol": "reticulum",
        "destHash": hashes,
        "user": {
            "longName": display_name if display_name else fallback_name,
            "shortName": _reticulum_short_name(node_id),
            "publicKey": _identity_public_key_hex(identity),
        },
    }
    if hops is not None:
        node["hopsAway"] = hops
    return node


def _seed_config_dir(configdir: str) -> None:
    """Write a starter RNS config into *configdir* when none exists yet.

    Only relevant when :data:`~data.mesh_ingestor.config.RETICULUM_INTERFACES`
    is set.  RNS decides whether to attach to an external ``rnsd`` from the
    ``share_instance`` **config option**, not from ``configdir`` — the
    shared-instance socket is keyed on ``instance_name`` — so an app-owned
    config dir alone does not stop the ingestor joining the operator's stack.
    Attached, every announce arrives over one ``LocalInterface`` and the
    allowlist cannot discriminate (SPEC RN4).

    An operator-authored config is never touched: this seeds an absent file
    only, so anyone who *wants* to share can say so and keep it.

    Parameters:
        configdir: The ingestor's Reticulum config directory.
    """
    config_path = os.path.join(configdir, "config")
    if os.path.exists(config_path):
        return
    os.makedirs(configdir, exist_ok=True)
    with open(config_path, "w", encoding="utf-8") as handle:
        handle.write(_SCOPED_CONFIG_TEMPLATE)
    config._debug_log(
        "Seeded an unshared Reticulum config with no interfaces enabled; add the "
        "interfaces named in RETICULUM_INTERFACES or nothing will be ingested",
        context="reticulum.connect",
        severity="warn",
        path=config_path,
        allowlist=list(config.RETICULUM_INTERFACES),
    )


_SCOPED_CONFIG_TEMPLATE = """# Written by potato-mesh because RETICULUM_INTERFACES is set.
#
# share_instance = No keeps this ingestor on its own RNS stack. Attached to a
# shared rnsd every announce arrives over one LocalInterface, so a per-interface
# allowlist cannot tell them apart and would filter everything or nothing.
#
# Add the interfaces you want ingested below -- this ingestor does not inherit
# the ones your rnsd has. Delete this file to fall back to RNS's own defaults.

[reticulum]
  enable_transport = No
  share_instance = No

[logging]
  loglevel = 3

[interfaces]

  # No interface is enabled here on purpose. RETICULUM_INTERFACES names what you
  # want ingested, and a stock AutoInterface would be called
  # "AutoInterface[Default Interface]" -- matching no sensible allowlist, so the
  # listener would connect and hear nothing. Add the interfaces you named, e.g.
  #
  #   [[RNode LoRa]]
  #     type = RNodeInterface
  #     enabled = Yes
  #     port = /dev/ttyUSB0
  #     frequency = 867200000
  #     bandwidth = 125000
  #     txpower = 7
  #     spreadingfactor = 8
  #     codingrate = 5
"""
"""Starter config seeded when an interface allowlist is configured (SPEC RN4)."""


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
            interface_name = _announce_interface_name(destination_hash)
            if not _interface_allowed(interface_name):
                config._debug_log(
                    "Skipped Reticulum announce from a non-allowlisted interface",
                    context="reticulum.announce",
                    aspect=self.aspect_filter,
                    interface=interface_name,
                    allowlist=list(config.RETICULUM_INTERFACES),
                )
                return
            handlers._mark_packet_seen()
            identity = _identity_from_announce(announced_identity, destination_hash)
            node_id = _reticulum_node_id(getattr(identity, "hash", None))
            if node_id is None:
                config._debug_log(
                    "Skipped Reticulum announce with no resolvable identity",
                    context="reticulum.announce",
                    severity="warn",
                    aspect=self.aspect_filter,
                )
                return
            # Merge this aspect's destination hash into the identity's set
            # before building the record, so the posted destHash list carries
            # every aspect heard from this peer so far (#888).
            dest_hashes = self._iface._record_dest_hash(
                node_id, _reticulum_hash_hex(destination_hash)
            )
            node = _announce_to_node_dict(
                destination_hash,
                app_data,
                identity=identity,
                dest_hashes=dest_hashes,
                hops=_announce_hops(destination_hash),
            )
            self._iface._update_node(node_id, node)
            handlers.upsert_node(node_id, node)
            config._debug_log(
                "Reticulum announce ingested",
                context="reticulum.announce",
                aspect=self.aspect_filter,
                node_id=node_id,
                interface=interface_name,
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
    """Always ``None``: Reticulum has no handshake revealing "our" node id."""

    def __init__(self, *, target: str | None) -> None:
        """Initialise an unconnected interface bound to *target*."""
        self._target = target
        self._rns: object | None = None
        self._announce_handlers: list[_ReticulumAnnounceHandler] = []
        self._nodes_lock = threading.Lock()
        self._nodes: dict[str, dict] = {}
        self._dest_hashes: dict[str, set[str]] = {}
        self.isConnected: bool = False

    def _record_dest_hash(self, node_id: str, hash_hex: str | None) -> list[str]:
        """Merge *hash_hex* into the destination-hash set for *node_id*.

        One Reticulum identity announces on several destination aspects, each
        with its own destination hash.  Accumulating them per node keeps the
        posted ``destHash`` list complete instead of letting the most recent
        aspect overwrite the others (#888).

        Parameters:
            node_id: Canonical identity-derived ``!xxxxxxxx`` node ID.
            hash_hex: Destination hash hex to record; ignored when falsy.

        Returns:
            Sorted list of every destination hash known for *node_id*.
        """
        with self._nodes_lock:
            known = self._dest_hashes.setdefault(node_id, set())
            if hash_hex:
                known.add(hash_hex)
            return sorted(known)

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

        # Reticulum has no handshake revealing "our" node id, so the daemon's
        # ingestor heartbeat depends entirely on the operator-supplied
        # INGESTOR_NODE_ID.  Without it the heartbeat silently never registers
        # and the instance's reticulum packets/hour stats stay at zero even
        # while announces are being ingested — warn once at startup so the
        # dead scope is diagnosable.
        if not config.INGESTOR_NODE_ID:
            config._debug_log(
                "INGESTOR_NODE_ID is not set; the ingestor heartbeat will "
                "never register and the reticulum packets/hour stats will "
                "stay at zero",
                context="reticulum.connect",
                severity="warn",
            )

        # An allowlist is only answerable on our own stack — see
        # :func:`_seed_config_dir`.
        if config.RETICULUM_INTERFACES:
            _seed_config_dir(configdir)

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
        )
        return iface, target, active_candidate

    def extract_host_node_id(self, iface: object) -> str | None:
        """Return the configured host node id.

        A passive announce listener has no protocol-level handshake that
        reveals "our" node id, so this surfaces the operator-supplied
        :data:`~data.mesh_ingestor.config.INGESTOR_NODE_ID` (mirroring the
        UDP transport).

        Parameters:
            iface: Unused; accepted for
                :class:`~data.mesh_ingestor.mesh_protocol.MeshProtocol`
                signature compatibility.

        Returns:
            :data:`~data.mesh_ingestor.config.INGESTOR_NODE_ID`, or ``None``
            when unset.
        """
        return config.INGESTOR_NODE_ID

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
        return iface.nodes_snapshot()


__all__ = [
    "ReticulumProvider",
    "_ANNOUNCE_ASPECTS",
    "_ReticulumAnnounceHandler",
    "_ReticulumInterface",
    "_announce_hops",
    "_announce_interface_name",
    "_announce_to_node_dict",
    "_decode_display_name",
    "_identity_from_announce",
    "_identity_public_key_hex",
    "_interface_allowed",
    "_warn_allowlist_ignored_once",
    "_reticulum_hash_hex",
    "_reticulum_node_id",
    "_seed_config_dir",
    "_reticulum_short_name",
]
