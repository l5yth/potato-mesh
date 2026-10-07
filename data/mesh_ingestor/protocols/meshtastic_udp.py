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
background thread reads datagrams off one multicast socket per joined group
and calls :func:`~data.mesh_ingestor.handlers.on_receive` directly for every
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
channel-encrypted -- already-decoded (plaintext) packets are dropped, because
genuine primary-channel traffic is always encrypted -- then decrypted with
:data:`config.PRIMARY_CHANNEL_KEY` and enriched to match the API/serial
transport's packet shape.

None of these gates authenticates the sender (SPEC UT1). The group sockets
accept a datagram from every host that can reach the multicast group, and a
packet that decrypts proves only that its sender holds the channel key: the
default ``AQ==`` key is public, and the AES-CTR encryption carries no MAC, so a
key holder can forge a packet under any sender id. When
:data:`config.MESH_UDP_ALLOWED_SOURCES` is set, the receive loop drops a
datagram from any other source address before it is parsed or decrypted
(SPEC UT2). A host on the same segment can spoof its source address, so that
check is defence in depth, not authentication (SPEC UT3).
"""

from __future__ import annotations

import ipaddress
import select
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

_RECV_POLL_SECS = 1.0
"""Seconds the receive loop waits on its sockets before re-checking the stop flag.

Matches the 1-second socket timeout set by
:func:`~data.mesh_ingestor.protocols.meshtastic_udp_socket.open_multicast_socket`,
which bounded the same re-check while the loop read a single socket."""


def _source_allowed(addr: tuple[str, int]) -> bool:
    """Return whether a datagram from *addr* may be handled (SPEC UT2).

    Reads :data:`config.MESH_UDP_ALLOWED_SOURCES` at call time, as
    :meth:`MeshtasticUdpProvider._primary_channel_hash` reads the channel
    settings, so a changed setting is honoured without reconstructing the
    provider. The address is not parsed while the setting is empty.

    Parameters:
        addr: The ``(host, port)`` pair ``recvfrom`` returned on an IPv4
            group socket.

    Returns:
        ``True`` when the setting is empty (the default: every source is
        accepted) or when *addr*'s host lies in one of its networks;
        ``False`` otherwise.
    """
    allowed = config.MESH_UDP_ALLOWED_SOURCES
    if not allowed:
        return True
    source = ipaddress.IPv4Address(addr[0])
    return any(source in network for network in allowed)


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
        self._socks: list[socket.socket] = []
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def close(self) -> None:
        """Stop the receive thread and release every group socket.

        Signals :attr:`_stop` first so the receive loop's next wait timeout
        (or the socket closes below, whichever comes first) causes it to
        exit, then closes each socket (best-effort -- close errors are not
        actionable here, and one failing close must not leave the others
        open) and joins the thread with a bounded timeout so shutdown can
        never hang indefinitely.
        """
        self._stop.set()
        for sock in self._socks:
            try:
                sock.close()
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
        """Join every configured multicast group and start the receive thread.

        Opens one socket per entry of :data:`config.MESH_UDP_GROUPS`, all on
        :data:`config.MESH_UDP_PORT`: each socket is bound to its group's
        address, so it receives that group's datagrams only. Joining is
        all-or-nothing -- if any group fails, the sockets already opened are
        closed and the error propagates, so the daemon retries the whole
        connect just as it does when a single group fails.

        Parameters:
            active_candidate: Ignored (there is no serial/BLE candidate
                concept for a multicast listener); passed through unchanged
                as the returned "next active candidate" to satisfy the
                :class:`~data.mesh_ingestor.mesh_protocol.MeshProtocol`
                contract.

        Returns:
            A ``(iface, resolved_target, next_active_candidate)`` tuple: the
            live :class:`_UdpInterface`, a ``udp://group[,group...]:port``
            string naming the joined groups, and *active_candidate* unchanged.

        Raises:
            OSError: When a group cannot be joined (for example, no
                multicast-capable route on the host).
        """
        iface = _UdpInterface()
        try:
            for group in config.MESH_UDP_GROUPS:
                iface._socks.append(open_multicast_socket(group, config.MESH_UDP_PORT))
        except Exception:
            # Release the groups already joined before failing, so each
            # reconnect attempt the daemon makes does not leak a socket.
            iface.close()
            raise
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
        target = f"udp://{','.join(config.MESH_UDP_GROUPS)}:{config.MESH_UDP_PORT}"
        return iface, target, active_candidate

    def _recv_loop(self, iface: _UdpInterface) -> None:
        """Wait on all of *iface*'s group sockets and handle datagrams until stopped.

        Runs on the background thread started by :meth:`connect`. One
        ``select`` waits on every joined group's socket at once, so this one
        thread serves all groups; its :data:`_RECV_POLL_SECS` timeout is what
        re-checks the stop flag. A socket reported readable whose ``recvfrom``
        still times out (each keeps the 1-second timeout set by
        :func:`~data.mesh_ingestor.protocols.meshtastic_udp_socket.open_multicast_socket`)
        is skipped. Any other ``OSError`` -- or the ``ValueError`` ``select``
        raises for a socket that is already closed -- means
        :meth:`_UdpInterface.close` closed a socket out from under this
        thread, and ends the loop. Right after ``recvfrom``, a datagram whose
        source :func:`_source_allowed` rejects (only possible while
        :data:`config.MESH_UDP_ALLOWED_SOURCES` is set) is dropped before it
        is parsed or decrypted, with a debug-severity log line only.
        Per-datagram handling is wrapped so a malformed or hostile packet is
        dropped rather than propagating and killing the thread, and
        :attr:`_UdpInterface.isConnected` is cleared on every exit path so a
        dead reader is detectable.

        Parameters:
            iface: The interface whose sockets to read and stop flag to
                honour.
        """
        try:
            while not iface._stop.is_set():
                try:
                    ready, _w, _x = select.select(iface._socks, [], [], _RECV_POLL_SECS)
                except (OSError, ValueError):
                    # A closed socket's fileno() is -1, which select rejects
                    # with ValueError rather than OSError.
                    return
                for sock in ready:
                    try:
                        raw, addr = sock.recvfrom(65535)
                    except socket.timeout:
                        # Readable yet empty by the time recvfrom ran (Linux
                        # can discard a datagram that fails its checksum after
                        # waking select); the other ready sockets still count.
                        continue
                    except OSError:
                        # Closed under the read; ``finally`` still runs.
                        return
                    if not _source_allowed(addr):
                        # An unlisted sender is dropped before any parse or
                        # decrypt. Debug severity only, as for a malformed
                        # datagram, so a flood cannot fill the log.
                        config._debug_log(
                            "Dropped UDP datagram from unlisted source",
                            context="udp.recv",
                            severity="debug",
                            source=addr[0],
                        )
                        continue
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
        every gate below; anything else is silently dropped. The sender's
        source address has already passed
        :data:`config.MESH_UDP_ALLOWED_SOURCES` in :meth:`_recv_loop`; no gate
        here authenticates the sender (see the module docstring):

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
           already-``decoded`` (plaintext) packets are dropped, because genuine
           primary-channel traffic is always encrypted. This keeps out a
           sender without the channel key, not one that holds it: the default
           ``AQ==`` key is public.
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
        # multicast feed are always encrypted with the channel key, so a packet
        # that arrives already-``decoded`` (plaintext) is never genuine. This is
        # not authentication: anyone holding the key (the default AQ== is
        # public) can still forge a packet under any sender id (SPEC UT1).
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
