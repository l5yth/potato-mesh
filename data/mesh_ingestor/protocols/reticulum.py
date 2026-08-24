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

**Canonical node-id mapping.**  Reticulum identifies a destination by a
16-byte truncated hash.  The canonical ``!%08x`` node id is derived from the
**first four bytes** of that destination hash (mirroring MeshCore's
first-four-bytes-of-the-public-key convention), and the full 32-hex
destination hash is preserved in ``user.publicKey`` so no identity information
is lost.  The mapping is deterministic and sender-side, so the same announce
heard by multiple ingestors collapses onto one node row (the CONTRACTS.md
cross-ingestor dedup requirement).

**Display names.**  ``lxmf.delivery`` announces carry the peer's display name
in ``app_data`` — either raw UTF-8 bytes (pre-0.5 LXMF) or a msgpack array
whose first element is the display name (LXMF >= 0.5, which appends the stamp
cost).  ``nomadnetwork.node`` announces carry the node name as raw UTF-8.
Undecodable ``app_data`` falls back to the 8-hex destination-hash prefix.
"""

from __future__ import annotations

import threading
import time

import RNS
from RNS.vendor import umsgpack

from .. import config, handlers

_ANNOUNCE_ASPECTS: tuple[str, ...] = ("lxmf.delivery", "nomadnetwork.node")
"""Destination aspects whose announces are ingested as node records."""

_MSGPACK_ARRAY_LEAD_BYTES = frozenset(range(0x90, 0xA0)) | {0xDC, 0xDD}
"""First-byte values identifying a msgpack-encoded announce ``app_data``.

``0x90``–``0x9f`` are msgpack fixarrays, ``0xdc``/``0xdd`` are array16/array32
— the same discrimination LXMF's ``display_name_from_app_data`` applies to
tell the >= 0.5 ``[display_name, stamp_cost]`` format from the original raw
UTF-8 name bytes.
"""


def _reticulum_node_id(dest_hash: object) -> str | None:
    """Derive a canonical ``!xxxxxxxx`` node ID from a Reticulum destination hash.

    Uses the first four bytes (eight hex characters) of the 16-byte truncated
    destination hash, formatted as ``!xxxxxxxx`` — the same
    prefix-of-native-identifier scheme MeshCore uses for public keys.

    Parameters:
        dest_hash: Destination hash as raw ``bytes`` (as delivered by RNS
            announce callbacks) or as a hex string.

    Returns:
        Canonical ``!xxxxxxxx`` node ID string, or ``None`` when the hash is
        absent or too short.
    """
    if isinstance(dest_hash, (bytes, bytearray)):
        hash_hex = bytes(dest_hash).hex()
    elif isinstance(dest_hash, str):
        hash_hex = dest_hash.strip().lower()
    else:
        return None
    if len(hash_hex) < 8:
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
    hops: int | None = None,
    last_heard: int | None = None,
) -> dict | None:
    """Convert a Reticulum announce into a ``POST /api/nodes`` node dict.

    Parameters:
        dest_hash: 16-byte destination hash (or hex string) identifying the
            announcing destination.
        app_data: Raw announce application data carrying the display name
            (see :func:`_decode_display_name`).
        hops: Hop count travelled by the announce, when known.
        last_heard: Unix seconds of announce receipt; defaults to now.

    Returns:
        Node dict compatible with the ``POST /api/nodes`` payload format, or
        ``None`` when *dest_hash* cannot be mapped to a canonical node ID.
    """
    node_id = _reticulum_node_id(dest_hash)
    hash_hex = _reticulum_hash_hex(dest_hash)
    if node_id is None or hash_hex is None:
        return None
    display_name = _decode_display_name(app_data)
    node: dict = {
        "lastHeard": int(time.time()) if last_heard is None else int(last_heard),
        "protocol": "reticulum",
        "user": {
            "longName": display_name if display_name else hash_hex[:8],
            "shortName": _reticulum_short_name(node_id),
            "publicKey": hash_hex,
        },
    }
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
            announced_identity: The announcing :class:`RNS.Identity` (unused;
                the destination hash is the canonical identifier).
            app_data: Raw announce application data (display name carrier).
        """
        try:
            handlers._mark_packet_seen()
            node = _announce_to_node_dict(
                destination_hash,
                app_data,
                hops=_announce_hops(destination_hash),
            )
            if node is None:
                return
            node_id = _reticulum_node_id(destination_hash)
            self._iface._update_node(node_id, node)
            handlers.upsert_node(node_id, node)
            config._debug_log(
                "Reticulum announce ingested",
                context="reticulum.announce",
                aspect=self.aspect_filter,
                node_id=node_id,
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
        :data:`~data.mesh_ingestor.config.RETICULUM_CONFIG_DIR` (``None`` =
        the RNS user default, ``~/.reticulum``).  One announce handler is
        registered per :data:`_ANNOUNCE_ASPECTS` entry.

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
        target = f"reticulum://{configdir or '~/.reticulum'}"
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
    "_announce_to_node_dict",
    "_decode_display_name",
    "_reticulum_hash_hex",
    "_reticulum_node_id",
    "_reticulum_short_name",
]
