import base64
import importlib
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.fixture
def mesh_module(monkeypatch):
    """Import data.mesh with stubbed dependencies."""

    repo_root = Path(__file__).resolve().parents[1]
    monkeypatch.syspath_prepend(str(repo_root))

    try:
        import meshtastic as real_meshtastic  # type: ignore
    except Exception:  # pragma: no cover - dependency may be unavailable in CI
        real_meshtastic = None

    real_protobuf = (
        getattr(real_meshtastic, "protobuf", None) if real_meshtastic else None
    )

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
    if real_protobuf is not None:
        meshtastic_mod.protobuf = real_protobuf

    monkeypatch.setitem(sys.modules, "meshtastic", meshtastic_mod)
    monkeypatch.setitem(
        sys.modules, "meshtastic.serial_interface", serial_interface_mod
    )
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

    module_name = "data.mesh"
    if module_name in sys.modules:
        module = importlib.reload(sys.modules[module_name])
    else:
        module = importlib.import_module(module_name)

    if hasattr(module, "_clear_post_queue"):
        module._clear_post_queue()

    yield module

    # Ensure a clean import for the next test
    if hasattr(module, "_clear_post_queue"):
        module._clear_post_queue()
    sys.modules.pop(module_name, None)


def test_snapshot_interval_defaults_to_60_seconds(mesh_module):
    mesh = mesh_module

    assert mesh.SNAPSHOT_SECS == 60


@pytest.mark.parametrize("value", ["mock", "Mock", " disabled "])
def test_create_serial_interface_allows_mock(mesh_module, value):
    mesh = mesh_module

    iface = mesh._create_serial_interface(value)

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

    iface = mesh._create_serial_interface("/dev/ttyTEST")

    assert created["devPath"] == "/dev/ttyTEST"
    assert iface.nodes == {"!foo": sentinel}


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
    assert priority == mesh._MESSAGE_POST_PRIORITY


def test_store_packet_dict_posts_position(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

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
    assert payload["raw"]["time"] == 1_758_624_189


def test_store_packet_dict_handles_nodeinfo_packet(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

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


def test_store_packet_dict_handles_user_only_nodeinfo(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

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
    node_entry = payload["!01020304"]
    assert node_entry["num"] == 0x01020304
    assert node_entry["lastHeard"] == 200
    assert node_entry["snr"] == pytest.approx(1.5)


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


def test_store_packet_dict_uses_top_level_channel(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

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
    assert payload["snr"] is None and payload["rssi"] is None
    assert priority == mesh._MESSAGE_POST_PRIORITY


def test_store_packet_dict_handles_invalid_channel(mesh_module, monkeypatch):
    mesh = mesh_module
    captured = []
    monkeypatch.setattr(
        mesh,
        "_queue_post_json",
        lambda path, payload, *, priority: captured.append((path, payload, priority)),
    )

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
    assert priority == mesh._MESSAGE_POST_PRIORITY


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
    assert "failed to store packet" in captured.out


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
