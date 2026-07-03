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
"""Unit tests for :mod:`data.mesh_ingestor.protocols.meshtastic_udp_socket`.

Every test replaces ``socket.socket`` with an in-process fake that records
calls instead of touching the network, so the suite never opens a real
socket or requires multicast-capable hardware/CI sandboxing.
"""

from __future__ import annotations

import socket as real_socket
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from data.mesh_ingestor.protocols import meshtastic_udp_socket as udp_socket


class FakeSock:
    """Records socket calls instead of touching a real network socket."""

    def __init__(self, raise_on_reuseport: bool = False) -> None:
        """Initialize the fake with an empty call log.

        Args:
            raise_on_reuseport: When ``True``, calling ``setsockopt`` with
                ``SO_REUSEPORT`` raises ``OSError`` (simulating a platform
                that advertises the constant but rejects the option).
        """
        self.calls: list[tuple] = []
        self._raise_on_reuseport = raise_on_reuseport

    def setsockopt(self, *args):
        """Record a ``setsockopt`` call, optionally raising for SO_REUSEPORT."""
        if (
            self._raise_on_reuseport
            and hasattr(real_socket, "SO_REUSEPORT")
            and args[1] == real_socket.SO_REUSEPORT
        ):
            self.calls.append(("setsockopt", args))
            raise OSError("SO_REUSEPORT not supported")
        self.calls.append(("setsockopt", args))

    def bind(self, addr):
        """Record a ``bind`` call."""
        self.calls.append(("bind", addr))

    def settimeout(self, timeout):
        """Record a ``settimeout`` call."""
        self.calls.append(("settimeout", timeout))


class TestOpenMulticastSocket:
    """Tests for :func:`open_multicast_socket`."""

    def test_sets_options_binds_joins_and_times_out(self, monkeypatch):
        """Happy path: reuseaddr, bind, IP_ADD_MEMBERSHIP, and a 1s timeout."""
        fake = FakeSock()
        monkeypatch.setattr(udp_socket.socket, "socket", lambda *a, **k: fake)

        sock = udp_socket.open_multicast_socket("224.0.0.69", 4403)

        assert sock is fake
        assert ("bind", ("", 4403)) in fake.calls
        assert (
            "setsockopt",
            (real_socket.SOL_SOCKET, real_socket.SO_REUSEADDR, 1),
        ) in fake.calls
        expected_mreq = real_socket.inet_aton("224.0.0.69") + real_socket.inet_aton(
            "0.0.0.0"
        )
        assert (
            "setsockopt",
            (real_socket.IPPROTO_IP, real_socket.IP_ADD_MEMBERSHIP, expected_mreq),
        ) in fake.calls
        assert ("settimeout", 1.0) in fake.calls

    def test_reuseport_set_when_available(self, monkeypatch):
        """When ``SO_REUSEPORT`` exists on the platform, it is set to 1."""
        monkeypatch.setattr(real_socket, "SO_REUSEPORT", 15, raising=False)
        fake = FakeSock()
        monkeypatch.setattr(udp_socket.socket, "socket", lambda *a, **k: fake)

        udp_socket.open_multicast_socket("224.0.0.69", 4403)

        assert (
            "setsockopt",
            (real_socket.SOL_SOCKET, real_socket.SO_REUSEPORT, 1),
        ) in fake.calls

    def test_reuseport_absent_is_skipped(self, monkeypatch):
        """When the platform has no ``SO_REUSEPORT``, no such call is made."""
        monkeypatch.delattr(real_socket, "SO_REUSEPORT", raising=False)
        fake = FakeSock()
        monkeypatch.setattr(udp_socket.socket, "socket", lambda *a, **k: fake)

        udp_socket.open_multicast_socket("224.0.0.69", 4403)

        assert not hasattr(udp_socket.socket, "SO_REUSEPORT")
        assert all(
            call[0] != "setsockopt" or len(call[1]) < 2 or call[1][1] != 15
            for call in fake.calls
        )
        # No SO_REUSEPORT option key can appear at all when the attribute
        # is absent, since the code cannot reference it.
        reuseport_calls = [
            call
            for call in fake.calls
            if call[0] == "setsockopt" and call[1][0] == real_socket.SOL_SOCKET
        ]
        assert len(reuseport_calls) == 1  # only SO_REUSEADDR

    def test_reuseport_oserror_is_tolerated(self, monkeypatch):
        """An ``OSError`` while setting ``SO_REUSEPORT`` does not propagate."""
        monkeypatch.setattr(real_socket, "SO_REUSEPORT", 15, raising=False)
        fake = FakeSock(raise_on_reuseport=True)
        monkeypatch.setattr(udp_socket.socket, "socket", lambda *a, **k: fake)

        sock = udp_socket.open_multicast_socket("224.0.0.69", 4403)

        assert sock is fake
        assert (
            "setsockopt",
            (real_socket.SOL_SOCKET, real_socket.SO_REUSEPORT, 1),
        ) in fake.calls
        # Despite the OSError, bind/join/timeout still happened.
        assert ("bind", ("", 4403)) in fake.calls
        assert ("settimeout", 1.0) in fake.calls

    def test_join_uses_requested_group_and_port(self, monkeypatch):
        """A different group/port is threaded through to bind and the mreq."""
        fake = FakeSock()
        monkeypatch.setattr(udp_socket.socket, "socket", lambda *a, **k: fake)

        udp_socket.open_multicast_socket("239.1.2.3", 5000)

        assert ("bind", ("", 5000)) in fake.calls
        expected_mreq = real_socket.inet_aton("239.1.2.3") + real_socket.inet_aton(
            "0.0.0.0"
        )
        assert (
            "setsockopt",
            (real_socket.IPPROTO_IP, real_socket.IP_ADD_MEMBERSHIP, expected_mreq),
        ) in fake.calls
