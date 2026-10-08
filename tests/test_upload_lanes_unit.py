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
"""One upload lane at a time (SPEC UR2-UR5, UR8).

A lane is driven by hand on a virtual clock (``_Lane.pump``), its transport a
script of outcomes and its jitter fixed, so backoff, the two attempt caps,
ordering and the bounds are checked without threads or sockets.  The last part starts real lane threads.
The production path through the queue is ``test_queue_lanes_unit.py``.
"""

from __future__ import annotations

import json
import sys
import threading
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.queue as queue  # noqa: E402
from data.mesh_ingestor import upload_lanes  # noqa: E402
from upload_wire import lane_set, logs, wait  # noqa: E402,F401 - tests/ on sys.path

OK = upload_lanes.SendOutcome.OK
PERMANENT = upload_lanes.SendOutcome.PERMANENT
UNSENT = upload_lanes.SendOutcome.UNSENT
UNKNOWN = upload_lanes.SendOutcome.UNKNOWN

_UNSENT_STATUSES = (408, 425, 429, 502, 503, 521, 522, 523, 525, 526, 527, 528, 529)
"""Every answer that is ``UNSENT``: the request was never processed (UR5)."""

_GATEWAY_UNKNOWN = (504, 520, 524)
"""A proxy's ``UNKNOWN`` answers, which never count toward the 5xx cap (UR3)."""


# ---------------------------------------------------------------------------
# What an answer means (UR3, UR5)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "status, outcome",
    [
        (200, OK),
        (299, OK),
        (300, PERMANENT),
        (399, PERMANENT),
        (400, PERMANENT),
        (499, PERMANENT),
        *[(status, UNSENT) for status in _UNSENT_STATUSES],
        *[(status, UNKNOWN) for status in (500, 501, 504, 505, 520, 524, 599, 199)],
    ],
)
def test_classify_status(status, outcome):
    """The status table of SPEC UR5."""

    assert upload_lanes.classify_status(status) is outcome


@pytest.mark.parametrize(
    "value, now, expected",
    [
        ("120", None, 120.0),
        (" 7 ", None, 7.0),
        ("Thu, 01 Jan 2026 00:00:30 GMT", 1_767_225_600, 30.0),
        ("Thu, 01 Jan 2026 00:00:05 -0000", 1_767_225_600, 5.0),
        ("Thu, 01 Jan 2026 00:00:00 GMT", 1_767_225_700, 0.0),
        ("Thu, 01 Jan 1970 00:00:00 GMT", None, 0.0),
        ("soon", None, None),
        ("²", None, None),
        (None, None, None),
    ],
)
def test_parse_retry_after(value, now, expected):
    """Delay seconds or an HTTP date, never negative; anything else is ignored."""

    assert upload_lanes.parse_retry_after(value, now=now) == expected


# ---------------------------------------------------------------------------
# One lane on a virtual clock: backoff, cap, order and bounds (UR2-UR4)
# ---------------------------------------------------------------------------

_DELIVERED = upload_lanes.SendResult(OK, status=201)
_DOWN = upload_lanes.SendResult(UNSENT)


def _answer(status: int, retry_after: float | None = None):
    """Return the result of an answer with ``status``."""

    return upload_lanes.SendResult(
        upload_lanes.classify_status(status), retry_after, status
    )


class _Clock:
    """Virtual monotonic clock of a lane under test."""

    def __init__(self) -> None:
        """Start the virtual time at 1,000 s; a test moves ``now`` itself."""

        self.now = 1_000.0

    def __call__(self) -> float:
        """Return the virtual time."""

        return self.now


class _Transport:
    """Lane transport answering from a script; 2xx once the script is spent.

    An answer may be a callable, run during the attempt, returning the result.
    """

    def __init__(self, *answers) -> None:
        """Answer with ``answers`` in turn, recording the id of every record sent.

        Parameters:
            answers: :class:`upload_lanes.SendResult` values, or callables
                returning one.
        """

        self.answers = list(answers)
        self.sent: list = []

    def __call__(self, instance, api_token, path, body):
        """Record the attempt and return the next scripted answer."""

        self.sent.append(json.loads(body)["id"])
        answer = self.answers.pop(0) if self.answers else _DELIVERED
        return answer() if callable(answer) else answer


def _steady() -> float:
    """Jitter factor of a lane under test unless it asks for one: none."""

    return 1.0


def _lane(transport: _Transport, clock: _Clock, **options) -> upload_lanes._Lane:
    """Return an idle lane on ``clock`` that sends through ``transport``.

    Its pauses are exact unless ``options`` passes a ``jitter`` of its own.
    """

    options.setdefault("jitter", _steady)
    return upload_lanes._Lane(
        "http://lane.example.test",
        "tok",
        send=transport,
        max_retries=queue._MAX_SEND_RETRIES,
        depth_warning=queue._QUEUE_DEPTH_WARNING_THRESHOLD,
        clock=clock,
        **options,
    )


_NO_DROPS = dict.fromkeys(("full", "expired", "rejected", "attempts", "unknown"), 0)
"""A lane's drop counters before it dropped anything."""

_TIMEOUT = upload_lanes.SendResult(UNKNOWN)
"""A reply that timed out: the record went out, its outcome is unknown."""


def _put(lane, record_id, priority: int = queue._MESSAGE_POST_PRIORITY) -> None:
    """Queue record ``record_id`` in ``lane``."""

    lane.put("/api/messages", json.dumps({"id": record_id}).encode(), priority)


def _run(lane, clock: _Clock) -> None:
    """Pump ``lane``, waiting out every pause, until it is empty."""

    while (pause := lane.pump()) is not None:
        clock.now += pause


def test_backoff_doubles_to_a_minute_and_resets_on_2xx():
    """5 s, doubling to 60 s; nothing goes out before a pause ends (UR3)."""

    clock = _Clock()
    transport = _Transport(*[_DOWN] * 6)
    lane = _lane(transport, clock)
    _put(lane, 1)

    pauses = []
    for _ in range(6):
        pauses.append(lane.pump())
        clock.now += pauses[-1] - 1
        assert lane.pump() == 1.0  # still paused: nothing is sent
        clock.now += 1

    assert pauses == [5.0, 10.0, 20.0, 40.0, 60.0, 60.0]
    assert lane.pump() is None  # the seventh attempt answers 201
    assert transport.sent == [1] * 7
    assert (lane.backoff, lane.not_before) == (0.0, 0.0)

    transport.answers = [_DOWN]
    _put(lane, 2)
    assert lane.pump() == 5.0  # the next outage starts from 5 s again


def test_retry_after_lengthens_a_pause_up_to_an_hour():
    """A pause is at least the Retry-After, which counts up to an hour (UR3)."""

    clock = _Clock()
    answers = (_answer(429, 120.0), _answer(503, 1.0), _answer(429, 86_400.0))
    lane = _lane(_Transport(*answers), clock)
    _put(lane, 1)

    pauses = []
    for _ in answers:
        pauses.append(lane.pump())
        clock.now += pauses[-1]

    assert pauses == [120.0, 10.0, upload_lanes.RETRY_AFTER_MAX_SECS]


@pytest.mark.parametrize(
    "factor, pauses",
    [
        (0.8, [5.0, 8.0, 16.0, 32.0, 48.0, 48.0, 120.0, 3_600.0, 48.0]),
        (1.2, [6.0, 12.0, 24.0, 48.0, 60.0, 60.0, 120.0, 3_600.0, 60.0]),
    ],
    ids=["low", "high"],
)
def test_jitter_scales_each_pause_within_its_bounds(factor, pauses):
    """A pause is the backoff times the jitter, kept to 5-60 s (UR3).

    A ``Retry-After`` is exact, up to an hour; a shorter one than the
    jittered backoff leaves the backoff.
    """

    clock = _Clock()
    answers = [_DOWN] * 6 + [_answer(429, 120.0), _answer(429, 86_400.0)]
    answers.append(_answer(503, 1.0))
    lane = _lane(_Transport(*answers), clock, jitter=lambda: factor)
    _put(lane, 1)

    seen = []
    for _ in answers:
        seen.append(lane.pump())
        clock.now += seen[-1]

    assert seen == pytest.approx(pauses)
    assert lane.backoff == upload_lanes.BACKOFF_MAX_SECS  # the doubling has no jitter


def test_the_default_jitter_is_uniform_over_its_range():
    """A lane draws its factor from ``random.uniform(0.8, 1.2)`` (UR3)."""

    lane = upload_lanes._Lane(
        "http://lane.example.test",
        "tok",
        send=_Transport(),
        max_retries=3,
        depth_warning=1,
    )
    draws = [lane._jitter() for _ in range(2_000)]

    assert lane._jitter is upload_lanes._backoff_jitter
    assert upload_lanes.BACKOFF_JITTER == (0.8, 1.2)
    assert all(0.8 <= draw <= 1.2 for draw in draws)
    assert min(draws) < 0.82 and max(draws) > 1.18  # the whole range is used


@pytest.mark.parametrize("status", [500, 501, 505])
def test_an_answered_5xx_counts_toward_the_attempt_cap(status):
    """A record drawing a 5xx one time past the cap is dropped; the next goes (UR3).

    A 500, 501 or 505 comes from the origin and may concern the record.
    """

    clock = _Clock()
    transport = _Transport(*[_answer(status)] * (queue._MAX_SEND_RETRIES + 1))
    lane = _lane(transport, clock)
    _put(lane, 1)
    _put(lane, 2)

    _run(lane, clock)

    assert transport.sent == [1] * (queue._MAX_SEND_RETRIES + 1) + [2]
    assert lane.dropped == {**_NO_DROPS, "attempts": 1}


@pytest.mark.parametrize(
    "unknown",
    [_TIMEOUT, *[_answer(status) for status in _GATEWAY_UNKNOWN]],
    ids=["reply-timeout", "504", "520", "524"],
)
def test_the_eighth_unknown_outcome_drops_the_record(logs, unknown):
    """Seven ``UNKNOWN`` outcomes keep a record, the eighth drops it (UR3).

    A reply timeout, a 504, a 520 and a 524 each count, none toward the 5xx
    cap; a refused connect, a 502 or a 522 in between counts toward neither.
    The lane then sends the next record, and the drop report names the
    outcome.
    """

    clock = _Clock()
    # Seven of ``unknown`` and three ``UNSENT`` answers, interleaved.
    kept = [unknown, _DOWN, unknown, _answer(502), unknown, unknown]
    kept += [_answer(522), unknown, unknown, unknown]
    transport = _Transport(*kept, unknown)
    lane = _lane(transport, clock)
    _put(lane, 1)
    _put(lane, 2)

    for _ in kept:
        clock.now += lane.pump()
    assert (lane.depth(), lane.dropped) == (2, _NO_DROPS)  # kept at the seventh

    _run(lane, clock)

    assert transport.sent == [1] * (len(kept) + 1) + [2]
    assert lane.dropped == {**_NO_DROPS, "unknown": 1}
    lane.report()
    reports = [kw for msg, kw in logs if msg == "Upload lane dropped records"]
    assert [(kw["reason"], kw["dropped_unknown"]) for kw in reports] == [("unknown", 1)]


@pytest.mark.parametrize(
    "answers, reason",
    [
        ([_answer(500)] * 3 + [_TIMEOUT] * 5, "unknown"),
        ([_answer(504)] * 4 + [_answer(500)] * 4, "attempts"),
    ],
    ids=["unknown-cap-first", "both-caps-at-once"],
)
def test_an_answered_500_counts_toward_both_caps(answers, reason):
    """A 500 is an ``UNKNOWN`` outcome too; the caps are counted apart (UR3).

    Three 500s stay under the 5xx cap, and five timeouts make the eighth
    ``UNKNOWN``; a record reaching both caps at once is dropped for its
    attempts.
    """

    clock = _Clock()
    transport = _Transport(*answers)
    lane = _lane(transport, clock)
    _put(lane, 1)
    _put(lane, 2)

    _run(lane, clock)

    assert transport.sent == [1] * len(answers) + [2]
    assert lane.dropped == {**_NO_DROPS, reason: 1}


def test_unsent_outcomes_only_pause_the_lane():
    """No ``UNSENT`` answer ever drops a record (UR3, UR5).

    408, 425, 429, 502, 503, Cloudflare's 521 to 523 and 525 to 529 and a
    refused connect say the request was never processed, so neither cap
    counts them, however often they come.
    """

    clock = _Clock()
    answers = [_answer(status) for status in _UNSENT_STATUSES] + [_DOWN]
    answers *= 2  # 28 outcomes, more than either cap
    transport = _Transport(*answers)
    lane = _lane(transport, clock)
    _put(lane, 1)

    _run(lane, clock)

    assert transport.sent == [1] * (len(answers) + 1)
    assert lane.dropped == _NO_DROPS


@pytest.mark.parametrize("statuses", [(502,), (521, 522, 523)], ids=["502", "521-523"])
def test_an_outage_behind_a_proxy_drops_nothing(statuses):
    """Four hours of a proxy whose origin is down cost no record (UR3, UR5).

    A 502, or Cloudflare's 521 to 523, says the origin never got the request:
    the lane only pauses, the heartbeat at its head is never dropped, and
    every record goes out in order once the origin is back.
    """

    clock = _Clock()
    start = clock.now
    answers = [_answer(statuses[n % len(statuses)]) for n in range(245)]
    transport = _Transport(*answers)
    lane = _lane(transport, clock)
    _put(lane, 0, queue._INGESTOR_POST_PRIORITY)  # a heartbeat
    for record_id in (1, 2, 3):
        _put(lane, record_id, queue._NODE_POST_PRIORITY)

    _run(lane, clock)

    assert lane.dropped == _NO_DROPS
    assert transport.sent == [0] * (len(answers) + 1) + [1, 2, 3]
    assert clock.now - start >= 4 * 60 * 60


def test_permanent_answer_drops_the_record_and_moves_on():
    """A final 4xx drops the record for this lane, unpaused (UR5)."""

    clock = _Clock()
    transport = _Transport(_answer(404))
    lane = _lane(transport, clock)
    _put(lane, 1)
    _put(lane, 2)

    assert lane.pump() is None
    assert transport.sent == [1, 2]
    assert (lane.dropped["rejected"], lane.backoff) == (1, 0.0)


def test_a_failed_record_keeps_its_place_and_classes_keep_their_order():
    """Classes go out by priority; a failed record stays at its class head (UR4)."""

    clock = _Clock()
    transport = _Transport(_DOWN)
    lane = _lane(transport, clock)
    _put(lane, 20, queue._NODE_POST_PRIORITY)
    assert lane.pump() == upload_lanes.BACKOFF_INITIAL_SECS  # record 20 failed
    _put(lane, 21, queue._NODE_POST_PRIORITY)
    for record_id, priority in ((70, 70), (30, 30), (0, 0)):
        _put(lane, record_id, priority)

    _run(lane, clock)

    assert transport.sent == [20, 0, 20, 21, 30, 70]


def test_a_full_lane_drops_the_lowest_class_first():
    """Telemetry, waypoints, positions, traces, neighbours, messages, nodes (UR2)."""

    clock = _Clock()
    transport = _Transport()
    lane = _lane(transport, clock, max_records=8)
    for priority in (70, 65, 60, 50, 40, 30, 20, 0):  # one record per class
        _put(lane, priority, priority)
    for record_id in (100, 101, 102):  # three more heartbeats
        _put(lane, record_id, queue._INGESTOR_POST_PRIORITY)

    assert (lane.depth(), lane.dropped["full"]) == (8, 3)
    lane.pump()
    assert transport.sent == [0, 100, 101, 102, 20, 30, 40, 50]


def test_a_full_lane_drops_the_oldest_of_a_class():
    """Within the lowest class the oldest goes; a newcomer below all goes itself."""

    clock = _Clock()
    transport = _Transport()
    lane = _lane(transport, clock, max_records=2)
    for record_id in (1, 2, 3):
        _put(lane, record_id, queue._TELEMETRY_POST_PRIORITY)
    lane.pump()
    assert transport.sent == [2, 3]

    lane = _lane(transport, clock, max_records=1)
    _put(lane, 4, queue._NODE_POST_PRIORITY)
    _put(lane, 5, queue._TELEMETRY_POST_PRIORITY)
    lane.pump()
    assert transport.sent == [2, 3, 4]
    assert lane.dropped["full"] == 1


def test_age_runs_from_the_lanes_enqueue_time():
    """A record waits 24 hours at most, from when the lane took it (UR2)."""

    clock = _Clock()
    transport = _Transport()
    lane = _lane(transport, clock)
    _put(lane, 1)
    clock.now += upload_lanes.LANE_MAX_AGE_SECS  # exactly 24 h: kept
    _put(lane, 2)
    clock.now += 1

    lane.pump()

    assert transport.sent == [2]
    assert lane.dropped["expired"] == 1


@pytest.mark.parametrize(
    "prior, final",
    [
        ((), _answer(404)),
        ((), _DELIVERED),
        ((_answer(500),) * queue._MAX_SEND_RETRIES, _answer(500)),
    ],
    ids=["rejected", "delivered", "attempt-cap"],
)
def test_a_record_dropped_in_flight_is_not_settled_again(prior, final):
    """The bounds may drop the record being sent; its answer then removes nothing."""

    clock = _Clock()

    def overflow():
        """Fill the lane during the send, so the record in flight is evicted."""

        _put(lane, 2, queue._TELEMETRY_POST_PRIORITY)
        _put(lane, 3, queue._TELEMETRY_POST_PRIORITY)
        return final

    transport = _Transport(*prior, overflow)
    lane = _lane(transport, clock, max_records=2)
    _put(lane, 1, queue._TELEMETRY_POST_PRIORITY)

    _run(lane, clock)

    assert transport.sent == [1] * (len(prior) + 1) + [2, 3]
    assert lane.dropped == {**_NO_DROPS, "full": 1}


def test_a_failing_transport_counts_as_unsent(logs):
    """A transport that raises pauses the lane and keeps the record."""

    clock = _Clock()

    def explode():
        raise RuntimeError("transport bug")

    lane = _lane(_Transport(explode), clock)
    _put(lane, 1)

    assert lane.pump() == upload_lanes.BACKOFF_INITIAL_SECS
    assert lane.depth() == 1
    errors = [kw for msg, kw in logs if msg == "Upload lane send error"]
    assert errors[0]["error_class"] == "RuntimeError"


def test_a_stopped_pump_sends_nothing():
    """The shutdown event ends a pump before its next attempt."""

    transport = _Transport()
    lane = _lane(transport, _Clock())
    _put(lane, 1)
    stop = threading.Event()
    stop.set()

    assert lane.pump(stop) is None
    assert transport.sent == []


def test_drops_are_reported_at_most_once_a_minute(logs):
    """Each report carries the counters so far; reports are 60 s apart (UR2)."""

    clock = _Clock()
    lane = _lane(_Transport(), clock, max_records=1)

    def reports() -> list[dict]:
        return [kw for msg, kw in logs if msg == "Upload lane dropped records"]

    lane.report()
    assert reports() == []
    _put(lane, 1)
    _put(lane, 2)  # drops record 1
    lane.report()
    _put(lane, 3)  # drops record 2, inside the minute
    lane.report()
    assert [kw["dropped_full"] for kw in reports()] == [1]
    clock.now += 60
    lane.report()
    lane.report()  # nothing new to report
    assert [kw["dropped_full"] for kw in reports()] == [1, 2]
    assert reports()[0]["reason"] == "full"
    assert reports()[0]["path"] == "/api/messages"


def test_depth_warning_fires_once_per_backlog(logs):
    """A lane past the threshold warns once, again only after it emptied."""

    clock = _Clock()
    lane = _lane(_Transport(), clock)

    def warnings() -> int:
        return sum(msg == "Queue depth warning" for msg, _kw in logs)

    for record_id in range(queue._QUEUE_DEPTH_WARNING_THRESHOLD + 1):
        _put(lane, record_id)
    lane.report()
    _put(lane, -1)
    lane.report()
    assert warnings() == 1

    lane.pump()
    lane.report()  # empty: re-armed
    for record_id in range(queue._QUEUE_DEPTH_WARNING_THRESHOLD + 1):
        _put(lane, record_id)
    lane.report()
    assert warnings() == 2


# ---------------------------------------------------------------------------
# Lane threads (UR8)
# ---------------------------------------------------------------------------


def test_lane_threads_start_once_and_stop_together():
    """Starting twice keeps the threads; stopping joins and forgets them."""

    lanes = lane_set("http://a.example.test", "http://b.example.test")
    lanes.start()
    threads = [lane.thread for lane in lanes.lanes]
    try:
        assert all(thread.is_alive() for thread in threads)
        lanes.start()
        assert [lane.thread for lane in lanes.lanes] == threads
    finally:
        lanes.stop(timeout=2.0)

    assert not any(thread.is_alive() for thread in threads)
    assert [lane.thread for lane in lanes.lanes] == [None, None]


def test_a_started_lane_sends_what_it_already_holds():
    """Records put before the thread starts are not stranded."""

    transport = _Transport()
    lanes = lane_set("http://a.example.test", send=transport)
    _put(lanes.lanes[0], 1)
    lanes.start()
    try:
        assert wait(lambda: transport.sent == [1])
    finally:
        lanes.stop(timeout=2.0)


def test_a_dead_lane_thread_is_restarted_and_an_unstarted_one_left(logs):
    """Only a thread that ran and died is restarted, with a warning."""

    lanes = lane_set("http://a.example.test", "http://b.example.test")
    dead = threading.Thread(target=lambda: None)
    dead.start()
    dead.join()
    lanes.lanes[0].thread = dead

    lanes.restart_dead()
    try:
        assert lanes.lanes[0].thread is not dead
        assert lanes.lanes[0].thread.is_alive()
        assert lanes.lanes[1].thread is None
        restarts = [kw for msg, kw in logs if "Restarting dead" in msg]
        assert [kw["instance"] for kw in restarts] == ["http://a.example.test"]
    finally:
        lanes.stop(timeout=2.0)


def test_a_thread_still_sending_when_stop_times_out_is_kept():
    """A stop that times out keeps the busy thread; it exits after its send."""

    sending = threading.Event()
    release = threading.Event()

    def slow(*_args):
        sending.set()
        release.wait(timeout=5.0)
        return upload_lanes.SendResult(OK)

    lanes = lane_set("http://a.example.test", send=slow)
    lane = lanes.lanes[0]
    lane.put("/api/messages", b'{"id": 1}', queue._MESSAGE_POST_PRIORITY)
    lanes.start()
    assert sending.wait(timeout=2.0)
    busy = lane.thread

    lanes.stop(timeout=0.05)
    assert lane.thread is busy
    lanes.start()  # no second thread beside the busy one
    assert lane.thread is busy

    release.set()
    busy.join(timeout=2.0)
    assert not busy.is_alive()
    lanes.stop(timeout=2.0)
    assert lane.thread is None
