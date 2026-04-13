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
"""Unit tests for :mod:`data.mesh_ingestor.queue`."""

from __future__ import annotations

import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.config as config
import data.mesh_ingestor.queue as _queue_mod
from data.mesh_ingestor.queue import (
    QueueState,
    _clear_post_queue,
    _drain_post_queue,
    _enqueue_post_json,
    _MAX_SEND_RETRIES,
    _post_json,
    _QUEUE_DEPTH_WARNING_THRESHOLD,
    _queue_drainer_loop,
    _queue_post_json,
    _send_single,
    _start_queue_drainer,
    _stop_queue_drainer,
    _CHANNEL_POST_PRIORITY,
    _DEFAULT_POST_PRIORITY,
    _INGESTOR_POST_PRIORITY,
    _MESSAGE_POST_PRIORITY,
    _NEIGHBOR_POST_PRIORITY,
    _NODE_POST_PRIORITY,
    _POSITION_POST_PRIORITY,
    _TELEMETRY_POST_PRIORITY,
    _TRACE_POST_PRIORITY,
)


def _fresh_state() -> QueueState:
    """Return a new QueueState for isolation."""
    return QueueState()


class _FakeResp:
    """Minimal context-manager response stub for ``urlopen`` patches."""

    def read(self):
        return b""

    def __enter__(self):
        return self

    def __exit__(self, *a):
        pass


# ---------------------------------------------------------------------------
# Priority constant ordering
# ---------------------------------------------------------------------------


def test_priority_constants_ordering():
    """Verify the intended priority hierarchy: ingestor first, telemetry last.

    Lower numeric values are dequeued first (min-heap semantics).  The ordering
    must be: ingestor < channel < node < message < neighbor < trace < position
    < telemetry < default.  Any regression in this order means the web backend
    may assign the wrong protocol to nodes and messages on startup.
    """
    assert _INGESTOR_POST_PRIORITY < _CHANNEL_POST_PRIORITY
    assert _CHANNEL_POST_PRIORITY < _NODE_POST_PRIORITY
    assert _NODE_POST_PRIORITY < _MESSAGE_POST_PRIORITY
    assert _MESSAGE_POST_PRIORITY < _NEIGHBOR_POST_PRIORITY
    assert _NEIGHBOR_POST_PRIORITY < _TRACE_POST_PRIORITY
    assert _TRACE_POST_PRIORITY < _POSITION_POST_PRIORITY
    assert _POSITION_POST_PRIORITY < _TELEMETRY_POST_PRIORITY
    assert _TELEMETRY_POST_PRIORITY < _DEFAULT_POST_PRIORITY


# ---------------------------------------------------------------------------
# _post_json
# ---------------------------------------------------------------------------


class TestPostJson:
    """Tests for :func:`queue._post_json`."""

    def test_skips_when_no_instance(self, monkeypatch):
        """Does nothing when INSTANCES is empty."""
        monkeypatch.setattr(config, "INSTANCES", ())
        monkeypatch.setattr(config, "INSTANCE", "")
        with patch("urllib.request.urlopen") as mock_open:
            _post_json("/api/test", {"key": "val"})
            mock_open.assert_not_called()

    def test_sends_json_post(self, monkeypatch):
        """Sends a POST request with JSON body and correct headers."""
        monkeypatch.setattr(config, "INSTANCES", (("http://localhost", "tok"),))
        monkeypatch.setattr(config, "INSTANCE", "http://localhost")
        monkeypatch.setattr(config, "API_TOKEN", "tok")

        captured_req = []

        def fake_urlopen(req, timeout=None):
            captured_req.append(req)
            return _FakeResp()

        with patch("urllib.request.urlopen", fake_urlopen):
            _post_json("/api/nodes", {"a": 1})

        assert len(captured_req) == 1
        req = captured_req[0]
        assert req.get_full_url() == "http://localhost/api/nodes"
        assert req.get_header("Content-type") == "application/json"
        assert req.get_header("Authorization") == "Bearer tok"

    def test_handles_network_error_gracefully(self, monkeypatch, capsys):
        """Network errors are caught and logged, not raised."""
        monkeypatch.setattr(config, "INSTANCES", (("http://localhost", ""),))
        monkeypatch.setattr(config, "INSTANCE", "http://localhost")
        monkeypatch.setattr(config, "API_TOKEN", "")
        monkeypatch.setattr(config, "DEBUG", True)

        def raise_error(req, timeout=None):
            raise OSError("connection refused")

        with patch("urllib.request.urlopen", raise_error):
            _post_json("/api/test", {"x": 1})  # should not raise

    def test_uses_instance_override(self, monkeypatch):
        """instance parameter overrides config.INSTANCE."""
        monkeypatch.setattr(config, "INSTANCE", "http://default")

        captured_req = []

        def fake_urlopen(req, timeout=None):
            captured_req.append(req)
            return _FakeResp()

        with patch("urllib.request.urlopen", fake_urlopen):
            _post_json("/api/test", {}, instance="http://override")

        assert "http://override" in captured_req[0].get_full_url()

    def test_no_auth_header_when_token_empty(self, monkeypatch):
        """No Authorization header is added when API_TOKEN is empty."""
        monkeypatch.setattr(config, "INSTANCES", (("http://localhost", ""),))
        monkeypatch.setattr(config, "INSTANCE", "http://localhost")
        monkeypatch.setattr(config, "API_TOKEN", "")

        captured_req = []

        def fake_urlopen(req, timeout=None):
            captured_req.append(req)
            return _FakeResp()

        with patch("urllib.request.urlopen", fake_urlopen):
            _post_json("/api/test", {})

        assert captured_req[0].get_header("Authorization") is None


# ---------------------------------------------------------------------------
# _enqueue_post_json
# ---------------------------------------------------------------------------


class TestEnqueuePostJson:
    """Tests for :func:`queue._enqueue_post_json`."""

    def test_adds_item_to_queue(self):
        """Item is added to the heap with correct priority."""
        state = _fresh_state()
        _enqueue_post_json("/api/test", {"k": 1}, 50, state=state)
        assert len(state.queue) == 1
        priority, _counter, path, payload, retries = state.queue[0]
        assert priority == 50
        assert path == "/api/test"
        assert payload == {"k": 1}
        assert retries == 0

    def test_heap_ordering(self):
        """Lower priority values are dequeued first (min-heap)."""
        import heapq

        state = _fresh_state()
        _enqueue_post_json("/api/low", {}, 90, state=state)
        _enqueue_post_json("/api/high", {}, 10, state=state)
        _priority, _counter, path, _payload, _retries = heapq.heappop(state.queue)
        assert path == "/api/high"

    def test_counter_increments(self):
        """Counter increments for each enqueue call."""
        state = _fresh_state()
        _enqueue_post_json("/a", {}, 10, state=state)
        _enqueue_post_json("/b", {}, 10, state=state)
        counters = [item[1] for item in state.queue]
        assert counters[0] != counters[1]

    def test_thread_safe_concurrent_enqueue(self):
        """Concurrent enqueues from multiple threads do not corrupt the queue."""
        state = _fresh_state()
        errors = []

        def enqueue():
            try:
                for i in range(50):
                    _enqueue_post_json("/api/t", {"i": i}, 10, state=state)
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=enqueue) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == []
        assert len(state.queue) == 200


# ---------------------------------------------------------------------------
# _drain_post_queue
# ---------------------------------------------------------------------------


class TestDrainPostQueue:
    """Tests for :func:`queue._drain_post_queue`."""

    def test_drains_all_items(self):
        """All queued items are sent and queue is emptied."""
        state = _fresh_state()
        sent = []
        _enqueue_post_json("/a", {"n": 1}, 10, state=state)
        _enqueue_post_json("/b", {"n": 2}, 20, state=state)
        _drain_post_queue(state, send=lambda path, payload: sent.append(path))
        assert sorted(sent) == ["/a", "/b"]
        assert state.queue == []

    def test_sets_active_false_after_drain(self):
        """active flag is set to False after draining."""
        state = _fresh_state()
        state.active = True
        _enqueue_post_json("/x", {}, 10, state=state)
        _drain_post_queue(state, send=lambda p, d: None)
        assert state.active is False

    def test_empty_queue_sets_active_false(self):
        """Empty queue immediately sets active to False."""
        state = _fresh_state()
        state.active = True
        _drain_post_queue(state, send=lambda p, d: None)
        assert state.active is False

    def test_sends_in_priority_order(self):
        """Items are sent in ascending priority order."""
        state = _fresh_state()
        sent = []
        _enqueue_post_json("/low", {}, 90, state=state)
        _enqueue_post_json("/high", {}, 10, state=state)
        _enqueue_post_json("/mid", {}, 50, state=state)
        _drain_post_queue(state, send=lambda path, payload: sent.append(path))
        assert sent == ["/high", "/mid", "/low"]

    def test_active_false_even_when_send_raises(self):
        """active is set to False even if the send callable raises."""
        state = _fresh_state()
        state.active = True
        _enqueue_post_json("/x", {}, 10, state=state)

        def boom(path, payload):
            raise RuntimeError("send failed")

        with pytest.raises(RuntimeError):
            _drain_post_queue(state, send=boom)
        assert state.active is False


# ---------------------------------------------------------------------------
# _queue_post_json
# ---------------------------------------------------------------------------


class TestQueuePostJson:
    """Tests for :func:`queue._queue_post_json`."""

    def test_sends_immediately_when_idle(self):
        """When the queue is idle, the item is sent synchronously."""
        state = _fresh_state()
        sent = []
        _queue_post_json(
            "/api/test",
            {"v": 1},
            priority=10,
            state=state,
            send=lambda p, d: sent.append(p),
        )
        assert "/api/test" in sent

    def test_enqueues_when_active(self):
        """When the queue is already active, the item is enqueued for later."""
        state = _fresh_state()
        state.active = True  # simulate in-flight drain
        _queue_post_json(
            "/api/test",
            {"v": 1},
            priority=10,
            state=state,
            send=lambda p, d: None,
        )
        # Item should be in the queue (not sent yet since active=True)
        assert len(state.queue) == 1

    def test_sets_active_true_when_starting(self):
        """active is set to True before draining starts."""
        state = _fresh_state()
        seen_active = []

        def capture_active(path, payload):
            seen_active.append(state.active)

        _queue_post_json("/api/test", {}, priority=10, state=state, send=capture_active)
        # During the drain, active was True
        assert any(seen_active)

    def test_default_priority_used_when_not_specified(self):
        """Default priority is applied when not explicitly provided."""
        state = _fresh_state()
        sent_priority = []

        original_enqueue = _enqueue_post_json

        def capturing_enqueue(path, payload, priority, *, state):
            sent_priority.append(priority)
            original_enqueue(path, payload, priority, state=state)

        import data.mesh_ingestor.queue as _q

        original = _q._enqueue_post_json
        _q._enqueue_post_json = capturing_enqueue
        try:
            _queue_post_json("/api/x", {}, state=state, send=lambda p, d: None)
        finally:
            _q._enqueue_post_json = original

        assert sent_priority == [_DEFAULT_POST_PRIORITY]


# ---------------------------------------------------------------------------
# _clear_post_queue
# ---------------------------------------------------------------------------


class TestClearPostQueue:
    """Tests for :func:`queue._clear_post_queue`."""

    def test_clears_queue_and_resets_active(self):
        """Queue is emptied and active is set to False."""
        state = _fresh_state()
        _enqueue_post_json("/a", {}, 10, state=state)
        _enqueue_post_json("/b", {}, 20, state=state)
        state.active = True
        _clear_post_queue(state=state)
        assert state.queue == []
        assert state.active is False

    def test_clears_empty_queue(self):
        """Clearing an already-empty queue is a no-op."""
        state = _fresh_state()
        _clear_post_queue(state=state)
        assert state.queue == []


# ---------------------------------------------------------------------------
# Multi-instance fan-out
# ---------------------------------------------------------------------------


class TestMultiInstanceFanOut:
    """Tests for multi-instance POST fan-out in :func:`queue._post_json`."""

    def test_fans_out_to_all_instances(self, monkeypatch):
        """Each configured instance receives the payload."""
        monkeypatch.setattr(
            config,
            "INSTANCES",
            (("http://alpha", "t1"), ("http://beta", "t2")),
        )

        captured = []

        def fake_urlopen(req, timeout=None):
            captured.append(req)
            return _FakeResp()

        with patch("urllib.request.urlopen", fake_urlopen):
            _post_json("/api/nodes", {"a": 1})

        assert len(captured) == 2
        urls = {r.get_full_url() for r in captured}
        assert urls == {"http://alpha/api/nodes", "http://beta/api/nodes"}
        tokens = {r.get_header("Authorization") for r in captured}
        assert tokens == {"Bearer t1", "Bearer t2"}

    def test_failure_isolation(self, monkeypatch):
        """A failure on one instance does not prevent delivery to the next."""
        monkeypatch.setattr(
            config,
            "INSTANCES",
            (("http://broken", "t1"), ("http://ok", "t2")),
        )
        monkeypatch.setattr(config, "DEBUG", False)

        captured = []

        def fake_urlopen(req, timeout=None):
            if "broken" in req.get_full_url():
                raise OSError("connection refused")
            captured.append(req)
            return _FakeResp()

        with patch("urllib.request.urlopen", fake_urlopen):
            _post_json("/api/test", {"x": 1})

        assert len(captured) == 1
        assert "http://ok" in captured[0].get_full_url()

    def test_explicit_instance_skips_fanout(self, monkeypatch):
        """Passing instance= explicitly bypasses the INSTANCES fan-out."""
        monkeypatch.setattr(
            config,
            "INSTANCES",
            (("http://a", "t1"), ("http://b", "t2")),
        )

        captured = []

        def fake_urlopen(req, timeout=None):
            captured.append(req)
            return _FakeResp()

        with patch("urllib.request.urlopen", fake_urlopen):
            _post_json("/api/test", {}, instance="http://override")

        assert len(captured) == 1
        assert "http://override" in captured[0].get_full_url()

    def test_empty_instances_noop(self, monkeypatch):
        """No requests are made when INSTANCES is empty."""
        monkeypatch.setattr(config, "INSTANCES", ())
        monkeypatch.setattr(config, "INSTANCE", "")

        with patch("urllib.request.urlopen") as mock_open:
            _post_json("/api/test", {})
            mock_open.assert_not_called()

    def test_backward_compat_fallback(self, monkeypatch):
        """Falls back to config.INSTANCE when INSTANCES is empty."""
        monkeypatch.setattr(config, "INSTANCES", ())
        monkeypatch.setattr(config, "INSTANCE", "http://legacy")
        monkeypatch.setattr(config, "API_TOKEN", "tok")

        captured = []

        def fake_urlopen(req, timeout=None):
            captured.append(req)
            return _FakeResp()

        with patch("urllib.request.urlopen", fake_urlopen):
            _post_json("/api/test", {"v": 1})

        assert len(captured) == 1
        assert "http://legacy" in captured[0].get_full_url()
        assert captured[0].get_header("Authorization") == "Bearer tok"


# ---------------------------------------------------------------------------
# HTTP failure always-logging
# ---------------------------------------------------------------------------


def test_http_failure_always_logged(monkeypatch):
    """POST failures are logged with always=True regardless of DEBUG mode.

    Operators must be able to see HTTP errors without enabling DEBUG so they
    can tell whether the ingestor is silently dropping data.
    """
    monkeypatch.setattr(config, "INSTANCES", (("http://localhost", ""),))
    monkeypatch.setattr(config, "INSTANCE", "http://localhost")
    monkeypatch.setattr(config, "DEBUG", False)

    log_calls: list[dict] = []
    original_debug_log = config._debug_log

    def capture_debug_log(msg, **kwargs):
        log_calls.append(kwargs)
        original_debug_log(msg, **kwargs)

    monkeypatch.setattr(config, "_debug_log", capture_debug_log)

    def raise_error(req, timeout=None):
        raise OSError("connection refused")

    with patch("urllib.request.urlopen", raise_error):
        _send_single("http://localhost", "", "/api/test", {"x": 1})

    assert any(
        c.get("always") is True for c in log_calls
    ), "Expected at least one _debug_log call with always=True on HTTP failure"


# ---------------------------------------------------------------------------
# Background drain thread
# ---------------------------------------------------------------------------


class TestQueueDrainer:
    """Tests for :func:`_start_queue_drainer` and :func:`_queue_drainer_loop`."""

    def test_start_queue_drainer_starts_thread(self):
        """_start_queue_drainer creates and starts a daemon thread."""
        state = _fresh_state()
        assert state.drainer is None
        _start_queue_drainer(state)
        assert state.drainer is not None
        assert state.drainer.is_alive()
        _stop_queue_drainer(state)

    def test_start_queue_drainer_idempotent(self):
        """Calling _start_queue_drainer twice does not create a second thread."""
        state = _fresh_state()
        _start_queue_drainer(state)
        first_thread = state.drainer
        _start_queue_drainer(state)
        assert state.drainer is first_thread
        _stop_queue_drainer(state)

    def test_queue_drainer_loop_drains_items(self):
        """_queue_drainer_loop drains enqueued items when signalled."""
        state = _fresh_state()
        drained: list[str] = []

        original_post_json = _queue_mod._post_json
        _queue_mod._post_json = lambda path, payload: drained.append(path)
        try:
            _start_queue_drainer(state)
            _enqueue_post_json("/api/drainer-test", {}, 10, state=state)
            state.drain_event.set()
            deadline = time.monotonic() + 2.0
            while "/api/drainer-test" not in drained and time.monotonic() < deadline:
                time.sleep(0.01)
            assert "/api/drainer-test" in drained
        finally:
            _queue_mod._post_json = original_post_json
            _stop_queue_drainer(state)

    def test_queue_post_json_signals_drain_event_with_drainer(self):
        """When a drainer is alive, _queue_post_json signals drain_event instead of blocking."""
        state = _fresh_state()
        drained: list[str] = []

        original_post_json = _queue_mod._post_json
        _queue_mod._post_json = lambda path, payload: drained.append(path)
        try:
            _start_queue_drainer(state)
            # With a live drainer, the call should return immediately
            # (signal only) and the drainer processes the item in the background.
            _queue_post_json("/api/bg-test", {"k": 1}, priority=10, state=state)
            deadline = time.monotonic() + 2.0
            while "/api/bg-test" not in drained and time.monotonic() < deadline:
                time.sleep(0.01)
            assert "/api/bg-test" in drained
        finally:
            _queue_mod._post_json = original_post_json
            _stop_queue_drainer(state)

    def test_queue_post_json_falls_back_to_sync_drain_without_drainer(self):
        """When no drainer is running, _queue_post_json drains synchronously."""
        state = _fresh_state()
        # state.drainer is None → synchronous path
        sent: list[str] = []
        _queue_post_json(
            "/api/sync",
            {"v": 1},
            priority=10,
            state=state,
            send=lambda p, d: sent.append(p),
        )
        assert "/api/sync" in sent

    def test_enqueue_during_drain_is_processed(self):
        """Items enqueued while the drainer is mid-drain are still drained.

        Simulates the race where a new item arrives while
        ``_drain_post_queue`` is actively processing.  The new item must
        be picked up within the same drain cycle or on the next signal.
        """
        state = _fresh_state()
        drained: list[str] = []
        gate = threading.Event()

        original_post_json = _queue_mod._post_json

        def slow_send(path, payload):
            """Drain the first item slowly, allowing a second enqueue."""
            drained.append(path)
            if path == "/api/first":
                gate.set()

        _queue_mod._post_json = slow_send
        try:
            _start_queue_drainer(state)
            _enqueue_post_json("/api/first", {}, 10, state=state)
            state.drain_event.set()
            # Wait until the drainer has started processing /api/first.
            gate.wait(timeout=2.0)
            # Enqueue a second item while the drainer is active.
            _enqueue_post_json("/api/second", {}, 10, state=state)
            state.drain_event.set()
            deadline = time.monotonic() + 2.0
            while "/api/second" not in drained and time.monotonic() < deadline:
                time.sleep(0.01)
            assert "/api/second" in drained
        finally:
            _queue_mod._post_json = original_post_json
            _stop_queue_drainer(state)

    def test_stop_queue_drainer(self):
        """_stop_queue_drainer signals the thread to exit and joins it."""
        state = _fresh_state()
        _start_queue_drainer(state)
        assert state.drainer is not None
        assert state.drainer.is_alive()
        _stop_queue_drainer(state)
        assert state.drainer is None
        assert state.shutdown.is_set()

    def test_stop_queue_drainer_noop_when_not_running(self):
        """_stop_queue_drainer is safe to call with no drainer."""
        state = _fresh_state()
        _stop_queue_drainer(state)
        assert state.drainer is None


# ---------------------------------------------------------------------------
# Drainer resilience
# ---------------------------------------------------------------------------


class TestDrainerResilience:
    """Tests verifying the drainer thread cannot be killed by exceptions."""

    def test_drainer_survives_drain_exception(self, monkeypatch):
        """The drainer loop keeps running after _drain_post_queue raises."""
        state = _fresh_state()
        drained: list[str] = []
        call_count = [0]

        original_drain = _queue_mod._drain_post_queue

        def flaky_drain(s, send=None):
            call_count[0] += 1
            if call_count[0] == 1:
                raise RuntimeError("transient drain error")
            original_drain(s, send=send)

        original_post_json = _queue_mod._post_json
        _queue_mod._post_json = lambda path, payload: drained.append(path)
        monkeypatch.setattr(_queue_mod, "_drain_post_queue", flaky_drain)
        try:
            _start_queue_drainer(state)
            # First signal triggers the RuntimeError; drainer should survive.
            _enqueue_post_json("/api/first", {}, 10, state=state)
            state.drain_event.set()
            time.sleep(0.2)
            assert state.drainer.is_alive(), "Drainer died after drain exception"
            # Second signal should succeed normally.
            _enqueue_post_json("/api/second", {}, 10, state=state)
            state.drain_event.set()
            deadline = time.monotonic() + 2.0
            while "/api/second" not in drained and time.monotonic() < deadline:
                time.sleep(0.01)
            assert "/api/second" in drained
        finally:
            _queue_mod._post_json = original_post_json
            _stop_queue_drainer(state)

    def test_drainer_survives_debug_log_exception(self, monkeypatch):
        """The drainer survives even when _debug_log raises inside the error handler."""
        state = _fresh_state()
        drained: list[str] = []
        call_count = [0]

        original_drain = _queue_mod._drain_post_queue

        def flaky_drain(s, send=None):
            call_count[0] += 1
            if call_count[0] == 1:
                raise RuntimeError("drain error")
            original_drain(s, send=send)

        def broken_log(*args, **kwargs):
            raise BrokenPipeError("stdout closed")

        original_post_json = _queue_mod._post_json
        _queue_mod._post_json = lambda path, payload: drained.append(path)
        monkeypatch.setattr(_queue_mod, "_drain_post_queue", flaky_drain)
        monkeypatch.setattr(config, "_debug_log", broken_log)
        try:
            _start_queue_drainer(state)
            _enqueue_post_json("/api/first", {}, 10, state=state)
            state.drain_event.set()
            time.sleep(0.2)
            assert state.drainer.is_alive(), "Drainer died after log exception"
            # Restore log so the second drain can proceed.
            monkeypatch.undo()
            _queue_mod._post_json = lambda path, payload: drained.append(path)
            monkeypatch.setattr(_queue_mod, "_drain_post_queue", original_drain)
            _enqueue_post_json("/api/second", {}, 10, state=state)
            state.drain_event.set()
            deadline = time.monotonic() + 2.0
            while "/api/second" not in drained and time.monotonic() < deadline:
                time.sleep(0.01)
            assert "/api/second" in drained
        finally:
            _queue_mod._post_json = original_post_json
            _stop_queue_drainer(state)

    def test_drainer_logs_startup(self, monkeypatch):
        """The drainer logs a startup message."""
        state = _fresh_state()
        log_msgs: list[str] = []
        monkeypatch.setattr(
            config, "_debug_log", lambda msg, **kw: log_msgs.append(msg)
        )
        _start_queue_drainer(state)
        time.sleep(0.1)
        _stop_queue_drainer(state)
        assert any("started" in m.lower() for m in log_msgs)

    def test_drainer_logs_exit(self, monkeypatch):
        """The drainer logs an exit message on clean shutdown."""
        state = _fresh_state()
        log_msgs: list[str] = []
        monkeypatch.setattr(
            config, "_debug_log", lambda msg, **kw: log_msgs.append(msg)
        )
        _start_queue_drainer(state)
        time.sleep(0.1)
        _stop_queue_drainer(state)
        assert any("exiting" in m.lower() for m in log_msgs)

    def test_drainer_logs_depth_warning(self, monkeypatch):
        """A warning is emitted when queue depth exceeds the threshold."""
        state = _fresh_state()
        log_kwargs: list[dict] = []
        monkeypatch.setattr(
            config,
            "_debug_log",
            lambda msg, **kw: log_kwargs.append({"msg": msg, **kw}),
        )

        original_post_json = _queue_mod._post_json
        _queue_mod._post_json = lambda path, payload: None
        try:
            for i in range(_QUEUE_DEPTH_WARNING_THRESHOLD + 1):
                _enqueue_post_json(f"/api/{i}", {}, 10, state=state)
            _start_queue_drainer(state)
            state.drain_event.set()
            deadline = time.monotonic() + 2.0
            while (
                not any("depth" in e.get("msg", "").lower() for e in log_kwargs)
                and time.monotonic() < deadline
            ):
                time.sleep(0.01)
            assert any("depth" in e.get("msg", "").lower() for e in log_kwargs)
        finally:
            _queue_mod._post_json = original_post_json
            _stop_queue_drainer(state)


# ---------------------------------------------------------------------------
# Retry logic
# ---------------------------------------------------------------------------


class TestRetryLogic:
    """Tests for send failure retry in :func:`_drain_post_queue`."""

    def test_send_single_returns_true_on_success(self, monkeypatch):
        """_send_single returns True when the HTTP call succeeds."""
        with patch("urllib.request.urlopen", lambda req, timeout=None: _FakeResp()):
            assert _send_single("http://localhost", "", "/api/ok", {}) is True

    def test_send_single_returns_false_on_failure(self, monkeypatch):
        """_send_single returns False when the HTTP call fails."""
        monkeypatch.setattr(config, "_debug_log", lambda *a, **kw: None)

        def raise_error(req, timeout=None):
            raise OSError("fail")

        with patch("urllib.request.urlopen", raise_error):
            assert _send_single("http://localhost", "", "/api/fail", {}) is False

    def test_post_json_returns_true_on_success(self, monkeypatch):
        """_post_json returns True when the instance succeeds."""
        monkeypatch.setattr(config, "INSTANCES", (("http://ok", ""),))
        with patch("urllib.request.urlopen", lambda req, timeout=None: _FakeResp()):
            assert _post_json("/api/ok", {}) is True

    def test_post_json_returns_false_when_all_fail(self, monkeypatch):
        """_post_json returns False when all instances fail."""
        monkeypatch.setattr(config, "INSTANCES", (("http://a", ""), ("http://b", "")))
        monkeypatch.setattr(config, "_debug_log", lambda *a, **kw: None)

        def raise_error(req, timeout=None):
            raise OSError("fail")

        with patch("urllib.request.urlopen", raise_error):
            assert _post_json("/api/fail", {}) is False

    def test_post_json_returns_true_when_at_least_one_succeeds(self, monkeypatch):
        """_post_json returns True when at least one instance succeeds."""
        monkeypatch.setattr(
            config, "INSTANCES", (("http://broken", ""), ("http://ok", ""))
        )
        monkeypatch.setattr(config, "_debug_log", lambda *a, **kw: None)

        def selective_urlopen(req, timeout=None):
            if "broken" in req.get_full_url():
                raise OSError("fail")
            return _FakeResp()

        with patch("urllib.request.urlopen", selective_urlopen):
            assert _post_json("/api/mixed", {}) is True

    def test_drain_retries_on_send_failure(self):
        """Items are re-queued and retried when send returns False."""
        state = _fresh_state()
        attempts: list[str] = []
        call_count = [0]

        def flaky_send(path, payload):
            call_count[0] += 1
            attempts.append(path)
            # Fail on first attempt, succeed on retry.
            return call_count[0] > 1

        _enqueue_post_json("/api/retry", {"v": 1}, 10, state=state)
        _drain_post_queue(state, send=flaky_send)
        assert attempts.count("/api/retry") == 2

    def test_drain_drops_after_max_retries(self, monkeypatch):
        """Items are dropped with a warning after exceeding max retries."""
        state = _fresh_state()
        attempts: list[str] = []
        log_kwargs: list[dict] = []
        monkeypatch.setattr(
            config,
            "_debug_log",
            lambda msg, **kw: log_kwargs.append({"msg": msg, **kw}),
        )

        def always_fail(path, payload):
            attempts.append(path)
            return False

        _enqueue_post_json("/api/doomed", {}, 10, state=state)
        _drain_post_queue(state, send=always_fail)
        # Initial attempt + _MAX_SEND_RETRIES retries.
        assert attempts.count("/api/doomed") == _MAX_SEND_RETRIES + 1
        assert any("dropping" in e.get("msg", "").lower() for e in log_kwargs)

    def test_drain_no_retry_for_none_return(self):
        """Custom send callables returning None are NOT retried.

        This preserves backward compatibility with test lambdas that do not
        return a boolean.
        """
        state = _fresh_state()
        attempts: list[str] = []

        def custom_send(path, payload):
            attempts.append(path)
            return None

        _enqueue_post_json("/api/once", {}, 10, state=state)
        _drain_post_queue(state, send=custom_send)
        assert attempts.count("/api/once") == 1

    def test_enqueue_with_retries_parameter(self):
        """_enqueue_post_json stores the retry count in the 5th tuple position."""
        state = _fresh_state()
        _enqueue_post_json("/api/r", {}, 10, state=state, retries=2)
        assert len(state.queue) == 1
        assert state.queue[0][4] == 2

    def test_drain_handles_legacy_4_tuple(self):
        """_drain_post_queue handles 4-tuple items without crashing."""
        import heapq

        state = _fresh_state()
        sent: list[str] = []
        # Push a legacy 4-tuple directly.
        with state.lock:
            heapq.heappush(state.queue, (10, 0, "/api/legacy", {"v": 1}))
        _drain_post_queue(state, send=lambda p, d: sent.append(p))
        assert "/api/legacy" in sent


# ---------------------------------------------------------------------------
# Drainer auto-restart
# ---------------------------------------------------------------------------


class TestDrainerAutoRestart:
    """Tests for automatic drainer thread recovery in :func:`_queue_post_json`."""

    def test_queue_post_json_restarts_dead_drainer(self, monkeypatch):
        """A dead drainer is automatically restarted by _queue_post_json."""
        state = _fresh_state()
        drained: list[str] = []

        original_post_json = _queue_mod._post_json
        _queue_mod._post_json = lambda path, payload: drained.append(path)
        monkeypatch.setattr(config, "_debug_log", lambda *a, **kw: None)
        try:
            # Start and then kill the drainer.
            _start_queue_drainer(state)
            _stop_queue_drainer(state)
            # _stop_queue_drainer sets drainer=None, so simulate a crash
            # where the Thread object is still present but dead.
            state.drainer = threading.Thread(target=lambda: None, daemon=True)
            state.drainer.start()
            state.drainer.join()  # Dead thread, is_alive()=False

            _queue_post_json("/api/revived", {"v": 1}, priority=10, state=state)
            deadline = time.monotonic() + 2.0
            while "/api/revived" not in drained and time.monotonic() < deadline:
                time.sleep(0.01)
            assert "/api/revived" in drained
            assert state.drainer is not None
            assert state.drainer.is_alive()
        finally:
            _queue_mod._post_json = original_post_json
            _stop_queue_drainer(state)

    def test_queue_post_json_no_restart_when_never_started(self):
        """No drainer is started when state.drainer is None (daemon's job)."""
        state = _fresh_state()
        assert state.drainer is None
        sent: list[str] = []
        _queue_post_json(
            "/api/no-restart",
            {},
            priority=10,
            state=state,
            send=lambda p, d: sent.append(p),
        )
        assert "/api/no-restart" in sent
        assert state.drainer is None

    def test_start_queue_drainer_resets_shutdown(self):
        """_start_queue_drainer clears the shutdown event before starting."""
        state = _fresh_state()
        _start_queue_drainer(state)
        _stop_queue_drainer(state)
        assert state.shutdown.is_set()
        # Re-start should clear shutdown and start a live thread.
        _start_queue_drainer(state)
        assert not state.shutdown.is_set()
        assert state.drainer is not None
        assert state.drainer.is_alive()
        _stop_queue_drainer(state)


# ---------------------------------------------------------------------------
# No-instances warning
# ---------------------------------------------------------------------------


class TestNoInstancesWarning:
    """Tests for the warning log when no target instances are configured."""

    def test_post_json_errors_when_no_instances(self, monkeypatch):
        """An error is logged when INSTANCES and INSTANCE are both empty."""
        monkeypatch.setattr(config, "INSTANCES", ())
        monkeypatch.setattr(config, "INSTANCE", "")
        log_kwargs: list[dict] = []
        monkeypatch.setattr(
            config,
            "_debug_log",
            lambda msg, **kw: log_kwargs.append({"msg": msg, **kw}),
        )

        result = _post_json("/api/nowhere", {"v": 1})

        assert result is False
        assert any(
            kw.get("always") is True and kw.get("severity") == "error"
            for kw in log_kwargs
        )

    def test_post_json_survives_log_exception_on_no_instances(self, monkeypatch):
        """_post_json still returns False when logging itself raises."""
        monkeypatch.setattr(config, "INSTANCES", ())
        monkeypatch.setattr(config, "INSTANCE", "")
        monkeypatch.setattr(
            config,
            "_debug_log",
            lambda *a, **kw: (_ for _ in ()).throw(OSError("log broken")),
        )
        assert _post_json("/api/nowhere", {}) is False


# ---------------------------------------------------------------------------
# Defensive exception guard coverage
# ---------------------------------------------------------------------------


class TestDefensiveExceptionGuards:
    """Cover the ``except Exception: pass`` guards wrapping ``_debug_log`` calls.

    These guards ensure that a broken logging backend (e.g. ``BrokenPipeError``
    from ``print()`` to a closed stdout) never crashes the drainer thread or
    drops data.
    """

    def test_drain_drop_log_exception(self, monkeypatch):
        """Max-retries drop path survives a broken _debug_log."""
        state = _fresh_state()
        monkeypatch.setattr(
            config,
            "_debug_log",
            lambda *a, **kw: (_ for _ in ()).throw(BrokenPipeError("broken")),
        )

        attempts: list[str] = []

        def always_fail(path, payload):
            attempts.append(path)
            return False

        _enqueue_post_json("/api/fail", {}, 10, state=state)
        # Should not raise even though _debug_log throws on the drop message.
        _drain_post_queue(state, send=always_fail)
        assert attempts.count("/api/fail") == _MAX_SEND_RETRIES + 1

    def test_drainer_startup_log_exception(self, monkeypatch):
        """Drainer thread starts even when the startup log raises."""
        state = _fresh_state()
        monkeypatch.setattr(
            config,
            "_debug_log",
            lambda *a, **kw: (_ for _ in ()).throw(BrokenPipeError("broken")),
        )
        _start_queue_drainer(state)
        time.sleep(0.15)
        assert state.drainer is not None
        assert state.drainer.is_alive()
        # Restore log so stop can log cleanly.
        monkeypatch.undo()
        _stop_queue_drainer(state)

    def test_drainer_exit_log_exception(self, monkeypatch):
        """Drainer thread exits cleanly even when the exit log raises."""
        state = _fresh_state()
        _start_queue_drainer(state)
        time.sleep(0.05)
        # Break _debug_log AFTER startup so only the exit log raises.
        monkeypatch.setattr(
            config,
            "_debug_log",
            lambda *a, **kw: (_ for _ in ()).throw(BrokenPipeError("broken")),
        )
        _stop_queue_drainer(state)
        assert state.drainer is None

    def test_drainer_depth_warning_log_exception(self, monkeypatch):
        """Drainer survives a broken _debug_log during depth warning."""
        state = _fresh_state()
        drained: list[str] = []

        original_post_json = _queue_mod._post_json
        _queue_mod._post_json = lambda path, payload: drained.append(path)
        try:
            _start_queue_drainer(state)
            time.sleep(0.05)
            # Break _debug_log so the depth warning raises.
            monkeypatch.setattr(
                config,
                "_debug_log",
                lambda *a, **kw: (_ for _ in ()).throw(BrokenPipeError("broken")),
            )
            for i in range(_QUEUE_DEPTH_WARNING_THRESHOLD + 1):
                _enqueue_post_json(f"/api/{i}", {}, 10, state=state)
            state.drain_event.set()
            deadline = time.monotonic() + 2.0
            while (
                len(drained) < _QUEUE_DEPTH_WARNING_THRESHOLD + 1
                and time.monotonic() < deadline
            ):
                time.sleep(0.01)
            assert len(drained) == _QUEUE_DEPTH_WARNING_THRESHOLD + 1
        finally:
            _queue_mod._post_json = original_post_json
            monkeypatch.undo()
            _stop_queue_drainer(state)

    def test_drainer_error_handler_log_exception(self, monkeypatch):
        """Drainer survives when both drain and error-log raise."""
        state = _fresh_state()
        call_count = [0]
        original_drain = _queue_mod._drain_post_queue

        def flaky_drain(s, send=None):
            call_count[0] += 1
            if call_count[0] == 1:
                raise RuntimeError("drain boom")
            original_drain(s, send=send)

        drained: list[str] = []
        original_post_json = _queue_mod._post_json
        _queue_mod._post_json = lambda path, payload: drained.append(path)
        monkeypatch.setattr(_queue_mod, "_drain_post_queue", flaky_drain)
        # _debug_log raises on the error handler's inner logging call.
        monkeypatch.setattr(
            config,
            "_debug_log",
            lambda *a, **kw: (_ for _ in ()).throw(BrokenPipeError("broken")),
        )
        try:
            _start_queue_drainer(state)
            _enqueue_post_json("/api/first", {}, 10, state=state)
            state.drain_event.set()
            time.sleep(0.3)
            assert state.drainer.is_alive()
            # Restore to process an item normally.
            monkeypatch.undo()
            _queue_mod._post_json = lambda path, payload: drained.append(path)
            monkeypatch.setattr(_queue_mod, "_drain_post_queue", original_drain)
            _enqueue_post_json("/api/second", {}, 10, state=state)
            state.drain_event.set()
            deadline = time.monotonic() + 2.0
            while "/api/second" not in drained and time.monotonic() < deadline:
                time.sleep(0.01)
            assert "/api/second" in drained
        finally:
            _queue_mod._post_json = original_post_json
            _stop_queue_drainer(state)

    def test_restart_warning_log_exception(self, monkeypatch):
        """Drainer restart proceeds even when the restart warning log raises."""
        state = _fresh_state()
        drained: list[str] = []
        original_post_json = _queue_mod._post_json
        _queue_mod._post_json = lambda path, payload: drained.append(path)
        monkeypatch.setattr(
            config,
            "_debug_log",
            lambda *a, **kw: (_ for _ in ()).throw(BrokenPipeError("broken")),
        )
        try:
            # Simulate a crashed drainer (dead Thread, not None).
            state.drainer = threading.Thread(target=lambda: None, daemon=True)
            state.drainer.start()
            state.drainer.join()
            assert not state.drainer.is_alive()

            _queue_post_json("/api/restarted", {"v": 1}, priority=10, state=state)
            deadline = time.monotonic() + 2.0
            while "/api/restarted" not in drained and time.monotonic() < deadline:
                time.sleep(0.01)
            assert "/api/restarted" in drained
        finally:
            _queue_mod._post_json = original_post_json
            monkeypatch.undo()
            _stop_queue_drainer(state)
