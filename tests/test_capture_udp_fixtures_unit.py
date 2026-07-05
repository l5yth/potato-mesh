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
"""Unit tests for ``data/tools/capture_udp_fixtures.py``'s socket plumbing.

The capture tool deliberately mirrors
:mod:`data.mesh_ingestor.protocols.meshtastic_udp_socket` (its module docstring
requires the two to stay in sync), so its ``open_multicast_socket`` gets the
same fake-socket bind/join assertions — most importantly that the socket is
bound to the multicast *group* address and never to the wildcard ``""``
(CodeQL: binding a socket to all network interfaces).

The tool is not a package module, so it is loaded here by file path.
"""

from __future__ import annotations

import importlib.util
import socket as real_socket
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

_TOOL_PATH = REPO_ROOT / "data" / "tools" / "capture_udp_fixtures.py"


def _load_tool():
    """Load the capture tool as a module from its file path.

    Returns:
        The loaded ``capture_udp_fixtures`` module object.
    """
    spec = importlib.util.spec_from_file_location("capture_udp_fixtures", _TOOL_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


capture_tool = _load_tool()


class FakeSock:
    """Records socket calls instead of touching a real network socket."""

    def __init__(self) -> None:
        """Initialize the fake with an empty call log."""
        self.calls: list[tuple] = []

    def setsockopt(self, *args):
        """Record a ``setsockopt`` call."""
        self.calls.append(("setsockopt", args))

    def bind(self, addr):
        """Record a ``bind`` call."""
        self.calls.append(("bind", addr))

    def settimeout(self, timeout):
        """Record a ``settimeout`` call."""
        self.calls.append(("settimeout", timeout))


class TestCaptureToolOpenMulticastSocket:
    """Tests for the capture tool's :func:`open_multicast_socket`."""

    def test_binds_group_address_not_wildcard(self, monkeypatch):
        """The socket is bound to ``(group, port)``, never the wildcard ``""``.

        Regression guard for the CodeQL finding "binding a socket to all
        network interfaces": a wildcard bind would deliver unicast datagrams
        sent to the port on any local interface, while the tool only ever
        needs the multicast group's traffic.
        """
        fake = FakeSock()
        monkeypatch.setattr(capture_tool.socket, "socket", lambda *a, **k: fake)

        sock = capture_tool.open_multicast_socket("224.0.0.69", 4403)

        assert sock is fake
        assert ("bind", ("224.0.0.69", 4403)) in fake.calls
        assert ("bind", ("", 4403)) not in fake.calls

    def test_sets_reuse_join_and_timeout(self, monkeypatch):
        """Reuse options, IP_ADD_MEMBERSHIP on the group, and a 1s timeout."""
        fake = FakeSock()
        monkeypatch.setattr(capture_tool.socket, "socket", lambda *a, **k: fake)

        capture_tool.open_multicast_socket("239.1.2.3", 5000)

        assert (
            "setsockopt",
            (real_socket.SOL_SOCKET, real_socket.SO_REUSEADDR, 1),
        ) in fake.calls
        assert ("bind", ("239.1.2.3", 5000)) in fake.calls
        expected_mreq = real_socket.inet_aton("239.1.2.3") + real_socket.inet_aton(
            "0.0.0.0"
        )
        assert (
            "setsockopt",
            (real_socket.IPPROTO_IP, real_socket.IP_ADD_MEMBERSHIP, expected_mreq),
        ) in fake.calls
        assert ("settimeout", 1.0) in fake.calls
