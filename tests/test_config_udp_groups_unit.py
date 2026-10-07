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
"""Unit tests for the ``MESH_UDP_GROUP`` multicast-group list (issue #903).

Meshtastic firmware 2.8 sends "Mesh via UDP" to ``239.0.0.69`` and earlier
firmware to ``224.0.0.69``, with no fallback either way, so the UDP transport
joins both by default and :envvar:`MESH_UDP_GROUP` accepts a comma-separated
list, validated at import time like ``PRIMARY_CHANNEL_KEY`` (ACCEPTANCE UH-A1).

The packaged deployment defaults are pinned here as well: the image ``ENV``
and the Nix option override the code default, so a stale single-group default
there would keep every such deployment deaf to one firmware line.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.config as config

#: The shipped default, spelled out rather than read back from ``config`` so a
#: change to the default has to be made here deliberately.
EXPECTED_GROUPS = ("239.0.0.69", "224.0.0.69")

#: :data:`EXPECTED_GROUPS` as an operator writes it in ``MESH_UDP_GROUP``.
EXPECTED_SETTING = ",".join(EXPECTED_GROUPS)


class TestParseMeshUdpGroups:
    """Tests for :func:`config._parse_mesh_udp_groups`."""

    def test_single_group(self):
        """One address yields a one-group tuple, restricting the listener."""
        assert config._parse_mesh_udp_groups("224.0.0.69") == ("224.0.0.69",)

    def test_list_keeps_configured_order(self):
        """A comma-separated list is split in the order it was written."""
        assert config._parse_mesh_udp_groups("224.0.0.69,239.0.0.69") == (
            "224.0.0.69",
            "239.0.0.69",
        )

    def test_whitespace_and_empty_segments_are_ignored(self):
        """Padding is trimmed and empty segments are skipped, not rejected."""
        assert (
            config._parse_mesh_udp_groups(" 239.0.0.69 ,, 224.0.0.69 ,")
            == EXPECTED_GROUPS
        )

    def test_duplicates_collapse_onto_first_position(self):
        """A repeated group is joined once, where it first appeared."""
        assert config._parse_mesh_udp_groups("224.0.0.69,239.0.0.69, 224.0.0.69") == (
            "224.0.0.69",
            "239.0.0.69",
        )

    @pytest.mark.parametrize("raw", ["", "   ", ",", " , ", '""', "''"])
    def test_blank_falls_back_to_both_groups(self, raw):
        """Blank, separator-only, or quote-only values mean the default.

        A quote-only value is what a Compose ``${VAR:-""}`` default delivers
        (see ``test_config_unit.TestComposeDefaults``); it carries no address.
        """
        assert config._parse_mesh_udp_groups(raw) == EXPECTED_GROUPS

    @pytest.mark.parametrize("group", ["224.0.0.0", "239.255.255.255"])
    def test_multicast_block_boundaries_are_accepted(self, group):
        """Both ends of ``224.0.0.0/4`` are valid groups."""
        assert config._parse_mesh_udp_groups(group) == (group,)

    @pytest.mark.parametrize(
        "entry",
        [
            "not-an-address",
            "10.0.0.1",  # unicast
            "223.255.255.255",  # just below the multicast block
            "240.0.0.1",  # just above it (reserved)
            "255.255.255.255",  # limited broadcast
            "239.0.0.256",  # octet out of range
            "239.0.0.69:4403",  # port belongs in MESH_UDP_PORT
            "ff02::1",  # IPv6 multicast; the transport is IPv4-only
            '"239.0.0.69"',  # quoted address: quotes are content, not stripped
        ],
    )
    def test_non_multicast_entry_raises_naming_variable_and_entry(self, entry):
        """Anything outside IPv4 ``224.0.0.0/4`` is rejected with a clear message."""
        with pytest.raises(ValueError) as excinfo:
            config._parse_mesh_udp_groups(f"239.0.0.69,{entry}")
        message = str(excinfo.value)
        assert "MESH_UDP_GROUP" in message
        assert repr(entry) in message


class TestMeshUdpGroupsAtImport:
    """Import-time resolution of :data:`config.MESH_UDP_GROUPS`."""

    def test_default_listens_on_both_groups(self, load_config):
        """Unset, the ingestor joins the firmware 2.8+ group and the earlier one."""
        assert load_config(MESH_UDP_GROUP=None).MESH_UDP_GROUPS == EXPECTED_GROUPS

    def test_list_is_normalised_into_both_names(self, load_config):
        """The tuple and the comma-joined string agree after normalisation."""
        cfg = load_config(MESH_UDP_GROUP=" 224.0.0.69 ,239.0.0.69,224.0.0.69")
        assert cfg.MESH_UDP_GROUPS == ("224.0.0.69", "239.0.0.69")
        assert cfg.MESH_UDP_GROUP == "224.0.0.69,239.0.0.69"

    def test_one_address_restricts_to_that_group(self, load_config):
        """Setting a single address listens on that group only."""
        cfg = load_config(MESH_UDP_GROUP="239.0.0.69")
        assert cfg.MESH_UDP_GROUPS == ("239.0.0.69",)
        assert cfg.MESH_UDP_GROUP == "239.0.0.69"

    def test_invalid_entry_fails_at_import(self, load_config):
        """A bad entry stops startup instead of failing every reconnect.

        Without import-time validation the entry first fails inside
        ``connect()``, which the daemon's generic handler retries forever
        (the failure mode ACCEPTANCE UH-A1 closed for ``PRIMARY_CHANNEL_KEY``).
        """
        with pytest.raises(ValueError, match="MESH_UDP_GROUP entry '10.0.0.1'"):
            load_config(MESH_UDP_GROUP="239.0.0.69,10.0.0.1")

    def test_both_names_are_exported(self):
        """The parsed tuple joins the string setting on the public surface."""
        assert {"MESH_UDP_GROUP", "MESH_UDP_GROUPS"} <= set(config.__all__)


class TestMeshUdpGroupDeploymentSurface:
    """Every packaged default delivers both groups, or defers to the code.

    A packaged default overrides :data:`config.DEFAULT_MESH_UDP_GROUPS`, so a
    surface still pinning ``224.0.0.69`` alone would silently keep that whole
    deployment path on one group.
    """

    def test_image_stages_default_to_both_groups(self):
        """Both ``data/Dockerfile`` stages declare the full default list."""
        text = (REPO_ROOT / "data" / "Dockerfile").read_text(encoding="utf-8")
        assert re.findall(r"^\s*MESH_UDP_GROUP=(\S+)", text, re.MULTILINE) == [
            EXPECTED_SETTING,
            EXPECTED_SETTING,
        ]

    def test_nix_option_defaults_to_both_groups(self):
        """The NixOS ``meshUdpGroup`` option defaults to the full list."""
        text = (REPO_ROOT / "flake.nix").read_text(encoding="utf-8")
        match = re.search(
            r'meshUdpGroup = lib\.mkOption \{.*?default = "([^"]*)";', text, re.S
        )
        assert match, "flake.nix no longer declares the meshUdpGroup option"
        assert match.group(1) == EXPECTED_SETTING

    @pytest.mark.parametrize(
        "path", ["docker-compose.yml", "data/tools/compose.udp.pi.yml"]
    )
    def test_compose_default_is_bare_or_both_groups(self, path):
        """A Compose default is either bare (code default) or the full list."""
        text = (REPO_ROOT / path).read_text(encoding="utf-8")
        match = re.search(r"MESH_UDP_GROUP:\s*\$\{MESH_UDP_GROUP:-([^}]*)\}", text)
        assert match, f"{path} no longer passes MESH_UDP_GROUP through"
        assert match.group(1) in ("", EXPECTED_SETTING)
