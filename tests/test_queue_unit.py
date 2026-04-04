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
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.config as config
from data.mesh_ingestor.queue import (
    QueueState,
    _clear_post_queue,
    _drain_post_queue,
    _enqueue_post_json,
    _post_json,
    _queue_post_json,
    _DEFAULT_POST_PRIORITY,
    _MESSAGE_POST_PRIORITY,
    _NODE_POST_PRIORITY,
)


def _fresh_state() -> QueueState:
    """Return a new QueueState for isolation."""
    return QueueState()


# ---------------------------------------------------------------------------
# _post_json
# ---------------------------------------------------------------------------


class TestPostJson:
    """Tests for :func:`queue._post_json`."""

    def test_skips_when_no_instance(self, monkeypatch):
        """Does nothing when INSTANCE is empty."""
        monkeypatch.setattr(config, "INSTANCE", "")
        sent = []
        with patch("urllib.request.urlopen") as mock_open:
            _post_json("/api/test", {"key": "val"})
            mock_open.assert_not_called()

    def test_sends_json_post(self, monkeypatch):
        """Sends a POST request with JSON body and correct headers."""
        monkeypatch.setattr(config, "INSTANCE", "http://localhost")
        monkeypatch.setattr(config, "API_TOKEN", "tok")

        captured_req = []

        class FakeResp:
            def read(self):
                return b""

            def __enter__(self):
                return self

            def __exit__(self, *a):
                pass

        def fake_urlopen(req, timeout=None):
            captured_req.append(req)
            return FakeResp()

        with patch("urllib.request.urlopen", fake_urlopen):
            _post_json("/api/nodes", {"a": 1})

        assert len(captured_req) == 1
        req = captured_req[0]
        assert req.get_full_url() == "http://localhost/api/nodes"
        assert req.get_header("Content-type") == "application/json"
        assert req.get_header("Authorization") == "Bearer tok"

    def test_handles_network_error_gracefully(self, monkeypatch, capsys):
        """Network errors are caught and logged, not raised."""
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

        class FakeResp:
            def read(self):
                return b""

            def __enter__(self):
                return self

            def __exit__(self, *a):
                pass

        def fake_urlopen(req, timeout=None):
            captured_req.append(req)
            return FakeResp()

        with patch("urllib.request.urlopen", fake_urlopen):
            _post_json("/api/test", {}, instance="http://override")

        assert "http://override" in captured_req[0].get_full_url()

    def test_no_auth_header_when_token_empty(self, monkeypatch):
        """No Authorization header is added when API_TOKEN is empty."""
        monkeypatch.setattr(config, "INSTANCE", "http://localhost")
        monkeypatch.setattr(config, "API_TOKEN", "")

        captured_req = []

        class FakeResp:
            def read(self):
                return b""

            def __enter__(self):
                return self

            def __exit__(self, *a):
                pass

        def fake_urlopen(req, timeout=None):
            captured_req.append(req)
            return FakeResp()

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
        priority, _counter, path, payload = state.queue[0]
        assert priority == 50
        assert path == "/api/test"
        assert payload == {"k": 1}

    def test_heap_ordering(self):
        """Lower priority values are dequeued first (min-heap)."""
        import heapq

        state = _fresh_state()
        _enqueue_post_json("/api/low", {}, 90, state=state)
        _enqueue_post_json("/api/high", {}, 10, state=state)
        _priority, _counter, path, _payload = heapq.heappop(state.queue)
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
