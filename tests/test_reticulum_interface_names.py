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
"""Unit tests for Reticulum interface names without peer addresses (SPEC RI1).

The cases live in ``tests/fixtures/reticulum_interface_names.tsv``, which
``web/spec/interface_names_spec.rb`` reads too, so the ingestor and the web
scrub a name the same way.  Each case this module knows is built from the real
RNS class without ``__init__`` (no socket, no device), so its printed name is
exactly what the pinned RNS prints, and every interface class the pinned RNS
ships has a case.
"""

from __future__ import annotations

import importlib
import inspect
import pkgutil
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:  # pragma: no cover - conftest adds it
    sys.path.insert(0, str(REPO_ROOT))

import RNS.Interfaces  # noqa: E402 - path setup
from RNS.Interfaces.Android.KISSInterface import (  # noqa: E402 - path setup
    KISSInterface as AndroidKISSInterface,
)
from RNS.Interfaces.Android.RNodeInterface import (  # noqa: E402 - path setup
    RNodeInterface as AndroidRNodeInterface,
)
from RNS.Interfaces.Android.SerialInterface import (  # noqa: E402 - path setup
    SerialInterface as AndroidSerialInterface,
)
from RNS.Interfaces.AutoInterface import (  # noqa: E402 - path setup
    AutoInterface,
    AutoInterfacePeer,
)
from RNS.Interfaces.AX25KISSInterface import AX25KISSInterface  # noqa: E402
from RNS.Interfaces.BackboneInterface import (  # noqa: E402 - path setup
    BackboneClientInterface,
    BackboneInterface,
)
from RNS.Interfaces.I2PInterface import (  # noqa: E402 - path setup
    I2PInterface,
    I2PInterfacePeer,
)
from RNS.Interfaces.Interface import Interface  # noqa: E402 - path setup
from RNS.Interfaces.KISSInterface import KISSInterface  # noqa: E402
from RNS.Interfaces.LocalInterface import (  # noqa: E402 - path setup
    LocalClientInterface,
    LocalServerInterface,
)
from RNS.Interfaces.PipeInterface import PipeInterface  # noqa: E402
from RNS.Interfaces.RNodeInterface import RNodeInterface  # noqa: E402
from RNS.Interfaces.RNodeMultiInterface import (  # noqa: E402 - path setup
    RNodeMultiInterface,
    RNodeSubInterface,
)
from RNS.Interfaces.SerialInterface import SerialInterface  # noqa: E402
from RNS.Interfaces.TCPInterface import (  # noqa: E402 - path setup
    TCPClientInterface,
    TCPServerInterface,
)
from RNS.Interfaces.UDPInterface import UDPInterface  # noqa: E402
from RNS.Interfaces.WeaveInterface import (  # noqa: E402 - path setup
    WeaveInterface,
    WeaveInterfacePeer,
)
from test_reticulum_scope_unit import (  # noqa: E402 - shared RNS doubles
    IFACES,
    _bare,
    _Run,
)

import data.mesh_ingestor.config as config  # noqa: E402 - path setup
from data.mesh_ingestor.protocols import reticulum as mod  # noqa: E402
from data.mesh_ingestor.protocols import reticulum_interfaces  # noqa: E402

FIXTURE = REPO_ROOT / "tests" / "fixtures" / "reticulum_interface_names.tsv"
"""The cases shared with the web suite."""

_I2P_PEER = "abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst.b32.i2p"
"""A made-up ``.b32.i2p`` address for an outbound I2P peer's name."""

_I2P_BASE64 = ("AbCdEfGh0123~-IjKlMnOp4567QrStUvWx89YzAB-~" * 13)[:516]
"""A made-up base64 I2P destination, as long as the shortest real one."""


def _cases() -> dict[str, tuple[str, str]]:
    """Read the shared fixture.

    Returns:
        ``{case: (printed name, public name)}`` in file order.
    """
    cases: dict[str, tuple[str, str]] = {}
    for line in FIXTURE.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        case, printed, public = line.split("\t")
        assert case not in cases, f"duplicate case {case}"
        cases[case] = (printed, public)
    return cases


CASES = _cases()
"""Every case of the shared fixture."""

_MULTI = _bare(RNodeMultiInterface, name="Multi Radio")

RNS_CASES = {
    "tcp_client": _bare(
        TCPClientInterface,
        name="RNS Testnet Amsterdam",
        target_ip="amsterdam.connect.reticulum.network",
        target_port=4965,
    ),
    "tcp_client_name_with_slash": _bare(
        TCPClientInterface, name="Hub A/B", target_ip="203.0.113.77", target_port=4242
    ),
    # A TCP server's connecting peer: RNS names it after the server and
    # stamps the peer's address and port (TCPServerInterface.incoming_connection).
    "tcp_server_peer": _bare(
        TCPClientInterface,
        name="Client on Public Hub",
        target_ip="203.0.113.77",
        target_port="51234",
    ),
    "tcp_server_peer_ipv6": _bare(
        TCPClientInterface,
        name="Client on Public Hub",
        target_ip="2001:db8::77",
        target_port="51234",
    ),
    "tcp_server": _bare(
        TCPServerInterface, name="Public Hub", bind_ip="0.0.0.0", bind_port=4242
    ),
    "tcp_server_ipv6": _bare(
        TCPServerInterface, name="Public Hub", bind_ip="::", bind_port=4242
    ),
    "backbone": _bare(
        BackboneInterface, name="Backbone Hub", bind_ip="198.51.100.4", bind_port=4242
    ),
    "backbone_client": _bare(
        BackboneClientInterface,
        name="Backbone Peer",
        target_ip="203.0.113.7",
        target_port=4242,
    ),
    "backbone_peer_ipv6": _bare(
        BackboneClientInterface,
        name="Client on Backbone Hub",
        target_ip="2001:db8::7",
        target_port=39012,
    ),
    "udp": _bare(UDPInterface, name="Local UDP", bind_ip="0.0.0.0", bind_port=4242),
    "udp_ipv6": _bare(
        UDPInterface, name="Local UDP", bind_ip="fe80::1", bind_port=4242
    ),
    "auto_peer": _bare(
        AutoInterfacePeer, ifname="wlan0", addr="fe80::1c2b:3aff:fe4d:5e6f"
    ),
    "weave_peer": _bare(WeaveInterfacePeer, endpoint_addr=bytes.fromhex("0a1b2c3d")),
    "auto": _bare(AutoInterface, name="Default Interface"),
    "weave": _bare(WeaveInterface, name="Weave Link"),
    "i2p": _bare(I2PInterface, name="I2P Link"),
    # I2PInterface names an outbound peer "<name> to <peer>"
    # (I2PInterface.__init__) and an inbound one "Connected peer on <name>".
    "i2p_peer": _bare(I2PInterfacePeer, name=f"I2P Link to {_I2P_PEER}"),
    "i2p_peer_hostname": _bare(I2PInterfacePeer, name="I2P Link to reticulum-hub.i2p"),
    "i2p_peer_base64": _bare(I2PInterfacePeer, name=f"I2P Link to {_I2P_BASE64}"),
    "i2p_peer_name_with_to": _bare(
        I2PInterfacePeer, name=f"Link to Berlin to {_I2P_PEER}"
    ),
    "i2p_connected_peer": _bare(I2PInterfacePeer, name="Connected peer on I2P Link"),
    "local": _bare(LocalClientInterface, socket_path="\0rns/default"),
    "local_tcp": _bare(LocalClientInterface, socket_path=None, target_port=37428),
    "shared_instance": _bare(LocalServerInterface, socket_path="\0rns/default"),
    "shared_instance_tcp": _bare(
        LocalServerInterface, socket_path=None, bind_port=37428
    ),
    "pipe": _bare(PipeInterface, name="Pipe Link"),
    "kiss": _bare(KISSInterface, name="Packet Radio"),
    "ax25_kiss": _bare(AX25KISSInterface, name="AX.25 Radio"),
    "serial": _bare(SerialInterface, name="Serial Link"),
    "serial_name_with_slash": _bare(SerialInterface, name="Shed/North"),
    "rnode": _bare(RNodeInterface, name="RNode Reticulum Berlin"),
    "rnode_name_with_slash": _bare(RNodeInterface, name="LoRa 868/915"),
    "rnode_multi": _MULTI,
    "android_kiss": _bare(AndroidKISSInterface, name="Packet Radio"),
    "android_rnode": _bare(AndroidRNodeInterface, name="RNode Reticulum Berlin"),
    "android_serial": _bare(AndroidSerialInterface, name="Serial Link"),
    "rnode_sub": _bare(RNodeSubInterface, name="868 Low", parent_interface=_MULTI),
    "rnode_sub_with_slash": _bare(
        RNodeSubInterface, name="868/915", parent_interface=_MULTI
    ),
    "rnode_sub_rnode_parent_with_slash": _bare(
        RNodeSubInterface,
        name="868/915",
        parent_interface=_bare(RNodeMultiInterface, name="RNodeMulti"),
    ),
    # The one RNode name the rule cuts: a parent name that reads as a class.
    "rnode_sub_identifier_parent_with_slash": _bare(
        RNodeSubInterface,
        name="868/915",
        parent_interface=_bare(RNodeMultiInterface, name="LoRaMulti"),
    ),
}
"""Cases built from the real RNS class, keyed as in the fixture."""

HAND_MADE = {
    "unknown_class",
    "unknown_class_slashes",
    "unknown_class_without_slash",
    "unknown_class_address_only",
    "tcp_address_only",
    "tcp_cut_in_address",
    "tcp_cut_in_name",
    "i2p_peer_cut",
    "i2p_peer_hostname_upper",
    "i2p_peer_base64_kelvin",
    "i2p_peer_base64_long_s",
    "i2p_peer_base64_kelvin_at_500",
    "i2p_peer_base64_long_s_at_500",
    "weave_peer_cut",
    "unknown_class_cut",
    "rnode_cut",
    "no_brackets",
}
"""Cases no RNS class prints: unknown classes, cut and malformed names, and
names that pin the I2P peer's character classes (no Unicode case folding)."""


def _pinned_interface_classes() -> set[type]:
    """Return every interface class the installed RNS ships.

    Returns:
        Each ``Interface`` subclass defined in a module under
        ``RNS.Interfaces``, the Android ones included.
    """
    classes: set[type] = set()
    prefix = RNS.Interfaces.__name__ + "."
    for info in pkgutil.walk_packages(RNS.Interfaces.__path__, prefix):
        module = importlib.import_module(info.name)
        for obj in vars(module).values():
            if (
                inspect.isclass(obj)
                and issubclass(obj, Interface)
                and obj is not Interface
                and obj.__module__ == module.__name__
            ):
                classes.add(obj)
    return classes


def test_every_pinned_interface_class_has_a_case():
    """The pinned RNS ships no interface class that the cases leave out."""
    covered = {type(iface) for iface in RNS_CASES.values()}
    missing = _pinned_interface_classes() - covered
    assert not missing, sorted(f"{cls.__module__}.{cls.__name__}" for cls in missing)


def test_every_case_is_built_from_rns_or_hand_made():
    """No fixture case goes unchecked, and every built case is in the fixture."""
    assert set(RNS_CASES) | HAND_MADE == set(CASES)
    assert not set(RNS_CASES) & HAND_MADE


@pytest.mark.parametrize("case", sorted(RNS_CASES))
def test_printed_name_is_what_rns_prints(case):
    """Each built case prints the fixture's name, so the fixture is RNS 1.5.7's."""
    assert str(RNS_CASES[case]) == CASES[case][0]


@pytest.mark.parametrize("case", list(CASES))
def test_public_name(case):
    """Each printed name posts as the fixture's public name."""
    printed, public = CASES[case]
    assert reticulum_interfaces.public_interface_name(printed) == public


@pytest.mark.parametrize("case", list(CASES))
def test_public_name_is_idempotent(case):
    """A public name passes through unchanged, as the web scrub and boot rely on."""
    public = CASES[case][1]
    assert reticulum_interfaces.public_interface_name(public) == public


@pytest.mark.parametrize(
    "case",
    [
        "tcp_client",
        "tcp_server_peer",
        "tcp_server_peer_ipv6",
        "tcp_server",
        "backbone",
        "backbone_client",
        "udp",
        "auto_peer",
        "weave_peer",
    ],
)
def test_no_address_survives(case):
    """No host, IP address, port or endpoint of an address-printing class stays."""
    iface = RNS_CASES[case]
    public = reticulum_interfaces.public_interface_name(str(iface))
    for attr in ("target_ip", "target_port", "bind_ip", "bind_port", "addr"):
        value = getattr(iface, attr, None)
        if value is not None:
            assert str(value) not in public
    endpoint = getattr(iface, "endpoint_addr", None)
    if endpoint is not None:
        assert endpoint.hex(":") not in public


@pytest.mark.parametrize(
    "case",
    ["i2p_peer", "i2p_peer_hostname", "i2p_peer_base64", "i2p_peer_name_with_to"],
)
def test_no_i2p_peer_survives(case):
    """An outbound I2P peer's destination goes, its I2PInterface name stays."""
    printed = str(RNS_CASES[case])
    name, _, peer = printed[len("I2PInterfacePeer[") : -1].rpartition(" to ")
    public = reticulum_interfaces.public_interface_name(printed)
    assert peer not in public
    assert public == f"I2PInterfacePeer[{name}]"


@pytest.mark.parametrize(
    "case",
    [
        "rnode",
        "rnode_name_with_slash",
        "rnode_multi",
        "rnode_sub",
        "rnode_sub_with_slash",
        "rnode_sub_rnode_parent_with_slash",
        "android_rnode",
    ],
)
def test_rnode_names_post_unchanged(case):
    """RNode names, a "/" included, post exactly as RNS printed them."""
    printed = str(RNS_CASES[case])
    assert reticulum_interfaces.public_interface_name(printed) == printed


@pytest.mark.parametrize("value", [None, 7, b"TCPInterface[x/1.2.3.4:5]"])
def test_a_value_that_is_no_string_passes_through(value):
    """Only a printed name is rewritten."""
    assert reticulum_interfaces.public_interface_name(value) is value


def test_the_class_prefix_sets_are_disjoint():
    """A printed class prefix has exactly one rule."""
    groups = (
        set(reticulum_interfaces.ADDRESS_INTERFACE_PREFIXES),
        set(reticulum_interfaces.BARE_ADDRESS_INTERFACE_PREFIXES),
        set(reticulum_interfaces.NAME_INTERFACE_PREFIXES),
    )
    for index, group in enumerate(groups):
        for other in groups[index + 1 :]:
            assert not group & other


# ---------------------------------------------------------------------------
# The provider posts the public name (the scope test harness, real RNS names)
# ---------------------------------------------------------------------------

_POSTED = {
    "tcp_peer": "TCPInterface[RNS Testnet Amsterdam]",
    "backbone_peer": "BackboneInterface[Backbone Peer]",
    "auto_peer": "AutoInterfacePeer[eth0]",
    "rnode_peer": "RNodeInterface[RNode LoRa Interface]",
    "rnode_sub_peer": "Multi Radio[868 Low]",
    "own": "LocalInterface[rns/default]",
}
"""The interface each peer of the scope harness posts."""

_ADDRESSES = (
    "amsterdam.connect.reticulum.network",
    "4965",
    "203.0.113.7",
    "4242",
    "fe80::1",
)
"""Every host, address and port the harness's interfaces print."""


def test_every_scope_posts_names_without_peer_addresses(monkeypatch, tmp_path):
    """``*`` posts each peer's interface without its address, in every record.

    The announce records and the node snapshot the daemon posts at connect,
    the host's own destinations included, carry the public name; an RNode, a
    sub-interface and the local socket keep theirs.
    """
    run = _Run(monkeypatch, tmp_path, config._parse_reticulum_interfaces("*"))
    run.connect().announce()
    assert {label: run.record(label)["interface"] for label in _POSTED} == _POSTED
    snapshot = mod.ReticulumProvider().node_snapshot_items(run.iface)
    names = [node.get("interface") for _nid, node in run.upserts + snapshot]
    assert len(names) > len(_POSTED) and all(names)
    assert not [name for name in names for part in _ADDRESSES if part in name]


def test_a_list_matches_the_printed_name_and_posts_the_public_one(
    monkeypatch, tmp_path
):
    """A list fragment may match the address part; the post still omits it."""
    scope = config._parse_reticulum_interfaces("reticulum.network")
    run = _Run(monkeypatch, tmp_path, scope).connect()
    run.announce()
    assert run.ingested == {"tcp_peer", "own"}
    assert run.record("tcp_peer")["interface"] == _POSTED["tcp_peer"]


@pytest.mark.parametrize(
    ("parent", "posted"),
    [("Multi Radio", "Multi Radio[868/915]"), ("LoRaMulti", "LoRaMulti[868]")],
)
def test_the_radio_test_reads_the_printed_name(monkeypatch, tmp_path, parent, posted):
    """A sub-interface whose name holds "/" counts as LoRa, cut or not.

    Its class comes from the stats entry for the printed name, so the record
    keeps the radio metadata also when the posted name is not that entry's: a
    parent name that reads as a class name is cut like an unknown class's
    (SPEC RI1, RL3).  An IP peer still gets none.
    """
    multi = _bare(RNodeMultiInterface, name=parent)
    sub = _bare(RNodeSubInterface, name="868/915", parent_interface=multi)
    monkeypatch.setitem(IFACES, "rnode_sub", sub)
    run = _Run(monkeypatch, tmp_path, config._parse_reticulum_interfaces("*"))
    run.connect().announce("rnode_sub_peer", "tcp_peer")
    record = run.record("rnode_sub_peer")
    assert record["interface"] == posted
    assert (record["lora_freq"], record["modem_preset"]) == (867, "SF8/BW125/CR5")
    assert "lora_freq" not in run.record("tcp_peer")


def test_host_destinations_post_without_a_peer_address(monkeypatch, tmp_path):
    """A host destination read from the path table posts the public name too."""
    run = _Run(monkeypatch, tmp_path, config._parse_reticulum_interfaces("*"))
    own = run.stack.identities["own"]
    nomad = RNS.Destination.hash(own, "nomadnetwork", "node")
    run.stack.paths[nomad] = (0, IFACES["auto_peer"])
    run.connect().announce("own")
    snapshot = mod.ReticulumProvider().node_snapshot_items(run.iface)
    [host] = [
        node
        for _nid, node in snapshot
        if node.get("destination", {}).get("aspect") == "nomadnetwork.node"
    ]
    assert host["interface"] == "AutoInterfacePeer[eth0]"
