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
"""Unit tests for :mod:`data.mesh_ingestor.provider` integration seams."""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from data.mesh_ingestor import daemon  # noqa: E402 - path setup
from data.mesh_ingestor.provider import Provider  # noqa: E402 - path setup
from data.mesh_ingestor.providers.meshtastic import (  # noqa: E402 - path setup
    MeshtasticProvider,
)
from data.mesh_ingestor.connection import parse_tcp_target  # noqa: E402 - path setup
from data.mesh_ingestor.providers.meshcore import (  # noqa: E402 - path setup
    MeshcoreProvider,
    _MeshcoreInterface,
    _contact_to_node_dict,
    _derive_message_id,
    _make_connection,
    _make_event_handlers,
    _meshcore_adv_type_to_role,
    _meshcore_node_id,
    _meshcore_short_name,
    _process_contact_update,
    _process_contacts,
    _process_self_info,
    _pubkey_prefix_to_node_id,
    _record_meshcore_message,
    _self_info_to_node_dict,
    _to_json_safe,
)


def test_meshtastic_provider_satisfies_protocol():
    """MeshtasticProvider must structurally satisfy the Provider Protocol."""
    assert isinstance(MeshtasticProvider(), Provider)


def test_daemon_main_uses_provider_connect(monkeypatch):
    calls = {"connect": 0}

    class FakeProvider(MeshtasticProvider):
        def subscribe(self):
            return []

        def connect(self, *, active_candidate):  # type: ignore[override]
            calls["connect"] += 1

            # Return a minimal iface and stop immediately via Event.
            class Iface:
                nodes = {}

                def close(self):
                    return None

            return Iface(), "serial0", active_candidate

        def extract_host_node_id(self, iface):  # type: ignore[override]
            return "!host"

        def node_snapshot_items(self, iface):  # type: ignore[override]
            return []

    # Make the loop exit quickly.
    class AutoStopEvent:
        def __init__(self):
            self._set = False

        def set(self):
            self._set = True

        def is_set(self):
            return self._set

        def wait(self, _timeout=None):
            self._set = True
            return True

    monkeypatch.setattr(daemon.config, "SNAPSHOT_SECS", 0)
    monkeypatch.setattr(daemon.config, "_RECONNECT_INITIAL_DELAY_SECS", 0)
    monkeypatch.setattr(daemon.config, "_RECONNECT_MAX_DELAY_SECS", 0)
    monkeypatch.setattr(daemon.config, "_CLOSE_TIMEOUT_SECS", 0)
    monkeypatch.setattr(daemon.config, "_INGESTOR_HEARTBEAT_SECS", 0)
    monkeypatch.setattr(daemon.config, "ENERGY_SAVING", False)
    monkeypatch.setattr(daemon.config, "_INACTIVITY_RECONNECT_SECS", 0)
    monkeypatch.setattr(daemon.config, "CONNECTION", "serial0")

    monkeypatch.setattr(
        daemon,
        "threading",
        types.SimpleNamespace(
            Event=AutoStopEvent,
            current_thread=daemon.threading.current_thread,
            main_thread=daemon.threading.main_thread,
        ),
    )

    monkeypatch.setattr(
        daemon.handlers, "register_host_node_id", lambda *_a, **_k: None
    )
    monkeypatch.setattr(daemon.handlers, "host_node_id", lambda: "!host")
    monkeypatch.setattr(daemon.handlers, "upsert_node", lambda *_a, **_k: None)
    monkeypatch.setattr(daemon.handlers, "last_packet_monotonic", lambda: None)
    monkeypatch.setattr(
        daemon.ingestors, "set_ingestor_node_id", lambda *_a, **_k: None
    )
    monkeypatch.setattr(
        daemon.ingestors, "queue_ingestor_heartbeat", lambda *_a, **_k: True
    )

    daemon.main(provider=FakeProvider())
    assert calls["connect"] >= 1


def test_node_snapshot_items_retries_on_concurrent_mutation(monkeypatch):
    """node_snapshot_items must retry on dict-mutation RuntimeError, not raise."""
    from data.mesh_ingestor.providers.meshtastic import MeshtasticProvider

    attempt = {"n": 0}

    class MutatingNodes:
        def items(self):
            attempt["n"] += 1
            if attempt["n"] < 3:
                raise RuntimeError("dictionary changed size during iteration")
            return [("!aabbccdd", {"num": 1})]

    class FakeIface:
        nodes = MutatingNodes()

    monkeypatch.setattr("time.sleep", lambda _: None)
    result = MeshtasticProvider().node_snapshot_items(FakeIface())
    assert result == [("!aabbccdd", {"num": 1})]
    assert attempt["n"] == 3


def test_node_snapshot_items_returns_empty_after_retry_exhaustion(monkeypatch):
    """node_snapshot_items returns [] (non-fatal) when all retries fail."""
    from data.mesh_ingestor.providers.meshtastic import MeshtasticProvider
    import data.mesh_ingestor.providers.meshtastic as _mod

    class AlwaysMutating:
        def items(self):
            raise RuntimeError("dictionary changed size during iteration")

    class FakeIface:
        nodes = AlwaysMutating()

    monkeypatch.setattr("time.sleep", lambda _: None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    result = MeshtasticProvider().node_snapshot_items(FakeIface())
    assert result == []


def test_meshtastic_subscribe_is_idempotent(monkeypatch):
    """Calling subscribe() twice returns the cached list without re-subscribing."""
    import data.mesh_ingestor.providers.meshtastic as _m

    subscribe_calls: list[str] = []

    monkeypatch.setattr(
        _m,
        "pub",
        types.SimpleNamespace(
            subscribe=lambda _h, topic: subscribe_calls.append(topic)
        ),
    )

    provider = MeshtasticProvider()
    first = provider.subscribe()
    second = provider.subscribe()

    assert first == second
    # pub.subscribe should only have been called once (first invocation)
    assert len(subscribe_calls) == len(first)


# ---------------------------------------------------------------------------
# MeshcoreProvider tests
# ---------------------------------------------------------------------------


def test_meshcore_provider_satisfies_protocol():
    """MeshcoreProvider must structurally satisfy the Provider Protocol."""
    assert isinstance(MeshcoreProvider(), Provider)


def test_meshcore_provider_name():
    """MeshcoreProvider.name must be 'meshcore'."""
    assert MeshcoreProvider().name == "meshcore"


def test_meshcore_subscribe_returns_empty_list():
    """MeshCore has no pubsub topics; subscribe() must return an empty list."""
    assert MeshcoreProvider().subscribe() == []


@pytest.mark.parametrize(
    "target",
    [
        "meshnode.local:4403",
        "meshtastic.local:4403",
        "hostname:1234",
        "otherhost:80",
    ],
)
def test_meshcore_connect_accepts_tcp_targets(target, monkeypatch):
    """connect() must succeed for TCP host:port targets."""
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod, "_run_meshcore", _fake_run_meshcore())
    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    iface, resolved, next_candidate = MeshcoreProvider().connect(
        active_candidate=target
    )
    assert iface is not None
    assert resolved == target
    assert next_candidate == target
    iface.close()


def _fake_run_meshcore(*, error=None, host_node_id=None):
    """Return a fake ``_run_meshcore`` coroutine for use in connect() tests.

    The coroutine immediately signals success (or the given error) without
    opening a real serial port, then waits for the stop event so that
    ``_MeshcoreInterface.close()`` works correctly.
    """
    import asyncio as _asyncio

    async def _fake(iface, target, connected_event, error_holder):
        stop = _asyncio.Event()
        iface._stop_event = stop
        if error is not None:
            error_holder[0] = error
        else:
            iface.isConnected = True
            if host_node_id is not None:
                iface.host_node_id = host_node_id
        connected_event.set()
        await stop.wait()

    return _fake


@pytest.mark.parametrize(
    "target",
    [
        "/dev/ttyUSB0",
        "/dev/ttyACM0",
        "COM3",
        "AA:BB:CC:DD:EE:FF",
        "12345678-1234-1234-1234-123456789abc",
    ],
)
def test_meshcore_connect_accepts_serial_ble_targets(target, monkeypatch):
    """connect() must succeed for explicit serial ports and BLE addresses."""
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod, "_run_meshcore", _fake_run_meshcore())
    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    iface, resolved, next_candidate = MeshcoreProvider().connect(
        active_candidate=target
    )
    assert iface is not None
    assert resolved == target
    assert next_candidate == target
    iface.close()


def test_meshcore_connect_auto_discovers_serial(monkeypatch):
    """connect() with no target must resolve to the first serial candidate."""
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod, "_run_meshcore", _fake_run_meshcore())
    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(
        _mod, "default_serial_targets", lambda: ["/dev/ttyACM0", "/dev/ttyUSB0"]
    )
    iface, resolved, next_candidate = MeshcoreProvider().connect(active_candidate=None)
    assert iface is not None
    assert resolved == "/dev/ttyACM0"
    assert next_candidate == "/dev/ttyACM0"
    iface.close()


@pytest.mark.parametrize(
    "target,expected_class_name",
    [
        # Serial paths
        ("/dev/ttyUSB0", "SerialConnection"),
        ("/dev/ttyACM0", "SerialConnection"),
        ("COM3", "SerialConnection"),
        # BLE targets
        ("AA:BB:CC:DD:EE:FF", "BLEConnection"),
        ("12345678-1234-1234-1234-123456789abc", "BLEConnection"),
        # TCP targets
        ("hostname:4403", "TCPConnection"),
        ("192.168.1.1:4403", "TCPConnection"),
        ("meshcore-node.local:4403", "TCPConnection"),
    ],
)
def test_make_connection_routes_to_correct_class(
    target, expected_class_name, monkeypatch
):
    """_make_connection must instantiate the correct meshcore connection class."""
    import types
    import data.mesh_ingestor.providers.meshcore as _mod

    instances: list = []

    def _make_mock(name):
        def _cls(*args, **kwargs):
            obj = types.SimpleNamespace(name=name, args=args, kwargs=kwargs)
            instances.append(obj)
            return obj

        _cls.__name__ = name
        return _cls

    fake_meshcore = types.ModuleType("meshcore")
    fake_meshcore.BLEConnection = _make_mock("BLEConnection")
    fake_meshcore.SerialConnection = _make_mock("SerialConnection")
    fake_meshcore.TCPConnection = _make_mock("TCPConnection")

    import sys as _sys

    original = _sys.modules.get("meshcore")
    try:
        _sys.modules["meshcore"] = fake_meshcore
        result = _make_connection(target, 115200)
    finally:
        if original is None:
            _sys.modules.pop("meshcore", None)
        else:
            _sys.modules["meshcore"] = original

    assert len(instances) == 1
    assert instances[0].name == expected_class_name


def test_meshcore_connect_returns_closeable_interface(monkeypatch):
    """The interface returned by connect() must expose a close() method."""
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod, "_run_meshcore", _fake_run_meshcore())
    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    iface, _, _ = MeshcoreProvider().connect(active_candidate="/dev/ttyUSB0")
    assert callable(getattr(iface, "close", None))
    iface.close()  # must not raise


def test_meshcore_extract_host_node_id_none_by_default(monkeypatch):
    """extract_host_node_id returns None when the interface has no host_node_id."""
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod, "_run_meshcore", _fake_run_meshcore())
    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    iface, _, _ = MeshcoreProvider().connect(active_candidate="/dev/ttyUSB0")
    assert MeshcoreProvider().extract_host_node_id(iface) is None
    iface.close()


def test_meshcore_extract_host_node_id_set_on_connect(monkeypatch):
    """extract_host_node_id returns the node ID set by the connection handler."""
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(
        _mod, "_run_meshcore", _fake_run_meshcore(host_node_id="!aabbccdd")
    )
    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    iface, _, _ = MeshcoreProvider().connect(active_candidate="/dev/ttyUSB0")
    assert MeshcoreProvider().extract_host_node_id(iface) == "!aabbccdd"
    iface.close()


def test_meshcore_connect_propagates_connection_error(monkeypatch):
    """connect() must re-raise a ConnectionError when the handshake fails."""
    import data.mesh_ingestor.providers.meshcore as _mod

    exc = ConnectionError("no response")
    monkeypatch.setattr(_mod, "_run_meshcore", _fake_run_meshcore(error=exc))
    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    with pytest.raises(ConnectionError, match="no response"):
        MeshcoreProvider().connect(active_candidate="/dev/ttyUSB0")


def test_meshcore_node_snapshot_items_non_interface():
    """node_snapshot_items must return [] for any non-_MeshcoreInterface object."""
    assert MeshcoreProvider().node_snapshot_items(object()) == []


def test_meshcore_node_snapshot_items_with_contacts(monkeypatch):
    """node_snapshot_items returns contacts converted to node dicts."""
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod, "_run_meshcore", _fake_run_meshcore())
    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    iface, _, _ = MeshcoreProvider().connect(active_candidate="/dev/ttyUSB0")

    pub_key = "aabbccdd" + "00" * 28
    iface._update_contact(
        {"public_key": pub_key, "adv_name": "Alice", "last_advert": 1000}
    )

    items = MeshcoreProvider().node_snapshot_items(iface)
    assert len(items) == 1
    node_id, node_dict = items[0]
    assert node_id == "!aabbccdd"
    assert node_dict["user"]["longName"] == "Alice"
    assert node_dict["user"]["shortName"] == "aabb"
    iface.close()


def test_parse_tcp_target_detects_host_port():
    """parse_tcp_target must return (host, port) for host:port strings."""
    assert parse_tcp_target("meshnode.local:4403") == ("meshnode.local", 4403)
    assert parse_tcp_target("meshtastic.local:4403") == ("meshtastic.local", 4403)


def test_parse_tcp_target_rejects_serial_ble():
    """parse_tcp_target must return None for serial paths and BLE addresses."""
    assert parse_tcp_target("/dev/ttyUSB0") is None
    assert parse_tcp_target("AA:BB:CC:DD:EE:FF") is None
    assert parse_tcp_target("COM3") is None
    # BLE MAC address whose final octet is all-decimal must not be a false positive.
    assert parse_tcp_target("AA:BB:CC:DD:EE:12") is None


def test_record_meshcore_message_skipped_without_debug(monkeypatch, tmp_path):
    """_record_meshcore_message must not write anything when DEBUG is False."""
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod.config, "DEBUG", False)
    log_path = tmp_path / "ignored-meshcore.txt"
    monkeypatch.setattr(_mod, "_IGNORED_MESSAGE_LOG_PATH", log_path)

    _record_meshcore_message({"key": "value"}, source="/dev/ttyUSB0")

    assert not log_path.exists()


def test_record_meshcore_message_writes_with_debug(monkeypatch, tmp_path):
    """_record_meshcore_message must append a JSON line when DEBUG=1."""
    import json as _json
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod.config, "DEBUG", True)
    log_path = tmp_path / "ignored-meshcore.txt"
    monkeypatch.setattr(_mod, "_IGNORED_MESSAGE_LOG_PATH", log_path)

    _record_meshcore_message({"hello": "world"}, source="/dev/ttyUSB0")

    assert log_path.exists()
    line = log_path.read_text(encoding="utf-8").strip()
    entry = _json.loads(line)
    assert entry["source"] == "/dev/ttyUSB0"
    assert "timestamp" in entry
    assert "message" in entry


def test_record_meshcore_message_serialises_bytes(monkeypatch, tmp_path):
    """bytes values in the message must be base64-encoded, not repr'd."""
    import json as _json
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod.config, "DEBUG", True)
    log_path = tmp_path / "ignored-meshcore.txt"
    monkeypatch.setattr(_mod, "_IGNORED_MESSAGE_LOG_PATH", log_path)

    _record_meshcore_message({"payload": b"\xde\xad\xbe\xef"}, source="ble")

    entry = _json.loads(log_path.read_text(encoding="utf-8").strip())
    # The dict should be preserved and bytes base64-encoded, not str()'d.
    assert entry["message"] == {"payload": "3q2+7w=="}


def test_record_meshcore_message_appends_multiple(monkeypatch, tmp_path):
    """_record_meshcore_message must append successive entries on separate lines."""
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod.config, "DEBUG", True)
    log_path = tmp_path / "ignored-meshcore.txt"
    monkeypatch.setattr(_mod, "_IGNORED_MESSAGE_LOG_PATH", log_path)

    _record_meshcore_message("first", source="ble")
    _record_meshcore_message("second", source="ble")

    lines = [l for l in log_path.read_text(encoding="utf-8").splitlines() if l]
    assert len(lines) == 2


# ---------------------------------------------------------------------------
# _meshcore_node_id
# ---------------------------------------------------------------------------


def test_meshcore_node_id_derives_from_first_four_bytes():
    """_meshcore_node_id returns !xxxxxxxx from the first 8 hex chars."""
    assert _meshcore_node_id("aabbccdd" + "00" * 28) == "!aabbccdd"


def test_meshcore_node_id_lowercases_hex():
    """_meshcore_node_id must lowercase the hex digits."""
    assert _meshcore_node_id("AABBCCDD" + "00" * 28) == "!aabbccdd"


def test_meshcore_node_id_none_on_empty():
    """_meshcore_node_id returns None for an empty or too-short key."""
    assert _meshcore_node_id("") is None
    assert _meshcore_node_id("abc") is None
    assert _meshcore_node_id(None) is None  # type: ignore[arg-type]


def test_meshcore_short_name_first_four_hex_digits():
    """_meshcore_short_name returns the first four hex chars, lowercased."""
    assert _meshcore_short_name("AABBccdd" + "00" * 28) == "aabb"


def test_meshcore_short_name_empty_when_too_short():
    """_meshcore_short_name returns '' when the key has fewer than four hex digits."""
    assert _meshcore_short_name("") == ""
    assert _meshcore_short_name("abc") == ""
    assert _meshcore_short_name(None) == ""  # type: ignore[arg-type]


def test_meshcore_short_name_exactly_four_chars():
    """_meshcore_short_name with exactly four hex chars returns those four chars."""
    assert _meshcore_short_name("abcd") == "abcd"


# ---------------------------------------------------------------------------
# _pubkey_prefix_to_node_id
# ---------------------------------------------------------------------------


def test_pubkey_prefix_finds_matching_contact():
    """_pubkey_prefix_to_node_id returns the node ID for a matching prefix."""
    pub_key = "aabbccddee11" + "00" * 26
    contacts = {pub_key: {}}
    result = _pubkey_prefix_to_node_id(contacts, "aabbccddee11")
    assert result == "!aabbccdd"


def test_pubkey_prefix_returns_none_on_no_match():
    """_pubkey_prefix_to_node_id returns None when no contact matches."""
    contacts = {"aabbccddee11" + "00" * 26: {}}
    assert _pubkey_prefix_to_node_id(contacts, "ffeeddccbbaa") is None


def test_pubkey_prefix_returns_none_for_empty_contacts():
    """_pubkey_prefix_to_node_id returns None for an empty contacts dict."""
    assert _pubkey_prefix_to_node_id({}, "aabbccddee11") is None


# ---------------------------------------------------------------------------
# _meshcore_adv_type_to_role
# ---------------------------------------------------------------------------


def test_meshcore_adv_type_to_role_maps_adv_types():
    """Known ADV_TYPE_* integers map to dashboard role strings."""
    assert _meshcore_adv_type_to_role(1) == "COMPANION"
    assert _meshcore_adv_type_to_role(2) == "REPEATER"
    assert _meshcore_adv_type_to_role(3) == "ROOM_SERVER"
    assert _meshcore_adv_type_to_role(4) == "SENSOR"


def test_meshcore_adv_type_to_role_none_for_unmapped():
    """ADV_TYPE_NONE, unknown codes, and non-integers yield None."""
    assert _meshcore_adv_type_to_role(0) is None
    assert _meshcore_adv_type_to_role(99) is None
    assert _meshcore_adv_type_to_role(None) is None
    assert _meshcore_adv_type_to_role("1") is None
    assert (
        _meshcore_adv_type_to_role(2.0) is None
    )  # float rejected; JSON numeric coercion guard


# ---------------------------------------------------------------------------
# _contact_to_node_dict
# ---------------------------------------------------------------------------


def test_contact_to_node_dict_basic_fields():
    """_contact_to_node_dict populates user and lastHeard from a contact."""
    contact = {
        "public_key": "aabbccdd" + "00" * 28,
        "adv_name": "Alice",
        "last_advert": 1700000000,
    }
    node = _contact_to_node_dict(contact)
    assert node["lastHeard"] == 1700000000
    assert node["user"]["longName"] == "Alice"
    assert node["user"]["shortName"] == "aabb"
    assert node["user"]["publicKey"] == contact["public_key"]
    assert "role" not in node["user"]


def test_contact_to_node_dict_sets_role_from_type():
    """Contact ``type`` must populate ``user.role`` when ADV_TYPE is mapped."""
    base = {"public_key": "aabbccdd" + "00" * 28, "adv_name": "Rpt"}
    assert _contact_to_node_dict({**base, "type": 2})["user"]["role"] == "REPEATER"


def test_contact_to_node_dict_omits_role_for_adv_type_none():
    """ADV_TYPE_NONE (0) must not set ``user.role``."""
    contact = {
        "public_key": "aabbccdd" + "00" * 28,
        "adv_name": "X",
        "type": 0,
    }
    assert "role" not in _contact_to_node_dict(contact)["user"]


def test_contact_to_node_dict_includes_position_when_nonzero():
    """_contact_to_node_dict adds position when lat/lon are non-zero."""
    contact = {
        "public_key": "aa" * 32,
        "adv_name": "Node",
        "adv_lat": 51.5,
        "adv_lon": -0.1,
    }
    node = _contact_to_node_dict(contact)
    assert "position" in node
    assert node["position"]["latitude"] == pytest.approx(51.5)
    assert node["position"]["longitude"] == pytest.approx(-0.1)


def test_contact_to_node_dict_omits_position_at_origin():
    """_contact_to_node_dict omits position when lat=0 and lon=0."""
    contact = {
        "public_key": "aa" * 32,
        "adv_name": "Node",
        "adv_lat": 0.0,
        "adv_lon": 0.0,
    }
    node = _contact_to_node_dict(contact)
    assert "position" not in node


# ---------------------------------------------------------------------------
# _self_info_to_node_dict
# ---------------------------------------------------------------------------


def test_self_info_to_node_dict_basic_fields():
    """_self_info_to_node_dict maps name and public_key to user dict."""
    self_info = {"name": "MyNode", "public_key": "bb" * 32}
    node = _self_info_to_node_dict(self_info)
    assert node["user"]["longName"] == "MyNode"
    assert node["user"]["shortName"] == "bbbb"
    assert node["user"]["publicKey"] == "bb" * 32
    assert isinstance(node["lastHeard"], int)
    assert "role" not in node["user"]


def test_self_info_to_node_dict_sets_role_from_adv_type():
    """SELF_INFO ``adv_type`` must populate ``user.role`` when mapped."""
    self_info = {"name": "Srv", "public_key": "cc" * 32, "adv_type": 3}
    assert _self_info_to_node_dict(self_info)["user"]["role"] == "ROOM_SERVER"


def test_self_info_to_node_dict_omits_role_for_adv_type_none():
    """adv_type 0 must not set ``user.role``."""
    self_info = {"name": "N", "public_key": "dd" * 32, "adv_type": 0}
    assert "role" not in _self_info_to_node_dict(self_info)["user"]


def test_self_info_to_node_dict_includes_position():
    """_self_info_to_node_dict adds position when lat/lon are non-zero."""
    self_info = {
        "name": "N",
        "public_key": "cc" * 32,
        "adv_lat": 48.8,
        "adv_lon": 2.35,
    }
    node = _self_info_to_node_dict(self_info)
    assert node["position"]["latitude"] == pytest.approx(48.8)
    assert node["position"]["longitude"] == pytest.approx(2.35)


# ---------------------------------------------------------------------------
# _MeshcoreInterface contact management
# ---------------------------------------------------------------------------


def test_interface_update_and_snapshot_contacts():
    """_update_contact stores contacts; contacts_snapshot returns node entries."""
    iface = _MeshcoreInterface(target=None)
    pub_key = "aabbccdd" + "00" * 28
    iface._update_contact({"public_key": pub_key, "adv_name": "Bob", "last_advert": 1})
    snapshot = iface.contacts_snapshot()
    assert len(snapshot) == 1
    node_id, node_dict = snapshot[0]
    assert node_id == "!aabbccdd"
    assert node_dict["user"]["longName"] == "Bob"
    assert node_dict["user"]["shortName"] == "aabb"


def test_interface_lookup_node_id_by_prefix():
    """lookup_node_id finds a contact by its 6-byte public-key prefix."""
    iface = _MeshcoreInterface(target=None)
    pub_key = "aabbccddee11" + "00" * 26
    iface._update_contact({"public_key": pub_key, "adv_name": "C"})
    result = iface.lookup_node_id("aabbccddee11")
    assert result == "!aabbccdd"


def test_interface_lookup_node_id_returns_none_on_miss():
    """lookup_node_id returns None when no contact matches the prefix."""
    iface = _MeshcoreInterface(target=None)
    assert iface.lookup_node_id("ffeeddccbbaa") is None


def test_interface_contacts_snapshot_skips_short_keys():
    """contacts_snapshot ignores contacts whose public_key is too short for a node ID."""
    iface = _MeshcoreInterface(target=None)
    iface._update_contact({"public_key": "abc", "adv_name": "Short"})
    assert iface.contacts_snapshot() == []


def test_interface_close_is_idempotent():
    """_MeshcoreInterface.close() must not raise when called multiple times."""
    iface = _MeshcoreInterface(target=None)
    iface.close()
    iface.close()  # must not raise


# ---------------------------------------------------------------------------
# _derive_message_id
# ---------------------------------------------------------------------------


def test_derive_message_id_is_deterministic():
    """Same inputs must always produce the same ID."""
    assert _derive_message_id(1_000_000, "c0", "hello") == _derive_message_id(
        1_000_000, "c0", "hello"
    )


def test_derive_message_id_differs_by_channel():
    """Messages on different channels with the same timestamp must not collide."""
    assert _derive_message_id(1_000_000, "c0", "hello") != _derive_message_id(
        1_000_000, "c1", "hello"
    )


def test_derive_message_id_differs_by_text():
    """Messages with different text must produce different IDs."""
    assert _derive_message_id(1_000_000, "c0", "hello") != _derive_message_id(
        1_000_000, "c0", "world"
    )


def test_derive_message_id_differs_by_timestamp():
    """Messages at different timestamps must produce different IDs."""
    assert _derive_message_id(1_000_000, "c0", "hi") != _derive_message_id(
        1_000_001, "c0", "hi"
    )


def test_derive_message_id_is_32bit():
    """Result must fit in a 32-bit unsigned integer."""
    result = _derive_message_id(1_758_000_000, "aabbccddee11", "some text")
    assert 0 <= result <= 0xFFFFFFFF


def test_derive_message_id_distinguishes_long_messages_differing_after_128_chars():
    """Messages that share the first 128 characters must still get different IDs."""
    prefix = "A" * 128
    id_a = _derive_message_id(1_000_000, "c0", prefix + "AAAAAA")
    id_b = _derive_message_id(1_000_000, "c0", prefix + "BBBBBB")
    assert id_a != id_b


# ---------------------------------------------------------------------------
# _make_event_handlers — async callbacks
# ---------------------------------------------------------------------------


def _make_stub_handlers_module():
    """Return a minimal stub for data.mesh_ingestor.handlers."""
    import types

    mod = types.SimpleNamespace(
        upsert_node=lambda *_a, **_k: None,
        register_host_node_id=lambda *_a, **_k: None,
        _mark_packet_seen=lambda: None,
        store_packet_dict=lambda *_a, **_k: None,
    )
    return mod


def test_on_channel_msg_queues_packet(monkeypatch):
    """on_channel_msg must call store_packet_dict with the correct packet fields."""
    import asyncio
    import data.mesh_ingestor as _mesh_pkg
    import data.mesh_ingestor.providers.meshcore as _mod

    captured: list = []
    stub = _make_stub_handlers_module()
    stub.store_packet_dict = lambda pkt: captured.append(pkt)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    # _make_event_handlers does `from .. import handlers`; patch the package attr
    # so the deferred import resolves to our stub without touching sys.modules.
    monkeypatch.setattr(_mesh_pkg, "handlers", stub)

    class _FakeEvt:
        def __init__(self, payload):
            self.payload = payload

    iface = _MeshcoreInterface(target=None)
    hmap = _make_event_handlers(iface, "/dev/ttyUSB0")
    asyncio.run(
        hmap["CHANNEL_MSG_RECV"](
            _FakeEvt(
                {
                    "sender_timestamp": 1_758_000_000,
                    "text": "hello mesh",
                    "channel_idx": 2,
                    "SNR": 5,
                    "RSSI": -80,
                }
            )
        )
    )

    assert len(captured) == 1
    pkt = captured[0]
    assert pkt["decoded"]["text"] == "hello mesh"
    assert pkt["channel"] == 2
    assert pkt["to_id"] == "^all"
    assert pkt["from_id"] is None
    assert pkt["snr"] == 5
    assert pkt["rssi"] == -80
    # ID must be the hash-derived value, not the raw timestamp
    assert pkt["id"] == _derive_message_id(1_758_000_000, "c2", "hello mesh")


def test_on_contact_msg_queues_packet_with_from_id(monkeypatch):
    """on_contact_msg must resolve from_id via pubkey_prefix and set to_id to host."""
    import asyncio
    import data.mesh_ingestor as _mesh_pkg
    import data.mesh_ingestor.providers.meshcore as _mod

    captured: list = []
    stub = _make_stub_handlers_module()
    stub.store_packet_dict = lambda pkt: captured.append(pkt)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(_mesh_pkg, "handlers", stub)

    pub_key = "aabbccddee11" + "00" * 26
    iface = _MeshcoreInterface(target=None)
    iface.host_node_id = "!deadbeef"
    iface._update_contact({"public_key": pub_key, "adv_name": "Alice"})

    class _FakeEvt:
        def __init__(self, payload):
            self.payload = payload

    hmap = _make_event_handlers(iface, "/dev/ttyUSB0")
    asyncio.run(
        hmap["CONTACT_MSG_RECV"](
            _FakeEvt(
                {
                    "sender_timestamp": 1_758_000_001,
                    "text": "direct message",
                    "pubkey_prefix": "aabbccddee11",
                    "SNR": 3,
                }
            )
        )
    )

    assert len(captured) == 1
    pkt = captured[0]
    assert pkt["decoded"]["text"] == "direct message"
    assert pkt["from_id"] == "!aabbccdd"
    assert pkt["to_id"] == "!deadbeef"
    assert pkt["id"] == _derive_message_id(
        1_758_000_001, "aabbccddee11", "direct message"
    )


def test_on_channel_msg_skips_empty_text(monkeypatch):
    """on_channel_msg must not queue a packet when text is absent."""
    import asyncio
    import data.mesh_ingestor as _mesh_pkg
    import data.mesh_ingestor.providers.meshcore as _mod

    captured: list = []
    stub = _make_stub_handlers_module()
    stub.store_packet_dict = lambda pkt: captured.append(pkt)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(_mesh_pkg, "handlers", stub)

    iface = _MeshcoreInterface(target=None)

    class _FakeEvt:
        def __init__(self, payload):
            self.payload = payload

    hmap = _make_event_handlers(iface, "/dev/ttyUSB0")
    asyncio.run(hmap["CHANNEL_MSG_RECV"](_FakeEvt({"sender_timestamp": 1, "text": ""})))
    asyncio.run(hmap["CHANNEL_MSG_RECV"](_FakeEvt({"text": "hi"})))  # missing ts

    assert captured == []


@pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
def test_connect_raises_on_timeout(monkeypatch):
    """connect() raises ConnectionError when connected_event is never signalled.

    The background thread's event loop is stopped by iface.close() while the
    mock coroutine is still suspended; the resulting RuntimeError in that thread
    is expected and suppressed via the filterwarnings mark above.
    """
    import data.mesh_ingestor.providers.meshcore as _mod

    async def _hanging(iface, target, connected_event, error_holder):
        # Never signals connected_event — simulates a device that does not respond.
        import asyncio as _aio

        await _aio.sleep(60)

    monkeypatch.setattr(_mod, "_run_meshcore", _hanging)
    monkeypatch.setattr(_mod, "_CONNECT_TIMEOUT_SECS", 0.05)
    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    with pytest.raises(ConnectionError, match="Timed out"):
        MeshcoreProvider().connect(active_candidate="/dev/ttyUSB0")


# ---------------------------------------------------------------------------
# _to_json_safe
# ---------------------------------------------------------------------------


def test_to_json_safe_primitives():
    """Primitive JSON types pass through unchanged."""
    assert _to_json_safe("hello") == "hello"
    assert _to_json_safe(42) == 42
    assert _to_json_safe(3.14) == pytest.approx(3.14)
    assert _to_json_safe(True) is True
    assert _to_json_safe(None) is None


def test_to_json_safe_bytes_base64():
    """bytes values are base64-encoded to an ASCII string."""
    import base64

    raw = b"\xde\xad\xbe\xef"
    result = _to_json_safe(raw)
    assert result == base64.b64encode(raw).decode("ascii")


def test_to_json_safe_nested_dict():
    """Dicts are recursively converted; bytes leaves are base64-encoded."""
    result = _to_json_safe({"a": 1, "payload": b"\x00\x01"})
    assert result["a"] == 1
    assert isinstance(result["payload"], str)


def test_to_json_safe_list_and_tuple_and_set():
    """Lists, tuples, and sets are converted to JSON arrays."""
    assert _to_json_safe([1, 2]) == [1, 2]
    assert _to_json_safe((3, 4)) == [3, 4]
    result = _to_json_safe({5})
    assert isinstance(result, list)
    assert 5 in result


def test_to_json_safe_unknown_type_stringified():
    """Unknown types are coerced to str."""

    class _Custom:
        def __str__(self) -> str:
            return "custom-repr"

    assert _to_json_safe(_Custom()) == "custom-repr"


# ---------------------------------------------------------------------------
# _process_self_info
# ---------------------------------------------------------------------------


def test_process_self_info_sets_host_node_id():
    """_process_self_info must set iface.host_node_id and call register_host_node_id."""
    stub = _make_stub_handlers_module()
    registered: list = []
    stub.register_host_node_id = lambda nid: registered.append(nid)

    iface = _MeshcoreInterface(target=None)
    _process_self_info(
        {"public_key": "aabbccdd" + "00" * 28, "name": "Host"}, iface, stub
    )

    assert iface.host_node_id == "!aabbccdd"
    assert registered == ["!aabbccdd"]


def test_process_self_info_skips_empty_key():
    """_process_self_info must not set host_node_id when public_key is absent."""
    stub = _make_stub_handlers_module()
    registered: list = []
    stub.register_host_node_id = lambda nid: registered.append(nid)

    iface = _MeshcoreInterface(target=None)
    _process_self_info({"public_key": "", "name": "Unknown"}, iface, stub)

    assert iface.host_node_id is None
    assert registered == []


# ---------------------------------------------------------------------------
# _process_contacts
# ---------------------------------------------------------------------------


def test_process_contacts_updates_snapshot_and_upserts():
    """_process_contacts must update the iface snapshot and call upsert_node."""
    stub = _make_stub_handlers_module()
    upserted: list = []
    stub.upsert_node = lambda nid, nd: upserted.append(nid)

    iface = _MeshcoreInterface(target=None)
    pub_key = "aabbccdd" + "00" * 28
    _process_contacts(
        {pub_key: {"public_key": pub_key, "adv_name": "Alice"}}, iface, stub
    )

    assert upserted == ["!aabbccdd"]
    assert len(iface.contacts_snapshot()) == 1


def test_process_contacts_skips_short_keys():
    """_process_contacts must ignore contacts whose public_key is too short."""
    stub = _make_stub_handlers_module()
    upserted: list = []
    stub.upsert_node = lambda nid, nd: upserted.append(nid)

    iface = _MeshcoreInterface(target=None)
    _process_contacts({"abc": {"adv_name": "Short"}}, iface, stub)

    assert upserted == []


def test_process_contacts_marks_packet_seen():
    """_process_contacts must always call _mark_packet_seen."""
    seen: list = []
    stub = _make_stub_handlers_module()
    stub._mark_packet_seen = lambda: seen.append(True)

    _process_contacts({}, _MeshcoreInterface(target=None), stub)

    assert seen == [True]


# ---------------------------------------------------------------------------
# _process_contact_update
# ---------------------------------------------------------------------------


def test_process_contact_update_upserts_node(monkeypatch):
    """_process_contact_update must upsert and update the snapshot."""
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    stub = _make_stub_handlers_module()
    upserted: list = []
    stub.upsert_node = lambda nid, nd: upserted.append(nid)

    iface = _MeshcoreInterface(target=None)
    pub_key = "aabbccdd" + "00" * 28
    _process_contact_update({"public_key": pub_key, "adv_name": "Bob"}, iface, stub)

    assert upserted == ["!aabbccdd"]
    assert len(iface.contacts_snapshot()) == 1


def test_process_contact_update_skips_empty_key(monkeypatch):
    """_process_contact_update must silently skip contacts without a valid key."""
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    stub = _make_stub_handlers_module()
    upserted: list = []
    stub.upsert_node = lambda nid, nd: upserted.append(nid)

    _process_contact_update(
        {"public_key": "", "adv_name": "Bad"}, _MeshcoreInterface(target=None), stub
    )

    assert upserted == []


# ---------------------------------------------------------------------------
# on_self_info via _make_event_handlers
# ---------------------------------------------------------------------------


def test_on_self_info_registers_and_upserts(monkeypatch):
    """SELF_INFO handler must register the host node and upsert it."""
    import asyncio
    import data.mesh_ingestor as _mesh_pkg
    import data.mesh_ingestor.providers.meshcore as _mod

    registered: list = []
    upserted: list = []
    stub = _make_stub_handlers_module()
    stub.register_host_node_id = lambda nid: registered.append(nid)
    stub.upsert_node = lambda nid, nd: upserted.append(nid)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(_mesh_pkg, "handlers", stub)

    class _Evt:
        payload = {"public_key": "aabbccdd" + "00" * 28, "name": "MyNode"}

    iface = _MeshcoreInterface(target=None)
    hmap = _make_event_handlers(iface, "/dev/ttyUSB0")
    asyncio.run(hmap["SELF_INFO"](_Evt()))

    assert iface.host_node_id == "!aabbccdd"
    assert registered == ["!aabbccdd"]
    assert upserted == ["!aabbccdd"]


# ---------------------------------------------------------------------------
# on_contacts via _make_event_handlers
# ---------------------------------------------------------------------------


def test_on_contacts_updates_contacts(monkeypatch):
    """CONTACTS handler must populate the iface contact snapshot."""
    import asyncio
    import data.mesh_ingestor as _mesh_pkg
    import data.mesh_ingestor.providers.meshcore as _mod

    upserted: list = []
    stub = _make_stub_handlers_module()
    stub.upsert_node = lambda nid, nd: upserted.append(nid)
    monkeypatch.setattr(_mesh_pkg, "handlers", stub)

    pub_key = "aabbccdd" + "00" * 28

    class _Evt:
        payload = {pub_key: {"public_key": pub_key, "adv_name": "C"}}

    iface = _MeshcoreInterface(target=None)
    hmap = _make_event_handlers(iface, "/dev/ttyUSB0")
    asyncio.run(hmap["CONTACTS"](_Evt()))

    assert "!aabbccdd" in upserted
    assert len(iface.contacts_snapshot()) == 1


# ---------------------------------------------------------------------------
# on_contact_update (NEW_CONTACT / NEXT_CONTACT) via _make_event_handlers
# ---------------------------------------------------------------------------


def test_on_new_contact_and_next_contact_update_iface(monkeypatch):
    """NEW_CONTACT and NEXT_CONTACT must both update the contact snapshot."""
    import asyncio
    import data.mesh_ingestor as _mesh_pkg
    import data.mesh_ingestor.providers.meshcore as _mod

    upserted: list = []
    stub = _make_stub_handlers_module()
    stub.upsert_node = lambda nid, nd: upserted.append(nid)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(_mesh_pkg, "handlers", stub)

    pub_key = "aabbccdd" + "00" * 28

    class _Evt:
        payload = {"public_key": pub_key, "adv_name": "D"}

    iface = _MeshcoreInterface(target=None)
    hmap = _make_event_handlers(iface, "/dev/ttyUSB0")
    asyncio.run(hmap["NEW_CONTACT"](_Evt()))
    asyncio.run(hmap["NEXT_CONTACT"](_Evt()))

    assert upserted.count("!aabbccdd") == 2


# ---------------------------------------------------------------------------
# on_disconnected via _make_event_handlers
# ---------------------------------------------------------------------------


def test_on_disconnected_clears_connected_flag(monkeypatch):
    """DISCONNECTED handler must set iface.isConnected to False."""
    import asyncio
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    class _Evt:
        payload = {}

    iface = _MeshcoreInterface(target=None)
    iface.isConnected = True
    hmap = _make_event_handlers(iface, "/dev/ttyUSB0")
    asyncio.run(hmap["DISCONNECTED"](_Evt()))

    assert iface.isConnected is False


# ---------------------------------------------------------------------------
# protocol field in emitted packets
# ---------------------------------------------------------------------------


def test_on_channel_msg_includes_protocol_meshcore(monkeypatch):
    """Channel message packets must carry protocol='meshcore'."""
    import asyncio
    import data.mesh_ingestor as _mesh_pkg
    import data.mesh_ingestor.providers.meshcore as _mod

    captured: list = []
    stub = _make_stub_handlers_module()
    stub.store_packet_dict = lambda pkt: captured.append(pkt)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(_mesh_pkg, "handlers", stub)

    class _Evt:
        payload = {"sender_timestamp": 1_000_000, "text": "ping", "channel_idx": 0}

    iface = _MeshcoreInterface(target=None)
    hmap = _make_event_handlers(iface, "/dev/ttyUSB0")
    asyncio.run(hmap["CHANNEL_MSG_RECV"](_Evt()))

    assert len(captured) == 1, "expected exactly one packet to be captured"
    assert captured[0]["protocol"] == "meshcore"


def test_on_contact_msg_includes_protocol_meshcore(monkeypatch):
    """Direct message packets must carry protocol='meshcore'."""
    import asyncio
    import data.mesh_ingestor as _mesh_pkg
    import data.mesh_ingestor.providers.meshcore as _mod

    captured: list = []
    stub = _make_stub_handlers_module()
    stub.store_packet_dict = lambda pkt: captured.append(pkt)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(_mesh_pkg, "handlers", stub)

    iface = _MeshcoreInterface(target=None)
    iface.host_node_id = "!deadbeef"

    class _Evt:
        payload = {
            "sender_timestamp": 1_000_001,
            "text": "direct",
            "pubkey_prefix": "",
        }

    hmap = _make_event_handlers(iface, "/dev/ttyUSB0")
    asyncio.run(hmap["CONTACT_MSG_RECV"](_Evt()))

    assert len(captured) == 1, "expected exactly one packet to be captured"
    assert captured[0]["protocol"] == "meshcore"


# ---------------------------------------------------------------------------
# _run_meshcore — full coroutine paths (fake meshcore module in sys.modules)
# ---------------------------------------------------------------------------


def _make_fake_meshcore_mod(
    *,
    connect_result: object = "ok",
    fail_ensure_contacts: bool = False,
    disconnect_raises: bool = False,
):
    """Build a minimal fake ``meshcore`` module for testing :func:`_run_meshcore`.

    Parameters:
        connect_result: Value returned by ``mc.connect()``.  Pass ``None`` to
            simulate a device that ignores the appstart handshake.
        fail_ensure_contacts: When ``True``, ``mc.ensure_contacts()`` raises a
            ``RuntimeError``.
        disconnect_raises: When ``True``, ``mc.disconnect()`` raises, exercising
            the ``finally`` exception-suppression path.
    """
    import enum

    EventType = enum.Enum(
        "EventType",
        [
            "SELF_INFO",
            "CONTACTS",
            "NEW_CONTACT",
            "NEXT_CONTACT",
            "CHANNEL_MSG_RECV",
            "CONTACT_MSG_RECV",
            "DISCONNECTED",
            "CONNECTED",
            "ACK",
            "OK",
            "ERROR",
            "NO_MORE_MSGS",
            "MESSAGES_WAITING",
            "MSG_SENT",
            "CURRENT_TIME",
            "UNKNOWN_EVT",
        ],
    )

    class _FakeMeshCore:
        def __init__(self, cx):
            self._catch_all = None

        def subscribe(self, event_type, callback):
            if event_type is None:
                self._catch_all = callback

        async def connect(self):
            return connect_result

        async def ensure_contacts(self):
            if fail_ensure_contacts:
                raise RuntimeError("contacts unavailable")

        async def start_auto_message_fetching(self):
            pass

        async def disconnect(self):
            if disconnect_raises:
                raise RuntimeError("disconnect failed")

    class _FakeSerialConnection:
        def __init__(self, target, baudrate):
            pass

    class _FakeBLEConnection:
        def __init__(self, address=None):
            pass

    class _FakeTCPConnection:
        def __init__(self, host, port):
            pass

    return types.SimpleNamespace(
        EventType=EventType,
        MeshCore=_FakeMeshCore,
        SerialConnection=_FakeSerialConnection,
        BLEConnection=_FakeBLEConnection,
        TCPConnection=_FakeTCPConnection,
    )


async def _run_until_connected(iface, target, fake_mod, mod):
    """Drive :func:`_run_meshcore` in a task and return once connected (or failed)."""
    import asyncio as _aio
    import threading

    connected_event = threading.Event()
    error_holder: list = [None]
    task = _aio.create_task(
        mod._run_meshcore(iface, target, connected_event, error_holder)
    )
    for _ in range(100):
        await _aio.sleep(0)
        if connected_event.is_set():
            break
    if iface._stop_event is not None:
        iface._stop_event.set()
    await task
    return connected_event, error_holder


def test_run_meshcore_happy_path(monkeypatch):
    """_run_meshcore must signal connected and leave isConnected=True on success."""
    import asyncio
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    fake_mod = _make_fake_meshcore_mod()
    monkeypatch.setitem(sys.modules, "meshcore", fake_mod)

    iface = _MeshcoreInterface(target=None)

    connected_event, error_holder = asyncio.run(
        _run_until_connected(iface, "/dev/ttyUSB0", fake_mod, _mod)
    )

    assert connected_event.is_set()
    assert error_holder[0] is None
    assert iface.isConnected is True


def test_run_meshcore_connect_returns_none_raises(monkeypatch):
    """_run_meshcore must propagate ConnectionError when connect() returns None."""
    import asyncio
    import threading
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    fake_mod = _make_fake_meshcore_mod(connect_result=None)
    monkeypatch.setitem(sys.modules, "meshcore", fake_mod)

    iface = _MeshcoreInterface(target=None)
    connected_event = threading.Event()
    error_holder: list = [None]

    asyncio.run(
        _mod._run_meshcore(iface, "/dev/ttyUSB0", connected_event, error_holder)
    )

    assert connected_event.is_set()
    assert isinstance(error_holder[0], ConnectionError)
    assert "appstart" in str(error_holder[0])


def test_run_meshcore_ensure_contacts_failure_continues(monkeypatch):
    """ensure_contacts() raising must log a warning but not abort the connection."""
    import asyncio
    import data.mesh_ingestor.providers.meshcore as _mod

    logged: list = []
    monkeypatch.setattr(
        _mod.config,
        "_debug_log",
        lambda *_a, severity=None, **_k: logged.append(severity),
    )
    fake_mod = _make_fake_meshcore_mod(fail_ensure_contacts=True)
    monkeypatch.setitem(sys.modules, "meshcore", fake_mod)

    iface = _MeshcoreInterface(target=None)

    connected_event, error_holder = asyncio.run(
        _run_until_connected(iface, "/dev/ttyUSB0", fake_mod, _mod)
    )

    assert connected_event.is_set()
    assert error_holder[0] is None
    assert "warning" in logged


def test_run_meshcore_disconnect_exception_suppressed(monkeypatch):
    """disconnect() raising in the finally block must be silently swallowed."""
    import asyncio
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    fake_mod = _make_fake_meshcore_mod(disconnect_raises=True)
    monkeypatch.setitem(sys.modules, "meshcore", fake_mod)

    iface = _MeshcoreInterface(target=None)

    connected_event, error_holder = asyncio.run(
        _run_until_connected(iface, "/dev/ttyUSB0", fake_mod, _mod)
    )

    assert connected_event.is_set()
    assert error_holder[0] is None


def test_run_meshcore_on_unhandled_skips_known_records_unknown(monkeypatch):
    """_on_unhandled must only call _record_meshcore_message for truly unknown events."""
    import asyncio
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    recorded: list = []
    monkeypatch.setattr(
        _mod,
        "_record_meshcore_message",
        lambda msg, *, source: recorded.append(source),
    )
    fake_mod = _make_fake_meshcore_mod()
    monkeypatch.setitem(sys.modules, "meshcore", fake_mod)

    iface = _MeshcoreInterface(target=None)

    async def _exercise():
        import asyncio as _aio
        import threading

        connected_event = threading.Event()
        error_holder: list = [None]
        task = _aio.create_task(
            _mod._run_meshcore(iface, "/dev/ttyUSB0", connected_event, error_holder)
        )
        for _ in range(100):
            await _aio.sleep(0)
            if connected_event.is_set():
                break

        mc = iface._mc
        EventType = fake_mod.EventType

        class _Evt:
            def __init__(self, etype, payload=None):
                self.type = etype
                self.payload = payload

        # Handled type → no record
        await mc._catch_all(_Evt(EventType.SELF_INFO))
        # Silent type → no record
        await mc._catch_all(_Evt(EventType.ACK))
        # Truly unknown type → must be recorded
        await mc._catch_all(_Evt(EventType.UNKNOWN_EVT, payload={"x": 1}))

        if iface._stop_event:
            iface._stop_event.set()
        await task

    asyncio.run(_exercise())

    assert len(recorded) == 1, "only the unknown event should be recorded"
    assert "UNKNOWN_EVT" in recorded[0]
