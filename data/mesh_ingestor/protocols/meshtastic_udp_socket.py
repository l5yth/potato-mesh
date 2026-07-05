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

"""Join the Meshtastic "Mesh via UDP" LAN multicast group.

This module is the pure socket-plumbing half of the passive UDP transport: it
has no protobuf, crypto, or daemon dependencies, so the option-setting and
group-join logic can be unit tested (and 100%-covered) with a fake socket,
independent of any real network stack.

This logic intentionally mirrors ``data/tools/capture_udp_fixtures.py``'s
``open_multicast_socket``, which has been exercised against a live
Station G2 on macOS and Linux; keep the two in sync if either changes.
"""

from __future__ import annotations

import socket


def open_multicast_socket(group: str, port: int) -> socket.socket:
    """Open, configure, and join *group* on *port* for passive reception.

    Creates an IPv4 UDP socket suitable for receive-only Meshtastic "Mesh via
    UDP" multicast traffic: address reuse is enabled (so multiple local
    listeners, or quick restarts, don't collide on the port), the socket is
    bound to the *group* address itself — never the wildcard, so unicast
    datagrams sent to the port on any local interface are not delivered to
    it — and it joins *group* via ``IP_ADD_MEMBERSHIP`` on the default
    interface (``0.0.0.0``). Binding a multicast group address is POSIX
    behaviour (Linux/macOS, the platforms this transport is exercised on).

    Args:
        group: IPv4 multicast group address to join, e.g. ``"224.0.0.69"``.
        port: UDP port the group publishes on, e.g. ``4403``.

    Returns:
        A bound, group-joined datagram socket with a 1-second receive
        timeout, ready for ``recvfrom`` polling.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    # SO_REUSEPORT is not available on every platform (e.g. some Windows
    # builds) and, even where the constant exists, some kernels reject it;
    # both cases are non-fatal since SO_REUSEADDR above already covers the
    # common "restart while the old socket lingers" case.
    if hasattr(socket, "SO_REUSEPORT"):
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except OSError:
            pass
    # Bind the multicast group address, not the wildcard: the kernel then
    # only delivers datagrams addressed to group:port, so unicast traffic to
    # the port never reaches this socket (CodeQL: binding a socket to all
    # network interfaces). POSIX-only behaviour, which matches the platforms
    # this transport supports.
    sock.bind((group, port))
    # Joining with the wildcard interface (0.0.0.0) lets the kernel pick
    # the receiving interface, matching how the capture tool joins the group.
    mreq = socket.inet_aton(group) + socket.inet_aton("0.0.0.0")
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
    sock.settimeout(1.0)
    return sock
