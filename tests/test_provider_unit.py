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
from data.mesh_ingestor.providers.meshcore import (  # noqa: E402 - path setup
    MeshcoreProvider,
    _MeshcoreInterface,
    _contact_to_node_dict,
    _is_tcp_target,
    _meshcore_node_id,
    _pubkey_prefix_to_node_id,
    _record_meshcore_message,
    _self_info_to_node_dict,
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
def test_meshcore_connect_rejects_tcp_targets(target, monkeypatch):
    """connect() must raise ValueError for TCP host:port targets."""
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    with pytest.raises(ValueError, match="TCP/IP"):
        MeshcoreProvider().connect(active_candidate=target)


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
        None,
    ],
)
def test_meshcore_connect_accepts_serial_ble_targets(target, monkeypatch):
    """connect() must succeed for serial ports, BLE addresses, and None (auto)."""
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
    iface.close()


def test_is_tcp_target_detects_host_port():
    """_is_tcp_target must return True for host:port strings."""
    assert _is_tcp_target("meshnode.local:4403") is True
    assert _is_tcp_target("meshtastic.local:4403") is True


def test_is_tcp_target_rejects_serial_ble():
    """_is_tcp_target must return False for serial paths and BLE addresses."""
    assert _is_tcp_target("/dev/ttyUSB0") is False
    assert _is_tcp_target("AA:BB:CC:DD:EE:FF") is False
    assert _is_tcp_target("COM3") is False
    # BLE MAC address whose final octet is all-decimal must not be a false positive.
    assert _is_tcp_target("AA:BB:CC:DD:EE:12") is False


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
    assert node["user"]["shortName"] == "Alic"
    assert node["user"]["publicKey"] == contact["public_key"]


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
    assert node["position"]["latitude"] == 51.5
    assert node["position"]["longitude"] == -0.1


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
    assert node["user"]["shortName"] == "MyNo"
    assert node["user"]["publicKey"] == "bb" * 32
    assert isinstance(node["lastHeard"], int)


def test_self_info_to_node_dict_includes_position():
    """_self_info_to_node_dict adds position when lat/lon are non-zero."""
    self_info = {
        "name": "N",
        "public_key": "cc" * 32,
        "adv_lat": 48.8,
        "adv_lon": 2.35,
    }
    node = _self_info_to_node_dict(self_info)
    assert node["position"]["latitude"] == 48.8
    assert node["position"]["longitude"] == 2.35


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
