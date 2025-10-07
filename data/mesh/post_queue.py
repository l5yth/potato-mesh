"""Utilities for queueing HTTP POST requests to the PotatoMesh API."""

from __future__ import annotations

import heapq
import itertools
import json
import threading
import urllib.error
import urllib.request

from . import config

_POST_QUEUE_LOCK = threading.Lock()
_POST_QUEUE: list[tuple[int, int, str, dict]] = []
_POST_QUEUE_COUNTER = itertools.count()
_POST_QUEUE_ACTIVE = False

_MESSAGE_POST_PRIORITY = 10
_NEIGHBOR_POST_PRIORITY = 20
_POSITION_POST_PRIORITY = 30
_TELEMETRY_POST_PRIORITY = 40
_NODE_POST_PRIORITY = 50
_DEFAULT_POST_PRIORITY = 90


def _post_json(path: str, payload: dict) -> None:
    """Send a JSON payload to the configured web API."""

    if not config.INSTANCE:
        return
    url = f"{config.INSTANCE}{path}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}
    )
    if config.API_TOKEN:
        req.add_header("Authorization", f"Bearer {config.API_TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except Exception as exc:
        config._debug_log(f"[warn] POST {url} failed: {exc}")


def _enqueue_post_json(path: str, payload: dict, priority: int) -> None:
    """Store a POST request in the priority queue."""

    with _POST_QUEUE_LOCK:
        heapq.heappush(
            _POST_QUEUE, (priority, next(_POST_QUEUE_COUNTER), path, payload)
        )


def _drain_post_queue() -> None:
    """Process queued POST requests in priority order."""

    global _POST_QUEUE_ACTIVE
    while True:
        with _POST_QUEUE_LOCK:
            if not _POST_QUEUE:
                _POST_QUEUE_ACTIVE = False
                return
            _priority, _idx, path, payload = heapq.heappop(_POST_QUEUE)
        _post_json(path, payload)


def _queue_post_json(
    path: str, payload: dict, *, priority: int = _DEFAULT_POST_PRIORITY
) -> None:
    """Queue a POST request and start processing if idle."""

    global _POST_QUEUE_ACTIVE
    _enqueue_post_json(path, payload, priority)
    with _POST_QUEUE_LOCK:
        if _POST_QUEUE_ACTIVE:
            return
        _POST_QUEUE_ACTIVE = True
    _drain_post_queue()


def _clear_post_queue() -> None:
    """Clear the pending POST queue (used by tests)."""

    global _POST_QUEUE_ACTIVE
    with _POST_QUEUE_LOCK:
        _POST_QUEUE.clear()
        _POST_QUEUE_ACTIVE = False


__all__ = [
    "_DEFAULT_POST_PRIORITY",
    "_MESSAGE_POST_PRIORITY",
    "_NEIGHBOR_POST_PRIORITY",
    "_NODE_POST_PRIORITY",
    "_POST_QUEUE",
    "_POST_QUEUE_ACTIVE",
    "_POST_QUEUE_COUNTER",
    "_POST_QUEUE_LOCK",
    "_POSITION_POST_PRIORITY",
    "_TELEMETRY_POST_PRIORITY",
    "_clear_post_queue",
    "_drain_post_queue",
    "_enqueue_post_json",
    "_post_json",
    "_queue_post_json",
]
