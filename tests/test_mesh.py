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

import base64
import enum
import importlib
import json
import re
import sys
import threading
import types

"""End-to-end tests covering the mesh ingestion package."""

from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

from meshtastic_protobuf_stub import build as build_protobuf_stub

import pytest


@pytest.fixture
def mesh_module(monkeypatch):
    """Import :mod:`data.mesh` with stubbed dependencies."""

    repo_root = Path(__file__).resolve().parents[1]
    monkeypatch.syspath_prepend(str(repo_root))

    try:
        import meshtastic as real_meshtastic  # type: ignore
    except Exception:  # pragma: no cover - dependency may be unavailable in CI
        real_meshtastic = None

    real_protobuf = (
        getattr(real_meshtastic, "protobuf", None) if real_meshtastic else None
    )

    # Prefer real google.protobuf modules when available, otherwise provide stubs
    try:
        from google.protobuf import json_format as json_format_mod  # type: ignore
        from google.protobuf import message as message_mod  # type: ignore
    except Exception:  # pragma: no cover - protobuf may be missing in CI
        json_format_mod = types.ModuleType("google.protobuf.json_format")

        def message_to_dict(obj, *_, **__):
            if hasattr(obj, "to_dict"):
                return obj.to_dict()
            if hasattr(obj, "__dict__"):
                return dict(obj.__dict__)
            return {}

        json_format_mod.MessageToDict = message_to_dict

        message_mod = types.ModuleType("google.protobuf.message")

        class DummyProtoMessage:
            pass

        class DummyDecodeError(Exception):
            pass

        message_mod.Message = DummyProtoMessage
        message_mod.DecodeError = DummyDecodeError

        protobuf_mod = types.ModuleType("google.protobuf")
        protobuf_mod.json_format = json_format_mod
        protobuf_mod.message = message_mod

        google_mod = types.ModuleType("google")
        google_mod.protobuf = protobuf_mod

        monkeypatch.setitem(sys.modules, "google", google_mod)
        monkeypatch.setitem(sys.modules, "google.protobuf", protobuf_mod)
        monkeypatch.setitem(sys.modules, "google.protobuf.json_format", json_format_mod)
        monkeypatch.setitem(sys.modules, "google.protobuf.message", message_mod)
    else:
        monkeypatch.setitem(sys.modules, "google.protobuf.json_format", json_format_mod)
        monkeypatch.setitem(sys.modules, "google.protobuf.message", message_mod)

    message_module = sys.modules.get("google.protobuf.message", message_mod)

    # Stub meshtastic.serial_interface.SerialInterface
    serial_interface_mod = types.ModuleType("meshtastic.serial_interface")

    class DummySerialInterface:
        def __init__(self, *_, **__):
            self.closed = False

        def close(self):
            self.closed = True

    serial_interface_mod.SerialInterface = DummySerialInterface

    tcp_interface_mod = types.ModuleType("meshtastic.tcp_interface")

    class DummyTCPInterface:
        def __init__(self, *_, **__):
            self.closed = False

        def close(self):
            self.closed = True

    tcp_interface_mod.TCPInterface = DummyTCPInterface

    ble_interface_mod = types.ModuleType("meshtastic.ble_interface")

    class DummyBLEInterface:
        def __init__(self, *_, **__):
            self.closed = False

        def close(self):
            self.closed = True

    ble_interface_mod.BLEInterface = DummyBLEInterface

    meshtastic_mod = types.ModuleType("meshtastic")
    meshtastic_mod.serial_interface = serial_interface_mod
    meshtastic_mod.tcp_interface = tcp_interface_mod
    meshtastic_mod.ble_interface = ble_interface_mod

    mesh_interface_mod = types.ModuleType("meshtastic.mesh_interface")

    def _default_nodeinfo_callback(iface, packet):
        iface.nodes[packet["id"]] = packet
        return packet["id"]

    class DummyNodeInfoHandler:
        """Stub that mimics Meshtastic's NodeInfo handler semantics."""

        def __init__(self):
            self.callback = getattr(
                meshtastic_mod, "_onNodeInfoReceive", _default_nodeinfo_callback
            )

        def onReceive(self, iface, packet):
            nodes = getattr(iface, "nodes", None)
            if isinstance(nodes, dict):
                nodes[packet["id"]] = packet
            return self.callback(iface, packet)

    mesh_interface_mod.NodeInfoHandler = DummyNodeInfoHandler
    meshtastic_mod.mesh_interface = mesh_interface_mod
    monkeypatch.setitem(sys.modules, "meshtastic.mesh_interface", mesh_interface_mod)

    meshtastic_mod._onNodeInfoReceive = _default_nodeinfo_callback
    if real_protobuf is not None:
        meshtastic_mod.protobuf = real_protobuf
    else:
        serialization_mod = sys.modules.get("data.mesh_ingestor.serialization")
        proto_base = getattr(serialization_mod, "ProtoMessage", message_module.Message)
        decode_error = getattr(message_module, "DecodeError", Exception)
        config_pb2_mod, mesh_pb2_mod = build_protobuf_stub(
            proto_base,
            decode_error,
        )
        protobuf_pkg = types.ModuleType("meshtastic.protobuf")
        protobuf_pkg.config_pb2 = config_pb2_mod
        protobuf_pkg.mesh_pb2 = mesh_pb2_mod
        meshtastic_mod.protobuf = protobuf_pkg
        monkeypatch.setitem(sys.modules, "meshtastic.protobuf", protobuf_pkg)
        monkeypatch.setitem(
            sys.modules, "meshtastic.protobuf.config_pb2", config_pb2_mod
        )
        monkeypatch.setitem(sys.modules, "meshtastic.protobuf.mesh_pb2", mesh_pb2_mod)

    monkeypatch.setitem(sys.modules, "meshtastic", meshtastic_mod)
    monkeypatch.setitem(
        sys.modules, "meshtastic.serial_interface", serial_interface_mod
    )
    monkeypatch.setitem(sys.modules, "meshtastic.tcp_interface", tcp_interface_mod)
    monkeypatch.setitem(sys.modules, "meshtastic.ble_interface", ble_interface_mod)
    if real_protobuf is not None:
        monkeypatch.setitem(sys.modules, "meshtastic.protobuf", real_protobuf)

    # Stub pubsub.pub
    pubsub_mod = types.ModuleType("pubsub")

    class DummyPub:
        def __init__(self):
            self.subscriptions = []

        def subscribe(self, *args, **kwargs):
            self.subscriptions.append((args, kwargs))

    pubsub_mod.pub = DummyPub()
    monkeypatch.setitem(sys.modules, "pubsub", pubsub_mod)

    module_name = "data.mesh_ingestor"
    if module_name in sys.modules:
        module = importlib.reload(sys.modules[module_name])
    else:
        module = importlib.import_module(module_name)

    if hasattr(module, "_clear_post_queue"):
        module._clear_post_queue()

    # Ensure radio metadata starts unset for each test run.
    module.config.LORA_FREQ = None
    module.config.MODEM_PRESET = None
    for attr in ("LORA_FREQ", "MODEM_PRESET"):
        if attr in module.__dict__:
            delattr(module, attr)
    module.channels._reset_channel_cache()

    yield module

    # Ensure a clean import for the next test
    if hasattr(module, "_clear_post_queue"):
        module._clear_post_queue()
    sys.modules.pop(module_name, None)


def test_subscribe_receive_topics_covers_all_handlers(mesh_module, monkeypatch):
    mesh = mesh_module
    daemon_mod = sys.modules["data.mesh_ingestor.daemon"]

    recorded_calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    class RecordingPub:
        def subscribe(self, *args, **kwargs):
            recorded_calls.append((args, kwargs))

    monkeypatch.setattr(daemon_mod, "pub", RecordingPub())

    subscribed_topics = mesh._subscribe_receive_topics()

    expected_topics = list(mesh._RECEIVE_TOPICS)
    assert subscribed_topics == expected_topics
    assert len(recorded_calls) == len(expected_topics)

    for (args, kwargs), topic in zip(recorded_calls, expected_topics):
        assert not kwargs
        assert args[0] is mesh.on_receive
        assert args[1] == topic


def test_snapshot_interval_defaults_to_60_seconds(mesh_module):
    mesh = mesh_module
    assert mesh.SNAPSHOT_SECS == 60


def test_extract_host_node_id_prefers_my_info_fields(mesh_module):
    mesh = mesh_module

    class DummyInterface:
        def __init__(self):
            self.myInfo = {"my_node_num": 0x9E95CF60}

    iface = DummyInterface()

    assert mesh._extract_host_node_id(iface) == "!9e95cf60"


def test_extract_host_node_id_from_nested_info(mesh_module):
    mesh = mesh_module

    class DummyInterface:
        def __init__(self):
            self.myInfo = {"info": {"id": "!cafebabe"}}

    iface = DummyInterface()

    assert mesh._extract_host_node_id(iface) == "!cafebabe"


def test_extract_host_node_id_from_callable(mesh_module):
    mesh = mesh_module

    class CallableNoDict:
        __slots__ = ()

        def __call__(self):
            return {"id": "!f00ba4"}

    class DummyInterface:
        def __init__(self):
            self.localNode = CallableNoDict()

    iface = DummyInterface()

    assert mesh._extract_host_node_id(iface) == "!00f00ba4"


def test_extract_host_node_id_from_my_node_num_attribute(mesh_module):
    mesh = mesh_module

    class DummyInterface:
        def __init__(self):
            self.myNodeNum = 0xDEADBEEF

    iface = DummyInterface()

    assert mesh._extract_host_node_id(iface) == "!deadbeef"


@pytest.mark.parametrize("value", ["mock", "Mock", " disabled "])
def test_create_serial_interface_allows_mock(mesh_module, value):
    mesh = mesh_module

    iface, resolved = mesh._create_serial_interface(value)

    assert resolved == "mock"
    assert isinstance(iface.nodes, dict)
    iface.close()


def test_create_serial_interface_uses_serial_module(mesh_module, monkeypatch):
    mesh = mesh_module
    created = {}
    sentinel = object()

    def fake_interface(*, devPath):
        created["devPath"] = devPath
        return SimpleNamespace(nodes={"!foo": sentinel}, close=lambda: None)

    monkeypatch.setattr(mesh, "SerialInterface", fake_interface)

    iface, resolved = mesh._create_serial_interface("/dev/ttyTEST")

    assert created["devPath"] == "/dev/ttyTEST"
    assert resolved == "/dev/ttyTEST"
    assert iface.nodes == {"!foo": sentinel}


def test_create_serial_interface_uses_tcp_for_ip(mesh_module, monkeypatch):
    mesh = mesh_module
    created = {}

    def fake_tcp_interface(*, hostname, portNumber, **_):
        created["hostname"] = hostname
        created["portNumber"] = portNumber
        return SimpleNamespace(nodes={}, close=lambda: None)

    monkeypatch.setattr(mesh, "TCPInterface", fake_tcp_interface)

    iface, resolved = mesh._create_serial_interface("192.168.1.25:4500")

    assert created == {"hostname": "192.168.1.25", "portNumber": 4500}
    assert resolved == "tcp://192.168.1.25:4500"
    assert iface.nodes == {}


def test_create_serial_interface_defaults_tcp_port(mesh_module, monkeypatch):
    mesh = mesh_module
    created = {}

    def fake_tcp_interface(*, hostname, portNumber, **_):
        created["hostname"] = hostname
        created["portNumber"] = portNumber
        return SimpleNamespace(nodes={}, close=lambda: None)

    monkeypatch.setattr(mesh, "TCPInterface", fake_tcp_interface)

    _, resolved = mesh._create_serial_interface("tcp://10.20.30.40")

    assert created["hostname"] == "10.20.30.40"
    assert created["portNumber"] == mesh._DEFAULT_TCP_PORT
    assert resolved == "tcp://10.20.30.40:4403"


def test_create_serial_interface_plain_ip(mesh_module, monkeypatch):
    mesh = mesh_module
    created = {}

    def fake_tcp_interface(*, hostname, portNumber, **_):
        created["hostname"] = hostname
        created["portNumber"] = portNumber
        return SimpleNamespace(nodes={}, close=lambda: None)

    monkeypatch.setattr(mesh, "TCPInterface", fake_tcp_interface)

    _, resolved = mesh._create_serial_interface(" 192.168.50.10 ")

    assert created["hostname"] == "192.168.50.10"
    assert created["portNumber"] == mesh._DEFAULT_TCP_PORT
    assert resolved == "tcp://192.168.50.10:4403"


def test_create_serial_interface_ble(mesh_module, monkeypatch):
    mesh = mesh_module
    created = {}

    def fake_ble_interface(*, address=None, **_):
        created["address"] = address
        return SimpleNamespace(nodes={}, close=lambda: None)

    monkeypatch.setattr(mesh, "BLEInterface", fake_ble_interface)

    iface, resolved = mesh._create_serial_interface("ed:4d:9e:95:cf:60")

    assert created["address"] == "ED:4D:9E:95:CF:60"
    assert resolved == "ED:4D:9E:95:CF:60"
    assert iface.nodes == {}


def test_ensure_radio_metadata_extracts_config(mesh_module, capsys):
    mesh = mesh_module

    class DummyEnumValue:
        def __init__(self, name: str) -> None:
            self.name = name

    class DummyEnum:
        def __init__(self, mapping: dict[int, str]) -> None:
            self.values_by_number = {
                number: DummyEnumValue(name) for number, name in mapping.items()
            }

    class DummyField:
        def __init__(self, enum_type=None) -> None:
            self.enum_type = enum_type

    class DummyDescriptor:
        def __init__(self, fields: dict[str, DummyField]) -> None:
            self.fields_by_name = fields

    def make_lora(
        region_value: int,
        region_name: str,
        preset_value: int,
        preset_name: str,
        *,
        preset_field: str = "modem_preset",
    ):
        descriptor = DummyDescriptor(
            {
                "region": DummyField(DummyEnum({region_value: region_name})),
                preset_field: DummyField(DummyEnum({preset_value: preset_name})),
            }
        )

        class DummyLora:
            DESCRIPTOR = descriptor

            def __init__(self) -> None:
                self.region = region_value
                setattr(self, preset_field, preset_value)

            def HasField(self, name: str) -> bool:  # noqa: D401 - simple proxy
                return hasattr(self, name)

        return DummyLora()

    class DummyRadio:
        def __init__(self, lora) -> None:
            self.lora = lora

        def HasField(self, name: str) -> bool:
            return hasattr(self, name)

    class DummyConfig:
        def __init__(self, lora, *, expose_direct: bool) -> None:
            if expose_direct:
                self.lora = lora
            else:
                self.radio = DummyRadio(lora)

        def HasField(self, name: str) -> bool:  # noqa: D401 - mimics protobuf API
            return hasattr(self, name)

    class DummyLocalNode:
        def __init__(self, config) -> None:
            self.localConfig = config

    class DummyInterface:
        def __init__(self, local_config) -> None:
            self.localNode = DummyLocalNode(local_config)
            self.wait_calls = 0

        def waitForConfig(self) -> None:  # noqa: D401 - matches Meshtastic API
            self.wait_calls += 1

    primary_lora = make_lora(3, "EU_868", 4, "MEDIUM_FAST")
    iface = DummyInterface(DummyConfig(primary_lora, expose_direct=False))

    mesh._ensure_radio_metadata(iface)
    first_log = capsys.readouterr().out

    assert iface.wait_calls == 1
    assert mesh.config.LORA_FREQ == 868
    assert mesh.config.MODEM_PRESET == "MediumFast"
    assert "Captured LoRa radio metadata" in first_log
    assert "lora_freq=868" in first_log
    assert "modem_preset='MediumFast'" in first_log

    secondary_lora = make_lora(7, "US_915", 2, "LONG_FAST", preset_field="preset")
    second_iface = DummyInterface(DummyConfig(secondary_lora, expose_direct=True))

    mesh._ensure_radio_metadata(second_iface)
    second_log = capsys.readouterr().out

    assert second_iface.wait_calls == 1
    assert mesh.config.LORA_FREQ == 868
    assert mesh.config.MODEM_PRESET == "MediumFast"
    assert second_log == ""


def test_capture_channels_from_interface_records_metadata(mesh_module, capsys):
    mesh = mesh_module

    mesh.config.MODEM_PRESET = "MediumFast"
    mesh.channels._reset_channel_cache()

    class DummyInterface:
        def __init__(self) -> None:
            self.wait_calls = 0
            primary = SimpleNamespace(
                role=1, settings=SimpleNamespace(name=" radioamator ")
            )
            secondary = SimpleNamespace(
                role="SECONDARY",
                index="7",
                settings=SimpleNamespace(name="TestChannel"),
            )
            self.localNode = SimpleNamespace(channels=[primary, secondary])

        def waitForConfig(self) -> None:  # noqa: D401 - matches interface contract
            self.wait_calls += 1

    iface = DummyInterface()

    mesh.channels.capture_from_interface(iface)
    log_output = capsys.readouterr().out

    assert iface.wait_calls == 1
    assert mesh.channels.channel_mappings() == ((0, "radioamator"), (7, "TestChannel"))
    assert mesh.channels.channel_name(7) == "TestChannel"
    assert "Captured channel metadata" in log_output
    assert "channels=((0, 'radioamator'), (7, 'TestChannel'))" in log_output

    mesh.channels.capture_from_interface(SimpleNamespace(localNode=None))
    assert mesh.channels.channel_mappings() == ((0, "radioamator"), (7, "TestChannel"))


def test_capture_channels_primary_falls_back_to_env(mesh_module, monkeypatch, capsys):
    mesh = mesh_module

    mesh.config.MODEM_PRESET = None
    mesh.channels._reset_channel_cache()
    monkeypatch.setenv("CHANNEL", "FallbackName")

    class DummyInterface:
        def __init__(self) -> None:
            self.localNode = SimpleNamespace(
                channels={"primary": SimpleNamespace(role="PRIMARY")}
            )

        def waitForConfig(self) -> None:  # noqa: D401 - placeholder
            return None

    mesh.channels._reset_channel_cache()
    mesh.channels.capture_from_interface(DummyInterface())
    log_output = capsys.readouterr().out

    assert mesh.channels.channel_mappings() == ((0, "FallbackName"),)
    assert mesh.channels.channel_name(0) == "FallbackName"
    assert "FallbackName" in log_output


def test_capture_channels_primary_falls_back_to_preset(mesh_module, capsys):
    mesh = mesh_module

    mesh.config.MODEM_PRESET = " MediumFast "
    mesh.channels._reset_channel_cache()

    class DummyInterface:
        def __init__(self) -> None:
            self.localNode = SimpleNamespace(
                channels=[SimpleNamespace(role="PRIMARY", settings=SimpleNamespace())]
            )

        def waitForConfig(self) -> None:  # noqa: D401 - matches interface contract
            return None

    mesh.channels.capture_from_interface(DummyInterface())
    log_output = capsys.readouterr().out

    assert mesh.channels.channel_mappings() == ((0, "MediumFast"),)
    assert mesh.channels.channel_name(0) == "MediumFast"
    assert "MediumFast" in log_output


def test_create_default_interface_falls_back_to_tcp(mesh_module, monkeypatch):
    mesh = mesh_module
    attempts = []

    def fake_targets():
        return ["/dev/ttyFAIL"]

    def fake_create(port):
        attempts.append(port)
        if port.startswith("/dev/tty"):
            raise RuntimeError("missing serial device")
        return SimpleNamespace(nodes={}, close=lambda: None), "tcp://127.0.0.1:4403"

    monkeypatch.setattr(mesh, "_default_serial_targets", fake_targets)
    monkeypatch.setattr(mesh, "_create_serial_interface", fake_create)

    iface, resolved = mesh._create_default_interface()

    assert attempts == ["/dev/ttyFAIL", mesh._DEFAULT_TCP_TARGET]
    assert resolved == "tcp://127.0.0.1:4403"
    assert iface.nodes == {}


def test_create_default_interface_raises_when_unavailable(mesh_module, monkeypatch):
    mesh = mesh_module

    monkeypatch.setattr(mesh, "_default_serial_targets", lambda: ["/dev/ttyFAIL"])

    def always_fail(port):
        raise RuntimeError(f"boom for {port}")

    monkeypatch.setattr(mesh, "_create_serial_interface", always_fail)

    with pytest.raises(mesh.NoAvailableMeshInterface) as exc_info:
        mesh._create_default_interface()

    assert "/dev/ttyFAIL" in str(exc_info.value)


def test_node_to_dict_handles_nested_structures(mesh_module):
    mesh = mesh_module

    @dataclass
    class Child:
        number: int

    class DummyProto(mesh.ProtoMessage):
        def __init__(self, **payload):
            self._payload = payload

        def to_dict(self):
            return self._payload

    @dataclass
    class Node:
        info: Child
        proto: DummyProto
        payload: bytes
        seq: list

    node = Node(Child(5), DummyProto(value=7), b"hi", [Child(1), DummyProto(value=9)])

    result = mesh._node_to_dict(node)
    assert result["info"] == {"number": 5}
    assert result["proto"] == {"value": 7}
    assert result["payload"] == "hi"
    assert result["seq"] == [{"number": 1}, {"value": 9}]


def test_store_packet_dict_posts_text_message(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    mesh.config.LORA_FREQ = 868
    mesh.config.MODEM_PRESET = "MediumFast"

    packet = {
        "id": 123,
        "rxTime": 1_700_000_000,
        "fromId": "!abc",
        "toId": "!def",
        "channel": "2",
        "hopLimit": "3",
        "snr": "1.25",
        "rxRssi": "-70",
        "decoded": {
            "payload": {"text": "hello"},
            "portnum": "TEXT_MESSAGE_APP",
            "channel": 4,
        },
    }

    mesh.store_packet_dict(packet)

    assert captured, "Expected POST to be triggered for text message"
    path, payload, priority = captured[0]
    assert path == "/api/messages"
    assert payload["id"] == 123
    assert payload["channel"] == 4
    assert payload["from_id"] == "!abc"
    assert payload["to_id"] == "!def"
    assert payload["text"] == "hello"
    assert payload["portnum"] == "TEXT_MESSAGE_APP"
    assert payload["rx_time"] == 1_700_000_000
    assert payload["rx_iso"] == mesh._iso(1_700_000_000)
    assert payload["hop_limit"] == 3
    assert payload["snr"] == pytest.approx(1.25)
    assert payload["rssi"] == -70
    assert payload["reply_id"] is None
    assert payload["emoji"] is None
    assert payload["lora_freq"] == 868
    assert payload["modem_preset"] == "MediumFast"
    assert priority == mesh._MESSAGE_POST_PRIORITY


def test_store_packet_dict_posts_reaction_message(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    packet = {
        "id": 999,
        "rxTime": 1_700_100_000,
        "fromId": "!reply",
        "toId": "!root",
        "decoded": {
            "portnum": "REACTION_APP",
            "data": {
                "reply_id": "123",
                "emoji": " 👍 ",
            },
        },
    }

    mesh.store_packet_dict(packet)

    assert captured, "Expected POST to be triggered for reaction message"
    path, payload, priority = captured[0]
    assert path == "/api/messages"
    assert payload["id"] == 999
    assert payload["from_id"] == "!reply"
    assert payload["to_id"] == "!root"
    assert payload["portnum"] == "REACTION_APP"
    assert payload["text"] is None
    assert payload["reply_id"] == 123
    assert payload["emoji"] == "👍"
    assert payload["rx_time"] == 1_700_100_000
    assert payload["rx_iso"] == mesh._iso(1_700_100_000)
    assert priority == mesh._MESSAGE_POST_PRIORITY


def test_store_packet_dict_posts_position(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    mesh.config.LORA_FREQ = 868
    mesh.config.MODEM_PRESET = "MediumFast"

    packet = {
        "id": 200498337,
        "rxTime": 1_758_624_186,
        "fromId": "!b1fa2b07",
        "toId": "^all",
        "rxSnr": -9.5,
        "rxRssi": -104,
        "decoded": {
            "portnum": "POSITION_APP",
            "bitfield": 1,
            "position": {
                "latitudeI": int(52.518912 * 1e7),
                "longitudeI": int(13.5512064 * 1e7),
                "altitude": -16,
                "time": 1_758_624_189,
                "locationSource": "LOC_INTERNAL",
                "precisionBits": 17,
                "satsInView": 7,
                "PDOP": 211,
                "groundSpeed": 2,
                "groundTrack": 0,
                "raw": {
                    "latitude_i": int(52.518912 * 1e7),
                    "longitude_i": int(13.5512064 * 1e7),
                    "altitude": -16,
                    "time": 1_758_624_189,
                },
            },
            "payload": {
                "__bytes_b64__": "DQDATR8VAMATCBjw//////////8BJb150mgoAljTAXgCgAEAmAEHuAER",
            },
        },
    }

    mesh.store_packet_dict(packet)

    assert captured, "Expected POST to be triggered for position packet"
    path, payload, priority = captured[0]
    assert path == "/api/positions"
    assert priority == mesh._POSITION_POST_PRIORITY
    assert payload["id"] == 200498337
    assert payload["node_id"] == "!b1fa2b07"
    assert payload["node_num"] == int("b1fa2b07", 16)
    assert payload["num"] == payload["node_num"]
    assert payload["rx_time"] == 1_758_624_186
    assert payload["rx_iso"] == mesh._iso(1_758_624_186)
    assert payload["latitude"] == pytest.approx(52.518912)
    assert payload["longitude"] == pytest.approx(13.5512064)
    assert payload["altitude"] == pytest.approx(-16)
    assert payload["position_time"] == 1_758_624_189
    assert payload["location_source"] == "LOC_INTERNAL"
    assert payload["precision_bits"] == 17
    assert payload["sats_in_view"] == 7
    assert payload["pdop"] == pytest.approx(211.0)
    assert payload["ground_speed"] == pytest.approx(2.0)
    assert payload["ground_track"] == pytest.approx(0.0)
    assert payload["snr"] == pytest.approx(-9.5)
    assert payload["rssi"] == -104
    assert payload["hop_limit"] is None
    assert payload["bitfield"] == 1
    assert (
        payload["payload_b64"]
        == "DQDATR8VAMATCBjw//////////8BJb150mgoAljTAXgCgAEAmAEHuAER"
    )
    assert payload["lora_freq"] == 868
    assert payload["modem_preset"] == "MediumFast"
    assert payload["raw"]["time"] == 1_758_624_189


def test_store_packet_dict_posts_neighborinfo(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    mesh.config.LORA_FREQ = 868
    mesh.config.MODEM_PRESET = "MediumFast"

    packet = {
        "id": 2049886869,
        "rxTime": 1_758_884_186,
        "fromId": "!7c5b0920",
        "decoded": {
            "portnum": "NEIGHBORINFO_APP",
            "neighborinfo": {
                "nodeId": 0x7C5B0920,
                "lastSentById": 0x9E3AA2F0,
                "nodeBroadcastIntervalSecs": 1800,
                "neighbors": [
                    {"nodeId": 0x2B2A4D51, "snr": -6.5},
                    {"nodeId": 0x437FE3E0, "snr": -2.75, "rxTime": 1_758_884_150},
                    {"nodeId": "!0badc0de", "snr": None},
                ],
            },
        },
    }

    mesh.store_packet_dict(packet)

    assert captured, "Expected POST to be triggered for neighbor info"
    path, payload, priority = captured[0]
    assert path == "/api/neighbors"
    assert priority == mesh._NEIGHBOR_POST_PRIORITY
    assert payload["node_id"] == "!7c5b0920"
    assert payload["node_num"] == 0x7C5B0920
    assert payload["rx_time"] == 1_758_884_186
    assert payload["node_broadcast_interval_secs"] == 1800
    assert payload["last_sent_by_id"] == "!9e3aa2f0"
    neighbors = payload["neighbors"]
    assert len(neighbors) == 3
    assert neighbors[0]["neighbor_id"] == "!2b2a4d51"
    assert neighbors[0]["neighbor_num"] == 0x2B2A4D51
    assert neighbors[0]["rx_time"] == 1_758_884_186
    assert neighbors[0]["snr"] == pytest.approx(-6.5)
    assert neighbors[1]["neighbor_id"] == "!437fe3e0"
    assert neighbors[1]["rx_time"] == 1_758_884_150
    assert neighbors[1]["snr"] == pytest.approx(-2.75)
    assert neighbors[2]["neighbor_id"] == "!0badc0de"
    assert neighbors[2]["neighbor_num"] == 0x0BAD_C0DE
    assert payload["lora_freq"] == 868
    assert payload["modem_preset"] == "MediumFast"


def test_store_packet_dict_handles_nodeinfo_packet(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    mesh.config.LORA_FREQ = 868
    mesh.config.MODEM_PRESET = "MediumFast"

    from meshtastic.protobuf import config_pb2, mesh_pb2

    node_info = mesh_pb2.NodeInfo()
    node_info.num = 321
    user = node_info.user
    user.id = "!abcd1234"
    user.short_name = "LoRa"
    user.long_name = "LoRa Node"
    user.role = config_pb2.Config.DeviceConfig.Role.Value("CLIENT")
    user.hw_model = mesh_pb2.HardwareModel.Value("TBEAM")
    node_info.device_metrics.battery_level = 87
    node_info.device_metrics.voltage = 3.91
    node_info.device_metrics.channel_utilization = 5.5
    node_info.device_metrics.air_util_tx = 0.12
    node_info.device_metrics.uptime_seconds = 4321
    node_info.position.latitude_i = int(52.5 * 1e7)
    node_info.position.longitude_i = int(13.4 * 1e7)
    node_info.position.altitude = 48
    node_info.position.time = 1_700_000_050
    node_info.position.location_source = mesh_pb2.Position.LocSource.Value(
        "LOC_INTERNAL"
    )
    node_info.snr = 9.5
    node_info.last_heard = 1_700_000_040
    node_info.hops_away = 2
    node_info.is_favorite = True

    payload_b64 = base64.b64encode(node_info.SerializeToString()).decode()
    packet = {
        "id": 999,
        "rxTime": 1_700_000_200,
        "from": int("abcd1234", 16),
        "rxSnr": -5.5,
        "decoded": {
            "portnum": "NODEINFO_APP",
            "payload": {"__bytes_b64__": payload_b64},
        },
    }

    mesh.store_packet_dict(packet)

    assert captured, "Expected nodeinfo packet to trigger POST"
    path, payload, priority = captured[0]
    assert path == "/api/nodes"
    assert priority == mesh._NODE_POST_PRIORITY
    assert "!abcd1234" in payload
    node_entry = payload["!abcd1234"]
    assert node_entry["num"] == 321
    assert node_entry["lastHeard"] == 1_700_000_200
    assert node_entry["snr"] == pytest.approx(9.5)
    assert node_entry["hopsAway"] == 2
    assert node_entry["isFavorite"] is True
    assert node_entry["user"]["shortName"] == "LoRa"
    assert node_entry["deviceMetrics"]["batteryLevel"] == pytest.approx(87)
    assert node_entry["deviceMetrics"]["voltage"] == pytest.approx(3.91)
    assert node_entry["deviceMetrics"]["uptimeSeconds"] == 4321
    assert node_entry["position"]["latitude"] == pytest.approx(52.5)
    assert node_entry["position"]["longitude"] == pytest.approx(13.4)
    assert node_entry["position"]["time"] == 1_700_000_050
    assert node_entry["lora_freq"] == 868
    assert node_entry["modem_preset"] == "MediumFast"


def test_store_packet_dict_handles_user_only_nodeinfo(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    mesh.config.LORA_FREQ = 868
    mesh.config.MODEM_PRESET = "MediumFast"

    from meshtastic.protobuf import mesh_pb2

    user_msg = mesh_pb2.User()
    user_msg.id = "!11223344"
    user_msg.short_name = "Test"
    user_msg.long_name = "Test Node"

    payload_b64 = base64.b64encode(user_msg.SerializeToString()).decode()
    packet = {
        "id": 42,
        "rxTime": 1_234,
        "from": int("11223344", 16),
        "decoded": {
            "portnum": "NODEINFO_APP",
            "payload": {"__bytes_b64__": payload_b64},
            "user": {
                "id": "!11223344",
                "shortName": "Test",
                "longName": "Test Node",
                "hwModel": "HELTEC_V3",
            },
        },
    }

    mesh.store_packet_dict(packet)

    assert captured
    _, payload, _ = captured[0]
    node_entry = payload["!11223344"]
    assert node_entry["lastHeard"] == 1_234
    assert node_entry["user"]["longName"] == "Test Node"
    assert "deviceMetrics" not in node_entry
    assert node_entry["lora_freq"] == 868
    assert node_entry["modem_preset"] == "MediumFast"


def test_store_packet_dict_nodeinfo_merges_proto_user(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    mesh.config.LORA_FREQ = 868
    mesh.config.MODEM_PRESET = "MediumFast"

    from meshtastic.protobuf import mesh_pb2

    user_msg = mesh_pb2.User()
    user_msg.id = "!44556677"
    user_msg.short_name = "Proto"
    user_msg.long_name = "Proto User"

    node_info = mesh_pb2.NodeInfo()
    node_info.snr = 2.5

    payload_b64 = base64.b64encode(node_info.SerializeToString()).decode()
    packet = {
        "id": 73,
        "rxTime": 5_000,
        "fromId": "!44556677",
        "decoded": {
            "portnum": "NODEINFO_APP",
            "payload": {"__bytes_b64__": payload_b64},
            "user": user_msg,
        },
    }

    mesh.store_packet_dict(packet)

    assert captured
    _, payload, _ = captured[0]
    node_entry = payload["!44556677"]
    assert node_entry["lastHeard"] == 5_000
    assert node_entry["user"]["shortName"] == "Proto"
    assert node_entry["user"]["longName"] == "Proto User"
    assert node_entry["lora_freq"] == 868
    assert node_entry["modem_preset"] == "MediumFast"


def test_store_packet_dict_nodeinfo_sanitizes_nested_proto(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    mesh.config.LORA_FREQ = 868
    mesh.config.MODEM_PRESET = "MediumFast"

    from meshtastic.protobuf import mesh_pb2

    user_msg = mesh_pb2.User()
    user_msg.id = "!55667788"
    user_msg.short_name = "Nested"

    node_info = mesh_pb2.NodeInfo()
    node_info.hops_away = 1

    payload_b64 = base64.b64encode(node_info.SerializeToString()).decode()
    packet = {
        "id": 74,
        "rxTime": 6_000,
        "fromId": "!55667788",
        "decoded": {
            "portnum": "NODEINFO_APP",
            "payload": {"__bytes_b64__": payload_b64},
            "user": {
                "id": "!55667788",
                "shortName": "Nested",
                "raw": user_msg,
            },
        },
    }

    mesh.store_packet_dict(packet)

    assert captured
    _, payload, _ = captured[0]
    node_entry = payload["!55667788"]
    assert node_entry["user"]["shortName"] == "Nested"
    assert isinstance(node_entry["user"]["raw"], dict)
    assert node_entry["user"]["raw"]["id"] == "!55667788"
    assert node_entry["lora_freq"] == 868
    assert node_entry["modem_preset"] == "MediumFast"


def test_store_packet_dict_nodeinfo_uses_from_id_when_user_missing(
    mesh_module, monkeypatch
):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    mesh.config.LORA_FREQ = 868
    mesh.config.MODEM_PRESET = "MediumFast"

    from meshtastic.protobuf import mesh_pb2

    node_info = mesh_pb2.NodeInfo()
    node_info.snr = 1.5
    node_info.last_heard = 100

    payload_b64 = base64.b64encode(node_info.SerializeToString()).decode()
    packet = {
        "id": 7,
        "rxTime": 200,
        "from": 0x01020304,
        "decoded": {"portnum": 5, "payload": {"__bytes_b64__": payload_b64}},
    }

    mesh.store_packet_dict(packet)

    assert captured
    _, payload, _ = captured[0]
    assert "!01020304" in payload


def test_nodeinfo_wrapper_infers_missing_identifier(mesh_module, monkeypatch):
    """Ensure the Meshtastic nodeinfo hook derives canonical IDs from payloads."""

    _ = mesh_module
    import meshtastic
    from data.mesh_ingestor import interfaces

    captured_packets: list[dict] = []

    def _original_handler(iface, packet):
        captured_packets.append(packet)
        return packet["id"]

    monkeypatch.setattr(
        meshtastic, "_onNodeInfoReceive", _original_handler, raising=False
    )
    interfaces._patch_meshtastic_nodeinfo_handler()

    safe_handler = meshtastic._onNodeInfoReceive

    class DummyUser:
        def __init__(self) -> None:
            self.num = 0x88776655

    class DummyDecoded:
        def __init__(self) -> None:
            self.user = DummyUser()

    class DummyPacket:
        def __init__(self) -> None:
            self.decoded = DummyDecoded()

    iface = types.SimpleNamespace(nodes={})

    safe_handler(iface, DummyPacket())

    assert captured_packets, "Expected wrapper to call the original handler"
    packet = captured_packets[0]
    assert packet["id"] == "!88776655"


def test_nodeinfo_handler_wrapper_prevents_key_error(mesh_module):
    """The NodeInfo handler should operate safely when the ID field is absent."""

    import meshtastic
    from data.mesh_ingestor import interfaces

    interfaces._patch_meshtastic_nodeinfo_handler()

    assert getattr(
        meshtastic.mesh_interface.NodeInfoHandler,
        "_potato_mesh_safe_wrapper",
        False,
    ), "Expected NodeInfoHandler to be replaced with a safe subclass"

    handler = meshtastic.mesh_interface.NodeInfoHandler()
    iface = types.SimpleNamespace(nodes={})

    packet = {"decoded": {"user": {"id": "!01020304"}}}

    result = handler.onReceive(iface, packet)

    assert iface.nodes["!01020304"]["id"] == "!01020304"
    assert result == "!01020304"


def test_interfaces_patch_handles_preimported_serial():
    """Regression: importing serial module before patch still updates handler."""

    preserved_modules: dict[str, types.ModuleType | None] = {}
    module_names = [
        "data.mesh_ingestor.interfaces",
        "data.mesh_ingestor",
        "meshtastic.serial_interface",
        "meshtastic.tcp_interface",
        "meshtastic.mesh_interface",
        "meshtastic",
    ]
    for name in module_names:
        preserved_modules[name] = sys.modules.pop(name, None)

    try:

        def _default_nodeinfo_callback(_iface, packet):
            return packet["id"]

        mesh_interface_mod = types.ModuleType("meshtastic.mesh_interface")

        class DummyNodeInfoHandler:
            """Stub that mirrors Meshtastic's original handler semantics."""

            def __init__(self) -> None:
                self.callback = _default_nodeinfo_callback

            def onReceive(self, iface, packet):  # noqa: D401 - simple passthrough
                return self.callback(iface, packet)

        mesh_interface_mod.NodeInfoHandler = DummyNodeInfoHandler

        serial_interface_mod = types.ModuleType("meshtastic.serial_interface")

        class DummySerialInterface:
            def __init__(self, *_, **__):
                self.nodes = {}

            def close(self):  # noqa: D401 - mimic Meshtastic close API
                self.nodes.clear()

        serial_interface_mod.SerialInterface = DummySerialInterface
        serial_interface_mod.NodeInfoHandler = DummyNodeInfoHandler

        tcp_interface_mod = types.ModuleType("meshtastic.tcp_interface")

        class DummyTCPInterface:
            def __init__(self, *_, **__):
                self.nodes = {}

            def close(self):  # noqa: D401 - mimic Meshtastic close API
                self.nodes.clear()

        tcp_interface_mod.TCPInterface = DummyTCPInterface

        meshtastic_mod = types.ModuleType("meshtastic")
        meshtastic_mod.__path__ = []  # mark as package for import machinery
        meshtastic_mod._onNodeInfoReceive = _default_nodeinfo_callback
        meshtastic_mod.mesh_interface = mesh_interface_mod
        meshtastic_mod.serial_interface = serial_interface_mod
        meshtastic_mod.tcp_interface = tcp_interface_mod

        sys.modules["meshtastic"] = meshtastic_mod
        sys.modules["meshtastic.mesh_interface"] = mesh_interface_mod
        sys.modules["meshtastic.serial_interface"] = serial_interface_mod
        sys.modules["meshtastic.tcp_interface"] = tcp_interface_mod

        serial_module = importlib.import_module("meshtastic.serial_interface")
        assert serial_module.NodeInfoHandler is DummyNodeInfoHandler

        interfaces = importlib.import_module("data.mesh_ingestor.interfaces")

        patched_handler = serial_module.NodeInfoHandler
        assert patched_handler is not DummyNodeInfoHandler
        assert getattr(patched_handler, "_potato_mesh_safe_wrapper", False)

        handler = patched_handler()
        iface = types.SimpleNamespace(nodes={})

        assert handler.onReceive(iface, {}) is None
        assert iface.nodes == {}

        patched_callback = getattr(meshtastic_mod, "_onNodeInfoReceive")
        assert getattr(patched_callback, "_potato_mesh_safe_wrapper", False)

        assert interfaces.SerialInterface is DummySerialInterface
    finally:
        for name in module_names:
            sys.modules.pop(name, None)
        for name, module in preserved_modules.items():
            if module is not None:
                sys.modules[name] = module


def test_store_packet_dict_ignores_non_text(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda *args, **kwargs: captured.append((args, kwargs)),
    )

    packet = {
        "id": 456,
        "rxTime": 1_700_000_100,
        "fromId": "!abc",
        "toId": "!def",
        "decoded": {
            "payload": {"text": "ignored"},
            "portnum": "ENVIRONMENTAL_MEASUREMENT",
        },
    }

    mesh.store_packet_dict(packet)

    assert not captured, "Non-text messages should not be queued"


def test_node_items_snapshot_handles_transient_runtime_error(mesh_module):
    mesh = mesh_module

    class FlakyDict(dict):
        def __init__(self):
            super().__init__({"node": {"foo": "bar"}})
            self.calls = 0

        def items(self):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("dictionary changed size during iteration")
            return super().items()

    nodes = FlakyDict()
    snapshot = mesh._node_items_snapshot(nodes, retries=3)

    assert snapshot == [("node", {"foo": "bar"})]
    assert nodes.calls == 2


def test_node_items_snapshot_returns_none_when_still_mutating(mesh_module):
    mesh = mesh_module

    class AlwaysChanging(dict):
        def __init__(self):
            super().__init__({"node": {"foo": "bar"}})

        def items(self):
            raise RuntimeError("dictionary changed size during iteration")

    nodes = AlwaysChanging()
    snapshot = mesh._node_items_snapshot(nodes, retries=2)

    assert snapshot is None


def test_get_handles_dicts_and_objects(mesh_module):
    mesh = mesh_module

    class Dummy:
        value = "obj"

    assert mesh._get({"key": 1}, "key") == 1
    assert mesh._get({"key": 1}, "missing", "fallback") == "fallback"
    dummy = Dummy()
    assert mesh._get(dummy, "value") == "obj"
    assert mesh._get(dummy, "missing", "default") == "default"


def test_post_json_skips_without_instance(mesh_module, monkeypatch):
    mesh = mesh_module
    monkeypatch.setattr(mesh, "INSTANCE", "")

    def fail_request(*_, **__):
        raise AssertionError("Request should not be created when INSTANCE is empty")

    monkeypatch.setattr(mesh.urllib.request, "Request", fail_request)
    mesh._post_json("/ignored", {"foo": "bar"})


def test_post_json_sends_payload_with_token(mesh_module, monkeypatch):
    mesh = mesh_module
    monkeypatch.setattr(mesh, "INSTANCE", "https://example.test")
    monkeypatch.setattr(mesh, "API_TOKEN", "secret")

    captured = {}

    def fake_urlopen(req, timeout=0):
        captured["req"] = req

        class DummyResponse:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return b"ok"

        return DummyResponse()

    monkeypatch.setattr(mesh.urllib.request, "urlopen", fake_urlopen)

    mesh._post_json("/api/test", {"hello": "world"})

    req = captured["req"]
    assert req.full_url == "https://example.test/api/test"
    assert req.headers["Content-type"] == "application/json"
    assert req.get_header("Authorization") == "Bearer secret"
    assert mesh.json.loads(req.data.decode("utf-8")) == {"hello": "world"}


def test_node_to_dict_handles_non_utf8_bytes(mesh_module):
    mesh = mesh_module

    @dataclass
    class Node:
        payload: bytes
        other: object

    class Custom:
        def __str__(self):
            return "custom!"

    node = Node(b"\xff", Custom())
    result = mesh._node_to_dict(node)

    assert result["payload"] == "ff"
    assert result["other"] == "custom!"


def test_first_prefers_first_non_empty_value(mesh_module):
    mesh = mesh_module
    data = {"primary": {"value": ""}, "secondary": {"value": "found"}}

    assert mesh._first(data, "primary.value", "secondary.value") == "found"
    assert mesh._first(data, "missing.path", default="fallback") == "fallback"


def test_first_handles_attribute_sources(mesh_module):
    mesh = mesh_module
    ns = SimpleNamespace(empty=None, value="attr")

    assert mesh._first(ns, "empty", "value") == "attr"


def test_pkt_to_dict_handles_dict_and_proto(mesh_module, monkeypatch):
    mesh = mesh_module

    assert mesh._pkt_to_dict({"a": 1}) == {"a": 1}

    class DummyProto(mesh.ProtoMessage):
        def to_dict(self):
            return {"value": 5}

    assert mesh._pkt_to_dict(DummyProto()) == {"value": 5}

    class Unknown:
        pass

    def broken_dumps(*_, **__):
        raise TypeError("boom")

    monkeypatch.setattr(mesh.json, "dumps", broken_dumps)
    fallback = mesh._pkt_to_dict(Unknown())
    assert set(fallback) == {"_unparsed"}
    assert isinstance(fallback["_unparsed"], str)


def test_main_retries_interface_creation(mesh_module, monkeypatch):
    mesh = mesh_module

    attempts = []

    class DummyEvent:
        def __init__(self):
            self.wait_calls = 0

        def is_set(self):
            return self.wait_calls >= 3

        def set(self):
            self.wait_calls = 3

        def wait(self, timeout):
            self.wait_calls += 1
            return self.is_set()

    class DummyInterface:
        def __init__(self):
            self.closed = False
            self.nodes = {}

        def close(self):
            self.closed = True

    iface = DummyInterface()

    def fake_create(port):
        attempts.append(port)
        if len(attempts) < 3:
            raise RuntimeError("boom")
        return iface, port

    monkeypatch.setattr(mesh, "PORT", "/dev/ttyTEST")
    monkeypatch.setattr(mesh, "_create_serial_interface", fake_create)
    monkeypatch.setattr(mesh.threading, "Event", DummyEvent)
    monkeypatch.setattr(mesh.signal, "signal", lambda *_, **__: None)
    monkeypatch.setattr(mesh, "SNAPSHOT_SECS", 0)
    monkeypatch.setattr(mesh, "_RECONNECT_INITIAL_DELAY_SECS", 0)
    monkeypatch.setattr(mesh, "_RECONNECT_MAX_DELAY_SECS", 0)

    mesh.main()

    assert len(attempts) == 3
    assert iface.closed is True


def test_connected_state_handles_threading_event(mesh_module):
    mesh = mesh_module

    event = mesh.threading.Event()
    assert mesh._connected_state(event) is False

    event.set()
    assert mesh._connected_state(event) is True


def test_main_reconnects_when_connection_event_clears(mesh_module, monkeypatch):
    mesh = mesh_module

    attempts = []
    interfaces = []
    current_iface = {"obj": None}
    import threading as real_threading_module

    real_event_cls = real_threading_module.Event

    class DummyInterface:
        def __init__(self):
            self.nodes = {}
            self.isConnected = real_event_cls()
            self.isConnected.set()
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    def fake_create(port):
        iface = DummyInterface()
        attempts.append(port)
        interfaces.append(iface)
        current_iface["obj"] = iface
        return iface, port

    class DummyStopEvent:
        def __init__(self):
            self._flag = False
            self.wait_calls = 0

        def is_set(self):
            return self._flag

        def set(self):
            self._flag = True

        def wait(self, timeout):
            self.wait_calls += 1
            if self.wait_calls == 1:
                iface = current_iface["obj"]
                assert iface is not None, "interface should be available"
                iface.isConnected.clear()
                return self._flag
            self._flag = True
            return True

    monkeypatch.setattr(mesh, "PORT", "/dev/ttyTEST")
    monkeypatch.setattr(mesh, "_create_serial_interface", fake_create)
    monkeypatch.setattr(mesh.threading, "Event", DummyStopEvent)
    monkeypatch.setattr(mesh.signal, "signal", lambda *_, **__: None)
    monkeypatch.setattr(mesh, "SNAPSHOT_SECS", 0)
    monkeypatch.setattr(mesh, "_RECONNECT_INITIAL_DELAY_SECS", 0)
    monkeypatch.setattr(mesh, "_RECONNECT_MAX_DELAY_SECS", 0)
    monkeypatch.setattr(mesh, "_CLOSE_TIMEOUT_SECS", 0)

    mesh.main()

    assert len(attempts) == 2
    assert len(interfaces) == 2
    assert interfaces[0].close_calls >= 1
    assert interfaces[1].close_calls >= 1


def test_main_recreates_interface_after_snapshot_error(mesh_module, monkeypatch):
    mesh = mesh_module

    class DummyEvent:
        def __init__(self):
            self.wait_calls = 0

        def is_set(self):
            return self.wait_calls >= 2

        def set(self):
            self.wait_calls = 2

        def wait(self, timeout):
            self.wait_calls += 1
            return self.is_set()

    interfaces = []

    def fake_create(port):
        fail_first = not interfaces

        class FlakyInterface:
            def __init__(self, should_fail):
                self.closed = False
                self._should_fail = should_fail
                self._calls = 0

            @property
            def nodes(self):
                self._calls += 1
                if self._should_fail and self._calls == 1:
                    raise RuntimeError("temporary failure")
                return {"!node": {"id": 1}}

            def close(self):
                self.closed = True

        interface = FlakyInterface(fail_first)
        interfaces.append(interface)
        return interface, port

    upsert_calls = []

    def record_upsert(node_id, node):
        upsert_calls.append(node_id)

    monkeypatch.setattr(mesh, "PORT", "/dev/ttyTEST")
    monkeypatch.setattr(mesh, "_create_serial_interface", fake_create)
    monkeypatch.setattr(mesh, "upsert_node", record_upsert)
    monkeypatch.setattr(mesh.threading, "Event", DummyEvent)
    monkeypatch.setattr(mesh.signal, "signal", lambda *_, **__: None)
    monkeypatch.setattr(mesh, "SNAPSHOT_SECS", 0)
    monkeypatch.setattr(mesh, "_RECONNECT_INITIAL_DELAY_SECS", 0)
    monkeypatch.setattr(mesh, "_RECONNECT_MAX_DELAY_SECS", 0)

    mesh.main()

    assert len(interfaces) >= 2
    assert interfaces[0].closed is True
    assert upsert_calls == ["!node"]


def test_main_exits_when_defaults_unavailable(mesh_module, monkeypatch):
    mesh = mesh_module

    def fail_default():
        raise mesh.NoAvailableMeshInterface("no interface available")

    monkeypatch.setattr(mesh, "PORT", None)
    monkeypatch.setattr(mesh, "_create_default_interface", fail_default)
    monkeypatch.setattr(mesh.signal, "signal", lambda *_, **__: None)

    with pytest.raises(SystemExit) as exc_info:
        mesh.main()

    assert exc_info.value.code == 1


def test_store_packet_dict_uses_top_level_channel(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    mesh.config.LORA_FREQ = 868
    mesh.config.MODEM_PRESET = "MediumFast"

    packet = {
        "id": "789",
        "rxTime": 123456,
        "from": "!abc",
        "to": "!def",
        "channel": "5",
        "decoded": {"text": "hi", "portnum": 1},
    }

    mesh.store_packet_dict(packet)

    assert captured, "Expected message to be stored"
    path, payload, priority = captured[0]
    assert path == "/api/messages"
    assert payload["channel"] == 5
    assert payload["portnum"] == "1"
    assert payload["text"] == "hi"
    assert payload["encrypted"] is None
    assert payload["snr"] is None and payload["rssi"] is None
    assert payload["lora_freq"] == 868
    assert payload["modem_preset"] == "MediumFast"
    assert priority == mesh._MESSAGE_POST_PRIORITY


def test_store_packet_dict_handles_invalid_channel(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    mesh.config.LORA_FREQ = 868
    mesh.config.MODEM_PRESET = "MediumFast"

    packet = {
        "id": 321,
        "rxTime": 999,
        "fromId": "!abc",
        "decoded": {
            "payload": {"text": "hello"},
            "portnum": "TEXT_MESSAGE_APP",
            "channel": "not-a-number",
        },
    }

    mesh.store_packet_dict(packet)

    assert captured
    path, payload, priority = captured[0]
    assert path == "/api/messages"
    assert payload["channel"] == 0
    assert payload["encrypted"] is None
    assert payload["lora_freq"] == 868
    assert payload["modem_preset"] == "MediumFast"
    assert priority == mesh._MESSAGE_POST_PRIORITY


def test_store_packet_dict_skips_direct_message_on_primary_channel(
    mesh_module, monkeypatch
):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    packet = {
        "id": 111,
        "rxTime": 777,
        "fromId": "!sender",
        "toId": "!recipient",
        "channel": 0,
        "decoded": {"text": "secret dm", "portnum": "TEXT_MESSAGE_APP"},
    }

    mesh.store_packet_dict(packet)

    assert not captured


def test_store_packet_dict_allows_primary_channel_broadcast(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    mesh.config.LORA_FREQ = 915
    mesh.config.MODEM_PRESET = "LongSlow"

    packet = {
        "id": 222,
        "rxTime": 888,
        "from": "!relay",
        "to": "^all",
        "channel": 0,
        "decoded": {"text": "announcement", "portnum": "TEXT_MESSAGE_APP"},
    }

    mesh.store_packet_dict(packet)

    assert captured
    path, payload, priority = captured[0]
    assert path == "/api/messages"
    assert payload["text"] == "announcement"
    assert payload["to_id"] == "^all"
    assert payload["channel"] == 0
    assert payload["lora_freq"] == 915
    assert payload["modem_preset"] == "LongSlow"
    assert priority == mesh._MESSAGE_POST_PRIORITY


def test_store_packet_dict_appends_channel_name(mesh_module, monkeypatch, capsys):
    mesh = mesh_module
    mesh.channels._reset_channel_cache()
    mesh.config.MODEM_PRESET = "MediumFast"

    class DummyInterface:
        def __init__(self) -> None:
            self.localNode = SimpleNamespace(
                channels=[
                    SimpleNamespace(role=1, settings=SimpleNamespace()),
                    SimpleNamespace(
                        role=2,
                        index=5,
                        settings=SimpleNamespace(name="Chat"),
                    ),
                ]
            )

        def waitForConfig(self) -> None:  # noqa: D401 - matches interface contract
            return None

    mesh.channels.capture_from_interface(DummyInterface())
    capsys.readouterr()

    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    monkeypatch.setattr(mesh, "DEBUG", True)

    packet = {
        "id": "789",
        "rxTime": 123456,
        "from": "!abc",
        "to": "!def",
        "channel": 5,
        "decoded": {"text": "hi", "portnum": 1},
    }

    mesh.store_packet_dict(packet)

    assert captured, "Expected message to be stored"
    path, payload, priority = captured[0]
    assert path == "/api/messages"
    assert payload["channel_name"] == "Chat"
    assert payload["channel"] == 5
    assert payload["text"] == "hi"
    assert payload["encrypted"] is None
    assert payload["reply_id"] is None
    assert payload["emoji"] is None
    assert priority == mesh._MESSAGE_POST_PRIORITY

    log_output = capsys.readouterr().out
    assert "channel_name='Chat'" in log_output
    assert "channel_display='Chat'" in log_output


def test_store_packet_dict_includes_encrypted_payload(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    mesh.config.LORA_FREQ = 868
    mesh.config.MODEM_PRESET = "MediumFast"

    packet = {
        "id": 555,
        "rxTime": 111,
        "from": 2988082812,
        "to": "!receiver",
        "channel": 8,
        "encrypted": "abc123==",
    }

    mesh.store_packet_dict(packet)

    assert captured
    path, payload, priority = captured[0]
    assert path == "/api/messages"
    assert payload["encrypted"] == "abc123=="
    assert payload["text"] is None
    assert payload["from_id"] == 2988082812
    assert payload["to_id"] == "!receiver"
    assert payload["reply_id"] is None
    assert payload["emoji"] is None
    assert "channel_name" not in payload
    assert payload["lora_freq"] == 868
    assert payload["modem_preset"] == "MediumFast"
    assert priority == mesh._MESSAGE_POST_PRIORITY


def test_store_packet_dict_handles_telemetry_packet(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    mesh.config.LORA_FREQ = 868
    mesh.config.MODEM_PRESET = "MediumFast"

    packet = {
        "id": 1_256_091_342,
        "rxTime": 1_758_024_300,
        "fromId": "!9e95cf60",
        "toId": "^all",
        "decoded": {
            "portnum": "TELEMETRY_APP",
            "bitfield": 1,
            "telemetry": {
                "time": 1_758_024_300,
                "deviceMetrics": {
                    "batteryLevel": 101,
                    "voltage": 4.224,
                    "channelUtilization": 0.59666663,
                    "airUtilTx": 0.03908333,
                    "uptimeSeconds": 305044,
                    "current": 0.0715,
                },
                "localStats": {
                    "numPacketsTx": 1280,
                    "numPacketsRx": 1425,
                },
            },
            "payload": {
                "__bytes_b64__": "DTVr0mgSFQhlFQIrh0AdJb8YPyXYFSA9KJTPEg==",
            },
        },
    }

    mesh.store_packet_dict(packet)

    assert captured
    path, payload, priority = captured[0]
    assert path == "/api/telemetry"
    assert priority == mesh._TELEMETRY_POST_PRIORITY
    assert payload["id"] == 1_256_091_342
    assert payload["node_id"] == "!9e95cf60"
    assert payload["from_id"] == "!9e95cf60"
    assert payload["rx_time"] == 1_758_024_300
    assert payload["telemetry_time"] == 1_758_024_300
    assert payload["channel"] == 0
    assert payload["bitfield"] == 1
    assert payload["payload_b64"] == "DTVr0mgSFQhlFQIrh0AdJb8YPyXYFSA9KJTPEg=="
    assert payload["battery_level"] == pytest.approx(101.0)
    assert payload["voltage"] == pytest.approx(4.224)
    assert payload["channel_utilization"] == pytest.approx(0.59666663)
    assert payload["air_util_tx"] == pytest.approx(0.03908333)
    assert payload["uptime_seconds"] == 305044
    assert payload["current"] == pytest.approx(0.0715)
    assert payload["lora_freq"] == 868
    assert payload["modem_preset"] == "MediumFast"


def test_store_packet_dict_handles_environment_telemetry(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    mesh.config.LORA_FREQ = 868
    mesh.config.MODEM_PRESET = "MediumFast"

    packet = {
        "id": 2_817_720_548,
        "rxTime": 1_758_024_400,
        "from": 3_698_627_780,
        "decoded": {
            "portnum": "TELEMETRY_APP",
            "telemetry": {
                "time": 1_758_024_390,
                "environmentMetrics": {
                    "temperature": 21.98,
                    "relativeHumidity": 39.475586,
                    "barometricPressure": 1017.8353,
                    "gasResistance": 1456.0,
                    "iaq": 83,
                    "distance": 12.5,
                    "lux": 100.25,
                    "whiteLux": 64.5,
                    "irLux": 12.75,
                    "uvLux": 1.6,
                    "windDirection": 270,
                    "windSpeed": 5.9,
                    "windGust": 7.4,
                    "windLull": 4.8,
                    "weight": 32.7,
                    "radiation": 0.45,
                    "rainfall1h": 0.18,
                    "rainfall24h": 1.42,
                    "soilMoisture": 3100,
                    "soilTemperature": 18.9,
                },
            },
        },
    }

    mesh.store_packet_dict(packet)

    assert captured
    path, payload, priority = captured[0]
    assert path == "/api/telemetry"
    assert payload["id"] == 2_817_720_548
    assert payload["node_id"] == "!dc7494c4"
    assert payload["from_id"] == "!dc7494c4"
    assert payload["telemetry_time"] == 1_758_024_390
    assert payload["temperature"] == pytest.approx(21.98)
    assert payload["relative_humidity"] == pytest.approx(39.475586)
    assert payload["barometric_pressure"] == pytest.approx(1017.8353)
    assert payload["gas_resistance"] == pytest.approx(1456.0)
    assert payload["iaq"] == 83
    assert payload["distance"] == pytest.approx(12.5)
    assert payload["lux"] == pytest.approx(100.25)
    assert payload["white_lux"] == pytest.approx(64.5)
    assert payload["ir_lux"] == pytest.approx(12.75)
    assert payload["uv_lux"] == pytest.approx(1.6)
    assert payload["wind_direction"] == 270
    assert payload["wind_speed"] == pytest.approx(5.9)
    assert payload["wind_gust"] == pytest.approx(7.4)
    assert payload["wind_lull"] == pytest.approx(4.8)
    assert payload["weight"] == pytest.approx(32.7)
    assert payload["radiation"] == pytest.approx(0.45)
    assert payload["rainfall_1h"] == pytest.approx(0.18)
    assert payload["rainfall_24h"] == pytest.approx(1.42)
    assert payload["soil_moisture"] == 3100
    assert payload["soil_temperature"] == pytest.approx(18.9)
    assert payload["lora_freq"] == 868
    assert payload["modem_preset"] == "MediumFast"


def test_store_packet_dict_throttles_host_telemetry(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    logs = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )
    monkeypatch.setattr(
        mesh.config,
        "_debug_log",
        lambda message, **metadata: logs.append((message, metadata)),
    )

    mesh.register_host_node_id("!9e95cf60")

    base_packet = {
        "id": 1_234,
        "fromId": "!9e95cf60",
        "decoded": {
            "portnum": "TELEMETRY_APP",
            "telemetry": {
                "time": 1_000,
                "deviceMetrics": {
                    "batteryLevel": 50,
                },
            },
        },
    }

    mesh.store_packet_dict({**base_packet, "rxTime": 1_000})
    mesh.store_packet_dict({**base_packet, "id": 1_235, "rxTime": 1_300})
    mesh.store_packet_dict({**base_packet, "id": 1_236, "rxTime": 4_700})

    assert len(captured) == 2
    first_path, first_payload, _ = captured[0]
    second_path, second_payload, _ = captured[1]
    assert first_path == "/api/telemetry"
    assert second_path == "/api/telemetry"
    assert first_payload["id"] == 1_234
    assert second_payload["id"] == 1_236

    suppression_logs = [
        entry for entry in logs if entry[0] == "Suppressed host telemetry update"
    ]
    assert suppression_logs
    assert suppression_logs[0][1]["host_node_id"] == "!9e95cf60"
    assert suppression_logs[0][1]["minutes_remaining"] == 55


def test_store_packet_dict_handles_traceroute_packet(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    mesh.config.LORA_FREQ = 915
    mesh.config.MODEM_PRESET = "LongFast"

    packet = {
        "id": 2_934_054_466,
        "rxTime": 1_763_183_133,
        "rssi": -70,
        "snr": 10.25,
        "fromId": "3664074452",
        "decoded": {
            "portnum": "PAXCOUNTER_APP",
            "dest": "2660618080",
            "traceroute": {
                "requestId": 17,
                "route": [3_663_643_096, "!beadf00d", "c0ffee99", 1_150_717_793],
                "snrTowards": [42, -14, 41],
            },
        },
    }

    mesh.store_packet_dict(packet)

    assert captured
    path, payload, priority = captured[0]
    assert path == "/api/traces"
    assert priority == mesh._TRACE_POST_PRIORITY
    assert payload["id"] == packet["id"]
    assert payload["request_id"] == 17
    assert payload["src"] == 3_664_074_452
    assert payload["dest"] == 2_660_618_080
    assert payload["rx_time"] == 1_763_183_133
    assert payload["rx_iso"] == "2025-11-15T05:05:33Z"
    assert payload["hops"] == [
        3_663_643_096,
        3_199_070_221,
        3_237_998_233,
        1_150_717_793,
    ]
    assert payload["rssi"] == -70
    assert payload["snr"] == pytest.approx(10.25)
    assert "elapsed_ms" in payload
    assert payload["lora_freq"] == 915
    assert payload["modem_preset"] == "LongFast"


def test_traceroute_hop_normalization_supports_mappings(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    packet = {
        "id": 1_111,
        "decoded": {
            "portnum": "TRACEROUTE_APP",
            "traceroute": {
                "requestId": 42,
                "route": [{"node_id": "!beadf00d"}, {"num": "0xc0ffee99"}, {"id": 123}],
            },
        },
    }

    mesh.store_packet_dict(packet)

    assert captured
    _, payload, _ = captured[0]
    assert payload["hops"] == [0xBEADF00D, 0xC0FFEE99, 123]


def test_traceroute_packet_without_identifiers_is_ignored(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    packet = {
        "decoded": {
            "portnum": "TRACEROUTE_APP",
            "traceroute": {},
        },
        "rxTime": 123,
    }

    mesh.store_packet_dict(packet)

    assert captured == []


def test_post_queue_prioritises_messages(mesh_module, monkeypatch):
    mesh = mesh_module
    mesh._clear_post_queue()
    calls = []

    def record(path, payload):
        calls.append((path, payload))

    monkeypatch.setattr(mesh, "_post_json", record)

    mesh._enqueue_post_json("/api/messages", {"id": 1}, mesh._MESSAGE_POST_PRIORITY)
    mesh._enqueue_post_json(
        "/api/nodes", {"!node": {"foo": "bar"}}, mesh._NODE_POST_PRIORITY
    )

    mesh._drain_post_queue()

    assert [path for path, _ in calls] == ["/api/messages", "/api/nodes"]


def test_drain_post_queue_handles_enqueued_items_during_send(mesh_module):
    mesh = mesh_module
    mesh._clear_post_queue()

    first_send_started = threading.Event()
    second_item_enqueued = threading.Event()
    second_item_processed = threading.Event()
    calls = []

    def blocking_send(path, payload):
        calls.append((path, payload))
        if path == "/api/first":
            first_send_started.set()
            assert second_item_enqueued.wait(timeout=2), "Second item was not enqueued"
        elif path == "/api/second":
            second_item_processed.set()

    mesh._enqueue_post_json(
        "/api/first",
        {"id": 1},
        mesh._DEFAULT_POST_PRIORITY,
        state=mesh.STATE,
    )

    mesh.STATE.active = True
    drain_thread = threading.Thread(
        target=mesh._drain_post_queue,
        kwargs={"state": mesh.STATE, "send": blocking_send},
    )
    drain_thread.start()

    assert first_send_started.wait(
        timeout=2
    ), "Drain did not begin processing the first item"

    mesh._queue_post_json(
        "/api/second",
        {"id": 2},
        state=mesh.STATE,
        send=blocking_send,
    )
    second_item_enqueued.set()

    assert second_item_processed.wait(timeout=2), "Second item was not processed"

    drain_thread.join(timeout=2)
    assert not drain_thread.is_alive(), "Drain thread did not finish"
    assert [path for path, _ in calls] == ["/api/first", "/api/second"]
    assert not mesh.STATE.queue
    assert mesh.STATE.active is False


def test_store_packet_dict_requires_id(mesh_module, monkeypatch):
    mesh = mesh_module

    def fail_post(*_, **__):
        raise AssertionError("Should not post without an id")

    monkeypatch.setattr(mesh, "_queue_post_json", fail_post)

    packet = {"decoded": {"payload": {"text": "hello"}, "portnum": "TEXT_MESSAGE_APP"}}
    mesh.store_packet_dict(packet)


def test_on_receive_logs_when_store_fails(mesh_module, monkeypatch, capsys):
    mesh = mesh_module
    monkeypatch.setattr(mesh, "_pkt_to_dict", lambda pkt: {"id": 1})

    def boom(*_, **__):
        raise ValueError("boom")

    monkeypatch.setattr(mesh, "store_packet_dict", boom)

    mesh.on_receive(object(), interface=None)

    captured = capsys.readouterr()
    assert "context=handlers.on_receive" in captured.out
    assert "Failed to store packet" in captured.out


def test_node_items_snapshot_iterable_without_items(mesh_module):
    mesh = mesh_module

    class Iterable:
        def __init__(self):
            self._data = {"node": {"foo": "bar"}}

        def __iter__(self):
            return iter(self._data)

        def __getitem__(self, key):
            return self._data[key]

    snapshot = mesh._node_items_snapshot(Iterable(), retries=1)
    assert snapshot == [("node", {"foo": "bar"})]


def test_node_items_snapshot_handles_empty_input(mesh_module):
    mesh = mesh_module

    assert mesh._node_items_snapshot(None) == []
    assert mesh._node_items_snapshot({}) == []


def test_debug_log_emits_when_enabled(mesh_module, monkeypatch, capsys):
    mesh = mesh_module

    monkeypatch.setattr(mesh, "DEBUG", True)
    mesh._debug_log("hello world")

    captured = capsys.readouterr()
    lines = [line for line in captured.out.splitlines() if "hello world" in line]
    assert lines, "expected debug log output"
    log_line = lines[-1]
    pattern = (
        r"\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[potato-mesh\] \[debug\] "
    )
    assert re.match(pattern, log_line), f"unexpected log format: {log_line}"
    assert log_line.endswith("hello world")


def test_event_wait_allows_default_timeout_handles_short_signature(
    mesh_module, monkeypatch
):
    mesh = mesh_module

    def wait_without_timeout(self):
        return True

    monkeypatch.setattr(
        mesh.threading.Event, "wait", wait_without_timeout, raising=False
    )

    assert mesh._event_wait_allows_default_timeout() is True


def test_event_wait_allows_default_timeout_handles_varargs(mesh_module, monkeypatch):
    mesh = mesh_module

    def wait_with_varargs(self, *args):
        return False

    monkeypatch.setattr(mesh.threading.Event, "wait", wait_with_varargs, raising=False)

    assert mesh._event_wait_allows_default_timeout() is True


def test_parse_ble_target_rejects_invalid_values(mesh_module):
    mesh = mesh_module

    assert mesh._parse_ble_target("") is None
    assert mesh._parse_ble_target("   ") is None
    assert mesh._parse_ble_target("zz:zz:zz:zz:zz:zz") is None


def test_parse_network_target_additional_cases(mesh_module):
    mesh = mesh_module

    assert mesh._parse_network_target("") is None
    assert mesh._parse_network_target("   ") is None
    assert mesh._parse_network_target("tcp://example.com") is None

    host, port = mesh._parse_network_target("tcp://10.1.2.3:abc")
    assert (host, port) == ("10.1.2.3", mesh._DEFAULT_TCP_PORT)

    host, port = mesh._parse_network_target("10.1.2.3:9001")
    assert (host, port) == ("10.1.2.3", 9001)


def test_load_ble_interface_sets_global(monkeypatch):
    repo_root = Path(__file__).resolve().parents[1]
    monkeypatch.syspath_prepend(str(repo_root))

    serial_interface_mod = types.ModuleType("meshtastic.serial_interface")

    class DummySerial:
        def __init__(self, *_, **__):
            pass

    serial_interface_mod.SerialInterface = DummySerial

    tcp_interface_mod = types.ModuleType("meshtastic.tcp_interface")
    tcp_interface_mod.TCPInterface = DummySerial

    ble_interface_mod = types.ModuleType("meshtastic.ble_interface")

    class DummyBLE:
        def __init__(self, *_, **__):
            pass

    ble_interface_mod.BLEInterface = DummyBLE

    meshtastic_mod = types.ModuleType("meshtastic")
    meshtastic_mod.serial_interface = serial_interface_mod
    meshtastic_mod.tcp_interface = tcp_interface_mod
    meshtastic_mod.ble_interface = ble_interface_mod

    monkeypatch.setitem(sys.modules, "meshtastic", meshtastic_mod)
    monkeypatch.setitem(
        sys.modules, "meshtastic.serial_interface", serial_interface_mod
    )
    monkeypatch.setitem(sys.modules, "meshtastic.tcp_interface", tcp_interface_mod)
    monkeypatch.setitem(sys.modules, "meshtastic.ble_interface", ble_interface_mod)

    module_name = "data.mesh"
    module = (
        importlib.import_module(module_name)
        if module_name not in sys.modules
        else importlib.reload(sys.modules[module_name])
    )

    monkeypatch.setattr(module, "BLEInterface", None)

    resolved = module._load_ble_interface()

    assert resolved is ble_interface_mod.BLEInterface
    assert module.BLEInterface is ble_interface_mod.BLEInterface


def test_default_serial_targets_deduplicates(mesh_module, monkeypatch):
    mesh = mesh_module

    def fake_glob(pattern):
        if pattern == "/dev/ttyUSB*":
            return ["/dev/ttyUSB0", "/dev/ttyUSB0"]
        if pattern == "/dev/ttyACM*":
            return ["/dev/ttyACM1"]
        return []

    monkeypatch.setattr(mesh.interfaces.glob, "glob", fake_glob)

    targets = mesh._default_serial_targets()

    assert targets.count("/dev/ttyUSB0") == 1
    assert "/dev/ttyACM1" in targets
    assert "/dev/ttyACM0" in targets


def test_post_json_logs_failures(mesh_module, monkeypatch, capsys):
    mesh = mesh_module

    monkeypatch.setattr(mesh, "INSTANCE", "https://example.invalid")
    monkeypatch.setattr(mesh, "DEBUG", True)

    def boom(*_, **__):
        raise RuntimeError("offline")

    monkeypatch.setattr(mesh.queue.urllib.request, "urlopen", boom)

    mesh._post_json("/api/test", {"foo": "bar"})

    captured = capsys.readouterr()
    assert "context=queue.post_json" in captured.out
    assert "POST request failed" in captured.out


def test_queue_post_json_logs_payload_details(mesh_module, monkeypatch, capsys):
    mesh = mesh_module

    mesh._clear_post_queue()
    monkeypatch.setattr(mesh, "DEBUG", True)

    mesh._queue_post_json(
        "/api/test",
        {"alpha": "beta", "count": 7},
        send=lambda *_: None,
    )

    out = capsys.readouterr().out
    assert "Forwarding payload to API" in out
    assert 'alpha="beta"' in out
    assert "count=7" in out


def test_queue_post_json_skips_when_active(mesh_module, monkeypatch):
    mesh = mesh_module

    mesh._clear_post_queue()
    mesh.STATE.active = True

    mesh._queue_post_json("/api/test", {"id": 1})

    assert mesh.STATE.active is True
    assert mesh.STATE.queue
    mesh._clear_post_queue()


def test_node_to_dict_handles_proto_fallback(mesh_module, monkeypatch):
    mesh = mesh_module

    class FailingProto(mesh.ProtoMessage):
        def to_dict(self):
            raise RuntimeError("boom")

        def __str__(self):
            return "proto"

    def fail_message_to_dict(*_, **__):
        raise RuntimeError("nope")

    monkeypatch.setattr(mesh, "MessageToDict", fail_message_to_dict)
    monkeypatch.setattr(
        mesh.json, "dumps", lambda *_, **__: (_ for _ in ()).throw(TypeError())
    )

    converted = mesh._node_to_dict({"value": FailingProto()})

    assert converted["value"] == "proto"


def test_upsert_node_logs_in_debug(mesh_module, monkeypatch, capsys):
    mesh = mesh_module

    monkeypatch.setattr(mesh, "DEBUG", True)
    captured = []

    def fake_queue(path, payload, *, priority):
        captured.append((path, payload, priority))

    monkeypatch.setattr(mesh, "_queue_post_json", fake_queue)

    mesh.upsert_node("!node", {"user": {"shortName": "SN", "longName": "LN"}})

    assert captured
    out = capsys.readouterr().out
    assert "context=handlers.upsert_node" in out
    assert "Queued node upsert payload" in out


def test_store_packet_dict_records_ignored_packets(mesh_module, monkeypatch, tmp_path):
    mesh = mesh_module

    monkeypatch.setattr(mesh, "DEBUG", True)
    ignored_path = tmp_path / "ignored.txt"
    monkeypatch.setattr(mesh.handlers, "_IGNORED_PACKET_LOG_PATH", ignored_path)
    monkeypatch.setattr(mesh.handlers, "_IGNORED_PACKET_LOCK", threading.Lock())

    packet = {"decoded": {"portnum": "UNKNOWN"}}
    mesh.store_packet_dict(packet)

    assert ignored_path.exists()
    lines = ignored_path.read_text(encoding="utf-8").strip().splitlines()
    assert lines
    payload = json.loads(lines[-1])
    assert payload["reason"] == "unsupported-port"
    assert payload["packet"]["decoded"]["portnum"] == "UNKNOWN"


def test_coerce_int_and_float_cover_edge_cases(mesh_module):
    mesh = mesh_module

    assert mesh._coerce_int(None) is None
    assert mesh._coerce_int(True) == 1
    assert mesh._coerce_int(7) == 7
    assert mesh._coerce_int(3.2) == 3
    assert mesh._coerce_int(float("inf")) is None
    assert mesh._coerce_int(" 0x10 ") == 16
    assert mesh._coerce_int("   ") is None
    assert mesh._coerce_int("7.0") == 7
    assert mesh._coerce_int("nan") is None

    class Intable:
        def __int__(self):
            return 9

    class BadInt:
        def __int__(self):
            raise TypeError

    assert mesh._coerce_int(Intable()) == 9
    assert mesh._coerce_int(BadInt()) is None

    assert mesh._coerce_float(None) is None
    assert mesh._coerce_float(True) == 1.0
    assert mesh._coerce_float(3) == 3.0
    assert mesh._coerce_float(float("inf")) is None
    assert mesh._coerce_float(" 1.5 ") == 1.5
    assert mesh._coerce_float("   ") is None
    assert mesh._coerce_float("nan") is None

    class Floatable:
        def __float__(self):
            return 2.5

    class BadFloat:
        def __float__(self):
            raise TypeError

    assert mesh._coerce_float(Floatable()) == 2.5
    assert mesh._coerce_float(BadFloat()) is None


def test_canonical_node_id_variants(mesh_module):
    mesh = mesh_module

    assert mesh._canonical_node_id(None) is None
    assert mesh._canonical_node_id(0x1234) == "!00001234"
    assert mesh._canonical_node_id("  ") is None
    assert mesh._canonical_node_id("!deadbeef") == "!deadbeef"
    assert mesh._canonical_node_id("0xCAFEBABE") == "!cafebabe"
    assert mesh._canonical_node_id("12345") == "!00003039"
    assert mesh._canonical_node_id("nothex") is None


def test_node_num_from_id_variants(mesh_module):
    mesh = mesh_module

    assert mesh._node_num_from_id(None) is None
    assert mesh._node_num_from_id(42) == 42
    assert mesh._node_num_from_id(-1) is None
    assert mesh._node_num_from_id("  ") is None
    assert mesh._node_num_from_id("!00ff") == 0xFF
    assert mesh._node_num_from_id("0x10") == 16
    assert mesh._node_num_from_id("123") == 0x123
    assert mesh._node_num_from_id("bad") == int("bad", 16)


def test_merge_mappings_handles_non_mappings(mesh_module):
    mesh = mesh_module

    @dataclass
    class UserBase:
        id: str

    @dataclass
    class UserExtra:
        name: str

    @dataclass
    class Holder:
        user: object

    base = Holder(UserBase("!1"))
    extra = Holder(UserExtra("Node"))

    merged = mesh._merge_mappings(base, extra)

    assert merged == {"user": {"id": "!1", "name": "Node"}}


def test_extract_payload_bytes_edge_cases(mesh_module):
    mesh = mesh_module

    assert mesh._extract_payload_bytes(None) is None
    assert (
        mesh._extract_payload_bytes({"payload": {"__bytes_b64__": "invalid"}}) is None
    )
    assert mesh._extract_payload_bytes({"payload": b"data"}) == b"data"
    assert mesh._extract_payload_bytes({"payload": "ZGF0YQ=="}) == b"data"


def test_decode_nodeinfo_payload_handles_user(mesh_module, monkeypatch):
    mesh = mesh_module

    from meshtastic.protobuf import mesh_pb2

    user = mesh_pb2.User()
    user.id = "!01020304"
    payload = user.SerializeToString()

    def raise_decode(self, *_):
        raise mesh.DecodeError("fail")

    monkeypatch.setattr(
        mesh_pb2.NodeInfo, "ParseFromString", raise_decode, raising=False
    )

    node_info = mesh._decode_nodeinfo_payload(payload)

    assert node_info is not None
    assert node_info.user.id == "!01020304"


def test_nodeinfo_helpers_cover_fallbacks(mesh_module, monkeypatch):
    mesh = mesh_module

    from meshtastic.protobuf import mesh_pb2

    node_info = mesh_pb2.NodeInfo()
    node_info.device_metrics.battery_level = 50
    node_info.position.latitude_i = int(1.23 * 1e7)
    node_info.position.longitude_i = int(4.56 * 1e7)
    node_info.position.location_source = 99

    monkeypatch.setattr(
        mesh_pb2.Position.LocSource,
        "Name",
        lambda value: (_ for _ in ()).throw(RuntimeError()),
        raising=False,
    )

    metrics = mesh._nodeinfo_metrics_dict(node_info)
    position = mesh._nodeinfo_position_dict(node_info)

    assert metrics["batteryLevel"] == 50.0
    assert position["locationSource"] == 99

    class DummyProto(mesh.ProtoMessage):
        def __init__(self):
            self.id = "!11223344"

        def __str__(self):
            return "dummy-proto"

        def to_dict(self):
            return {"id": self.id}

    def raise_message_to_dict(*_, **__):
        raise RuntimeError()

    monkeypatch.setattr(mesh, "MessageToDict", raise_message_to_dict)

    user = mesh._nodeinfo_user_dict(node_info, DummyProto())

    assert user["id"] == "!11223344"


def test_nodeinfo_user_role_falls_back_to_cli_enum(mesh_module, monkeypatch):
    mesh = mesh_module
    mesh._reset_cli_role_cache()

    cli_module = types.ModuleType("meshtastic.cli")
    cli_common = types.ModuleType("meshtastic.cli.common")

    class DummyRole(enum.IntEnum):
        CLIENT = 0
        CLIENT_BASE = 12

    cli_common.Role = DummyRole
    cli_module.common = cli_common

    monkeypatch.setitem(sys.modules, "meshtastic.cli", cli_module)
    monkeypatch.setitem(sys.modules, "meshtastic.cli.common", cli_common)

    user = mesh._nodeinfo_user_dict(None, {"id": "!11223344", "role": 12})

    assert user["role"] == "CLIENT_BASE"

    mesh._reset_cli_role_cache()

    cli_dict_module = types.ModuleType("meshtastic.cli")
    cli_dict_common = types.ModuleType("meshtastic.cli.common")
    cli_dict_common.ClientRoles = {12: "client_hidden"}
    cli_dict_module.common = cli_dict_common

    monkeypatch.setitem(sys.modules, "meshtastic.cli", cli_dict_module)
    monkeypatch.setitem(sys.modules, "meshtastic.cli.common", cli_dict_common)

    user = mesh._nodeinfo_user_dict(None, {"id": "!11223344", "role": 12})

    assert user["role"] == "CLIENT_HIDDEN"

    mesh._reset_cli_role_cache()


def test_store_position_packet_defaults(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []

    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

    mesh.config.LORA_FREQ = 868
    mesh.config.MODEM_PRESET = "MediumFast"

    packet = {"id": "7", "rxTime": "", "from": "!abcd", "to": "", "decoded": {}}

    mesh.store_position_packet(packet, {})

    assert captured
    _, payload, _ = captured[0]
    assert payload["node_id"] == "!0000abcd"
    assert payload["node_num"] == int("abcd", 16)
    assert payload["to_id"] is None
    assert payload["latitude"] is None
    assert payload["longitude"] is None
    assert payload["lora_freq"] == 868
    assert payload["modem_preset"] == "MediumFast"


def test_store_nodeinfo_packet_debug(mesh_module, monkeypatch, capsys):
    mesh = mesh_module

    monkeypatch.setattr(mesh, "DEBUG", True)
    monkeypatch.setattr(mesh, "_queue_post_json", lambda *_, **__: None)

    from meshtastic.protobuf import mesh_pb2

    node_info = mesh_pb2.NodeInfo()
    user = node_info.user
    user.id = "!01020304"
    user.short_name = "A"
    user.long_name = "B"
    node_info.channel = 1
    node_info.via_mqtt = True
    node_info.is_ignored = True
    node_info.is_key_manually_verified = True

    payload = {
        "__bytes_b64__": base64.b64encode(node_info.SerializeToString()).decode()
    }

    packet = {
        "id": 1,
        "rxTime": 1,
        "decoded": {"portnum": "NODEINFO_APP", "payload": payload},
    }

    mesh.store_packet_dict(packet)

    out = capsys.readouterr().out
    assert "context=handlers.store_nodeinfo" in out
    assert "Queued nodeinfo payload" in out


def test_store_neighborinfo_packet_debug(mesh_module, monkeypatch, capsys):
    mesh = mesh_module

    monkeypatch.setattr(mesh, "DEBUG", True)
    captured = []

    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append(payload),
    )

    packet = {
        "id": 1,
        "rxTime": 2,
        "fromId": "!12345678",
        "decoded": {
            "portnum": "NEIGHBORINFO_APP",
            "neighborinfo": {
                "nodeId": 0x12345678,
                "neighbors": [],
            },
        },
    }

    mesh.store_packet_dict(packet)

    assert captured
    out = capsys.readouterr().out
    assert "context=handlers.store_neighborinfo" in out
    assert "Queued neighborinfo payload" in out


def test_store_packet_dict_debug_message(mesh_module, monkeypatch, capsys):
    mesh = mesh_module

    monkeypatch.setattr(mesh, "DEBUG", True)
    captured = []

    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append(payload),
    )

    packet = {
        "id": 2,
        "rxTime": 10,
        "fromId": "!abc",
        "decoded": {"payload": {"text": "hi"}, "portnum": "TEXT_MESSAGE_APP"},
    }

    mesh.store_packet_dict(packet)

    assert captured
    out = capsys.readouterr().out
    assert "context=handlers.store_packet_dict" in out
    assert "Queued message payload" in out
    assert "channel_display=0" in out
    assert "channel_name=" not in out


def test_on_receive_skips_seen_packets(mesh_module):
    mesh = mesh_module

    packet = {"_potatomesh_seen": True}
    mesh.on_receive(packet, interface=None)

    assert packet["_potatomesh_seen"] is True
