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

"""Per-instance upload lanes for the POST queue (SPEC UR1-UR5, UR8).

Every configured instance gets its own lane: a bounded queue, a daemon thread
that empties it, its own backoff, not-before time and drop counters.  An
instance that is down, slow or refusing therefore holds up no other instance,
and a record one instance missed is still sent to it after the others took
it.  :func:`data.mesh_ingestor.queue._queue_post_json` trims and encodes each
record once and puts it into every lane (:meth:`LaneSet.put`).

A lane keeps one deque per priority class.  Its worker takes the oldest record
of the most urgent class and settles it by the outcome the transport reports
(:class:`SendResult`, classified by :func:`classify_status`):

* ``OK`` (a 2xx): delivered, and the lane's backoff is reset.
* ``PERMANENT`` (a 3xx, or a 4xx other than 408/425/429): dropped for this
  lane, never retried.
* ``UNSENT`` or ``UNKNOWN``: the record stays at the head of its class and the
  lane pauses, 5 s doubling to 60 s with a jitter of up to 20%, at least the
  answer's ``Retry-After``.  ``UNSENT`` (the request never reached the
  instance, or the origin behind its proxy) counts toward no cap, so an
  outage drops no record but by the lane's bounds.  The eighth ``UNKNOWN``
  outcome of one record drops it, so a record whose every reply times out
  does not stall the lane for a day; and an ``UNKNOWN`` 5xx from the origin
  (not 504/520/524, a proxy's) also counts toward the record's attempt cap,
  so one record an instance cannot store does not stall it either.

A full lane drops the oldest record of its lowest class, and a record older
than 24 hours by its monotonic enqueue time is dropped unsent.  Lanes live in
memory only: a restart loses what they hold.
"""

from __future__ import annotations

import collections
import email.utils
import enum
import random
import time
from dataclasses import dataclass
from datetime import timezone

# Bound at import rather than looked up on use: tests replace the shared
# ``threading.Event`` and ``time.monotonic`` while ``daemon.main`` runs, and
# that must not reach the lanes' threads.
from threading import Event, Lock, Thread
from typing import Callable, Iterable

from . import config

LANE_MAX_RECORDS = 10_000
"""Records one lane holds; past it the lowest class loses its oldest record."""

LANE_MAX_AGE_SECS = 24 * 60 * 60
"""Seconds a record may wait in a lane, counted from its monotonic enqueue time."""

BACKOFF_INITIAL_SECS = 5.0
"""Pause of a lane after its first failed attempt since the last 2xx."""

BACKOFF_MAX_SECS = 60.0
"""Longest pause the doubling backoff reaches."""

BACKOFF_JITTER = (0.8, 1.2)
"""Range of the uniform factor each backoff pause is multiplied by.

The pause is then clamped to :data:`BACKOFF_INITIAL_SECS` and
:data:`BACKOFF_MAX_SECS`, so lanes that failed together do not retry in step.
A ``Retry-After`` is honoured exactly, without jitter.
"""

RETRY_AFTER_MAX_SECS = 60 * 60
"""Longest ``Retry-After`` a lane honours; a longer one pauses it this long."""

LANE_MAX_UNKNOWN_OUTCOMES = 8
"""``UNKNOWN`` outcomes a record may draw in a lane; the eighth drops it.

Every ``UNKNOWN`` counts, a reply timeout or a 5xx outside
:data:`_NOT_TAKEN_STATUSES` (504, 520 and 524 among them), apart from the
answered-5xx cap (``max_retries``); ``UNSENT`` never counts.  A record whose
every attempt times out on the reply would otherwise hold its lane for up to
:data:`LANE_MAX_AGE_SECS`.
"""

_IDLE_WAIT_SECS = 1.0
"""Longest a lane's thread sleeps before it checks its records again."""

_DROP_LOG_INTERVAL_SECS = 60.0
"""Shortest interval between two drop reports of one lane."""

_DROP_REASONS = ("full", "expired", "rejected", "attempts", "unknown")
"""Why a lane drops a record.

The count bound, the age bound, a permanent answer, the answered-5xx cap and
the cap on ``UNKNOWN`` outcomes (:data:`LANE_MAX_UNKNOWN_OUTCOMES`).
"""

_RETRIED_CLIENT_STATUSES = frozenset({408, 425, 429})
"""The 4xx answers that are retried rather than final."""

_NOT_TAKEN_STATUSES = frozenset(
    {408, 425, 429, 502, 503, 521, 522, 523, *range(525, 530)}
)
"""Answers saying the request was never processed (``UNSENT``).

408, 425 and 429 turn it away and a 503 is the instance unavailable; a 502,
or Cloudflare's 521 to 523 and 525 to 529, is a proxy that could not reach or
talk to the origin behind it.  None counts against the record, so an outage
behind a proxy drops no record but by the lane's bounds.
"""

_GATEWAY_UNKNOWN_STATUSES = frozenset({504, 520, 524})
"""``UNKNOWN`` answers from a proxy, never counted toward the 5xx cap.

A 504 or Cloudflare's 524 is a proxy that stopped waiting for the origin, a
520 one that got an unreadable answer from it.  The origin may have stored the
record, so they count toward :data:`LANE_MAX_UNKNOWN_OUTCOMES`, but they say
nothing about the record itself.
"""


class SendOutcome(enum.Enum):
    """What one POST attempt did with a record (SPEC UR5)."""

    OK = "ok"
    """A 2xx: the instance took the record (SPEC BF7)."""

    PERMANENT = "permanent"
    """A 3xx or a final 4xx: the instance will never take this record."""

    UNSENT = "unsent"
    """The instance did not get or did not process the record: retry it."""

    UNKNOWN = "unknown"
    """The record went out and may or may not be stored: retry it."""


@dataclass(frozen=True)
class SendResult:
    """The outcome of one POST attempt, with what the answer said.

    Attributes:
        outcome: What became of the record.
        retry_after: The answer's ``Retry-After``, in seconds, if any.
        status: The HTTP status, when the instance answered.
    """

    outcome: SendOutcome
    retry_after: float | None = None
    status: int | None = None

    @property
    def retriable(self) -> bool:
        """Whether sending the record again could deliver it."""

        return self.outcome in (SendOutcome.UNSENT, SendOutcome.UNKNOWN)


def classify_status(status: int) -> SendOutcome:
    """Return the outcome an answer with HTTP ``status`` stands for.

    Parameters:
        status: Status code of the instance's answer.

    Returns:
        ``OK`` for a 2xx; ``PERMANENT`` for a 3xx (redirects are not followed,
        SPEC UR6) and for a 4xx other than 408, 425 and 429; ``UNSENT`` for
        :data:`_NOT_TAKEN_STATUSES` (408, 425, 429, 502, 503 and Cloudflare's
        521 to 523 and 525 to 529), which say the request was not processed;
        ``UNKNOWN`` for any other status, a 5xx (504, 520 and 524 among them)
        after which the record may or may not be stored.
    """

    if 200 <= status < 300:
        return SendOutcome.OK
    if 300 <= status < 400:
        return SendOutcome.PERMANENT
    if 400 <= status < 500 and status not in _RETRIED_CLIENT_STATUSES:
        return SendOutcome.PERMANENT
    if status in _NOT_TAKEN_STATUSES:
        return SendOutcome.UNSENT
    return SendOutcome.UNKNOWN


def parse_retry_after(value: str | None, *, now: float | None = None) -> float | None:
    """Return the delay a ``Retry-After`` header asks for, in seconds.

    Parameters:
        value: The header, delay seconds or an HTTP date, or ``None``.
        now: Wall-clock time the date is measured from; defaults to
            :func:`time.time`.

    Returns:
        The delay, never negative, or ``None`` when the header is absent or
        unreadable.
    """

    if value is None:
        return None
    text = value.strip()
    if text.isascii() and text.isdigit():
        return float(text)
    try:
        when = email.utils.parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    reference = time.time() if now is None else now
    return max(0.0, when.timestamp() - reference)


def _counts_against_record(result: SendResult) -> bool:
    """Return whether a failed attempt counts toward the record's attempt cap.

    Only an ``UNKNOWN`` 5xx from the origin counts, one that may concern the
    record itself: not one of :data:`_GATEWAY_UNKNOWN_STATUSES`.  An
    ``UNSENT`` answer never counts, and every ``UNKNOWN`` outcome, this one
    included, counts toward its own cap too (:data:`LANE_MAX_UNKNOWN_OUTCOMES`).
    """

    status = result.status
    return (
        result.outcome is SendOutcome.UNKNOWN
        and status is not None
        and 500 <= status <= 599
        and status not in _GATEWAY_UNKNOWN_STATUSES
    )


_now = time.monotonic
"""The lanes' monotonic clock; a test replaces it to make time virtual."""


def _monotonic() -> float:
    """Read :data:`_now` at call time."""

    return _now()


def _backoff_jitter() -> float:
    """Return a factor drawn uniformly from :data:`BACKOFF_JITTER`.

    The default random source of a lane; a test passes its own to
    :class:`_Lane` to keep the pauses exact.
    """

    return random.uniform(*BACKOFF_JITTER)


def _log(message: str, *, severity: str, **fields) -> None:
    """Log ``message`` for operators; a broken log never stops a lane."""

    try:
        config._debug_log(
            message, context="queue.lane", severity=severity, always=True, **fields
        )
    except Exception:
        pass


@dataclass(slots=True)
class _Record:
    """One record waiting in one lane.

    Attributes:
        path: API path the record is POSTed to.
        body: The record's JSON body, shared by every lane.
        priority: Class of the record; lower values are sent first.
        enqueued_at: Lane clock reading when the record was queued.
        attempts: Failed attempts that counted toward the cap so far.
        unknowns: Attempts whose outcome was ``UNKNOWN`` so far.
    """

    path: str
    body: bytes
    priority: int
    enqueued_at: float
    attempts: int = 0
    unknowns: int = 0


Send = Callable[[str, str, str, bytes], SendResult]
"""Transport of a lane: ``send(instance, api_token, path, body)``."""


class _Lane:
    """The upload queue, worker thread and backoff of one instance.

    Records wait in one deque per priority class, oldest on the left.  The
    worker peeks at the head of the most urgent class and removes the record
    only once it is settled, so a failed record keeps its place (SPEC UR4).
    The count and age bounds may drop a record while it is being sent; its
    answer then still moves the lane's backoff but removes nothing.
    """

    def __init__(
        self,
        instance: str,
        api_token: str,
        *,
        send: Send,
        max_retries: int,
        depth_warning: int,
        clock: Callable[[], float] = _monotonic,
        max_records: int = LANE_MAX_RECORDS,
        max_age: float = LANE_MAX_AGE_SECS,
        max_unknown: int = LANE_MAX_UNKNOWN_OUTCOMES,
        jitter: Callable[[], float] = _backoff_jitter,
    ) -> None:
        """Create an idle lane for ``instance``.

        Parameters:
            instance: Base URL of the target instance.
            api_token: Bearer token for this instance (may be empty).
            send: Transport used for every attempt.
            max_retries: Counted failures a record may have and still be
                re-sent; one more drops it.
            depth_warning: Depth past which the lane warns, once per backlog.
            clock: Monotonic clock for enqueue times, ages and pauses.
            max_records: Records the lane holds (:data:`LANE_MAX_RECORDS`).
            max_age: Seconds a record may wait (:data:`LANE_MAX_AGE_SECS`).
            max_unknown: ``UNKNOWN`` outcomes that drop a record
                (:data:`LANE_MAX_UNKNOWN_OUTCOMES`).
            jitter: Random source of the backoff, returning the factor one
                pause is multiplied by (:func:`_backoff_jitter`).
        """

        self.instance = instance
        self.api_token = api_token
        self._send = send
        self._max_retries = max_retries
        self._depth_warning = depth_warning
        self._clock = clock
        self._max_records = max_records
        self._max_age = max_age
        self._max_unknown = max_unknown
        self._jitter = jitter
        self._lock = Lock()
        self._start_lock = Lock()
        self._classes: dict[int, collections.deque[_Record]] = {}
        self._size = 0
        #: Current pause in seconds; ``0`` while the instance answers 2xx.
        self.backoff = 0.0
        #: Clock reading before which the lane sends nothing.
        self.not_before = 0.0
        #: Records dropped so far, by reason (see :data:`_DROP_REASONS`).
        self.dropped = dict.fromkeys(_DROP_REASONS, 0)
        self._pending_drop: tuple[str, str] | None = None
        self._drop_reported_at: float | None = None
        self._depth_warned = False
        self.wake = Event()
        self.shutdown = Event()
        self.thread: Thread | None = None

    # -- bookkeeping, all under ``self._lock`` --------------------------------

    def _drop_locked(self, record: _Record, reason: str) -> None:
        """Count ``record`` as dropped for ``reason`` and queue a report."""

        self.dropped[reason] += 1
        self._pending_drop = (reason, record.path)

    def _remove_head_locked(self, record: _Record) -> bool:
        """Remove ``record`` if it still heads its class; return whether it did."""

        records = self._classes.get(record.priority)
        if not records or records[0] is not record:
            return False
        records.popleft()
        self._size -= 1
        return True

    def _expire_locked(self, now: float) -> None:
        """Drop every record older than the age bound.

        Each class holds its records in enqueue order, so only heads expire.
        """

        for records in self._classes.values():
            while records and now - records[0].enqueued_at > self._max_age:
                self._size -= 1
                self._drop_locked(records.popleft(), "expired")

    def _evict_locked(self) -> None:
        """Drop the oldest record of the lowest class to make room."""

        lowest = max(priority for priority, records in self._classes.items() if records)
        self._size -= 1
        self._drop_locked(self._classes[lowest].popleft(), "full")

    def _head_locked(self) -> _Record | None:
        """Return the oldest record of the most urgent class, if any."""

        for priority in sorted(self._classes):
            records = self._classes[priority]
            if records:
                return records[0]
        return None

    # -- producer side ---------------------------------------------------------

    def put(self, path: str, body: bytes, priority: int) -> None:
        """Queue a record and wake the worker.

        Parameters:
            path: API path the record is POSTed to.
            body: The record's encoded JSON body.
            priority: Class of the record; lower values are sent first.
        """

        with self._lock:
            now = self._clock()
            self._expire_locked(now)
            records = self._classes.setdefault(priority, collections.deque())
            records.append(_Record(path, body, priority, now))
            self._size += 1
            while self._size > self._max_records:
                self._evict_locked()
        self.wake.set()

    def depth(self) -> int:
        """Return how many records the lane holds, one in flight included."""

        with self._lock:
            return self._size

    # -- worker side -----------------------------------------------------------

    def pump(self, stop: Event | None = None) -> float | None:
        """Send every record that is due, most urgent class first.

        Parameters:
            stop: Event that ends the pump between two attempts.

        Returns:
            Seconds until the lane may send again, or ``None`` once it is
            empty or ``stop`` is set.
        """

        while stop is None or not stop.is_set():
            with self._lock:
                now = self._clock()
                self._expire_locked(now)
                record = self._head_locked()
                if record is None:
                    return None
                if now < self.not_before:
                    return self.not_before - now
            self._settle(record, self._attempt(record))
        return None

    def _attempt(self, record: _Record) -> SendResult:
        """Send ``record`` once; a transport that raises counts as ``UNSENT``."""

        try:
            return self._send(self.instance, self.api_token, record.path, record.body)
        except Exception as exc:
            _log(
                "Upload lane send error",
                severity="error",
                instance=self.instance,
                path=record.path,
                error_class=exc.__class__.__name__,
                error_message=str(exc),
            )
            return SendResult(SendOutcome.UNSENT)

    def _settle(self, record: _Record, result: SendResult) -> None:
        """Apply the outcome of one attempt to ``record`` and the backoff."""

        with self._lock:
            if result.outcome is SendOutcome.OK:
                self.backoff = 0.0
                self.not_before = 0.0
                self._remove_head_locked(record)
                return
            if result.outcome is SendOutcome.PERMANENT:
                if self._remove_head_locked(record):
                    self._drop_locked(record, "rejected")
                return
            # A retriable outcome pauses the lane: 5 s, doubled per failure
            # since the last 2xx up to 60 s, times a jitter factor and kept
            # within those bounds, and at least the Retry-After, exactly.
            if self.backoff <= 0:
                self.backoff = BACKOFF_INITIAL_SECS
            else:
                self.backoff = min(BACKOFF_MAX_SECS, self.backoff * 2)
            jittered = self.backoff * self._jitter()
            pause = min(BACKOFF_MAX_SECS, max(BACKOFF_INITIAL_SECS, jittered))
            if result.retry_after is not None:
                pause = max(pause, min(result.retry_after, RETRY_AFTER_MAX_SECS))
            self.not_before = self._clock() + pause
            # Two caps per record, counted apart; a record that reaches both
            # at once is dropped for its attempts.
            if _counts_against_record(result):
                record.attempts += 1
            if result.outcome is SendOutcome.UNKNOWN:
                record.unknowns += 1
            if record.attempts > self._max_retries:
                reason = "attempts"
            elif record.unknowns >= self._max_unknown:
                reason = "unknown"
            else:
                return
            if self._remove_head_locked(record):
                self._drop_locked(record, reason)

    def report(self) -> None:
        """Log a backlog past the depth warning, and the drop counters.

        The depth warning fires once per backlog and re-arms when the lane is
        empty; drops are reported at most once per
        :data:`_DROP_LOG_INTERVAL_SECS`, with the counters so far.
        """

        with self._lock:
            now = self._clock()
            depth = self._size
            warn_depth = depth > self._depth_warning and not self._depth_warned
            if warn_depth:
                self._depth_warned = True
            elif depth == 0:
                self._depth_warned = False
            drop = None
            if self._pending_drop is not None and (
                self._drop_reported_at is None
                or now - self._drop_reported_at >= _DROP_LOG_INTERVAL_SECS
            ):
                drop = self._pending_drop
                self._pending_drop = None
                self._drop_reported_at = now
            counts = dict(self.dropped)
        if warn_depth:
            _log(
                "Queue depth warning",
                severity="warn",
                instance=self.instance,
                depth=depth,
            )
        if drop is not None:
            reason, path = drop
            _log(
                "Upload lane dropped records",
                severity="warn",
                instance=self.instance,
                reason=reason,
                path=path,
                **{f"dropped_{name}": count for name, count in counts.items()},
            )

    # -- thread lifecycle ------------------------------------------------------

    def start(self) -> None:
        """Start the worker thread unless it is running; safe to call often."""

        with self._start_lock:
            if self.thread is not None and self.thread.is_alive():
                return
            self.shutdown.clear()
            thread = Thread(
                target=_lane_loop,
                args=(self,),
                name=f"upload-lane {self.instance}",
                daemon=True,
            )
            thread.start()
            self.thread = thread
        # Records may have arrived while no thread ran.
        self.wake.set()


def _lane_loop(lane: _Lane) -> None:
    """Body of a lane's daemon thread: pump, report, sleep, until shut down.

    The wake event is cleared before each pump, so a record put during the
    pump wakes the next round instead of being missed.  No exception ends the
    loop; one escaping :meth:`_Lane.pump` is logged and the lane carries on.
    The sleep never exceeds :data:`_IDLE_WAIT_SECS`, so ages and pauses are
    checked at least once a second.

    Parameters:
        lane: The lane this thread empties.
    """

    _log("Upload lane thread started", severity="info", instance=lane.instance)
    while not lane.shutdown.is_set():
        lane.wake.clear()
        delay: float | None = _IDLE_WAIT_SECS
        try:
            delay = lane.pump(stop=lane.shutdown)
            lane.report()
        except Exception as exc:
            _log(
                "Upload lane error",
                severity="error",
                instance=lane.instance,
                error_class=exc.__class__.__name__,
                error_message=str(exc),
            )
        if lane.shutdown.is_set():
            break
        wait = _IDLE_WAIT_SECS if delay is None else min(delay, _IDLE_WAIT_SECS)
        lane.wake.wait(timeout=wait)
    _log("Upload lane thread exiting", severity="info", instance=lane.instance)


class LaneSet:
    """The lanes of every configured instance (SPEC UR1).

    Attributes:
        lanes: One :class:`_Lane` per ``(instance, api_token)`` target, in
            configuration order.
    """

    def __init__(
        self,
        targets: Iterable[tuple[str, str]],
        *,
        send: Send,
        max_retries: int,
        depth_warning: int,
        clock: Callable[[], float] = _monotonic,
    ) -> None:
        """Create one idle lane per target.

        Parameters:
            targets: ``(instance, api_token)`` pairs.
            send: Transport every lane uses.
            max_retries: Per-record cap on counted failures (see :class:`_Lane`).
            depth_warning: Depth past which a lane warns.
            clock: Monotonic clock shared by the lanes.
        """

        self.lanes = tuple(
            _Lane(
                instance,
                api_token,
                send=send,
                max_retries=max_retries,
                depth_warning=depth_warning,
                clock=clock,
            )
            for instance, api_token in targets
        )

    def put(self, path: str, body: bytes, priority: int) -> None:
        """Queue one record in every lane; the lanes share ``body``.

        Parameters:
            path: API path the record is POSTed to.
            body: The record's encoded JSON body.
            priority: Class of the record; lower values are sent first.
        """

        for lane in self.lanes:
            lane.put(path, body, priority)

    def depth(self) -> int:
        """Return the depth of the deepest lane."""

        return max((lane.depth() for lane in self.lanes), default=0)

    def start(self) -> None:
        """Start every lane whose thread is not running."""

        for lane in self.lanes:
            lane.start()

    def restart_dead(self) -> None:
        """Restart each lane whose thread was started and has died."""

        for lane in self.lanes:
            thread = lane.thread
            if thread is not None and not thread.is_alive():
                _log(
                    "Restarting dead upload lane thread",
                    severity="warn",
                    instance=lane.instance,
                )
                lane.start()

    def stop(self, timeout: float = 5.0) -> None:
        """Ask every lane's thread to exit, then wait for them together.

        A thread that ended is forgotten.  One still finishing a send when the
        time is up is kept, so a later :meth:`start` cannot run a second
        thread beside it; it exits after that send, and
        :meth:`restart_dead` would then replace it.

        Parameters:
            timeout: Longest wait for all threads together.
        """

        for lane in self.lanes:
            lane.shutdown.set()
            lane.wake.set()
        deadline = _monotonic() + timeout
        for lane in self.lanes:
            thread = lane.thread
            if thread is None:
                continue
            thread.join(timeout=max(0.0, deadline - _monotonic()))
            if not thread.is_alive():
                lane.thread = None


__all__ = [
    "BACKOFF_INITIAL_SECS",
    "BACKOFF_JITTER",
    "BACKOFF_MAX_SECS",
    "LANE_MAX_AGE_SECS",
    "LANE_MAX_RECORDS",
    "LANE_MAX_UNKNOWN_OUTCOMES",
    "LaneSet",
    "RETRY_AFTER_MAX_SECS",
    "SendOutcome",
    "SendResult",
    "classify_status",
    "parse_retry_after",
]
