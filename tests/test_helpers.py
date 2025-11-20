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

"""Additional tests that exercise defensive helpers and interfaces."""

import importlib
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from data.mesh_ingestor import channels, config, interfaces, queue, serialization


@pytest.fixture(autouse=True)
def reset_state(monkeypatch):
    """Ensure mutable singletons are cleaned up between tests."""

    repo_root = Path(__file__).resolve().parents[1]
    monkeypatch.syspath_prepend(str(repo_root))
    channels._reset_channel_cache()
    yield
    channels._reset_channel_cache()
    importlib.reload(config)


def test_config_module_port_aliases(monkeypatch):
    """Ensure the config module keeps CONNECTION and PORT in sync."""

    reloaded = importlib.reload(config)
    monkeypatch.setattr(reloaded, "CONNECTION", "dev-tty", raising=False)
    reloaded.PORT = "new-port"
    assert reloaded.CONNECTION == "new-port"
    assert reloaded.PORT == "new-port"


def test_queue_stringification_and_ordering():
    """Exercise queue payload formatting and priority ordering."""

    mapping_payload = {"b": 1, "a": 2}
    assert queue._stringify_payload_value(mapping_payload).startswith('{"a"')
    assert queue._stringify_payload_value([1, 2, 3]).startswith("[1")
    assert queue._stringify_payload_value({1, 2}).replace(" ", "") in ("[1,2]", "[2,1]")
    assert queue._stringify_payload_value(b"bytes") == '"bytes"'
    assert queue._stringify_payload_value("text") == '"text"'
    pairs = queue._payload_key_value_pairs(mapping_payload)
    assert pairs.split(" ") == ["a=2", "b=1"]

    state = queue.QueueState()
    order = []
    queue._enqueue_post_json("/low", {"x": 1}, priority=90, state=state)
    queue._enqueue_post_json("/high", {"x": 2}, priority=10, state=state)
    state.active = True
    queue._drain_post_queue(
        state=state, send=lambda path, payload: order.append((path, payload["x"]))
    )
    assert order == [("/high", 2), ("/low", 1)]
    assert state.active is False
    assert state.queue == []


def test_channels_iterator_and_capture(monkeypatch):
    """Verify channel helpers normalise roles and cache primary/secondary entries."""

    channels._reset_channel_cache()

    class StubSettings:
        def __init__(self, name):
            self.name = name

    class PrimaryChannel:
        def __init__(self):
            self.role = "PRIMARY"
            self.settings = StubSettings("Alpha")

    class SecondaryChannel:
        def __init__(self, index, name):
            self.role = "SECONDARY"
            self.index = index
            self.settings = StubSettings(name)

    class Container:
        def __len__(self):
            return 2

        def __getitem__(self, idx):
            if idx == 0:
                return PrimaryChannel()
            if idx == 1:
                return SecondaryChannel(5, "Bravo")
            raise IndexError

    class StubLocalNode:
        def __init__(self):
            self.channels = Container()

    class StubIface:
        def __init__(self):
            self.localNode = StubLocalNode()

        def waitForConfig(self):
            return True

    channels.capture_from_interface(StubIface())
    assert channels.channel_mappings() == ((0, "Alpha"), (5, "Bravo"))
    assert channels.channel_name(5) == "Bravo"
    assert list(channels._iter_channel_objects({"0": "zero"})) == ["zero"]


def test_candidate_node_id_and_normaliser():
    """Ensure node identifiers are found inside nested payloads."""

    nested = {
        "payload": {"meta": {"user": {"id": "0x42"}}},
        "decoded": {"from": "!0000002a"},
    }
    node_id = interfaces._candidate_node_id(nested)
    assert node_id == "!0000002a"

    telemetry_packet = {"id": 123456, "from": "!0000000b"}
    node_id = interfaces._candidate_node_id(telemetry_packet)
    assert node_id == "!0000000b"

    unknown_packet = {"id": "123456"}
    assert interfaces._candidate_node_id(unknown_packet) is None

    preferred_hex_packet = {"id": "0x2a"}
    assert interfaces._candidate_node_id(preferred_hex_packet) == "!0000002a"

    caret_alias_packet = {"id": "^abc"}
    assert interfaces._candidate_node_id(caret_alias_packet) == "^abc"

    non_node_numeric = {"id": 42.0}
    assert interfaces._candidate_node_id(non_node_numeric) is None

    packet = {"user": {"id": "!0000002a"}, "userId": None}
    normalised = interfaces._normalise_nodeinfo_packet(packet)
    assert normalised["id"] == "!0000002a"
    assert normalised["user"]["id"] == "!0000002a"


def test_safe_nodeinfo_wrapper_handles_missing_id():
    """Cover the KeyError guard and wrapper marker."""

    called = {}

    def original(_iface, _packet):
        called["ran"] = True
        raise KeyError("id")

    wrapper = interfaces._build_safe_nodeinfo_callback(original)
    result = wrapper(SimpleNamespace(), {"anything": 1})
    assert called["ran"] is True
    assert result is None
    assert getattr(wrapper, "_potato_mesh_safe_wrapper")


def test_patch_nodeinfo_handler_class(monkeypatch):
    """Ensure NodeInfoHandler subclasses normalise packets with missing ids."""

    class DummyHandler:
        def __init__(self):
            self.calls = []

        def onReceive(self, iface, packet):
            self.calls.append(packet)
            return packet.get("id")

    mesh_interface = types.SimpleNamespace(
        NodeInfoHandler=DummyHandler, __name__="meshtastic.mesh_interface"
    )
    interfaces._patch_nodeinfo_handler_class(mesh_interface)
    handler_cls = mesh_interface.NodeInfoHandler
    handler = handler_cls()
    iface = SimpleNamespace()
    packet = {"user": {"id": "abcd"}}
    result = handler.onReceive(iface, packet)
    assert result == serialization._canonical_node_id("abcd")
    assert handler.calls[0]["id"] == serialization._canonical_node_id("abcd")


def test_region_frequency_and_resolution_helpers():
    """Cover enum name parsing for LoRa region frequency."""

    class EnumValue:
        def __init__(self, name):
            self.name = name

    class EnumType:
        def __init__(self):
            self.values_by_number = {
                1: EnumValue("REGION_915"),
                2: EnumValue("US"),
            }

    class FieldDesc:
        def __init__(self):
            self.enum_type = EnumType()

    class Descriptor:
        def __init__(self):
            self.fields_by_name = {"region": FieldDesc()}

    class LoraMessage:
        def __init__(self, region, override_frequency=None):
            self.region = region
            self.override_frequency = override_frequency
            self.DESCRIPTOR = Descriptor()

    freq = interfaces._region_frequency(LoraMessage(1))
    assert freq == 915

    freq = interfaces._region_frequency(LoraMessage(1, override_frequency=0))
    assert freq == 915

    freq = interfaces._region_frequency(LoraMessage(1, override_frequency=921.5))
    assert freq == 921

    freq = interfaces._region_frequency(LoraMessage(1, override_frequency="915MHz"))
    assert freq == "915MHz"

    freq = interfaces._region_frequency(LoraMessage(2))
    assert freq == "US"

    class StringRegionMessage:
        def __init__(self, region):
            self.region = region

    freq = interfaces._region_frequency(StringRegionMessage("EU"))
    assert freq == "EU"

    class LocalConfig:
        def __init__(self, lora):
            self.lora = lora

    lora_msg = LoraMessage(1)
    resolved = interfaces._resolve_lora_message(LocalConfig(lora_msg))
    assert resolved is lora_msg
