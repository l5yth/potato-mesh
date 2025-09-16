import importlib
import sys
import types
from dataclasses import dataclass
from pathlib import Path

import pytest


@pytest.fixture
def mesh_module(monkeypatch):
    """Import data.mesh with stubbed dependencies."""

    repo_root = Path(__file__).resolve().parents[1]
    monkeypatch.syspath_prepend(str(repo_root))

    # Stub meshtastic.serial_interface.SerialInterface
    serial_interface_mod = types.ModuleType("meshtastic.serial_interface")

    class DummySerialInterface:
        def __init__(self, *_, **__):
            self.closed = False

        def close(self):
            self.closed = True

    serial_interface_mod.SerialInterface = DummySerialInterface

    meshtastic_mod = types.ModuleType("meshtastic")
    meshtastic_mod.serial_interface = serial_interface_mod

    monkeypatch.setitem(sys.modules, "meshtastic", meshtastic_mod)
    monkeypatch.setitem(
        sys.modules, "meshtastic.serial_interface", serial_interface_mod
    )

    # Stub pubsub.pub
    pubsub_mod = types.ModuleType("pubsub")

    class DummyPub:
        def __init__(self):
            self.subscriptions = []

        def subscribe(self, *args, **kwargs):
            self.subscriptions.append((args, kwargs))

    pubsub_mod.pub = DummyPub()
    monkeypatch.setitem(sys.modules, "pubsub", pubsub_mod)

    # Stub google.protobuf modules used by mesh.py
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

    message_mod.Message = DummyProtoMessage

    protobuf_mod = types.ModuleType("google.protobuf")
    protobuf_mod.json_format = json_format_mod
    protobuf_mod.message = message_mod

    google_mod = types.ModuleType("google")
    google_mod.protobuf = protobuf_mod

    monkeypatch.setitem(sys.modules, "google", google_mod)
    monkeypatch.setitem(sys.modules, "google.protobuf", protobuf_mod)
    monkeypatch.setitem(sys.modules, "google.protobuf.json_format", json_format_mod)
    monkeypatch.setitem(sys.modules, "google.protobuf.message", message_mod)

    module_name = "data.mesh"
    if module_name in sys.modules:
        module = importlib.reload(sys.modules[module_name])
    else:
        module = importlib.import_module(module_name)

    yield module

    # Ensure a clean import for the next test
    sys.modules.pop(module_name, None)


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
        mesh, "_post_json", lambda path, payload: captured.append((path, payload))
    )

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
    path, payload = captured[0]
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


def test_store_packet_dict_ignores_non_text(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh, "_post_json", lambda *args, **kwargs: captured.append(args)
    )

    packet = {
        "id": 456,
        "rxTime": 1_700_000_100,
        "fromId": "!abc",
        "toId": "!def",
        "decoded": {
            "payload": {"text": "ignored"},
            "portnum": "POSITION_APP",
        },
    }

    mesh.store_packet_dict(packet)

    assert not captured, "Non-text messages should not be posted"


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
