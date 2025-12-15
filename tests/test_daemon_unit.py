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
"""Unit tests for :mod:`data.mesh_ingestor.daemon`."""

from __future__ import annotations

import sys
import threading
import types
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from data.mesh_ingestor import daemon


class FakeEvent:
    """Test double for :class:`threading.Event` that can auto-set itself."""

    instances: list["FakeEvent"] = []

    def __init__(self, *, auto_set_on_wait: bool = False):
        self._is_set = False
        self._auto_set_on_wait = auto_set_on_wait
        self.wait_calls: list[Any] = []
        FakeEvent.instances.append(self)

    def set(self) -> None:
        """Mark the event as set."""

        self._is_set = True

    def is_set(self) -> bool:
        """Return whether the event is currently set."""

        return self._is_set

    def wait(self, timeout: float | None = None) -> bool:
        """Record waits and optionally auto-set the flag."""

        self.wait_calls.append(timeout)
        if self._auto_set_on_wait:
            self._is_set = True
        return self._is_set


class AutoSetEvent(FakeEvent):
    """Event variant that automatically sets on each wait call."""

    def __init__(self):  # noqa: D401 - short initializer docstring handled by class
        super().__init__(auto_set_on_wait=True)


@pytest.fixture(autouse=True)
def reset_fake_events():
    """Ensure :class:`FakeEvent` registry is cleared between tests."""

    FakeEvent.instances.clear()
    yield
    FakeEvent.instances.clear()


def test_event_wait_default_detection(monkeypatch):
    """``_event_wait_allows_default_timeout`` matches defaulted signatures."""

    assert daemon._event_wait_allows_default_timeout() is True

    class _NoDefaultEvent:
        def wait(self, timeout):  # type: ignore[override]
            return bool(timeout)

    monkeypatch.setattr(
        daemon, "threading", types.SimpleNamespace(Event=_NoDefaultEvent)
    )
    assert daemon._event_wait_allows_default_timeout() is False


def test_subscribe_receive_topics(monkeypatch):
    """Subscribing to receive topics returns the exact topic list."""

    subscribed: list[str] = []

    def _record_subscription(_handler, topic):
        subscribed.append(topic)

    monkeypatch.setattr(
        daemon, "pub", types.SimpleNamespace(subscribe=_record_subscription)
    )
    assert daemon._subscribe_receive_topics() == list(daemon._RECEIVE_TOPICS)
    assert subscribed == list(daemon._RECEIVE_TOPICS)


def test_node_items_snapshot_handles_mutation(monkeypatch):
    """Snapshots tolerate temporary runtime errors while iterating."""

    class MutatingMapping(dict):
        def __bool__(self):
            return True

        def items(self):  # type: ignore[override]
            raise RuntimeError("dictionary changed size during iteration")

    monkeypatch.setattr(daemon.time, "sleep", lambda _: None)
    assert daemon._node_items_snapshot({"a": 1}) == [("a", 1)]
    assert daemon._node_items_snapshot(MutatingMapping(), retries=1) is None

    class IteratingMapping:
        def __init__(self):
            self.calls = 0
            self._data = {"x": 10, "y": 20}

        def __iter__(self):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("dictionary changed size during iteration")
            return iter(self._data)

        def __getitem__(self, key):
            return self._data[key]

    mapping = IteratingMapping()
    assert daemon._node_items_snapshot(mapping, retries=2) == [("x", 10), ("y", 20)]


def test_close_interface_respects_timeout(monkeypatch):
    """Long-running close calls emit a timeout debug log."""

    log_calls = []
    monkeypatch.setattr(daemon.config, "_CLOSE_TIMEOUT_SECS", 0.01)
    monkeypatch.setattr(
        daemon.config, "_debug_log", lambda *args, **kwargs: log_calls.append(kwargs)
    )
    blocker = threading.Event()

    class SlowInterface:
        def close(self):
            blocker.wait(timeout=0.1)

    daemon._close_interface(SlowInterface())
    assert any("timeout_seconds" in entry for entry in log_calls)


def test_close_interface_immediate_path(monkeypatch):
    """A zero timeout calls ``close`` inline without threading."""

    flags = {"called": False}
    monkeypatch.setattr(daemon.config, "_CLOSE_TIMEOUT_SECS", 0)

    class ImmediateInterface:
        def close(self):
            flags["called"] = True

    daemon._close_interface(ImmediateInterface())
    assert flags["called"] is True


def test_ble_interface_detection():
    """Detect BLE module names reliably."""

    class BLE:
        __module__ = "meshtastic.ble_interface"

    class NonBLE:
        __module__ = "meshtastic.serial"

    assert daemon._is_ble_interface(BLE()) is True
    assert daemon._is_ble_interface(NonBLE()) is False
    assert daemon._is_ble_interface(None) is False


def test_process_ingestor_heartbeat_with_extracted_host(monkeypatch):
    """Host id extraction triggers heartbeat announcement flag updates."""

    host_ids: list[str | None] = [None]
    ingestor_ids: list[str | None] = []
    queued: list[bool] = []

    monkeypatch.setattr(daemon.handlers, "host_node_id", lambda: host_ids[0])
    monkeypatch.setattr(
        daemon.interfaces, "_extract_host_node_id", lambda iface: "!abcd"
    )
    monkeypatch.setattr(
        daemon.handlers,
        "register_host_node_id",
        lambda node: host_ids.__setitem__(0, node),
    )
    monkeypatch.setattr(daemon.ingestors, "set_ingestor_node_id", ingestor_ids.append)
    monkeypatch.setattr(
        daemon.ingestors,
        "queue_ingestor_heartbeat",
        lambda force: queued.append(force) or True,
    )

    assert (
        daemon._process_ingestor_heartbeat(object(), ingestor_announcement_sent=False)
        is True
    )
    assert host_ids[0] == "!abcd"
    assert ingestor_ids[-1] == "!abcd"
    assert queued[-1] is True

    monkeypatch.setattr(daemon.handlers, "host_node_id", lambda: "!abcd")
    monkeypatch.setattr(
        daemon.ingestors,
        "queue_ingestor_heartbeat",
        lambda force: queued.append(force) or False,
    )
    assert (
        daemon._process_ingestor_heartbeat(object(), ingestor_announcement_sent=True)
        is True
    )
    assert queued[-1] is False


def test_connected_state_branches(monkeypatch):
    """Connection state resolves across multiple attribute forms."""

    event = threading.Event()
    event.set()
    assert daemon._connected_state(event) is True

    class CallableCandidate:
        def __call__(self):
            return False

    assert daemon._connected_state(CallableCandidate()) is False

    class BooleanCandidate:
        def __bool__(self):
            raise RuntimeError("cannot bool")

    assert daemon._connected_state(BooleanCandidate()) is None

    class HasIsSet:
        def is_set(self):
            raise RuntimeError("broken")

    assert daemon._connected_state(HasIsSet()) is None


def _configure_common_defaults(
    monkeypatch, *, energy_saving: bool = False, inactivity: float = 0.0
):
    """Set fast configuration defaults shared by daemon integration tests."""

    monkeypatch.setattr(daemon.config, "SNAPSHOT_SECS", 0)
    monkeypatch.setattr(daemon.config, "_RECONNECT_INITIAL_DELAY_SECS", 0)
    monkeypatch.setattr(daemon.config, "_RECONNECT_MAX_DELAY_SECS", 0)
    monkeypatch.setattr(daemon.config, "_CLOSE_TIMEOUT_SECS", 0)
    monkeypatch.setattr(daemon.config, "ENERGY_SAVING", energy_saving)
    monkeypatch.setattr(
        daemon.config, "_ENERGY_ONLINE_DURATION_SECS", 0 if energy_saving else 0.0
    )
    monkeypatch.setattr(daemon.config, "_ENERGY_SLEEP_SECS", 0.0)
    monkeypatch.setattr(daemon.config, "_INGESTOR_HEARTBEAT_SECS", 0)
    monkeypatch.setattr(daemon.config, "_INACTIVITY_RECONNECT_SECS", inactivity)
    monkeypatch.setattr(daemon.config, "CONNECTION", "serial0")


class DummyInterface:
    """Lightweight mesh interface stand-in used for daemon integration tests."""

    def __init__(self, *, nodes=None, is_connected=True, client_present=True):
        self.nodes = nodes if nodes is not None else {"!node": {"id": 1}}
        self.isConnected = is_connected
        self.client = object() if client_present else None

    def close(self):
        return None


def test_main_happy_path(monkeypatch):
    """The main loop processes snapshots and heartbeats once before stopping."""

    _configure_common_defaults(monkeypatch)
    monkeypatch.setattr(
        daemon,
        "threading",
        types.SimpleNamespace(
            Event=AutoSetEvent,
            current_thread=threading.current_thread,
            main_thread=threading.main_thread,
        ),
    )
    monkeypatch.setattr(
        daemon, "pub", types.SimpleNamespace(subscribe=lambda *_args, **_kwargs: None)
    )
    monkeypatch.setattr(
        daemon.interfaces,
        "_create_serial_interface",
        lambda candidate: (DummyInterface(), candidate),
    )
    monkeypatch.setattr(daemon.interfaces, "_ensure_radio_metadata", lambda iface: None)
    monkeypatch.setattr(
        daemon.interfaces, "_ensure_channel_metadata", lambda iface: None
    )
    monkeypatch.setattr(
        daemon.interfaces, "_extract_host_node_id", lambda iface: "!host"
    )

    host_id = {"value": None}
    monkeypatch.setattr(
        daemon.handlers,
        "register_host_node_id",
        lambda node: host_id.__setitem__("value", node),
    )
    monkeypatch.setattr(daemon.handlers, "host_node_id", lambda: host_id["value"])
    monkeypatch.setattr(daemon.handlers, "upsert_node", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(daemon.handlers, "last_packet_monotonic", lambda: None)

    heartbeats: list[bool] = []
    monkeypatch.setattr(
        daemon.ingestors, "set_ingestor_node_id", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(
        daemon.ingestors,
        "queue_ingestor_heartbeat",
        lambda force: heartbeats.append(force) or True,
    )

    daemon.main()
    assert heartbeats
    assert host_id["value"] == "!host"
    assert FakeEvent.instances and FakeEvent.instances[0].is_set() is True


def test_main_energy_saving_disconnect(monkeypatch):
    """Energy saving mode disconnects and sleeps when deadlines expire."""

    _configure_common_defaults(monkeypatch, energy_saving=True)
    monkeypatch.setattr(
        daemon,
        "threading",
        types.SimpleNamespace(
            Event=AutoSetEvent,
            current_thread=threading.current_thread,
            main_thread=threading.main_thread,
        ),
    )
    monkeypatch.setattr(
        daemon, "pub", types.SimpleNamespace(subscribe=lambda *_args, **_kwargs: None)
    )
    monkeypatch.setattr(
        daemon.interfaces,
        "_create_serial_interface",
        lambda candidate: (DummyInterface(), candidate),
    )
    monkeypatch.setattr(daemon.interfaces, "_ensure_radio_metadata", lambda iface: None)
    monkeypatch.setattr(
        daemon.interfaces, "_ensure_channel_metadata", lambda iface: None
    )
    monkeypatch.setattr(
        daemon.interfaces, "_extract_host_node_id", lambda iface: "!host"
    )
    monkeypatch.setattr(
        daemon.handlers, "register_host_node_id", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(daemon.handlers, "host_node_id", lambda: "!host")
    monkeypatch.setattr(daemon.handlers, "upsert_node", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(daemon.handlers, "last_packet_monotonic", lambda: None)
    monkeypatch.setattr(
        daemon.ingestors, "set_ingestor_node_id", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(
        daemon.ingestors, "queue_ingestor_heartbeat", lambda *_args, **_kwargs: True
    )

    daemon.main()
    assert FakeEvent.instances and FakeEvent.instances[0].is_set() is True


def test_main_inactivity_reconnect(monkeypatch):
    """Inactivity triggers reconnect attempts and respects stop events."""

    _configure_common_defaults(monkeypatch, inactivity=0.5)
    monkeypatch.setattr(
        daemon,
        "threading",
        types.SimpleNamespace(
            Event=AutoSetEvent,
            current_thread=threading.current_thread,
            main_thread=threading.main_thread,
        ),
    )
    monkeypatch.setattr(
        daemon, "pub", types.SimpleNamespace(subscribe=lambda *_args, **_kwargs: None)
    )

    interface_cycle = iter(
        [DummyInterface(is_connected=False), DummyInterface(is_connected=True)]
    )
    monkeypatch.setattr(
        daemon.interfaces,
        "_create_serial_interface",
        lambda candidate: (next(interface_cycle), candidate),
    )
    monkeypatch.setattr(daemon.interfaces, "_ensure_radio_metadata", lambda iface: None)
    monkeypatch.setattr(
        daemon.interfaces, "_ensure_channel_metadata", lambda iface: None
    )
    monkeypatch.setattr(
        daemon.interfaces, "_extract_host_node_id", lambda iface: "!host"
    )
    monkeypatch.setattr(
        daemon.handlers, "register_host_node_id", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(daemon.handlers, "host_node_id", lambda: "!host")
    monkeypatch.setattr(daemon.handlers, "upsert_node", lambda *_args, **_kwargs: None)

    monotonic_calls = iter([0.0, 1.0, 2.0, 3.0, 4.0])
    monkeypatch.setattr(daemon.time, "monotonic", lambda: next(monotonic_calls))
    monkeypatch.setattr(daemon.handlers, "last_packet_monotonic", lambda: 0.0)
    monkeypatch.setattr(
        daemon.ingestors, "set_ingestor_node_id", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(
        daemon.ingestors, "queue_ingestor_heartbeat", lambda *_args, **_kwargs: True
    )

    daemon.main()
    assert any(event.is_set() for event in FakeEvent.instances)
