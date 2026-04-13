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

_MAX_SEND_RETRIES = 3
"""Maximum number of times a failed POST item is re-queued before being dropped."""


@dataclass
class QueueState:
    """Mutable state for the HTTP POST priority queue."""

    lock: threading.Lock = field(default_factory=threading.Lock)
    # Heap tuple: (priority, counter, path, payload, retries).
    queue: list[tuple[int, int, str, dict, int]] = field(default_factory=list)
    counter: Iterable[int] = field(default_factory=itertools.count)
    active: bool = False
    # Background drain thread.  When the drainer is alive, _queue_post_json
    # signals drain_event instead of blocking the caller with HTTP calls.
    drain_event: threading.Event = field(default_factory=threading.Event)
    drainer: threading.Thread | None = None
    # Set to request the drainer thread to exit its loop cleanly.
    shutdown: threading.Event = field(default_factory=threading.Event)


STATE = QueueState()


def _send_single(
    instance: str,
    api_token: str,
    path: str,
    payload: dict,
) -> bool:
    """Transmit a single JSON payload to one instance.

    Parameters:
        instance: Base URL of the target instance.
        api_token: Bearer token for this instance (may be empty).
        path: API path relative to the instance root.
        payload: JSON-serialisable body to transmit.

    Returns:
        ``True`` when the request succeeded, ``False`` on failure.
    """

    if not instance:
        return True

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
        return True
    except Exception as exc:
        config._debug_log(
            "POST request failed",
            context="queue.post_json",
            severity="warn",
            always=True,
            url=url,
            error_class=exc.__class__.__name__,
            error_message=str(exc),
        )
        return False


def _post_json(
    path: str,
    payload: dict,
    *,
    instance: str | None = None,
    api_token: str | None = None,
) -> bool:
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

    Returns:
        ``True`` when at least one instance received the payload
        successfully, ``False`` when all targets failed.  A missing
        configuration is not a transient failure and returns ``True``
        (retrying would not help).
    """

    if instance is not None:
        if not instance:
            return True
        return _send_single(instance, api_token or "", path, payload)

    targets: tuple[tuple[str, str], ...] = config.INSTANCES
    if not targets:
        # Backward-compatible fallback for callers that only set
        # config.INSTANCE / config.API_TOKEN directly.
        inst = config.INSTANCE
        if not inst:
            try:
                config._debug_log(
                    "No target instances configured; discarding payload",
                    context="queue.post_json",
                    severity="error",
                    always=True,
                    path=path,
                )
            except Exception:
                pass
            return False
        return _send_single(inst, api_token or config.API_TOKEN, path, payload)

    any_ok = False
    any_attempted = False
    for inst, token in targets:
        if not inst:
            continue
        any_attempted = True
        if _send_single(inst, token, path, payload):
            any_ok = True
    return any_ok or not any_attempted


def _enqueue_post_json(
    path: str,
    payload: dict,
    priority: int,
    *,
    state: QueueState = STATE,
    retries: int = 0,
) -> None:
    """Store a POST request in the priority queue.

    Parameters:
        path: API path for the queued request.
        payload: JSON-serialisable body.
        priority: Lower values execute first.
        state: Shared queue state, injectable for testing.
        retries: Number of prior failed send attempts for this item.
    """

    with state.lock:
        counter = next(state.counter)
        # Heap tuple: (priority, counter, path, payload, retries).  Lower
        # priority values are dequeued first (min-heap semantics).  The
        # monotonically increasing counter breaks ties so equal-priority
        # items are processed in FIFO order without comparing the
        # non-orderable payload dict.
        heapq.heappush(state.queue, (priority, counter, path, payload, retries))


def _drain_post_queue(
    state: QueueState = STATE, send: Callable[[str, dict], None] | None = None
) -> None:
    """Process queued POST requests in priority order.

    When the *send* callable returns ``False`` (transient failure) the item
    is re-queued up to :data:`_MAX_SEND_RETRIES` times.  Items exceeding
    the limit are dropped with a warning.  Custom *send* callables that
    return ``None`` (the typical test/heartbeat pattern) are never retried
    — the ``result is False`` identity check ensures backward compatibility.

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
                item = heapq.heappop(state.queue)

            # Support both 5-tuple (current) and 4-tuple (legacy/test) items.
            if len(item) >= 5:
                priority, _idx, path, payload, retries = item[:5]
            else:
                priority, _idx, path, payload = item[:4]
                retries = 0

            result = send(path, payload)

            # Only retry when the send callable explicitly signals failure
            # (returns False).  Custom send callables (tests, heartbeat)
            # return None and must NOT be treated as failures.
            if result is False:
                if retries < _MAX_SEND_RETRIES:
                    _enqueue_post_json(
                        path, payload, priority, state=state, retries=retries + 1
                    )
                else:
                    try:
                        config._debug_log(
                            "Dropping item after max retries",
                            context="queue.drain",
                            severity="warn",
                            always=True,
                            path=path,
                            retries=retries,
                        )
                    except Exception:
                        pass
    finally:
        with state.lock:
            state.active = False


_QUEUE_DEPTH_WARNING_THRESHOLD = 100
"""Log a warning when the queue grows past this many items."""


def _queue_drainer_loop(state: QueueState = STATE) -> None:
    """Body of the background queue-drain daemon thread.

    Blocks on :attr:`QueueState.drain_event`, clears it, then empties the
    queue by calling :func:`_drain_post_queue`.  The thread is created as a
    daemon so it terminates automatically when the process exits.

    The loop exits cleanly when :attr:`QueueState.shutdown` is set, allowing
    tests (and graceful-shutdown paths) to join the thread instead of leaking
    daemon threads that accumulate across a test run.

    The loop is deliberately hardened so that **no** :class:`Exception` can
    kill the thread.  The ``_debug_log`` calls inside the error handler are
    themselves wrapped in ``try/except`` to prevent cascading failures
    (e.g. ``BrokenPipeError`` from ``print()`` to a closed stdout).

    .. note::
        There is a benign race between ``drain_event.clear()`` and the end
        of :func:`_drain_post_queue`: a signal arriving in that window is
        consumed by ``clear()`` but the item is still drained because the
        drain loop empties the queue completely.  However, an item enqueued
        *after* the drain loop finds the queue empty and *before*
        ``wait()`` re-blocks will sit until the next ``drain_event.set()``
        call (i.e. the next enqueue).  This is acceptable for a best-effort
        ingestor — maximum extra latency equals the inter-packet interval.

    Parameters:
        state: Queue state instance to drain.
    """
    try:
        config._debug_log(
            "Queue drainer thread started",
            context="queue.drainer",
            severity="info",
            always=True,
        )
    except Exception:
        pass

    while not state.shutdown.is_set():
        state.drain_event.wait(timeout=1.0)
        if state.shutdown.is_set():
            break
        state.drain_event.clear()

        depth = len(state.queue)
        if depth > _QUEUE_DEPTH_WARNING_THRESHOLD:
            try:
                config._debug_log(
                    "Queue depth warning",
                    context="queue.drainer",
                    severity="warn",
                    always=True,
                    depth=depth,
                )
            except Exception:
                pass

        try:
            _drain_post_queue(state)
        except Exception as exc:
            try:
                config._debug_log(
                    "Queue drainer error",
                    context="queue.drainer",
                    severity="error",
                    always=True,
                    error_class=exc.__class__.__name__,
                    error_message=str(exc),
                )
            except Exception:
                pass

    try:
        config._debug_log(
            "Queue drainer thread exiting",
            context="queue.drainer",
            severity="info",
            always=True,
        )
    except Exception:
        pass


def _start_queue_drainer(state: QueueState = STATE) -> None:
    """Idempotently start the background queue-drain thread.

    Calling this function when a drainer thread is already alive is a
    no-op.  The thread is created as a daemon so it does not prevent
    process exit.  The check-and-start is performed under :attr:`state.lock`
    to avoid starting duplicate threads under concurrent callers.

    If items are already in the queue when the drainer is started,
    :attr:`QueueState.drain_event` is signalled immediately so they are not
    stranded waiting for the next packet to arrive.

    Parameters:
        state: Queue state whose :func:`_queue_drainer_loop` to start.
    """
    with state.lock:
        if state.drainer is not None and state.drainer.is_alive():
            return
        # Reset in case the prior thread was stopped or crashed while
        # shutdown was already set.
        state.shutdown.clear()
        t = threading.Thread(
            target=_queue_drainer_loop,
            args=(state,),
            name="queue-drainer",
            daemon=True,
        )
        t.start()
        state.drainer = t
        if state.queue:
            state.drain_event.set()


def _stop_queue_drainer(state: QueueState = STATE, timeout: float = 5.0) -> None:
    """Signal the drainer thread to exit and wait for it to finish.

    Sets :attr:`QueueState.shutdown` and :attr:`QueueState.drain_event` so
    the loop wakes up, observes the shutdown flag, and terminates.  After
    joining (up to *timeout* seconds) the drainer reference is cleared.

    Safe to call when no drainer is running (no-op).

    Parameters:
        state: Queue state whose drainer to stop.
        timeout: Maximum seconds to wait for the thread to finish.
    """
    if state.drainer is None or not state.drainer.is_alive():
        return
    state.shutdown.set()
    state.drain_event.set()
    state.drainer.join(timeout=timeout)
    state.drainer = None


def _queue_post_json(
    path: str,
    payload: dict,
    *,
    priority: int = _DEFAULT_POST_PRIORITY,
    state: QueueState = STATE,
    send: Callable[[str, dict], None] | None = None,
) -> None:
    """Queue a POST request and wake the drain thread (or drain inline).

    When a background drainer thread is running (started via
    :func:`_start_queue_drainer`), this function enqueues the item and
    signals :attr:`QueueState.drain_event` without blocking — the drain
    happens on the dedicated thread.  This keeps the caller's thread (which
    may be the Meshtastic asyncio I/O thread) free to process serial events.

    When no background drainer is alive the call falls back to a
    synchronous inline drain.  This path is used by tests (which pass a
    ``send`` override via :func:`_fresh_state`) and for any standalone use
    without calling :func:`_start_queue_drainer`.

    .. note::
        The background drainer is used **only** when no custom ``send``
        override is provided (i.e. the production ``_post_json`` path).
        Any caller that supplies a custom ``send`` (tests, heartbeat
        helpers) always gets the synchronous inline drain so its transport
        is honoured correctly.

    Parameters:
        path: API path for the request.
        payload: JSON payload to send.
        priority: Scheduling priority where lower values run first.
        state: Queue container used to store pending requests.
        send: Optional transport override (synchronous fallback only).
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

    # Use the background drainer only when it is alive AND no custom send
    # override is in play.  A custom send (used by tests and callers such as
    # ingestors.queue_ingestor_heartbeat) must be honoured synchronously
    # because the background drainer always calls _drain_post_queue without
    # a send override.
    #
    # The ``is`` check is intentional: _post_json is a module-level function
    # so identity comparison reliably detects the "no override" default that
    # was assigned at the top of this function.
    if send is _post_json:
        if state.drainer is not None and state.drainer.is_alive():
            state.drain_event.set()
            return

        # The drainer was previously started but has died (e.g. unhandled
        # exception).  Restart it so the caller stays non-blocking and the
        # MeshCore asyncio event loop is not stalled by inline HTTP calls.
        if state.drainer is not None:
            try:
                config._debug_log(
                    "Restarting dead queue drainer thread",
                    context="queue.queue_post_json",
                    severity="warn",
                    always=True,
                )
            except Exception:
                pass
            _start_queue_drainer(state)
            # If the restart succeeded, delegate to the background thread.
            if state.drainer is not None and state.drainer.is_alive():
                state.drain_event.set()
                return

    # Synchronous fallback: no drainer was ever started, the restart
    # failed, or a custom send override is in play.
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
    "_MAX_SEND_RETRIES",
    "_MESSAGE_POST_PRIORITY",
    "_NEIGHBOR_POST_PRIORITY",
    "_NODE_POST_PRIORITY",
    "_POSITION_POST_PRIORITY",
    "_QUEUE_DEPTH_WARNING_THRESHOLD",
    "_TRACE_POST_PRIORITY",
    "_TELEMETRY_POST_PRIORITY",
    "_clear_post_queue",
    "_drain_post_queue",
    "_enqueue_post_json",
    "_post_json",
    "_queue_drainer_loop",
    "_queue_post_json",
    "_start_queue_drainer",
    "_stop_queue_drainer",
]
