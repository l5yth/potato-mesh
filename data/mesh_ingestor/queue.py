"""Priority queue for POST operations."""

from __future__ import annotations

import heapq
import itertools
import json
import threading
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Iterable, Tuple

from . import config

_MESSAGE_POST_PRIORITY = 10
_NEIGHBOR_POST_PRIORITY = 20
_POSITION_POST_PRIORITY = 30
_TELEMETRY_POST_PRIORITY = 40
_NODE_POST_PRIORITY = 50
_DEFAULT_POST_PRIORITY = 90


@dataclass
class QueueState:
    """Mutable state for the HTTP POST priority queue."""

    lock: threading.Lock = field(default_factory=threading.Lock)
    queue: list[tuple[int, int, str, dict]] = field(default_factory=list)
    counter: Iterable[int] = field(default_factory=itertools.count)
    active: bool = False


STATE = QueueState()


def _post_json(
    path: str,
    payload: dict,
    *,
    instance: str | None = None,
    api_token: str | None = None,
) -> None:
    """Send a JSON payload to the configured web API.

    Parameters:
        path: API path relative to the configured instance root.
        payload: JSON-serialisable body to transmit.
        instance: Optional override for :data:`config.INSTANCE`.
        api_token: Optional override for :data:`config.API_TOKEN`.
    """

    if instance is None:
        instance = config.INSTANCE
    if api_token is None:
        api_token = config.API_TOKEN

    if not instance:
        return
    url = f"{instance}{path}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}
    )
    if api_token:
        req.add_header("Authorization", f"Bearer {api_token}")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except Exception as exc:  # pragma: no cover - exercised in production
        config._debug_log(f"[warn] POST {url} failed: {exc}")


def _enqueue_post_json(
    path: str,
    payload: dict,
    priority: int,
    *,
    state: QueueState = STATE,
) -> None:
    """Store a POST request in the priority queue.

    Parameters:
        path: API path for the queued request.
        payload: JSON-serialisable body.
        priority: Lower values execute first.
        state: Shared queue state, injectable for testing.
    """

    with state.lock:
        counter = next(state.counter)
        heapq.heappush(state.queue, (priority, counter, path, payload))


def _drain_post_queue(
    state: QueueState = STATE, send: Callable[[str, dict], None] | None = None
) -> None:
    """Process queued POST requests in priority order.

    Parameters:
        state: Queue container holding pending items.
        send: Optional callable used to transmit requests.
    """

    if send is None:
        send = _post_json

    try:
        while True:
            with state.lock:
                if not state.queue:
                    return
                _priority, _idx, path, payload = heapq.heappop(state.queue)
            send(path, payload)
    finally:
        with state.lock:
            state.active = False


def _queue_post_json(
    path: str,
    payload: dict,
    *,
    priority: int = _DEFAULT_POST_PRIORITY,
    state: QueueState = STATE,
    send: Callable[[str, dict], None] | None = None,
) -> None:
    """Queue a POST request and start processing if idle.

    Parameters:
        path: API path for the request.
        payload: JSON payload to send.
        priority: Scheduling priority where lower values run first.
        state: Queue container used to store pending requests.
        send: Optional transport override, primarily for tests.
    """

    if send is None:
        send = _post_json

    _enqueue_post_json(path, payload, priority, state=state)
    with state.lock:
        if state.active:
            return
        state.active = True
    _drain_post_queue(state, send=send)


def _clear_post_queue(state: QueueState = STATE) -> None:
    """Clear the pending POST queue.

    Parameters:
        state: Queue state to reset. Defaults to the global queue.
    """

    with state.lock:
        state.queue.clear()
        state.active = False


__all__ = [
    "STATE",
    "QueueState",
    "_DEFAULT_POST_PRIORITY",
    "_MESSAGE_POST_PRIORITY",
    "_NEIGHBOR_POST_PRIORITY",
    "_NODE_POST_PRIORITY",
    "_POSITION_POST_PRIORITY",
    "_TELEMETRY_POST_PRIORITY",
    "_clear_post_queue",
    "_drain_post_queue",
    "_enqueue_post_json",
    "_post_json",
    "_queue_post_json",
]
