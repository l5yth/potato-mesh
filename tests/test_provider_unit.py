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
from contextlib import suppress
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from data.mesh_ingestor import daemon  # noqa: E402 - path setup
from data.mesh_ingestor.mesh_protocol import MeshProtocol  # noqa: E402 - path setup
from data.mesh_ingestor.protocols.meshtastic import (  # noqa: E402 - path setup
    MeshtasticProvider,
)
from data.mesh_ingestor.connection import parse_tcp_target  # noqa: E402 - path setup
from data.mesh_ingestor.protocols.meshcore import (  # noqa: E402 - path setup
    EventType,
    MeshcoreProvider,
    _CHANNEL_PROBE_FALLBACK_MAX,
    _MeshcoreInterface,
    _contact_to_node_dict,
    _derive_message_id,
    _derive_modem_preset,
    _derive_synthetic_node_id,
    _ensure_channel_names,
    _extract_mention_names,
    _make_connection,
    _make_event_handlers,
    _meshcore_adv_type_to_role,
    _meshcore_node_id,
    _meshcore_short_name,
    _parse_sender_name,
    _process_contact_update,
    _process_contacts,
    _process_self_info,
    _pubkey_prefix_to_node_id,
    _record_meshcore_message,
    _self_info_to_node_dict,
    _store_meshcore_position,
    _synthetic_node_dict,
    _to_json_safe,
)


def test_meshtastic_provider_satisfies_protocol():
    """MeshtasticProvider must structurally satisfy the Provider Protocol."""
    assert isinstance(MeshtasticProvider(), MeshProtocol)


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

    monkeypatch.setattr(daemon.config, "INSTANCES", (("http://test", ""),))
    monkeypatch.setattr(daemon.config, "INSTANCE", "http://test")
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
    from data.mesh_ingestor.protocols.meshtastic import MeshtasticProvider

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
    from data.mesh_ingestor.protocols.meshtastic import MeshtasticProvider
    import data.mesh_ingestor.protocols.meshtastic as _mod

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
    import data.mesh_ingestor.protocols.meshtastic as _m

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
    assert isinstance(MeshcoreProvider(), MeshProtocol)


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
    import data.mesh_ingestor.protocols.meshcore as _mod

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
    import data.mesh_ingestor.protocols.meshcore as _mod

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
    import data.mesh_ingestor.protocols.meshcore as _mod

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
    import data.mesh_ingestor.protocols.meshcore as _mod

    instances: list = []

    def _make_mock(name):
        def _cls(*args, **kwargs):
            obj = types.SimpleNamespace(name=name, args=args, kwargs=kwargs)
            instances.append(obj)
            return obj

        _cls.__name__ = name
        return _cls

    # Patch module-level names directly — sys.modules patching no longer works
    # because BLEConnection/SerialConnection/TCPConnection are imported at module
    # load time (not lazily inside the function).
    monkeypatch.setattr(_mod, "BLEConnection", _make_mock("BLEConnection"))
    monkeypatch.setattr(_mod, "SerialConnection", _make_mock("SerialConnection"))
    monkeypatch.setattr(_mod, "TCPConnection", _make_mock("TCPConnection"))

    result = _make_connection(target, 115200)

    assert len(instances) == 1
    assert instances[0].name == expected_class_name


def test_meshcore_connect_returns_closeable_interface(monkeypatch):
    """The interface returned by connect() must expose a close() method."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod, "_run_meshcore", _fake_run_meshcore())
    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    iface, _, _ = MeshcoreProvider().connect(active_candidate="/dev/ttyUSB0")
    assert callable(getattr(iface, "close", None))
    iface.close()  # must not raise


def test_meshcore_extract_host_node_id_none_by_default(monkeypatch):
    """extract_host_node_id returns None when the interface has no host_node_id."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod, "_run_meshcore", _fake_run_meshcore())
    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    iface, _, _ = MeshcoreProvider().connect(active_candidate="/dev/ttyUSB0")
    assert MeshcoreProvider().extract_host_node_id(iface) is None
    iface.close()


def test_meshcore_extract_host_node_id_set_on_connect(monkeypatch):
    """extract_host_node_id returns the node ID set by the connection handler."""
    import data.mesh_ingestor.protocols.meshcore as _mod

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
    import data.mesh_ingestor.protocols.meshcore as _mod

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
    import data.mesh_ingestor.protocols.meshcore as _mod

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


def test_meshcore_node_snapshot_items_includes_self_node_when_cached(monkeypatch):
    """node_snapshot_items appends the self-node when _self_info_payload is set."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod, "_run_meshcore", _fake_run_meshcore())
    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    iface, _, _ = MeshcoreProvider().connect(active_candidate="/dev/ttyUSB0")

    self_pub_key = "deadbeef" + "00" * 28
    iface._self_info_payload = {"public_key": self_pub_key, "name": "SelfNode"}

    items = MeshcoreProvider().node_snapshot_items(iface)
    assert len(items) == 1
    node_id, node_dict = items[0]
    assert node_id == "!deadbeef"
    assert node_dict["user"]["longName"] == "SelfNode"
    iface.close()


def test_meshcore_node_snapshot_items_excludes_self_node_when_no_payload(monkeypatch):
    """node_snapshot_items omits the self-node when no SELF_INFO has been received."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod, "_run_meshcore", _fake_run_meshcore())
    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    iface, _, _ = MeshcoreProvider().connect(active_candidate="/dev/ttyUSB0")

    assert iface._self_info_payload is None
    items = MeshcoreProvider().node_snapshot_items(iface)
    assert items == []
    iface.close()


def test_meshcore_node_snapshot_items_contacts_and_self(monkeypatch):
    """node_snapshot_items includes both contacts and the self-node."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod, "_run_meshcore", _fake_run_meshcore())
    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    iface, _, _ = MeshcoreProvider().connect(active_candidate="/dev/ttyUSB0")

    contact_pub_key = "aabbccdd" + "00" * 28
    iface._update_contact(
        {"public_key": contact_pub_key, "adv_name": "Peer", "last_advert": 1000}
    )
    self_pub_key = "deadbeef" + "00" * 28
    iface._self_info_payload = {"public_key": self_pub_key, "name": "Self"}

    items = MeshcoreProvider().node_snapshot_items(iface)
    node_ids = {nid for nid, _ in items}
    assert "!aabbccdd" in node_ids
    assert "!deadbeef" in node_ids
    assert len(items) == 2
    iface.close()


# ---------------------------------------------------------------------------
# MeshcoreProvider.self_node_item
# ---------------------------------------------------------------------------


def test_meshcore_self_node_item_non_interface():
    """self_node_item returns None for any non-_MeshcoreInterface object."""
    assert MeshcoreProvider().self_node_item(object()) is None


def test_meshcore_self_node_item_no_payload(monkeypatch):
    """self_node_item returns None when no SELF_INFO payload is cached."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod, "_run_meshcore", _fake_run_meshcore())
    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    iface, _, _ = MeshcoreProvider().connect(active_candidate="/dev/ttyUSB0")

    assert iface._self_info_payload is None
    assert MeshcoreProvider().self_node_item(iface) is None
    iface.close()


def test_meshcore_self_node_item_with_payload(monkeypatch):
    """self_node_item returns the correct (node_id, node_dict) when payload cached."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod, "_run_meshcore", _fake_run_meshcore())
    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    iface, _, _ = MeshcoreProvider().connect(active_candidate="/dev/ttyUSB0")

    pub_key = "deadbeef" + "00" * 28
    iface._self_info_payload = {"public_key": pub_key, "name": "MyHost"}

    result = MeshcoreProvider().self_node_item(iface)
    assert result is not None
    node_id, node_dict = result
    assert node_id == "!deadbeef"
    assert node_dict["user"]["longName"] == "MyHost"
    assert node_dict["protocol"] == "meshcore"
    iface.close()


def test_meshcore_self_node_item_empty_key(monkeypatch):
    """self_node_item returns None when the cached public_key is empty."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod, "_run_meshcore", _fake_run_meshcore())
    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    iface, _, _ = MeshcoreProvider().connect(active_candidate="/dev/ttyUSB0")

    # An empty key produces a None node_id from _meshcore_node_id.
    iface._self_info_payload = {"public_key": "", "name": "Bad"}
    assert MeshcoreProvider().self_node_item(iface) is None
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
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "DEBUG", False)
    log_path = tmp_path / "ignored-meshcore.txt"
    monkeypatch.setattr(_mod, "_IGNORED_MESSAGE_LOG_PATH", log_path)

    _record_meshcore_message({"key": "value"}, source="/dev/ttyUSB0")

    assert not log_path.exists()


def test_record_meshcore_message_writes_with_debug(monkeypatch, tmp_path):
    """_record_meshcore_message must append a JSON line when DEBUG=1."""
    import json as _json
    import data.mesh_ingestor.protocols.meshcore as _mod

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
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "DEBUG", True)
    log_path = tmp_path / "ignored-meshcore.txt"
    monkeypatch.setattr(_mod, "_IGNORED_MESSAGE_LOG_PATH", log_path)

    _record_meshcore_message({"payload": b"\xde\xad\xbe\xef"}, source="ble")

    entry = _json.loads(log_path.read_text(encoding="utf-8").strip())
    # The dict should be preserved and bytes base64-encoded, not str()'d.
    assert entry["message"] == {"payload": "3q2+7w=="}


def test_record_meshcore_message_appends_multiple(monkeypatch, tmp_path):
    """_record_meshcore_message must append successive entries on separate lines."""
    import data.mesh_ingestor.protocols.meshcore as _mod

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


def test_meshcore_short_name_first_two_bytes_of_node_id():
    """_meshcore_short_name returns the first four hex chars of the node ID."""
    assert _meshcore_short_name("!aabbccdd") == "aabb"
    assert _meshcore_short_name("!AABBccdd") == "aabb"


def test_meshcore_short_name_empty_when_too_short():
    """_meshcore_short_name returns '' when the node ID is missing or too short."""
    assert _meshcore_short_name("") == ""
    assert _meshcore_short_name("!ab") == ""
    assert _meshcore_short_name(None) == ""  # type: ignore[arg-type]


def test_meshcore_short_name_without_bang_prefix():
    """_meshcore_short_name handles node IDs without the leading '!' prefix."""
    assert _meshcore_short_name("cafef00d") == "cafe"


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
# _parse_sender_name
# ---------------------------------------------------------------------------


def test_parse_sender_name_typical():
    """Returns the name portion of 'SenderName: body' text."""
    assert _parse_sender_name("T114-Zeh: Hello world") == "T114-Zeh"


def test_parse_sender_name_trims_whitespace():
    """Leading and trailing whitespace is stripped from the sender name."""
    assert _parse_sender_name("  Alice : body  ") == "Alice"


def test_parse_sender_name_body_may_contain_colons():
    """Only the first colon separates sender from body; body colons are kept."""
    assert _parse_sender_name("BGruenauBot: ack | 80,42,68 (3 hops)") == "BGruenauBot"


def test_parse_sender_name_no_colon_returns_none():
    """Returns None when the text contains no colon."""
    assert _parse_sender_name("no colon here") is None


def test_parse_sender_name_empty_string_returns_none():
    """Returns None for an empty string."""
    assert _parse_sender_name("") is None


def test_parse_sender_name_colon_first_returns_none():
    """Returns None when the colon is the first character (empty sender)."""
    assert _parse_sender_name(":body") is None


def test_parse_sender_name_whitespace_only_before_colon_returns_none():
    """Returns None when only whitespace appears before the colon."""
    assert _parse_sender_name("   : body") is None


# ---------------------------------------------------------------------------
# _derive_synthetic_node_id
# ---------------------------------------------------------------------------


def test_derive_synthetic_node_id_format():
    """Synthetic node ID must start with ! and have eight hex chars."""
    nid = _derive_synthetic_node_id("Alice")
    assert nid.startswith("!")
    assert len(nid) == 9
    assert all(c in "0123456789abcdef" for c in nid[1:])


def test_derive_synthetic_node_id_deterministic():
    """Same long name always produces the same node ID."""
    assert _derive_synthetic_node_id("Alice") == _derive_synthetic_node_id("Alice")


def test_derive_synthetic_node_id_distinct_names():
    """Different long names produce different node IDs."""
    assert _derive_synthetic_node_id("Alice") != _derive_synthetic_node_id("Bob")


def test_derive_synthetic_node_id_unicode():
    """Unicode names produce valid IDs."""
    nid = _derive_synthetic_node_id("pete 🍁")
    assert nid.startswith("!")
    assert len(nid) == 9


# ---------------------------------------------------------------------------
# _synthetic_node_dict
# ---------------------------------------------------------------------------


def test_synthetic_node_dict_fields():
    """_synthetic_node_dict returns a node dict with correct user fields."""
    nd = _synthetic_node_dict("T114-Zeh")
    assert nd["protocol"] == "meshcore"
    assert nd["user"]["longName"] == "T114-Zeh"
    assert nd["user"]["role"] == "COMPANION"
    assert nd["user"]["synthetic"] is True
    assert isinstance(nd["lastHeard"], int)


def test_synthetic_node_dict_short_name_empty():
    """Short name is always empty — the Ruby web app derives it at query time."""
    nd = _synthetic_node_dict("pete 🍁")
    assert nd["user"]["shortName"] == ""


# ---------------------------------------------------------------------------
# _extract_mention_names
# ---------------------------------------------------------------------------


def test_extract_mention_names_single():
    """Extracts one mention name."""
    assert _extract_mention_names("Hey @[Alice]!") == ["Alice"]


def test_extract_mention_names_multiple():
    """Extracts multiple mention names in order."""
    assert _extract_mention_names("@[Alpha] and @[Beta]") == ["Alpha", "Beta"]


def test_extract_mention_names_none():
    """Returns empty list when no mentions are present."""
    assert _extract_mention_names("no mentions here") == []


def test_extract_mention_names_preserves_spaces():
    """Names with spaces inside brackets are preserved."""
    assert _extract_mention_names("Hi @[MaLiBu'2 Britz-Sued]") == [
        "MaLiBu'2 Britz-Sued"
    ]


# ---------------------------------------------------------------------------
# _MeshcoreInterface.lookup_node_id_by_name
# ---------------------------------------------------------------------------


def test_lookup_node_id_by_name_finds_exact_match():
    """Returns the node ID when a contact with the given adv_name exists."""
    iface = _MeshcoreInterface(target=None)
    pub_key = "aabbccdd" + "00" * 28
    iface._update_contact({"public_key": pub_key, "adv_name": "Alice"})
    assert iface.lookup_node_id_by_name("Alice") == "!aabbccdd"


def test_lookup_node_id_by_name_trims_query():
    """Strips whitespace from the query before comparing."""
    iface = _MeshcoreInterface(target=None)
    pub_key = "aabbccdd" + "00" * 28
    iface._update_contact({"public_key": pub_key, "adv_name": "Alice"})
    assert iface.lookup_node_id_by_name("  Alice  ") == "!aabbccdd"


def test_lookup_node_id_by_name_case_sensitive_mismatch():
    """Returns None for a case-insensitive match — comparison is case-sensitive."""
    iface = _MeshcoreInterface(target=None)
    pub_key = "aabbccdd" + "00" * 28
    iface._update_contact({"public_key": pub_key, "adv_name": "Alice"})
    assert iface.lookup_node_id_by_name("alice") is None


def test_lookup_node_id_by_name_no_contacts():
    """Returns None when no contacts are registered."""
    iface = _MeshcoreInterface(target=None)
    assert iface.lookup_node_id_by_name("Alice") is None


def test_lookup_node_id_by_name_empty_string():
    """Returns None for an empty name query."""
    iface = _MeshcoreInterface(target=None)
    pub_key = "aabbccdd" + "00" * 28
    iface._update_contact({"public_key": pub_key, "adv_name": "Alice"})
    assert iface.lookup_node_id_by_name("") is None


def test_lookup_node_id_by_name_none_query():
    """Returns None when adv_name argument is None."""
    iface = _MeshcoreInterface(target=None)
    assert iface.lookup_node_id_by_name(None) is None


def test_lookup_node_id_by_name_multiple_contacts():
    """Returns the correct node ID when multiple contacts are registered."""
    iface = _MeshcoreInterface(target=None)
    iface._update_contact({"public_key": "11111111" + "00" * 28, "adv_name": "Alpha"})
    iface._update_contact({"public_key": "22222222" + "00" * 28, "adv_name": "Beta"})
    assert iface.lookup_node_id_by_name("Alpha") == "!11111111"
    assert iface.lookup_node_id_by_name("Beta") == "!22222222"


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


def test_contact_to_node_dict_sets_protocol_meshcore():
    """_contact_to_node_dict must set protocol='meshcore' on every node dict."""
    contact = {"public_key": "aa" * 32, "adv_name": "Node"}
    assert _contact_to_node_dict(contact)["protocol"] == "meshcore"


def test_contact_to_node_dict_position_includes_time_from_last_advert():
    """position['time'] must equal last_advert when it is present."""
    contact = {
        "public_key": "aa" * 32,
        "adv_name": "Node",
        "adv_lat": 51.5,
        "adv_lon": -0.1,
        "last_advert": 1700001234,
    }
    node = _contact_to_node_dict(contact)
    assert node["position"]["time"] == 1700001234


def test_contact_to_node_dict_position_omits_time_without_last_advert():
    """position dict must not include 'time' when last_advert is absent."""
    contact = {
        "public_key": "aa" * 32,
        "adv_name": "Node",
        "adv_lat": 51.5,
        "adv_lon": -0.1,
    }
    node = _contact_to_node_dict(contact)
    assert "time" not in node["position"]


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


def test_self_info_to_node_dict_sets_protocol_meshcore():
    """_self_info_to_node_dict must set protocol='meshcore' on the node dict."""
    self_info = {"name": "MyNode", "public_key": "bb" * 32}
    assert _self_info_to_node_dict(self_info)["protocol"] == "meshcore"


def test_self_info_to_node_dict_position_includes_time():
    """position['time'] must be set to a recent integer when lat/lon are present."""
    import time as _time

    before = int(_time.time())
    self_info = {
        "name": "N",
        "public_key": "cc" * 32,
        "adv_lat": 48.8,
        "adv_lon": 2.35,
    }
    node = _self_info_to_node_dict(self_info)
    after = int(_time.time())
    assert "time" in node["position"]
    assert before <= node["position"]["time"] <= after


# ---------------------------------------------------------------------------
# _store_meshcore_position
# ---------------------------------------------------------------------------


def test_store_meshcore_position_queues_to_api_positions(monkeypatch):
    """_store_meshcore_position must enqueue a POST to /api/positions."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    posted: list = []
    monkeypatch.setattr(
        _mod._queue,
        "_queue_post_json",
        lambda route, payload, **_k: posted.append((route, payload)),
    )

    _store_meshcore_position("!aabbccdd", 51.5, -0.1, 1700001234, "!ingestor1")

    assert len(posted) == 1
    route, payload = posted[0]
    assert route == "/api/positions"
    assert payload["node_id"] == "!aabbccdd"
    assert payload["latitude"] == pytest.approx(51.5)
    assert payload["longitude"] == pytest.approx(-0.1)
    assert payload["position_time"] == 1700001234
    assert payload["from_id"] == "!aabbccdd"
    assert isinstance(payload["id"], int)
    assert payload["id"] >= 0


def test_store_meshcore_position_id_is_stable_for_same_node_and_time(monkeypatch):
    """The pseudo-ID must be identical for repeated calls with the same arguments."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    ids: list = []
    monkeypatch.setattr(
        _mod._queue,
        "_queue_post_json",
        lambda route, payload, **_k: ids.append(payload["id"]),
    )

    _store_meshcore_position("!aabbccdd", 51.5, -0.1, 1700001234, None)
    _store_meshcore_position("!aabbccdd", 51.5, -0.1, 1700001234, None)

    assert ids[0] == ids[1]


def test_store_meshcore_position_id_differs_for_different_times(monkeypatch):
    """The pseudo-ID must differ when position_time changes."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    ids: list = []
    monkeypatch.setattr(
        _mod._queue,
        "_queue_post_json",
        lambda route, payload, **_k: ids.append(payload["id"]),
    )

    _store_meshcore_position("!aabbccdd", 51.5, -0.1, 1700001234, None)
    _store_meshcore_position("!aabbccdd", 51.5, -0.1, 1700009999, None)

    assert ids[0] != ids[1]


def test_store_meshcore_position_falls_back_to_rx_time_when_no_position_time(
    monkeypatch,
):
    """When position_time is None, rx_time must be used as position_time."""
    import time as _time
    import data.mesh_ingestor.protocols.meshcore as _mod

    posted: list = []
    monkeypatch.setattr(
        _mod._queue,
        "_queue_post_json",
        lambda route, payload, **_k: posted.append(payload),
    )

    before = int(_time.time())
    _store_meshcore_position("!aabbccdd", 51.5, -0.1, None, None)
    after = int(_time.time())

    payload = posted[0]
    assert before <= payload["position_time"] <= after


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


def test_interface_close_swallows_runtime_error_from_loop():
    """close() must swallow RuntimeError from loop.call_soon_threadsafe.

    A race between the ``loop.is_closed()`` guard and the ``call_soon_threadsafe``
    invocation can leave the loop closed by the time we schedule the stop, in
    which case asyncio raises ``RuntimeError("Event loop is closed")``.  ``close()``
    must absorb that error so callers can treat shutdown as best-effort.
    """
    iface = _MeshcoreInterface(target=None)

    class _RacingLoop:
        def is_closed(self):
            return False

        def call_soon_threadsafe(self, *_a, **_k):
            raise RuntimeError("Event loop is closed")

        def stop(self):  # accessed as ``loop.stop`` arg in the no-stop_event branch
            return None

    iface._loop = _RacingLoop()
    iface._stop_event = types.SimpleNamespace(set=lambda: None)

    iface.close()  # must not raise
    assert iface.isConnected is False

    # Same code path with stop_event=None exercises the loop.stop() branch.
    iface2 = _MeshcoreInterface(target=None)
    iface2._loop = _RacingLoop()
    iface2._stop_event = None
    iface2.close()  # must not raise
    assert iface2.isConnected is False


# ---------------------------------------------------------------------------
# _derive_message_id
# ---------------------------------------------------------------------------


def test_derive_message_id_is_deterministic():
    """Same inputs must always produce the same ID."""
    assert _derive_message_id("alice", 1_000_000, "c0", "hello") == _derive_message_id(
        "alice", 1_000_000, "c0", "hello"
    )


def test_derive_message_id_differs_by_channel():
    """Messages on different channels with the same timestamp must not collide."""
    assert _derive_message_id("alice", 1_000_000, "c0", "hello") != _derive_message_id(
        "alice", 1_000_000, "c1", "hello"
    )


def test_derive_message_id_differs_by_text():
    """Messages with different text must produce different IDs."""
    assert _derive_message_id("alice", 1_000_000, "c0", "hello") != _derive_message_id(
        "alice", 1_000_000, "c0", "world"
    )


def test_derive_message_id_differs_by_timestamp():
    """Messages at different timestamps must produce different IDs."""
    assert _derive_message_id("alice", 1_000_000, "c0", "hi") != _derive_message_id(
        "alice", 1_000_001, "c0", "hi"
    )


def test_derive_message_id_is_53bit():
    """Result must fit in JS ``Number.MAX_SAFE_INTEGER`` (2**53 - 1).

    Federation passes the id through JSON, where Number values exceeding
    53 bits lose precision in the JavaScript frontend.  Clamping to 53 bits
    preserves the value across the round-trip while leaving ample collision
    headroom (~95M messages at the 50% birthday bound).
    """
    result = _derive_message_id("alice", 1_758_000_000, "c0", "some text")
    assert 0 <= result <= (1 << 53) - 1


def test_derive_message_id_distinguishes_long_messages_differing_after_128_chars():
    """Messages that share the first 128 characters must still get different IDs."""
    prefix = "A" * 128
    id_a = _derive_message_id("alice", 1_000_000, "c0", prefix + "AAAAAA")
    id_b = _derive_message_id("alice", 1_000_000, "c0", prefix + "BBBBBB")
    assert id_a != id_b


def test_derive_message_id_includes_sender_identity():
    """Two senders posting the same text on the same channel/second must NOT collide.

    Regression test for issue #751: prior to the fix the channel-message
    fingerprint omitted the sender entirely, so Alice and Bob both posting
    "ack" at the same instant collapsed into a single row.
    """
    alice_id = _derive_message_id("alice", 1_000_000, "c0", "ack")
    bob_id = _derive_message_id("bob", 1_000_000, "c0", "ack")
    assert alice_id != bob_id


def test_derive_message_id_channel_vs_dm_disjoint():
    """Channel and direct messages must occupy disjoint id namespaces.

    Without a discriminator that distinguishes the two classes, a channel
    message and a DM that happen to share the other components could collide.
    """
    channel_id = _derive_message_id("alice", 1_000_000, "c0", "hi")
    dm_id = _derive_message_id("alice", 1_000_000, "dm", "hi")
    assert channel_id != dm_id


def test_derive_message_id_identical_across_receivers():
    """Two ingestors with different roster state must derive the same id.

    The whole point of the fingerprint is that every input is sender-side, so
    two physically separate receivers compute the same id and the messages
    collapse on the ``messages.id`` PRIMARY KEY upsert.
    """
    args = ("alice", 1_758_000_000, "c0", "hello mesh")
    assert _derive_message_id(*args) == _derive_message_id(*args)


def test_derive_message_id_handles_invalid_utf8():
    """Inputs with surrogate pairs must not raise; ``errors='replace'`` cleans them."""
    bad_text = "before \ud800 after"  # lone surrogate is invalid UTF-8
    result = _derive_message_id("alice", 1_000_000, "c0", bad_text)
    assert 0 <= result <= (1 << 53) - 1


def test_derive_message_id_anonymous_channel_msgs_still_distinguished_by_other_fields():
    """Anonymous channel msgs (sender_identity="") still differ when text/ts differ.

    The empty sender-identity path is documented as a degraded mode in
    CONTRACTS.md (anonymous transmissions cannot be distinguished from each
    other when timestamp + channel + text also match).  This test pins down
    the *non-degraded* behaviour: as long as any of the remaining components
    differ, the ids must remain distinct.
    """
    base = _derive_message_id("", 1_000_000, "c0", "hi")
    assert base != _derive_message_id("", 1_000_001, "c0", "hi")  # ts differs
    assert base != _derive_message_id("", 1_000_000, "c1", "hi")  # channel differs
    assert base != _derive_message_id("", 1_000_000, "c0", "hello")  # text differs


# ---------------------------------------------------------------------------
# _make_event_handlers — async callbacks
# ---------------------------------------------------------------------------


def _make_stub_handlers_module():
    """Return a minimal stub for data.mesh_ingestor.handlers."""
    import types

    mod = types.SimpleNamespace(
        upsert_node=lambda *_a, **_k: None,
        register_host_node_id=lambda *_a, **_k: None,
        host_node_id=lambda: None,
        _mark_packet_seen=lambda: None,
        store_packet_dict=lambda *_a, **_k: None,
    )
    return mod


class _FakeEvt:
    """Minimal stand-in for a MeshCore SDK event object used in handler tests."""

    def __init__(self, payload):
        self.payload = payload


def _setup_channel_msg_handlers(monkeypatch, *, contacts=None):
    """Set up the patched handler environment for ``CHANNEL_MSG_RECV`` tests.

    Patches the debug logger and the ``handlers`` module reference so that
    :func:`_make_event_handlers` can be called without a real connection.

    Parameters:
        monkeypatch: pytest monkeypatch fixture.
        contacts: Optional list of contact dicts to pre-register on the
            returned interface, e.g. ``[{"public_key": "aabb…", "adv_name": "Alice"}]``.

    Returns:
        Tuple of ``(captured, upserted, iface, hmap)`` where *captured* is the
        list of packets passed to ``store_packet_dict``, *upserted* is the list
        of ``(node_id, node_dict)`` pairs passed to ``upsert_node``, *iface* is
        the :class:`_MeshcoreInterface` instance, and *hmap* is the event
        handler map returned by :func:`_make_event_handlers`.
    """
    import data.mesh_ingestor as _mesh_pkg
    import data.mesh_ingestor.protocols.meshcore as _mod

    captured: list = []
    upserted: list = []
    stub = _make_stub_handlers_module()
    stub.store_packet_dict = lambda pkt: captured.append(pkt)
    stub.upsert_node = lambda node_id, node_dict: upserted.append((node_id, node_dict))
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(_mesh_pkg, "handlers", stub)

    iface = _MeshcoreInterface(target=None)
    for contact in contacts or []:
        iface._update_contact(contact)
    hmap = _make_event_handlers(iface, "/dev/ttyUSB0")
    return captured, upserted, iface, hmap


def test_on_channel_msg_queues_packet(monkeypatch):
    """on_channel_msg must call store_packet_dict with the correct packet fields."""
    import asyncio

    # _make_event_handlers does `from .. import handlers`; _setup_channel_msg_handlers
    # patches the package attribute so the deferred import resolves to a stub.
    captured, _upserted, _iface, hmap = _setup_channel_msg_handlers(monkeypatch)
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
    # Text has no "SenderName:" prefix so from_id cannot be resolved.
    assert pkt["from_id"] is None
    assert pkt["snr"] == 5
    assert pkt["rssi"] == -80
    # ID must be the hash-derived value, not the raw timestamp.  The text has no
    # "Name:" prefix so the sender-identity component is the empty string.
    assert pkt["id"] == _derive_message_id("", 1_758_000_000, "c2", "hello mesh")


def test_on_channel_msg_resolves_from_id_via_sender_name(monkeypatch):
    """on_channel_msg sets from_id when sender name matches a known contact."""
    import asyncio

    pub_key = "aabbccdd" + "00" * 28
    captured, _upserted, _iface, hmap = _setup_channel_msg_handlers(
        monkeypatch,
        contacts=[{"public_key": pub_key, "adv_name": "T114-Zeh"}],
    )
    asyncio.run(
        hmap["CHANNEL_MSG_RECV"](
            _FakeEvt(
                {
                    "sender_timestamp": 1_758_000_002,
                    "text": "T114-Zeh: Test message",
                    "channel_idx": 0,
                    "SNR": 7,
                    "RSSI": -70,
                }
            )
        )
    )

    assert len(captured) == 1
    pkt = captured[0]
    assert pkt["decoded"]["text"] == "T114-Zeh: Test message"
    assert pkt["to_id"] == "^all"
    # Sender resolved from contacts via name prefix — no synthetic upsert needed.
    assert pkt["from_id"] == "!aabbccdd"


def test_on_channel_msg_creates_synthetic_node_when_sender_not_in_contacts(monkeypatch):
    """on_channel_msg upserts a synthetic node and sets from_id when sender is unknown."""
    import asyncio
    from data.mesh_ingestor.protocols.meshcore import _derive_synthetic_node_id

    captured, upserted, _iface, hmap = _setup_channel_msg_handlers(monkeypatch)
    asyncio.run(
        hmap["CHANNEL_MSG_RECV"](
            _FakeEvt(
                {
                    "sender_timestamp": 1_758_000_003,
                    "text": "UnknownSender: Hello",
                    "channel_idx": 0,
                }
            )
        )
    )

    assert len(captured) == 1
    expected_id = _derive_synthetic_node_id("UnknownSender")
    assert captured[0]["from_id"] == expected_id
    # A synthetic node should have been upserted for the sender.
    synth_upserts = [(nid, nd) for nid, nd in upserted if nid == expected_id]
    assert len(synth_upserts) == 1
    synth_node = synth_upserts[0][1]
    assert synth_node["user"]["longName"] == "UnknownSender"
    assert synth_node["user"]["role"] == "COMPANION"
    assert synth_node["user"]["synthetic"] is True


def test_on_channel_msg_synthetic_upserted_only_once_per_session(monkeypatch):
    """on_channel_msg only calls upsert_node once per unique synthetic ID per session."""
    import asyncio
    from data.mesh_ingestor.protocols.meshcore import _derive_synthetic_node_id

    captured, upserted, _iface, hmap = _setup_channel_msg_handlers(monkeypatch)
    payload = {
        "sender_timestamp": 1_758_000_010,
        "text": "UnknownSender: First",
        "channel_idx": 0,
    }
    asyncio.run(hmap["CHANNEL_MSG_RECV"](_FakeEvt(payload)))
    payload2 = {
        "sender_timestamp": 1_758_000_011,
        "text": "UnknownSender: Second",
        "channel_idx": 0,
    }
    asyncio.run(hmap["CHANNEL_MSG_RECV"](_FakeEvt(payload2)))

    expected_id = _derive_synthetic_node_id("UnknownSender")
    sender_upserts = [nid for nid, _ in upserted if nid == expected_id]
    # Second message must NOT re-upsert the same synthetic node.
    assert len(sender_upserts) == 1


def test_on_channel_msg_no_synthetic_when_no_sender_prefix(monkeypatch):
    """on_channel_msg leaves from_id None when text has no SenderName: prefix."""
    import asyncio

    captured, upserted, _iface, hmap = _setup_channel_msg_handlers(monkeypatch)
    asyncio.run(
        hmap["CHANNEL_MSG_RECV"](
            _FakeEvt(
                {
                    "sender_timestamp": 1_758_000_004,
                    "text": "no colon here",
                    "channel_idx": 0,
                }
            )
        )
    )

    assert len(captured) == 1
    assert captured[0]["from_id"] is None
    assert upserted == []


def test_on_channel_msg_upserts_synthetic_for_unknown_mention(monkeypatch):
    """on_channel_msg upserts synthetic nodes for @[Name] mentions not in contacts."""
    import asyncio
    from data.mesh_ingestor.protocols.meshcore import _derive_synthetic_node_id

    captured, upserted, _iface, hmap = _setup_channel_msg_handlers(monkeypatch)
    asyncio.run(
        hmap["CHANNEL_MSG_RECV"](
            _FakeEvt(
                {
                    "sender_timestamp": 1_758_000_005,
                    "text": "Alice: Hey @[Bob] and @[Carol]",
                    "channel_idx": 0,
                }
            )
        )
    )

    upserted_ids = {nid for nid, _ in upserted}
    assert _derive_synthetic_node_id("Bob") in upserted_ids
    assert _derive_synthetic_node_id("Carol") in upserted_ids


def test_on_channel_msg_skips_synthetic_for_known_mention(monkeypatch):
    """on_channel_msg does not upsert synthetic for @[Name] if name is in contacts."""
    import asyncio
    from data.mesh_ingestor.protocols.meshcore import _derive_synthetic_node_id

    pub_key = "aabbccdd" + "00" * 28
    captured, upserted, _iface, hmap = _setup_channel_msg_handlers(
        monkeypatch,
        contacts=[{"public_key": pub_key, "adv_name": "Bob"}],
    )
    asyncio.run(
        hmap["CHANNEL_MSG_RECV"](
            _FakeEvt(
                {
                    "sender_timestamp": 1_758_000_006,
                    "text": "Alice: Hey @[Bob]",
                    "channel_idx": 0,
                }
            )
        )
    )

    # Bob is in contacts — no synthetic upsert for Bob.
    bob_upserts = [
        nid for nid, _ in upserted if nid == _derive_synthetic_node_id("Bob")
    ]
    assert bob_upserts == []


def test_on_contact_msg_queues_packet_with_from_id(monkeypatch):
    """on_contact_msg must resolve from_id via pubkey_prefix and set to_id to host."""
    import asyncio
    import data.mesh_ingestor as _mesh_pkg
    import data.mesh_ingestor.protocols.meshcore as _mod

    captured: list = []
    stub = _make_stub_handlers_module()
    stub.store_packet_dict = lambda pkt: captured.append(pkt)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(_mesh_pkg, "handlers", stub)

    pub_key = "aabbccddee11" + "00" * 26
    iface = _MeshcoreInterface(target=None)
    iface.host_node_id = "!deadbeef"
    iface._update_contact({"public_key": pub_key, "adv_name": "Alice"})

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
        "aabbccddee11", 1_758_000_001, "dm", "direct message"
    )


def test_on_channel_msg_id_identical_across_ingestors_with_different_rosters(
    monkeypatch,
):
    """Two ingestors that hear the same channel message must emit the same id.

    Regression test for issue #751.  Ingestor A has Alice in its contact roster
    (so ``from_id`` resolves to ``!aabbccdd``); ingestor B does not (so a
    synthetic ``from_id`` is created).  The dedup id MUST still match because
    it is derived from the parsed sender name in the text, not from the
    per-ingestor ``from_id`` resolution.
    """
    import asyncio

    pub_key = "aabbccdd" + "00" * 28
    payload = {
        "sender_timestamp": 1_758_000_999,
        "text": "Alice: dedup me",
        "channel_idx": 0,
    }

    captured_a, _, _, hmap_a = _setup_channel_msg_handlers(
        monkeypatch,
        contacts=[{"public_key": pub_key, "adv_name": "Alice"}],
    )
    asyncio.run(hmap_a["CHANNEL_MSG_RECV"](_FakeEvt(payload)))

    captured_b, _, _, hmap_b = _setup_channel_msg_handlers(monkeypatch)
    asyncio.run(hmap_b["CHANNEL_MSG_RECV"](_FakeEvt(payload)))

    assert len(captured_a) == 1
    assert len(captured_b) == 1
    # Different ingestors → different from_id resolution, but the dedup id is
    # identical because it comes from the parsed sender name and the
    # sender-side timestamp/text.
    assert captured_a[0]["from_id"] != captured_b[0]["from_id"]
    assert captured_a[0]["id"] == captured_b[0]["id"]


def test_on_contact_msg_id_identical_across_ingestors_with_different_rosters(
    monkeypatch,
):
    """Two ingestors that hear the same DM must emit the same id.

    Direct messages already carry the sender's ``pubkey_prefix`` in the event
    payload, so the dedup id is identical regardless of contact-roster state.
    """
    import asyncio
    import data.mesh_ingestor as _mesh_pkg
    import data.mesh_ingestor.protocols.meshcore as _mod

    pub_key = "aabbccddee11" + "00" * 26
    payload = {
        "sender_timestamp": 1_758_000_998,
        "text": "private hello",
        "pubkey_prefix": "aabbccddee11",
    }

    def _run(with_contact: bool):
        captured: list = []
        stub = _make_stub_handlers_module()
        stub.store_packet_dict = lambda pkt: captured.append(pkt)
        monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
        monkeypatch.setattr(_mesh_pkg, "handlers", stub)

        iface = _MeshcoreInterface(target=None)
        iface.host_node_id = "!deadbeef"
        if with_contact:
            iface._update_contact({"public_key": pub_key, "adv_name": "Alice"})
        hmap = _make_event_handlers(iface, "/dev/ttyUSB0")
        asyncio.run(hmap["CONTACT_MSG_RECV"](_FakeEvt(payload)))
        return captured

    captured_a = _run(with_contact=True)
    captured_b = _run(with_contact=False)

    assert len(captured_a) == 1
    assert len(captured_b) == 1
    assert captured_a[0]["id"] == captured_b[0]["id"]


def test_on_channel_msg_skips_empty_text(monkeypatch):
    """on_channel_msg must not queue a packet when text is absent."""
    import asyncio
    import data.mesh_ingestor as _mesh_pkg
    import data.mesh_ingestor.protocols.meshcore as _mod

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


def test_on_contact_msg_skips_when_text_or_sender_ts_missing(monkeypatch):
    """on_contact_msg must early-return when text is empty or sender_ts is None.

    Mirrors :func:`test_on_channel_msg_skips_empty_text` for direct messages so
    that a malformed CONTACT_MSG_RECV event cannot enqueue an empty packet.
    """
    import asyncio
    import data.mesh_ingestor as _mesh_pkg
    import data.mesh_ingestor.protocols.meshcore as _mod

    captured: list = []
    stub = _make_stub_handlers_module()
    stub.store_packet_dict = lambda pkt: captured.append(pkt)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(_mesh_pkg, "handlers", stub)

    iface = _MeshcoreInterface(target=None)
    iface.host_node_id = "!deadbeef"
    hmap = _make_event_handlers(iface, "/dev/ttyUSB0")

    asyncio.run(hmap["CONTACT_MSG_RECV"](_FakeEvt({"sender_timestamp": 1, "text": ""})))
    asyncio.run(hmap["CONTACT_MSG_RECV"](_FakeEvt({"text": "hi"})))  # missing ts
    asyncio.run(hmap["CONTACT_MSG_RECV"](_FakeEvt({})))  # both missing

    assert captured == []


@pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
def test_connect_raises_on_timeout(monkeypatch):
    """connect() raises ConnectionError when connected_event is never signalled.

    The background thread's event loop is stopped by iface.close() while the
    mock coroutine is still suspended; the resulting RuntimeError in that thread
    is expected and suppressed via the filterwarnings mark above.
    """
    import data.mesh_ingestor.protocols.meshcore as _mod

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


def test_process_self_info_sets_host_node_id(monkeypatch):
    """_process_self_info must set iface.host_node_id and call register_host_node_id."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(
        _mod._ingestors, "queue_ingestor_heartbeat", lambda *_a, **_k: True
    )
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


def test_process_self_info_caches_payload(monkeypatch):
    """_process_self_info must store the payload on iface._self_info_payload."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(
        _mod._ingestors, "queue_ingestor_heartbeat", lambda *_a, **_k: True
    )
    stub = _make_stub_handlers_module()
    iface = _MeshcoreInterface(target=None)
    payload = {"public_key": "aabbccdd" + "00" * 28, "name": "Host"}

    _process_self_info(payload, iface, stub)

    assert iface._self_info_payload is payload


def test_process_self_info_caches_payload_even_when_empty_key():
    """_process_self_info caches the payload even when public_key is empty.

    The payload is cached unconditionally so that radio metadata is always
    preserved.  self_node_item will still return None for an empty key because
    _meshcore_node_id returns None, but the cached payload lets radio metadata
    be applied on reconnect without waiting for a second SELF_INFO.
    """
    stub = _make_stub_handlers_module()
    iface = _MeshcoreInterface(target=None)
    payload = {"public_key": "", "name": "Unknown"}

    _process_self_info(payload, iface, stub)

    assert iface._self_info_payload is payload


def test_process_self_info_radio_metadata_set_before_upsert(monkeypatch):
    """Radio metadata must be written to config BEFORE upsert_node is called.

    Regression test for the ordering bug: previously LORA_FREQ/MODEM_PRESET
    were captured after upsert_node, so _apply_radio_metadata_to_nodes found
    no values and the first self-node upsert lacked radio metadata.
    """
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "LORA_FREQ", None)
    monkeypatch.setattr(_mod.config, "MODEM_PRESET", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(
        _mod._ingestors, "queue_ingestor_heartbeat", lambda *_a, **_k: True
    )

    captured_lora_freq_at_upsert: list = []
    captured_modem_preset_at_upsert: list = []

    def _spy_upsert(node_id, node):
        captured_lora_freq_at_upsert.append(_mod.config.LORA_FREQ)
        captured_modem_preset_at_upsert.append(_mod.config.MODEM_PRESET)

    stub = _make_stub_handlers_module()
    stub.upsert_node = _spy_upsert

    payload = {
        "public_key": "aabbccdd" + "00" * 28,
        "name": "Host",
        "radio_freq": 868.125,
        "radio_sf": 8,
        "radio_bw": 62.0,
        "radio_cr": 8,
    }
    _process_self_info(payload, _MeshcoreInterface(target=None), stub)

    # Config must have been set before upsert_node was invoked.
    assert captured_lora_freq_at_upsert == [pytest.approx(868.125)]
    assert captured_modem_preset_at_upsert == ["SF8/BW62/CR8"]


# ---------------------------------------------------------------------------
# _process_self_info — radio metadata capture
# ---------------------------------------------------------------------------


def test_process_self_info_captures_radio_freq(monkeypatch):
    """SELF_INFO with radio_freq must populate config.LORA_FREQ."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "LORA_FREQ", None)
    monkeypatch.setattr(_mod.config, "MODEM_PRESET", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(
        _mod._ingestors, "queue_ingestor_heartbeat", lambda *_a, **_k: True
    )

    stub = _make_stub_handlers_module()
    payload = {
        "public_key": "aabbccdd" + "00" * 28,
        "radio_freq": 868.125,
        "radio_sf": 12,
        "radio_bw": 125.0,
        "radio_cr": 5,
    }
    _process_self_info(payload, _MeshcoreInterface(target=None), stub)

    assert _mod.config.LORA_FREQ == pytest.approx(868.125)


def test_process_self_info_captures_modem_preset(monkeypatch):
    """SELF_INFO with radio_sf, radio_bw, radio_cr must populate config.MODEM_PRESET."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "LORA_FREQ", None)
    monkeypatch.setattr(_mod.config, "MODEM_PRESET", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(
        _mod._ingestors, "queue_ingestor_heartbeat", lambda *_a, **_k: True
    )

    stub = _make_stub_handlers_module()
    payload = {
        "public_key": "aabbccdd" + "00" * 28,
        "radio_freq": 868.125,
        "radio_sf": 12,
        "radio_bw": 125.0,
        "radio_cr": 5,
    }
    _process_self_info(payload, _MeshcoreInterface(target=None), stub)

    assert _mod.config.MODEM_PRESET == "SF12/BW125/CR5"


def test_process_self_info_no_overwrite_lora_freq(monkeypatch):
    """SELF_INFO must not overwrite an already-cached LORA_FREQ."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "LORA_FREQ", 915)
    monkeypatch.setattr(_mod.config, "MODEM_PRESET", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(
        _mod._ingestors, "queue_ingestor_heartbeat", lambda *_a, **_k: True
    )

    stub = _make_stub_handlers_module()
    payload = {
        "public_key": "aabbccdd" + "00" * 28,
        "radio_freq": 868.125,
        "radio_sf": 12,
        "radio_bw": 125.0,
        "radio_cr": 5,
    }
    _process_self_info(payload, _MeshcoreInterface(target=None), stub)

    assert _mod.config.LORA_FREQ == 915


def test_process_self_info_no_overwrite_modem_preset(monkeypatch):
    """SELF_INFO must not overwrite an already-cached MODEM_PRESET."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "LORA_FREQ", None)
    monkeypatch.setattr(_mod.config, "MODEM_PRESET", "LongFast")
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(
        _mod._ingestors, "queue_ingestor_heartbeat", lambda *_a, **_k: True
    )

    stub = _make_stub_handlers_module()
    payload = {
        "public_key": "aabbccdd" + "00" * 28,
        "radio_freq": 868.125,
        "radio_sf": 12,
        "radio_bw": 125.0,
        "radio_cr": 5,
    }
    _process_self_info(payload, _MeshcoreInterface(target=None), stub)

    assert _mod.config.MODEM_PRESET == "LongFast"


def test_process_self_info_missing_radio_fields_leaves_config_none(monkeypatch):
    """SELF_INFO with no radio_* keys must leave LORA_FREQ and MODEM_PRESET as None."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "LORA_FREQ", None)
    monkeypatch.setattr(_mod.config, "MODEM_PRESET", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(
        _mod._ingestors, "queue_ingestor_heartbeat", lambda *_a, **_k: True
    )

    stub = _make_stub_handlers_module()
    _process_self_info(
        {"public_key": "aabbccdd" + "00" * 28, "name": "Node"},
        _MeshcoreInterface(target=None),
        stub,
    )

    assert _mod.config.LORA_FREQ is None
    assert _mod.config.MODEM_PRESET is None


def test_process_self_info_queues_ingestor_heartbeat_before_upsert(monkeypatch):
    """_process_self_info must queue the ingestor heartbeat before upsert_node.

    The ingestor report carries priority 0 (highest) so the web backend assigns
    the correct protocol to all subsequent node and message records.  The
    heartbeat must therefore be queued before the node upsert so that the
    web backend knows the ingestor protocol before it processes the node.
    """
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    call_order: list[str] = []

    def _spy_heartbeat(*, force, node_id, **_kw):
        call_order.append("heartbeat")
        return True

    stub = _make_stub_handlers_module()
    stub.upsert_node = lambda *_a, **_k: call_order.append("upsert")
    stub.register_host_node_id = lambda *_a, **_k: None

    monkeypatch.setattr(_mod._ingestors, "queue_ingestor_heartbeat", _spy_heartbeat)

    payload = {"public_key": "aabbccdd" + "00" * 28, "name": "Host"}
    _process_self_info(payload, _MeshcoreInterface(target=None), stub)

    assert call_order[:2] == [
        "heartbeat",
        "upsert",
    ], "Ingestor heartbeat must be queued before node upsert"


def test_process_self_info_queues_position_when_advertised(monkeypatch):
    """_process_self_info must POST to /api/positions when adv_lat/adv_lon are set.

    Covers the host-node position branch: when the connected radio reports a
    GPS-fixed advertisement in its SELF_INFO, the host's own position must be
    forwarded to the web backend exactly once per heartbeat.
    """
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(
        _mod._ingestors, "queue_ingestor_heartbeat", lambda *_a, **_k: True
    )
    posted: list = []
    monkeypatch.setattr(
        _mod._queue,
        "_queue_post_json",
        lambda route, payload, **_k: posted.append((route, payload)),
    )

    stub = _make_stub_handlers_module()
    stub.host_node_id = lambda: "!ingestor1"

    payload = {
        "public_key": "aabbccdd" + "00" * 28,
        "name": "Host",
        "adv_lat": 51.5,
        "adv_lon": -0.1,
    }
    _process_self_info(payload, _MeshcoreInterface(target=None), stub)

    position_posts = [p for r, p in posted if r == "/api/positions"]
    assert len(position_posts) == 1
    assert position_posts[0]["node_id"] == "!aabbccdd"
    assert position_posts[0]["latitude"] == pytest.approx(51.5)
    assert position_posts[0]["longitude"] == pytest.approx(-0.1)
    assert position_posts[0]["ingestor"] == "!ingestor1"


def test_process_self_info_skips_position_when_latlon_absent(monkeypatch):
    """_process_self_info must not POST to /api/positions when lat/lon are absent."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(
        _mod._ingestors, "queue_ingestor_heartbeat", lambda *_a, **_k: True
    )
    posted: list = []
    monkeypatch.setattr(
        _mod._queue,
        "_queue_post_json",
        lambda route, payload, **_k: posted.append(route),
    )

    payload = {"public_key": "aabbccdd" + "00" * 28, "name": "Host"}
    _process_self_info(
        payload, _MeshcoreInterface(target=None), _make_stub_handlers_module()
    )

    assert "/api/positions" not in posted


# ---------------------------------------------------------------------------
# _derive_modem_preset
# ---------------------------------------------------------------------------


def test_derive_modem_preset_valid():
    """_derive_modem_preset must format SF, BW, and CR into a compact string."""
    assert _derive_modem_preset(12, 125.0, 5) == "SF12/BW125/CR5"
    assert _derive_modem_preset(7, 250.0, 5) == "SF7/BW250/CR5"
    assert _derive_modem_preset(11, 62.5, 8) == "SF11/BW62/CR8"


def test_derive_modem_preset_none_on_missing():
    """_derive_modem_preset must return None when any parameter is absent or zero."""
    assert _derive_modem_preset(None, 125.0, 5) is None
    assert _derive_modem_preset(12, None, 5) is None
    assert _derive_modem_preset(12, 125.0, None) is None
    assert _derive_modem_preset(0, 125.0, 5) is None
    assert _derive_modem_preset(12, 0, 5) is None
    assert _derive_modem_preset(12, 125.0, 0) is None


# ---------------------------------------------------------------------------
# _ensure_channel_names
# ---------------------------------------------------------------------------


def _make_fake_mc_for_channels(channel_map: dict, max_channels: int | None = None):
    """Build a minimal fake MeshCore instance for channel-probe tests.

    Parameters:
        channel_map: Mapping of channel_idx → channel_name string; absent keys
            simulate an ERROR response for that index.
        max_channels: Value to return in the DEVICE_INFO ``max_channels`` field.
            When ``None`` the device query returns an ERROR so the fallback bound
            is used.
    """

    class _FakeCommands:
        async def send_device_query(self):
            if max_channels is None:
                return types.SimpleNamespace(type=EventType.ERROR, payload={})
            return types.SimpleNamespace(
                type=EventType.DEVICE_INFO,
                payload={"max_channels": max_channels},
            )

        async def get_channel(self, idx):
            name = channel_map.get(idx)
            if name is None:
                return types.SimpleNamespace(
                    type=EventType.ERROR, payload={"reason": "not_found"}
                )
            return types.SimpleNamespace(
                type=EventType.CHANNEL_INFO,
                payload={"channel_idx": idx, "channel_name": name},
            )

    return types.SimpleNamespace(commands=_FakeCommands())


def test_ensure_channel_names_populates_cache(monkeypatch):
    """Channel names returned by the device must be registered in the cache."""
    import asyncio
    import data.mesh_ingestor.protocols.meshcore as _mod
    import data.mesh_ingestor.channels as _channels

    _channels._reset_channel_cache()
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    fake_mc = _make_fake_mc_for_channels({0: "LongFast", 1: "Chat"}, max_channels=4)
    asyncio.run(_ensure_channel_names(fake_mc))

    assert _channels.channel_name(0) == "LongFast"
    assert _channels.channel_name(1) == "Chat"
    _channels._reset_channel_cache()


def test_ensure_channel_names_tolerates_error_response(monkeypatch):
    """An ERROR for one index must not prevent subsequent indices from registering."""
    import asyncio
    import data.mesh_ingestor.protocols.meshcore as _mod
    import data.mesh_ingestor.channels as _channels

    _channels._reset_channel_cache()
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    # Index 0 returns ERROR; index 1 returns a valid name.
    fake_mc = _make_fake_mc_for_channels({1: "Chat"}, max_channels=4)
    asyncio.run(_ensure_channel_names(fake_mc))

    assert _channels.channel_name(0) is None
    assert _channels.channel_name(1) == "Chat"
    _channels._reset_channel_cache()


def test_ensure_channel_names_probes_all_indices_on_sparse_config(monkeypatch):
    """All indices must be probed even when earlier slots return ERROR.

    Sparse configurations (e.g. slots 0 and 5 configured, 1-4 empty) must
    not be truncated by consecutive-error heuristics.
    """
    import asyncio
    import data.mesh_ingestor.protocols.meshcore as _mod
    import data.mesh_ingestor.channels as _channels

    _channels._reset_channel_cache()
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    # Slots 0-4 return ERROR; slot 5 is configured.
    # Device reports max_channels=8 so all indices are probed.
    fake_mc = _make_fake_mc_for_channels({5: "Admin"}, max_channels=8)
    asyncio.run(_ensure_channel_names(fake_mc))

    # Slot 5 must be registered despite the preceding empty slots.
    assert _channels.channel_name(5) == "Admin"
    assert _channels.channel_name(0) is None
    _channels._reset_channel_cache()


def test_ensure_channel_names_stops_on_exception(monkeypatch):
    """An exception during get_channel must abort the probe without propagating."""
    import asyncio
    import data.mesh_ingestor.protocols.meshcore as _mod
    import data.mesh_ingestor.channels as _channels

    _channels._reset_channel_cache()
    logged: list = []
    monkeypatch.setattr(
        _mod.config,
        "_debug_log",
        lambda *_a, severity=None, **_k: logged.append(severity),
    )

    class _FakeCommands:
        async def send_device_query(self):
            return types.SimpleNamespace(
                type=EventType.DEVICE_INFO, payload={"max_channels": 4}
            )

        async def get_channel(self, idx):
            raise OSError("serial port disconnected")

    # Must complete without raising.
    asyncio.run(_ensure_channel_names(types.SimpleNamespace(commands=_FakeCommands())))

    assert "warning" in logged
    _channels._reset_channel_cache()


def test_on_channel_info_handler_registers_channel(monkeypatch):
    """CHANNEL_INFO event delivered to the handler must populate the channel cache."""
    import asyncio
    import data.mesh_ingestor.channels as _channels
    import data.mesh_ingestor.protocols.meshcore as _mod

    _channels._reset_channel_cache()
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    iface = _MeshcoreInterface(target=None)
    handlers_map = _make_event_handlers(iface, "/dev/ttyUSB0")

    evt = types.SimpleNamespace(payload={"channel_idx": 2, "channel_name": "Admin"})
    asyncio.run(handlers_map["CHANNEL_INFO"](evt))

    assert _channels.channel_name(2) == "Admin"
    _channels._reset_channel_cache()


def test_ensure_channel_names_uses_device_max_channels(monkeypatch):
    """max_channels from DEVICE_INFO must bound the probe, not the fallback."""
    import asyncio
    import data.mesh_ingestor.protocols.meshcore as _mod
    import data.mesh_ingestor.channels as _channels

    _channels._reset_channel_cache()
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    probed: list[int] = []

    class _FakeCommands:
        async def send_device_query(self):
            # Device reports exactly 3 channels.
            return types.SimpleNamespace(
                type=EventType.DEVICE_INFO, payload={"max_channels": 3}
            )

        async def get_channel(self, idx):
            probed.append(idx)
            return types.SimpleNamespace(type=EventType.ERROR, payload={})

    asyncio.run(_ensure_channel_names(types.SimpleNamespace(commands=_FakeCommands())))

    assert probed == [0, 1, 2]
    _channels._reset_channel_cache()


def test_ensure_channel_names_falls_back_when_device_query_fails(monkeypatch):
    """When DEVICE_INFO is unavailable the fallback bound must be used."""
    import asyncio
    import data.mesh_ingestor.protocols.meshcore as _mod
    import data.mesh_ingestor.channels as _channels

    _channels._reset_channel_cache()
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    probed: list[int] = []

    class _FakeCommands:
        async def send_device_query(self):
            return types.SimpleNamespace(type=EventType.ERROR, payload={})

        async def get_channel(self, idx):
            probed.append(idx)
            return types.SimpleNamespace(type=EventType.ERROR, payload={})

    asyncio.run(_ensure_channel_names(types.SimpleNamespace(commands=_FakeCommands())))

    assert len(probed) == _CHANNEL_PROBE_FALLBACK_MAX
    _channels._reset_channel_cache()


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


def test_process_contacts_queues_position_for_contacts_with_latlon(monkeypatch):
    """_process_contacts must post to /api/positions for each contact with a position."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    posted: list = []
    monkeypatch.setattr(
        _mod._queue,
        "_queue_post_json",
        lambda route, payload, **_k: posted.append((route, payload)),
    )

    stub = _make_stub_handlers_module()
    iface = _MeshcoreInterface(target=None)
    pub_key = "aabbccdd" + "00" * 28
    _process_contacts(
        {
            pub_key: {
                "public_key": pub_key,
                "adv_name": "Alice",
                "adv_lat": 51.5,
                "adv_lon": -0.1,
                "last_advert": 1700001234,
            }
        },
        iface,
        stub,
    )

    position_posts = [p for r, p in posted if r == "/api/positions"]
    assert len(position_posts) == 1
    assert position_posts[0]["node_id"] == "!aabbccdd"
    assert position_posts[0]["latitude"] == pytest.approx(51.5)
    assert position_posts[0]["position_time"] == 1700001234


def test_process_contacts_skips_position_for_contacts_without_latlon(monkeypatch):
    """_process_contacts must not post to /api/positions when lat/lon are absent."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    posted: list = []
    monkeypatch.setattr(
        _mod._queue,
        "_queue_post_json",
        lambda route, payload, **_k: posted.append(route),
    )

    stub = _make_stub_handlers_module()
    iface = _MeshcoreInterface(target=None)
    pub_key = "aabbccdd" + "00" * 28
    _process_contacts(
        {pub_key: {"public_key": pub_key, "adv_name": "Alice"}},
        iface,
        stub,
    )

    assert "/api/positions" not in posted


def test_process_contacts_only_posts_positions_for_located_contacts(monkeypatch):
    """Bulk CONTACTS: only contacts with lat/lon must produce a /api/positions POST."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    posted: list = []
    monkeypatch.setattr(
        _mod._queue,
        "_queue_post_json",
        lambda route, payload, **_k: posted.append((route, payload)),
    )

    stub = _make_stub_handlers_module()
    iface = _MeshcoreInterface(target=None)
    key_with_pos = "aabbccdd" + "00" * 28
    key_without_pos = "11223344" + "00" * 28
    _process_contacts(
        {
            key_with_pos: {
                "public_key": key_with_pos,
                "adv_name": "A",
                "adv_lat": 10.0,
                "adv_lon": 20.0,
            },
            key_without_pos: {"public_key": key_without_pos, "adv_name": "B"},
        },
        iface,
        stub,
    )

    position_posts = [p for r, p in posted if r == "/api/positions"]
    assert len(position_posts) == 1
    assert position_posts[0]["node_id"] == "!aabbccdd"


# ---------------------------------------------------------------------------
# _process_contact_update
# ---------------------------------------------------------------------------


def test_process_contact_update_upserts_node(monkeypatch):
    """_process_contact_update must upsert and update the snapshot."""
    import data.mesh_ingestor.protocols.meshcore as _mod

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
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)

    stub = _make_stub_handlers_module()
    upserted: list = []
    stub.upsert_node = lambda nid, nd: upserted.append(nid)

    _process_contact_update(
        {"public_key": "", "adv_name": "Bad"}, _MeshcoreInterface(target=None), stub
    )

    assert upserted == []


def test_process_contact_update_queues_position_when_latlon_present(monkeypatch):
    """_process_contact_update must POST to /api/positions when the contact has lat/lon."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    posted: list = []
    monkeypatch.setattr(
        _mod._queue,
        "_queue_post_json",
        lambda route, payload, **_k: posted.append((route, payload)),
    )

    stub = _make_stub_handlers_module()
    iface = _MeshcoreInterface(target=None)
    pub_key = "aabbccdd" + "00" * 28
    _process_contact_update(
        {
            "public_key": pub_key,
            "adv_name": "Bob",
            "adv_lat": 52.0,
            "adv_lon": 4.0,
            "last_advert": 1700005678,
        },
        iface,
        stub,
    )

    position_posts = [p for r, p in posted if r == "/api/positions"]
    assert len(position_posts) == 1
    assert position_posts[0]["node_id"] == "!aabbccdd"
    assert position_posts[0]["latitude"] == pytest.approx(52.0)
    assert position_posts[0]["position_time"] == 1700005678


def test_process_contact_update_skips_position_when_no_latlon(monkeypatch):
    """_process_contact_update must not POST to /api/positions when lat/lon are absent."""
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    posted: list = []
    monkeypatch.setattr(
        _mod._queue,
        "_queue_post_json",
        lambda route, payload, **_k: posted.append(route),
    )

    stub = _make_stub_handlers_module()
    iface = _MeshcoreInterface(target=None)
    pub_key = "aabbccdd" + "00" * 28
    _process_contact_update({"public_key": pub_key, "adv_name": "Bob"}, iface, stub)

    assert "/api/positions" not in posted


# ---------------------------------------------------------------------------
# on_self_info via _make_event_handlers
# ---------------------------------------------------------------------------


def test_on_self_info_registers_and_upserts(monkeypatch):
    """SELF_INFO handler must register the host node and upsert it."""
    import asyncio
    import data.mesh_ingestor as _mesh_pkg
    import data.mesh_ingestor.protocols.meshcore as _mod

    registered: list = []
    upserted: list = []
    stub = _make_stub_handlers_module()
    stub.register_host_node_id = lambda nid: registered.append(nid)
    stub.upsert_node = lambda nid, nd: upserted.append(nid)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    monkeypatch.setattr(
        _mod._ingestors, "queue_ingestor_heartbeat", lambda *_a, **_k: True
    )
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
    import data.mesh_ingestor.protocols.meshcore as _mod

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
    import data.mesh_ingestor.protocols.meshcore as _mod

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
    import data.mesh_ingestor.protocols.meshcore as _mod

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
    import data.mesh_ingestor.protocols.meshcore as _mod

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
    import data.mesh_ingestor.protocols.meshcore as _mod

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
# _run_meshcore — full coroutine paths (fake meshcore module patched on the module)
# ---------------------------------------------------------------------------


def _patch_meshcore_mod(monkeypatch, mod, fake_mod):
    """Patch module-level meshcore names in *mod* with values from *fake_mod*.

    Since ``protocols/meshcore.py`` now imports ``BLEConnection``, ``EventType``,
    ``MeshCore``, ``SerialConnection``, and ``TCPConnection`` at module load time
    (not lazily inside functions), ``sys.modules`` patching no longer reaches
    these already-bound names.  This helper patches the module attributes
    directly so tests can substitute fakes at the point of use.
    """
    for attr in (
        "BLEConnection",
        "EventType",
        "MeshCore",
        "SerialConnection",
        "TCPConnection",
    ):
        monkeypatch.setattr(mod, attr, getattr(fake_mod, attr))


def _make_fake_meshcore_mod(
    *,
    connect_result: object = "ok",
    fail_ensure_contacts: bool = False,
    disconnect_raises: bool = False,
    connect_stall_event=None,
):
    """Build a minimal fake ``meshcore`` module for testing :func:`_run_meshcore`.

    Parameters:
        connect_result: Value returned by ``mc.connect()``.  Pass ``None`` to
            simulate a device that ignores the appstart handshake.
        fail_ensure_contacts: When ``True``, ``mc.ensure_contacts()`` raises a
            ``RuntimeError``.
        disconnect_raises: When ``True``, ``mc.disconnect()`` raises, exercising
            the ``finally`` exception-suppression path.
        connect_stall_event: Optional :class:`asyncio.Event`; when set,
            ``connect()`` awaits it (never completes unless the event is set).
    """
    import enum

    EventType = enum.Enum(
        "EventType",
        [
            "CHANNEL_INFO",
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

    class _FakeCommands:
        async def send_device_query(self):
            # Return minimal DEVICE_INFO — channel probing is not under test here.
            return types.SimpleNamespace(
                type=EventType.DEVICE_INFO, payload={"max_channels": 1}
            )

        async def get_channel(self, idx):
            # Return ERROR for all channels — channel probing is not under test here.
            return types.SimpleNamespace(type=EventType.ERROR, payload={})

    class _FakeMeshCore:
        def __init__(self, cx):
            self._catch_all = None
            self.commands = _FakeCommands()

        def subscribe(self, event_type, callback):
            if event_type is None:
                self._catch_all = callback

        async def connect(self):
            if connect_stall_event is not None:
                await connect_stall_event.wait()
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


def _setup_stalled_run(monkeypatch):
    """Shared setup for tests that need a *_run_meshcore* stalled at ``connect()``.

    Patches ``_debug_log``, builds a fake ``meshcore`` module whose
    ``connect()`` blocks on a :class:`asyncio.Event`, and injects it into
    ``sys.modules``.

    Returns:
        tuple: ``(stall, _mod)`` where *stall* is the event that, when set,
        lets ``connect()`` proceed, and *_mod* is the imported provider module.
    """
    import asyncio

    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    stall = asyncio.Event()
    fake_mod = _make_fake_meshcore_mod(connect_stall_event=stall)
    _patch_meshcore_mod(monkeypatch, _mod, fake_mod)
    return stall, _mod


async def _start_stalled_run(mod):
    """Start *_run_meshcore* in a task and spin until ``_stop_event`` is installed.

    ``_stop_event`` is guaranteed to be set before the first ``await`` inside
    ``connect()``, so after this coroutine returns the task is parked inside
    the stall event and ``iface._stop_event`` is ready for use.

    Returns:
        tuple: ``(iface, connected_event, error_holder, task)``
    """
    import asyncio
    import threading

    iface = _MeshcoreInterface(target=None)
    connected_event = threading.Event()
    error_holder: list = [None]
    task = asyncio.create_task(
        mod._run_meshcore(iface, "/dev/ttyUSB0", connected_event, error_holder)
    )
    for _ in range(500):
        await asyncio.sleep(0)
        if iface._stop_event is not None:
            break
    return iface, connected_event, error_holder, task


def test_run_meshcore_stop_event_before_connect_finishes(monkeypatch):
    """_stop_event must exist before connect() returns so iface.close() avoids loop.stop()."""
    import asyncio

    stall, _mod = _setup_stalled_run(monkeypatch)

    async def _runner() -> None:
        iface, connected_event, _err, task = await _start_stalled_run(_mod)
        assert (
            iface._stop_event is not None
        ), "_stop_event must be set before connect() completes"
        assert not connected_event.is_set()
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    asyncio.run(_runner())


def test_run_meshcore_close_before_connect_completes(monkeypatch):
    """close() while connect() is stalled must surface ClosedBeforeConnectedError.

    The coroutine should:
    - Set ``connected_event`` so the caller is unblocked.
    - Store a :class:`ClosedBeforeConnectedError` in ``error_holder[0]``.
    - Leave ``iface.isConnected`` as ``False``.
    """
    import asyncio

    stall, _mod = _setup_stalled_run(monkeypatch)

    async def _runner() -> None:
        iface, connected_event, error_holder, task = await _start_stalled_run(_mod)
        assert iface._stop_event is not None

        # Signal shutdown then let connect() return — simulating iface.close()
        # being called while the device handshake is still in flight.
        iface._stop_event.set()
        stall.set()
        await task

        assert connected_event.is_set(), "connected_event must be set to unblock caller"
        assert isinstance(
            error_holder[0], _mod.ClosedBeforeConnectedError
        ), "error_holder must contain ClosedBeforeConnectedError"
        assert isinstance(
            error_holder[0], ConnectionError
        ), "ClosedBeforeConnectedError must be a ConnectionError subclass"
        assert iface.isConnected is False, "isConnected must remain False"

    asyncio.run(_runner())


def test_run_meshcore_happy_path(monkeypatch):
    """_run_meshcore must signal connected and leave isConnected=True on success."""
    import asyncio
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    fake_mod = _make_fake_meshcore_mod()
    _patch_meshcore_mod(monkeypatch, _mod, fake_mod)

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
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    fake_mod = _make_fake_meshcore_mod(connect_result=None)
    _patch_meshcore_mod(monkeypatch, _mod, fake_mod)

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
    import data.mesh_ingestor.protocols.meshcore as _mod

    logged: list = []
    monkeypatch.setattr(
        _mod.config,
        "_debug_log",
        lambda *_a, severity=None, **_k: logged.append(severity),
    )
    fake_mod = _make_fake_meshcore_mod(fail_ensure_contacts=True)
    _patch_meshcore_mod(monkeypatch, _mod, fake_mod)

    iface = _MeshcoreInterface(target=None)

    connected_event, error_holder = asyncio.run(
        _run_until_connected(iface, "/dev/ttyUSB0", fake_mod, _mod)
    )

    assert connected_event.is_set()
    assert error_holder[0] is None
    assert "warning" in logged


def test_run_meshcore_ensure_channel_names_failure_continues(monkeypatch):
    """_ensure_channel_names raising must log a warning but not abort the connection.

    The channel-name probe is best-effort: even when its internal try/except is
    bypassed (e.g. a programming error inside ``_ensure_channel_names`` itself
    or an exception from a deferred import), the outer ``_run_meshcore`` loop
    must catch it so the connection stays alive.
    """
    import asyncio
    import data.mesh_ingestor.protocols.meshcore as _mod
    import data.mesh_ingestor.protocols.meshcore.runner as _runner_mod

    logged: list = []

    def _capture(*_a, severity=None, **_k):
        logged.append(severity)

    monkeypatch.setattr(_mod.config, "_debug_log", _capture)

    async def _boom(_mc):
        raise RuntimeError("synthetic channel probe failure")

    # Patch the binding inside runner.py — the module-level ``from .channels
    # import _ensure_channel_names`` resolves the name at import time, so
    # patching the package attribute alone would not reach the runner.
    monkeypatch.setattr(_runner_mod, "_ensure_channel_names", _boom)

    fake_mod = _make_fake_meshcore_mod()
    _patch_meshcore_mod(monkeypatch, _mod, fake_mod)

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
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    fake_mod = _make_fake_meshcore_mod(disconnect_raises=True)
    _patch_meshcore_mod(monkeypatch, _mod, fake_mod)

    iface = _MeshcoreInterface(target=None)

    connected_event, error_holder = asyncio.run(
        _run_until_connected(iface, "/dev/ttyUSB0", fake_mod, _mod)
    )

    assert connected_event.is_set()
    assert error_holder[0] is None


def test_run_meshcore_on_unhandled_skips_known_records_unknown(monkeypatch):
    """_on_unhandled must only call _record_meshcore_message for truly unknown events."""
    import asyncio
    import data.mesh_ingestor.protocols.meshcore as _mod

    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    recorded: list = []
    monkeypatch.setattr(
        _mod,
        "_record_meshcore_message",
        lambda msg, *, source: recorded.append(source),
    )
    fake_mod = _make_fake_meshcore_mod()
    _patch_meshcore_mod(monkeypatch, _mod, fake_mod)

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
