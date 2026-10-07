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
"""Unit tests for the ``MESH_UDP_ALLOWED_SOURCES`` sender allowlist (SPEC UT2).

The passive UDP transport accepts a datagram from every host that can reach the
multicast group.  :envvar:`MESH_UDP_ALLOWED_SOURCES` optionally narrows that to
a comma-separated list of IPv4 addresses or CIDRs, validated at import time as
``MESH_UDP_GROUP`` is (ACCEPTANCE UG-A2), so a typo stops startup instead of
silently changing who may send.  The receive-loop check itself is covered by
``TestRecvLoopAllowedSources`` in ``tests/test_meshtastic_udp_unit.py``.
"""

from __future__ import annotations

import sys
from ipaddress import IPv4Network
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.config as config

#: A list mixing a single address and a CIDR, as an operator writes it.
LISTED = "192.168.1.20,10.0.0.0/8"

#: What :data:`LISTED` must parse to: the address as its ``/32``, in order.
LISTED_NETWORKS = (IPv4Network("192.168.1.20/32"), IPv4Network("10.0.0.0/8"))


class TestParseMeshUdpAllowedSources:
    """Tests for :func:`config._parse_mesh_udp_allowed_sources`."""

    def test_addresses_and_cidrs_keep_configured_order(self):
        """An address reads as its ``/32``, a CIDR as its network, in order."""
        assert config._parse_mesh_udp_allowed_sources(LISTED) == LISTED_NETWORKS

    def test_whitespace_and_empty_segments_are_ignored(self):
        """Padding is trimmed and empty segments are skipped, not rejected."""
        assert (
            config._parse_mesh_udp_allowed_sources(" 192.168.1.20 ,, 10.0.0.0/8 ,")
            == LISTED_NETWORKS
        )

    def test_host_bits_below_the_prefix_are_dropped(self):
        """``192.168.1.7/24`` names its network, ``192.168.1.0/24``."""
        assert config._parse_mesh_udp_allowed_sources("192.168.1.7/24") == (
            IPv4Network("192.168.1.0/24"),
        )

    def test_duplicates_collapse_onto_first_position(self):
        """A network listed twice, in any spelling, is kept once, at its first spot."""
        raw = "192.168.1.20,10.0.0.0/8,192.168.1.20/32,10.9.9.9/8"
        assert config._parse_mesh_udp_allowed_sources(raw) == LISTED_NETWORKS

    @pytest.mark.parametrize("raw", ["", "   ", ",", " , ", '""', "''"])
    def test_blank_accepts_every_source(self, raw):
        """Blank, separator-only or quote-only values mean no list.

        A quote-only value is what a Compose ``${VAR:-""}`` default delivers
        (see ``test_config_unit.TestComposeDefaults``); it lists no source.
        """
        assert config._parse_mesh_udp_allowed_sources(raw) == ()

    @pytest.mark.parametrize(
        "entry",
        [
            "192.168.1.0/33",  # prefix longer than 32 bits
            "192.168.1.256",  # octet out of range
            "192.168.001.020",  # leading zeros
            "mesh-node.local",  # a hostname: nothing is resolved
            "192.168.1.20:4403",  # a port is not part of a source
            "192.168.1.20-192.168.1.30",  # a range is not a CIDR
            "fe80::1",  # IPv6: the transport is IPv4-only
            '"192.168.1.20"',  # quoted address: quotes are content, not stripped
        ],
    )
    def test_invalid_entry_raises_naming_variable_and_entry(self, entry):
        """Anything but an IPv4 address or CIDR is rejected with a clear message."""
        with pytest.raises(ValueError) as excinfo:
            config._parse_mesh_udp_allowed_sources(f"192.168.1.20,{entry}")
        message = str(excinfo.value)
        assert "MESH_UDP_ALLOWED_SOURCES" in message
        assert repr(entry) in message


class TestMeshUdpAllowedSourcesAtImport:
    """Import-time resolution of :data:`config.MESH_UDP_ALLOWED_SOURCES`."""

    def test_unset_accepts_every_source(self, load_config):
        """Unset, the list is empty: every source is accepted, as before."""
        cfg = load_config(MESH_UDP_ALLOWED_SOURCES=None)
        assert cfg.MESH_UDP_ALLOWED_SOURCES == ()

    def test_list_is_parsed_at_import(self, load_config):
        """The variable is read and parsed when the module loads."""
        cfg = load_config(MESH_UDP_ALLOWED_SOURCES=LISTED)
        assert cfg.MESH_UDP_ALLOWED_SOURCES == LISTED_NETWORKS

    def test_invalid_entry_fails_at_import(self, load_config):
        """A bad entry stops startup instead of being skipped.

        Skipping it would leave a list without the sender the operator meant
        or, for a one-entry list, no list at all: every host accepted.
        """
        with pytest.raises(
            ValueError, match="MESH_UDP_ALLOWED_SOURCES entry '192.168.1.0/33'"
        ):
            load_config(MESH_UDP_ALLOWED_SOURCES="192.168.1.0/33")
