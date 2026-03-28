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
