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

"""Priority queue for POST operations.

In production every record goes to one upload lane per configured instance
(:mod:`data.mesh_ingestor.upload_lanes`, SPEC UR1), started by
:func:`_start_queue_drainer`.  Before that, and for a caller with its own
``send``, :func:`_queue_post_json` drains a priority heap inline.
"""

from __future__ import annotations

import heapq
import itertools
import json
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Iterable, Mapping, Tuple

from . import config, field_limits, upload_lanes
from .upload_lanes import SendOutcome, SendResult


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
_WAYPOINT_POST_PRIORITY = 65
_TELEMETRY_POST_PRIORITY = 70
_DEFAULT_POST_PRIORITY = 90

_MAX_SEND_RETRIES = 3
"""Times a record is re-sent after a failure that counts against it.

In a lane (SPEC UR3) only an answered server error that may concern the record
counts, a 5xx other than 502/503/504/52x; a record that draws one more is
dropped for that instance.  ``UNKNOWN`` outcomes have a cap of their own
(:data:`upload_lanes.LANE_MAX_UNKNOWN_OUTCOMES`).  The inline drain re-queues
an item whose ``send`` returned ``False`` this many times.
"""

_POST_TIMEOUT_SECS = 10
"""Seconds one POST may wait to connect, and again for each read of the reply."""


@dataclass
class QueueState:
    """Mutable state for the HTTP POST queue."""

    lock: threading.Lock = field(default_factory=threading.Lock)
    # Heap of the inline drain, tuple: (priority, counter, path, payload, retries).
    queue: list[tuple[int, int, str, dict, int]] = field(default_factory=list)
    counter: Iterable[int] = field(default_factory=itertools.count)
    active: bool = False
    # The per-instance upload lanes (SPEC UR1), set by _start_queue_drainer.
    # While set, _queue_post_json hands every record without a custom send to
    # them instead of draining the heap on the caller's thread.
    drainer: upload_lanes.LaneSet | None = None


STATE = QueueState()


class _RefuseRedirect(urllib.request.HTTPRedirectHandler):
    """Redirect handler that follows no redirect (SPEC UR6).

    urllib replays a POST answered 301, 302 or 303 as a GET without its body,
    and the answer to that GET then counted as delivered.  Each redirect
    urllib would follow (301, 302, 303, 307, 308) is raised here instead,
    before urllib reads its ``Location``, so a malformed target cannot raise
    anything else; any other 3xx, a 300 among them, has no handler and
    urllib's default error handler raises it.  Every 3xx thus reaches
    :func:`_send_single` as the instance's answer, an
    :class:`urllib.error.HTTPError`.
    """

    def http_error_302(self, req, fp, code, msg, headers):
        """Refuse the redirect by raising its answer ``code`` as an error."""

        raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302


def _redirect_host(url: str, location: str | None) -> str | None:
    """Return the host a redirect from ``url`` to ``location`` points at.

    Parameters:
        url: The URL the record was POSTed to.
        location: The answer's ``Location``, absolute or relative, if any.

    Returns:
        The target's host (a relative target is the host of ``url``), or
        ``None`` without a ``location`` or when it does not parse, such as
        ``http://[::1/x``, for which :mod:`urllib.parse` raises
        :class:`ValueError`.
    """

    if not location:
        return None
    try:
        return urllib.parse.urlsplit(urllib.parse.urljoin(url, location)).hostname
    except ValueError:
        return None


_UPLOAD_OPENER: urllib.request.OpenerDirector | None = None
"""Opener of every POST, built on first use by :func:`_open_upload`."""


def _open_upload(req: urllib.request.Request, timeout: float):
    """Open ``req`` with :class:`_RefuseRedirect` in place of urllib's redirects.

    The opener is built once, on first use, as :func:`urllib.request.urlopen`
    builds its own, so the environment's proxy settings apply the same way.

    Parameters:
        req: The prepared POST request.
        timeout: Socket timeout in seconds.

    Returns:
        The response of a 2xx answer; any other answer raises
        :class:`urllib.error.HTTPError`.
    """

    global _UPLOAD_OPENER
    opener = _UPLOAD_OPENER
    if opener is None:
        opener = _UPLOAD_OPENER = urllib.request.build_opener(_RefuseRedirect)
    return opener.open(req, timeout=timeout)


def _http_error_result(url: str, exc: urllib.error.HTTPError) -> SendResult:
    """Classify an answer other than 2xx and log it (SPEC UR5, UR6).

    Parameters:
        url: The URL the record was POSTed to.
        exc: The error urllib raised for the answer.

    Returns:
        The outcome the status stands for, with the answer's ``Retry-After``.
    """

    headers = exc.headers or {}
    status = exc.code
    result = SendResult(
        upload_lanes.classify_status(status),
        retry_after=upload_lanes.parse_retry_after(headers.get("Retry-After")),
        status=status,
    )
    extra: dict[str, object] = {}
    if 300 <= status < 400:
        # Name the host the instance redirects to, so the operator can fix the
        # scheme or host of INSTANCE_DOMAIN.
        extra["redirect_host"] = _redirect_host(url, headers.get("Location"))
    try:
        exc.close()
    except Exception:
        pass
    _log_post_failure(url, exc, result, **extra)
    return result


def _log_post_failure(
    url: str, exc: BaseException, result: SendResult, **extra
) -> None:
    """Log a failed POST for operators; a broken log never loses the outcome.

    The line carries the outcome, and the status when the instance answered.
    """

    if result.status is not None:
        extra["status"] = result.status
    try:
        config._debug_log(
            "POST request failed",
            context="queue.post_json",
            severity="warn",
            always=True,
            url=url,
            error_class=exc.__class__.__name__,
            error_message=str(exc),
            outcome=result.outcome.value,
            **extra,
        )
    except Exception:
        pass


def _send_single(
    instance: str,
    api_token: str,
    path: str,
    payload: dict | bytes,
) -> SendResult:
    """POST one record to one instance and report what became of it (SPEC UR5).

    The HTTP error is examined before the URL error, since every
    :class:`urllib.error.HTTPError` is also a :class:`urllib.error.URLError`.

    Parameters:
        instance: Base URL of the target instance.
        api_token: Bearer token for this instance (may be empty).
        path: API path relative to the instance root.
        payload: JSON-serialisable body, or that body already encoded as UTF-8
            JSON (a lane sends the bytes encoded once for every instance).

    Returns:
        A :class:`~data.mesh_ingestor.upload_lanes.SendResult`: ``OK`` for a
        2xx (SPEC BF7), including one whose body could not be read; for any
        other answer, the outcome
        :func:`~data.mesh_ingestor.upload_lanes.classify_status` gives its
        status, with its ``Retry-After``; ``UNSENT`` when the request never
        reached the instance (a URL error that is not an HTTP error: connect,
        DNS, TLS, refused); ``UNKNOWN`` when it went out and no reply came (a
        timeout or connection error while reading it).  An empty ``instance``
        is ``OK``: there is nowhere to deliver.
    """

    if not instance:
        return SendResult(SendOutcome.OK)

    url = f"{instance}{path}"
    data = (
        payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
    )

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
        resp = _open_upload(req, _POST_TIMEOUT_SECS)
    except urllib.error.HTTPError as exc:
        return _http_error_result(url, exc)
    except urllib.error.URLError as exc:
        # urllib wraps what fails before the request is out: never sent.
        result = SendResult(SendOutcome.UNSENT)
        _log_post_failure(url, exc, result)
        return result
    except Exception as exc:
        # A timeout or reset while waiting for the reply: the request went
        # out, and whether the instance stored the record is unknown.
        result = SendResult(SendOutcome.UNKNOWN)
        _log_post_failure(url, exc, result)
        return result
    with resp:
        try:
            resp.read()
        except Exception:
            pass  # the 2xx status line already said the record was taken
    return SendResult(SendOutcome.OK, status=getattr(resp, "status", None))


def _post_json(
    path: str,
    payload: dict,
    *,
    instance: str | None = None,
    api_token: str | None = None,
) -> bool:
    """Send a JSON payload to one or more configured web API instances.

    This is the transport of the inline drain only (:func:`_drain_post_queue`
    without a custom ``send``); started lanes send each instance its own copy
    (SPEC UR1).  When ``instance`` is provided explicitly the payload is sent
    to that single target.  Otherwise every ``(url, token)`` pair in
    :data:`config.INSTANCES` receives the payload in turn.

    Parameters:
        path: API path relative to the instance root.
        payload: JSON-serialisable body to transmit.
        instance: Optional single-instance override.
        api_token: Optional token override (only used with ``instance``).

    Returns:
        ``False`` when no instance took the payload and at least one failed in
        a way a retry could fix (``UNSENT`` or ``UNKNOWN``), so the inline
        drain re-queues it; ``True`` otherwise.  A permanent answer (SPEC UR5)
        or an empty override instance is not worth a retry and returns
        ``True``; no configured instance at all returns ``False``.
    """

    if instance is not None:
        if not instance:
            return True
        return not _send_single(instance, api_token or "", path, payload).retriable

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
        result = _send_single(inst, api_token or config.API_TOKEN, path, payload)
        return not result.retriable

    any_ok = False
    any_retriable = False
    for inst, token in targets:
        if not inst:
            continue
        result = _send_single(inst, token, path, payload)
        if result.outcome is SendOutcome.OK:
            any_ok = True
        elif result.retriable:
            any_retriable = True
    return any_ok or not any_retriable


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
"""A lane warns once when its backlog grows past this many records."""


def _upload_targets() -> tuple[tuple[str, str], ...]:
    """Return the ``(instance, api_token)`` pairs that each get a lane.

    :data:`config.INSTANCES`, or the legacy ``config.INSTANCE`` and
    ``config.API_TOKEN`` pair when only those are set; empty instances are
    left out.
    """

    targets = config.INSTANCES or ((config.INSTANCE, config.API_TOKEN),)
    return tuple((instance, token) for instance, token in targets if instance)


def _send_lane_record(
    instance: str, api_token: str, path: str, body: bytes
) -> SendResult:
    """Transport of every lane: :func:`_send_single`, looked up at call time."""

    return _send_single(instance, api_token, path, body)


def _start_queue_drainer(state: QueueState = STATE) -> None:
    """Idempotently start one upload lane per configured instance (SPEC UR1).

    The first call creates the lanes (:func:`_upload_targets`); every call
    starts each lane whose thread is not running, so a second call is a no-op
    while all run and restarts any that died.  Each lane runs on a daemon
    thread, which does not keep the process alive.  The check-and-create runs
    under :attr:`QueueState.lock`.  With no instance configured no lane is
    created, and :func:`_queue_post_json` keeps draining inline, which logs
    that the payload has nowhere to go.

    Parameters:
        state: Queue state to attach the lanes to.
    """

    with state.lock:
        if state.drainer is None:
            targets = _upload_targets()
            if not targets:
                return
            state.drainer = upload_lanes.LaneSet(
                targets,
                send=_send_lane_record,
                max_retries=_MAX_SEND_RETRIES,
                depth_warning=_QUEUE_DEPTH_WARNING_THRESHOLD,
            )
        state.drainer.start()


def _stop_queue_drainer(state: QueueState = STATE, timeout: float = 5.0) -> None:
    """Stop the lanes' threads and detach the lanes.

    Every lane is told to exit, then the threads are joined for up to
    *timeout* seconds together (:meth:`upload_lanes.LaneSet.stop`); a send in
    flight finishes first.  What the lanes still hold is discarded (they are
    memory only, SPEC UR8), and later records drain inline until
    :func:`_start_queue_drainer` runs again.  Safe to call when no lane exists
    (no-op).

    Parameters:
        state: Queue state whose lanes to stop.
        timeout: Maximum seconds to wait for all lane threads together.
    """

    lanes = state.drainer
    if lanes is None:
        return
    lanes.stop(timeout)
    state.drainer = None


def _queue_depth(state: QueueState = STATE) -> int:
    """Return how many records wait: the inline heap plus the deepest lane.

    Parameters:
        state: Queue state to measure.
    """

    lanes = state.drainer
    return len(state.queue) + (lanes.depth() if lanes is not None else 0)


def _queue_post_json(
    path: str,
    payload: dict,
    *,
    priority: int = _DEFAULT_POST_PRIORITY,
    state: QueueState = STATE,
    send: Callable[[str, dict], None] | None = None,
) -> None:
    """Hand a POST to every instance's upload lane, or drain it inline.

    Once :func:`_start_queue_drainer` has attached lanes, the payload is
    encoded once and put into every lane, and the call returns without
    waiting for any HTTP request (SPEC UR1); each lane's thread delivers its
    copy.  This keeps the caller's thread (which may be the Meshtastic or
    MeshCore I/O thread) free to process radio events.  A lane whose thread
    has died is restarted here.

    Without lanes the call falls back to a synchronous inline drain of the
    priority heap through :func:`_post_json`.  This path is used by tests
    and for any standalone use without :func:`_start_queue_drainer`.

    Every payload passes here on its way to the web app, so this is where
    oversized strings are trimmed, loosely, before they are queued
    (:func:`~data.mesh_ingestor.field_limits.bound_post_payload`, SPEC SL8).
    The caller's payload is never modified.

    .. note::
        The lanes are used **only** when no custom ``send`` override is
        provided (i.e. the production ``_post_json`` path).  Any caller that
        supplies a custom ``send`` (tests, heartbeat helpers) always gets the
        synchronous inline drain so its transport is honoured correctly.

    Parameters:
        path: API path for the request.
        payload: JSON payload to send.
        priority: Scheduling priority where lower values run first.
        state: Queue container used to store pending requests.
        send: Optional transport override (synchronous fallback only).
    """

    if send is None:
        send = _post_json

    payload = field_limits.bound_post_payload(path, payload)

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

    # The ``is`` check is intentional: _post_json is a module-level function
    # so identity comparison reliably detects the "no override" default that
    # was assigned at the top of this function.
    lanes = state.drainer
    if send is _post_json and lanes is not None:
        try:
            body = json.dumps(payload).encode("utf-8")
        except Exception as exc:
            try:
                config._debug_log(
                    "Dropping payload that cannot be encoded as JSON",
                    context="queue.queue_post_json",
                    severity="error",
                    always=True,
                    path=path,
                    error_class=exc.__class__.__name__,
                    error_message=str(exc),
                )
            except Exception:
                pass
            return
        lanes.put(path, body, priority)
        lanes.restart_dead()
        return

    # Synchronous fallback: no lanes were started, or a custom send override
    # is in play.
    _enqueue_post_json(path, payload, priority, state=state)
    with state.lock:
        if state.active:
            return
        state.active = True
    _drain_post_queue(state, send=send)


def _clear_post_queue(state: QueueState = STATE) -> None:
    """Clear the inline drain's heap; the lanes keep their records.

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
    "_WAYPOINT_POST_PRIORITY",
    "_clear_post_queue",
    "_drain_post_queue",
    "_enqueue_post_json",
    "_post_json",
    "_queue_depth",
    "_queue_post_json",
    "_start_queue_drainer",
    "_stop_queue_drainer",
]
