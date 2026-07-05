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
"""Passive UDP ``MeshProtocol`` provider.

Wires the pure decrypt/mapping logic in
:mod:`data.mesh_ingestor.protocols.meshtastic_udp_decode` and the socket
plumbing in :mod:`data.mesh_ingestor.protocols.meshtastic_udp_socket` into a
:class:`~data.mesh_ingestor.mesh_protocol.MeshProtocol` implementation, so the
daemon can ingest Meshtastic's "Mesh via UDP" LAN multicast broadcasts
instead of holding the node's single API/serial connection slot.

Unlike :class:`~data.mesh_ingestor.protocols.meshtastic.MeshtasticProvider`
(pubsub-driven) this provider has no async callback registration: a single
background thread reads datagrams off a multicast socket and calls
:func:`~data.mesh_ingestor.handlers.on_receive` directly for every
primary-channel packet.

Primary-channel membership is decided by the packet's channel *hash*, not by
decryptability, and the gate is UNCONDITIONAL: a datagram is accepted only when
its ``channel`` hash equals the hash of the configured primary channel (see
:func:`~data.mesh_ingestor.protocols.meshtastic_udp_decode.channel_hash`). This
is deliberately stricter than "decrypts with :data:`config.PRIMARY_CHANNEL_KEY`"
because a SECONDARY channel created with the default key would also decrypt --
so the hash, which folds in the channel *name*, is what keeps secondary/private
channels out. Because this transport stamps channel index 0 on everything it
emits, it can only faithfully represent the primary channel, so filtering is not
optional: when the primary hash cannot be resolved (no
:data:`config.PRIMARY_CHANNEL_NAME`) the provider FAILS CLOSED and drops every
packet. (:data:`config.PRIMARY_CHANNEL_ONLY` still governs the separate
API/serial transport; it does not weaken this gate.) Accepted packets must be
channel-encrypted -- already-decoded (plaintext) packets are dropped to close a
no-key LAN spoofing path -- then decrypted with
:data:`config.PRIMARY_CHANNEL_KEY` and enriched to match the API/serial
transport's packet shape.
"""

from __future__ import annotations

import socket
import threading

from meshtastic.protobuf import mesh_pb2

from .. import config, handlers
from .meshtastic_udp_decode import (
    channel_hash,
    decrypt_meshpacket,
    meshpacket_to_packet_dict,
)
from .meshtastic_udp_socket import open_multicast_socket


class _UdpInterface:
    """Minimal interface object standing in for a Meshtastic library interface.

    The rest of the ingestor pipeline (daemon loop, heartbeat, snapshot code)
    expects an "interface" object with a ``nodes`` mapping, an
    ``isConnected`` event, and a ``close()`` method; this class supplies just
    that surface for the UDP transport; it does not otherwise track node
    state (:meth:`MeshtasticUdpProvider.node_snapshot_items` accordingly
    reads an always-empty dict).
    """

    def __init__(self) -> None:
        """Initialise an unconnected interface with no known nodes."""
        self.nodes: dict = {}
        self.isConnected = threading.Event()
        self._sock: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def close(self) -> None:
        """Stop the receive thread and release the socket.

        Signals :attr:`_stop` first so the receive loop's next timeout (or
        the socket close below, whichever comes first) causes it to exit,
        then closes the socket (best-effort -- close errors are not
        actionable here) and joins the thread with a bounded timeout so
        shutdown can never hang indefinitely.
        """
        self._stop.set()
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        self.isConnected.clear()


class MeshtasticUdpProvider:
    """Passive Meshtastic "Mesh via UDP" ``MeshProtocol`` implementation."""

    name = "meshtastic-udp"

    def __init__(self) -> None:
        """Initialise the provider with no topics subscribed yet."""
        self._subscribed: list[str] = []

    def _primary_channel_hash(self) -> int | None:
        """Return the channel hash that identifies primary-channel traffic.

        Computed from :data:`config.PRIMARY_CHANNEL_NAME` and
        :data:`config.PRIMARY_CHANNEL_KEY` via
        :func:`~data.mesh_ingestor.protocols.meshtastic_udp_decode.channel_hash`.
        Read fresh each call so a test (or a live config reload) that changes
        the environment is honoured without reconstructing the provider.

        Returns:
            The primary channel's hash byte, or ``None`` when
            :data:`config.PRIMARY_CHANNEL_NAME` is blank -- in which case the
            primary channel cannot be identified and primary-only filtering
            must fail closed (drop everything) rather than risk leaking a
            secondary channel that happens to share the primary key.
        """
        name = config.PRIMARY_CHANNEL_NAME
        if not name:
            return None
        return channel_hash(name, config.PRIMARY_CHANNEL_KEY)

    def subscribe(self) -> list[str]:
        """Return an empty topic list.

        This provider has no pubsub callbacks to register -- the receive
        thread started in :meth:`connect` calls
        :func:`~data.mesh_ingestor.handlers.on_receive` directly for every
        decoded packet. The method is still idempotent and side-effect-free
        so it mirrors the shape of
        :meth:`~data.mesh_ingestor.protocols.meshtastic.MeshtasticProvider.subscribe`.

        Returns:
            An empty list, always.
        """
        return list(self._subscribed)

    def connect(
        self, *, active_candidate: str | None
    ) -> tuple[object, str | None, str | None]:
        """Open the multicast socket and start the background receive thread.

        Parameters:
            active_candidate: Ignored (there is no serial/BLE candidate
                concept for a multicast listener); passed through unchanged
                as the returned "next active candidate" to satisfy the
                :class:`~data.mesh_ingestor.mesh_protocol.MeshProtocol`
                contract.

        Returns:
            A ``(iface, resolved_target, next_active_candidate)`` tuple: the
            live :class:`_UdpInterface`, a ``udp://group:port`` string
            describing the joined group, and *active_candidate* unchanged.
        """
        iface = _UdpInterface()
        iface._sock = open_multicast_socket(config.MESH_UDP_GROUP, config.MESH_UDP_PORT)
        # Surface the resolved primary-channel filter so operators can verify at
        # a glance that ingestion is pinned to the intended channel 0 (e.g.
        # "primary_channel_name='MediumFast' primary_channel_hash=31"). Filtering
        # is unconditional; a warn severity flags the FAIL-CLOSED state where no
        # PRIMARY_CHANNEL_NAME is configured, in which every packet is dropped.
        primary_hash = self._primary_channel_hash()
        config._debug_log(
            "UDP primary-channel filter",
            context="udp.connect",
            severity="warn" if primary_hash is None else "info",
            always=True,
            primary_channel_name=config.PRIMARY_CHANNEL_NAME or None,
            primary_channel_hash=primary_hash,
        )
        # Mark connected BEFORE starting the reader thread so the thread's
        # finally-clause always has the last word on clearing it. If the thread
        # were started first and hit an immediate socket error, its
        # ``finally: isConnected.clear()`` could run before this line, leaving
        # the interface wrongly marked connected over a dead reader.
        iface.isConnected.set()
        iface._thread = threading.Thread(
            target=self._recv_loop, args=(iface,), daemon=True
        )
        iface._thread.start()
        target = f"udp://{config.MESH_UDP_GROUP}:{config.MESH_UDP_PORT}"
        return iface, target, active_candidate

    def _recv_loop(self, iface: _UdpInterface) -> None:
        """Poll *iface*'s socket for datagrams until told to stop.

        Runs on the background thread started by :meth:`connect`. A
        ``socket.timeout`` (the socket has a 1-second timeout, see
        :func:`~data.mesh_ingestor.protocols.meshtastic_udp_socket.open_multicast_socket`)
        is expected and simply re-checks the stop flag; any other
        ``OSError`` (e.g. the socket was closed out from under this thread by
        :meth:`_UdpInterface.close`) ends the loop. Per-datagram handling is
        wrapped so a malformed or hostile packet is dropped rather than
        propagating and killing the thread, and :attr:`_UdpInterface.isConnected`
        is cleared on every exit path so a dead reader is detectable.

        Parameters:
            iface: The interface whose socket to read and stop flag to
                honour.
        """
        try:
            while not iface._stop.is_set():
                try:
                    raw, _addr = iface._sock.recvfrom(65535)
                except socket.timeout:
                    continue
                except OSError:
                    break
                try:
                    self._handle_datagram(raw, iface)
                except Exception:
                    # A single malformed or hostile datagram must never kill
                    # the reader thread. Drop it and continue. Logged at debug
                    # severity only, so a flood of bad datagrams cannot amplify
                    # into a log-volume DoS.
                    config._debug_log(
                        "Dropped malformed UDP datagram",
                        context="udp.recv",
                        severity="debug",
                    )
        finally:
            # Any loop exit -- stop flag, socket error, or an unexpected error
            # -- marks the interface disconnected so the daemon can notice a
            # dead reader and reconnect, instead of believing a crashed thread
            # is still healthy (isConnected was previously only cleared on
            # OSError, so a thread death left the daemon wedged).
            iface.isConnected.clear()

    def _handle_datagram(self, raw: bytes, iface: _UdpInterface) -> None:
        """Parse, filter, decrypt, and dispatch one raw UDP datagram.

        Parses *raw* as a ``MeshPacket`` and dispatches it to
        :func:`~data.mesh_ingestor.handlers.on_receive` only when it passes
        every gate below; anything else is silently dropped:

        1. **Parse** -- unparseable bytes are dropped.
        2. **Primary-channel hash** -- the packet's ``channel`` hash must equal
           the configured primary channel's hash (see
           :meth:`_primary_channel_hash`). This gate is UNCONDITIONAL: the UDP
           transport can only faithfully represent the primary channel (it
           stamps channel index 0), so it must never emit anything else. When
           the primary hash cannot be resolved (no
           :data:`config.PRIMARY_CHANNEL_NAME`) the gate FAILS CLOSED and drops
           everything, rather than risk leaking a secondary channel.
        3. **Encrypted-only** -- the packet must carry ``encrypted`` bytes;
           already-``decoded`` (plaintext) packets are dropped, closing a
           no-key LAN spoofing path.
        4. **Decrypt** -- decryption with :data:`config.PRIMARY_CHANNEL_KEY`
           must succeed (a private channel this key cannot open decrypts to
           ``None`` and is dropped).

        Parameters:
            raw: The raw datagram bytes read from the multicast socket.
            iface: The interface to report as the packet's origin.
        """
        mp = mesh_pb2.MeshPacket()
        try:
            mp.ParseFromString(raw)
        except Exception:
            return
        # Channel-0-only enforcement (unconditional -- fail closed). A
        # ``MeshPacket`` advertises the hash of its channel (a fold of channel
        # name + key); accept only when that hash matches the PRIMARY channel's.
        # This is stricter than "decrypts with the primary key" -- a SECONDARY
        # channel created with the default AQ== key would decrypt too, but has a
        # different name and therefore a different hash.
        primary_hash = self._primary_channel_hash()
        if primary_hash is None or mp.channel != primary_hash:
            return
        # Require channel-encrypted traffic. Real primary-channel packets on the
        # multicast feed are always encrypted with the channel key; dropping
        # packets that arrive already-``decoded`` (plaintext) closes a no-key
        # LAN spoofing path and avoids forwarding unauthenticated records.
        if not mp.HasField("encrypted"):
            return
        data = decrypt_meshpacket(mp, config.PRIMARY_CHANNEL_KEY)
        if data is None:
            # Private channel (or noise) this key cannot open -- drop.
            return
        mp.decoded.CopyFrom(data)
        handlers.on_receive(packet=meshpacket_to_packet_dict(mp), interface=iface)

    def extract_host_node_id(self, iface: object) -> str | None:
        """Return the configured host node id.

        Unlike the API/serial transport, a passive multicast listener has no
        protocol-level handshake that reveals "our" node id, so this simply
        surfaces the operator-supplied :data:`config.INGESTOR_NODE_ID`.

        Parameters:
            iface: Unused; accepted for
                :class:`~data.mesh_ingestor.mesh_protocol.MeshProtocol`
                signature compatibility.

        Returns:
            :data:`config.INGESTOR_NODE_ID`, or ``None`` when unset.
        """
        return config.INGESTOR_NODE_ID

    def node_snapshot_items(self, iface: object) -> list[tuple[str, object]]:
        """Return a snapshot of known nodes.

        This provider does not track a node roster (it only relays decoded
        packets), so the snapshot reflects whatever (typically empty)
        ``nodes`` mapping the interface carries.

        Parameters:
            iface: The interface whose ``nodes`` mapping to snapshot.

        Returns:
            A list of ``(node_id, node_obj)`` tuples; empty when *iface* has
            no ``nodes`` attribute or an empty one.
        """
        return list(getattr(iface, "nodes", {}).items())


__all__ = ["MeshtasticUdpProvider"]
