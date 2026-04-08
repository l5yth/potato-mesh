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

"""Priority queue for POST operations."""

from __future__ import annotations

import heapq
import itertools
import json
import threading
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Iterable, Mapping, Tuple

from . import config


def _stringify_payload_value(value: object) -> str:
    """Return a stable string representation for ``value``."""

    if isinstance(value, Mapping):
        try:
            return json.dumps(
                {
                    str(key): value[key]
                    for key in sorted(value, key=lambda item: str(item))
                },
                sort_keys=True,
                ensure_ascii=False,
                default=str,
            )
        except Exception:  # pragma: no cover - defensive guard
            return str(value)
    if isinstance(value, (list, tuple)):
        try:
            return json.dumps(list(value), ensure_ascii=False, default=str)
        except Exception:  # pragma: no cover - defensive guard
            return str(value)
    if isinstance(value, set):
        try:
            return json.dumps(sorted(value, key=str), ensure_ascii=False, default=str)
        except Exception:  # pragma: no cover - defensive guard
            return str(value)
    if isinstance(value, bytes):
        return json.dumps(value.decode("utf-8", "replace"), ensure_ascii=False)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _payload_key_value_pairs(payload: Mapping[str, object]) -> str:
    """Serialise ``payload`` into ``key=value`` pairs for debug logs."""

    pairs: list[str] = []
    for key in sorted(payload):
        try:
            formatted = _stringify_payload_value(payload[key])
        except Exception:  # pragma: no cover - defensive guard
            formatted = str(payload[key])
        pairs.append(f"{key}={formatted}")
    return " ".join(pairs)


_INGESTOR_POST_PRIORITY = 0
_CHANNEL_POST_PRIORITY = 10
_NODE_POST_PRIORITY = 20
_MESSAGE_POST_PRIORITY = 30
_NEIGHBOR_POST_PRIORITY = 40
_TRACE_POST_PRIORITY = 50
_POSITION_POST_PRIORITY = 60
_TELEMETRY_POST_PRIORITY = 70
_DEFAULT_POST_PRIORITY = 90


@dataclass
class QueueState:
    """Mutable state for the HTTP POST priority queue."""

    lock: threading.Lock = field(default_factory=threading.Lock)
    queue: list[tuple[int, int, str, dict]] = field(default_factory=list)
    counter: Iterable[int] = field(default_factory=itertools.count)
    active: bool = False


STATE = QueueState()


def _send_single(
    instance: str,
    api_token: str,
    path: str,
    payload: dict,
) -> None:
    """Transmit a single JSON payload to one instance.

    Parameters:
        instance: Base URL of the target instance.
        api_token: Bearer token for this instance (may be empty).
        path: API path relative to the instance root.
        payload: JSON-serialisable body to transmit.
    """

    url = f"{instance}{path}"
    data = json.dumps(payload).encode("utf-8")

    # Add full headers to avoid Cloudflare blocks on instances behind cloudflare proxy
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": f"{instance}",
        "Referer": f"{instance}",
    }
    if api_token:
        headers["Authorization"] = f"Bearer {api_token}"

    req = urllib.request.Request(
        url,
        data=data,
        headers=headers,
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except Exception as exc:  # pragma: no cover - exercised in production
        config._debug_log(
            "POST request failed",
            context="queue.post_json",
            severity="warn",
            url=url,
            error_class=exc.__class__.__name__,
            error_message=str(exc),
        )


def _post_json(
    path: str,
    payload: dict,
    *,
    instance: str | None = None,
    api_token: str | None = None,
) -> None:
    """Send a JSON payload to one or more configured web API instances.

    When ``instance`` is provided explicitly the payload is sent to that
    single target.  Otherwise every ``(url, token)`` pair in
    :data:`config.INSTANCES` receives the payload independently so that
    one failure does not block delivery to the remaining targets.

    Parameters:
        path: API path relative to the instance root.
        payload: JSON-serialisable body to transmit.
        instance: Optional single-instance override.
        api_token: Optional token override (only used with ``instance``).
    """

    if instance is not None:
        if not instance:
            return
        _send_single(instance, api_token or "", path, payload)
        return

    targets: tuple[tuple[str, str], ...] = getattr(config, "INSTANCES", ())
    if not targets:
        # Backward-compatible fallback for callers that only set
        # config.INSTANCE / config.API_TOKEN directly.
        inst = getattr(config, "INSTANCE", "")
        if not inst:
            return
        _send_single(inst, api_token or getattr(config, "API_TOKEN", ""), path, payload)
        return

    for inst, token in targets:
        if not inst:
            continue
        _send_single(inst, token, path, payload)


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
        # Heap tuple: (priority, counter, path, payload).  Lower priority
        # values are dequeued first (min-heap semantics).  The monotonically
        # increasing counter breaks ties so equal-priority items are processed
        # in FIFO order without comparing the non-orderable payload dict.
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
                    state.active = False
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

    if config.DEBUG:
        formatted_payload = (
            _payload_key_value_pairs(payload)
            if isinstance(payload, Mapping)
            else str(payload)
        )
        config._debug_log(
            f"Forwarding payload to API: {formatted_payload}",
            context="queue.queue_post_json",
            path=path,
            priority=priority,
        )

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
    "_CHANNEL_POST_PRIORITY",
    "_DEFAULT_POST_PRIORITY",
    "_INGESTOR_POST_PRIORITY",
    "_MESSAGE_POST_PRIORITY",
    "_NEIGHBOR_POST_PRIORITY",
    "_NODE_POST_PRIORITY",
    "_POSITION_POST_PRIORITY",
    "_TRACE_POST_PRIORITY",
    "_TELEMETRY_POST_PRIORITY",
    "_clear_post_queue",
    "_drain_post_queue",
    "_enqueue_post_json",
    "_post_json",
    "_send_single",
    "_queue_post_json",
]
