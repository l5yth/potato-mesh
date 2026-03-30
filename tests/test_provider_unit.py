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
    _is_tcp_target,
    _record_meshcore_message,
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
        "192.168.1.1:4403",
        "meshtastic.local:4403",
        "hostname:1234",
        "10.0.0.1:80",
    ],
)
def test_meshcore_connect_rejects_tcp_targets(target, monkeypatch):
    """connect() must raise ValueError for TCP host:port targets."""
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    with pytest.raises(ValueError, match="TCP/IP"):
        MeshcoreProvider().connect(active_candidate=target)


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

    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    iface, resolved, next_candidate = MeshcoreProvider().connect(
        active_candidate=target
    )
    assert iface is not None
    assert resolved == target
    assert next_candidate == target


def test_meshcore_connect_returns_closeable_interface(monkeypatch):
    """The interface returned by connect() must expose a close() method."""
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    iface, _, _ = MeshcoreProvider().connect(active_candidate="/dev/ttyUSB0")
    assert callable(getattr(iface, "close", None))
    iface.close()  # must not raise


def test_meshcore_extract_host_node_id_none_by_default(monkeypatch):
    """extract_host_node_id returns None for a freshly-created stub interface."""
    import data.mesh_ingestor.providers.meshcore as _mod

    monkeypatch.setattr(_mod.config, "CONNECTION", None)
    monkeypatch.setattr(_mod.config, "_debug_log", lambda *_a, **_k: None)
    iface, _, _ = MeshcoreProvider().connect(active_candidate="/dev/ttyUSB0")
    assert MeshcoreProvider().extract_host_node_id(iface) is None


def test_meshcore_node_snapshot_items_empty():
    """node_snapshot_items must return an empty list in the skeleton phase."""
    assert MeshcoreProvider().node_snapshot_items(object()) == []


def test_is_tcp_target_detects_host_port():
    """_is_tcp_target must return True for host:port strings."""
    assert _is_tcp_target("192.168.1.1:4403") is True
    assert _is_tcp_target("meshtastic.local:4403") is True


def test_is_tcp_target_rejects_serial_ble():
    """_is_tcp_target must return False for serial paths and BLE addresses."""
    assert _is_tcp_target("/dev/ttyUSB0") is False
    assert _is_tcp_target("AA:BB:CC:DD:EE:FF") is False
    assert _is_tcp_target("COM3") is False


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
