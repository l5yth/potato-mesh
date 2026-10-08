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
"""Per-instance upload lanes through the queue (SPEC UR1-UR6, UR8; ACCEPTANCE UR-A1).

The checks in the first part run the production path: ``_start_queue_drainer``
starts the delivery threads, ``_queue_post_json`` hands them each record, and
every POST goes through the real urllib stack over the stubbed network of
:mod:`upload_wire`.  The lanes' clock (``upload_lanes._now``) is virtual and
only the test moves it, so a backoff pause costs no real time.  The second
part checks the outcome of one attempt (``_send_single``), the third the
queue's two delivery paths, the last that every protocol queues its positions
in one priority class.  The lanes themselves are covered in
``test_upload_lanes_unit.py``.
"""

from __future__ import annotations

import io
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import data.mesh_ingestor.config as config  # noqa: E402
import data.mesh_ingestor.queue as queue  # noqa: E402
from data.mesh_ingestor import activity, handlers, ingestors, upload_lanes  # noqa: E402
from data.mesh_ingestor.protocols import reticulum_position  # noqa: E402
from data.mesh_ingestor.protocols.meshcore.position import (  # noqa: E402
    _store_meshcore_position,
)
from upload_wire import (  # noqa: E402,F401 - pytest puts tests/ on sys.path
    ELSEWHERE,
    FLAKY,
    HEALTHY,
    Wire,
    configure_instances,
    lane_set,
    lanes,
    logs,
    wait,
    wire,
)

_STEP_SECS = 61.0
"""Virtual seconds per round of :func:`_drive`: past the longest backoff pause."""

_NUDGE_PATH = "/api/nudge"
"""Path of the records :func:`_drive` posts to wake the lanes; no check reads it."""


def _drive(wire: Wire, state, done, *, deadline: float = 5.0) -> bool:
    """Let virtual time pass and wake the lanes until ``done()`` holds.

    Each round moves the clock past the longest backoff pause and posts a
    record on :data:`_NUDGE_PATH`, which wakes every lane.

    Returns:
        Whether ``done()`` held before ``deadline`` real seconds passed.
    """

    end = time.monotonic() + deadline
    while not done():
        if time.monotonic() >= end:
            return False
        wire.advance(_STEP_SECS)
        queue._queue_post_json(
            _NUDGE_PATH,
            {"nudge": True},
            priority=queue._DEFAULT_POST_PRIORITY,
            state=state,
        )
        time.sleep(0.02)
    return True


def _message(msg_id: int) -> dict:
    """Return a minimal text message record with ``msg_id``."""

    return {
        "id": msg_id,
        "rx_time": 1_791_000_000 + msg_id,
        "rx_iso": "2026-10-08T00:00:00Z",
        "from_id": "!0badc0de",
        "to_id": "^all",
        "channel": 0,
        "text": f"m{msg_id}",
    }


def _post(state, path: str, payload: dict, priority: int) -> None:
    """Queue ``payload`` the way every handler does."""

    queue._queue_post_json(path, payload, priority=priority, state=state)


def _post_message(state, msg_id: int) -> None:
    """Queue text message ``msg_id``."""

    _post(state, "/api/messages", _message(msg_id), queue._MESSAGE_POST_PRIORITY)


def _post_telemetry(state, record_id: int, rx_time: int = 1_791_000_000) -> None:
    """Queue telemetry record ``record_id``."""

    payload = {"id": record_id, "node_id": "!0badc0de", "rx_time": rx_time}
    _post(state, "/api/telemetry", payload, queue._TELEMETRY_POST_PRIORITY)


def _failures(wire: Wire) -> list[dict]:
    """Return the fields of every logged POST failure."""

    return [kw for msg, kw in wire.logs if msg == "POST request failed"]


# ---------------------------------------------------------------------------
# The production path: one lane per instance (UR1-UR6)
# ---------------------------------------------------------------------------


def test_connect_timeout_is_retried_to_that_instance_only(wire, lanes):
    """A record a connect timeout kept from one instance reaches it later.

    The healthy instance gets it once, at once; the other gets it after its
    outage, ahead of the record queued after it (UR1, UR3, UR5).
    """

    state = lanes(HEALTHY, FLAKY)
    wire.modes = {HEALTHY: "ok", FLAKY: "connect-timeout"}

    _post_message(state, 1)
    assert wait(lambda: wire.connects.get(FLAKY) == 1 and wire.sent(HEALTHY) == [1])

    wire.modes[FLAKY] = "ok"  # the outage ends
    _post_message(state, 2)

    assert _drive(
        wire, state, lambda: wire.sent(FLAKY) == [1, 2]
    ), f"{FLAKY} received ids {wire.sent(FLAKY)}: record 1 was never re-sent"
    assert wait(lambda: wire.sent(HEALTHY) == [1, 2])


def test_read_timeout_is_resent_to_that_instance_only(wire, lanes):
    """A record whose reply timed out is sent to that instance again.

    It went out once and the reply never came, so whether the instance stored
    it is unknown; only that instance gets it a second time (UR5).
    """

    state = lanes(HEALTHY, FLAKY)
    wire.modes = {HEALTHY: "ok", FLAKY: "read-timeout"}

    _post_message(state, 1)
    assert wait(lambda: wire.sent(FLAKY) == [1] and wire.sent(HEALTHY) == [1])

    wire.modes[FLAKY] = "ok"
    _post_message(state, 2)

    assert _drive(wire, state, lambda: wire.sent(FLAKY) == [1, 1, 2]), (
        f"{FLAKY} saw ids {wire.sent(FLAKY)}: record 1 went out once, its "
        "reply timed out, and it was never re-sent"
    )
    assert wait(lambda: wire.sent(HEALTHY) == [1, 2])


def test_heartbeat_reaches_an_instance_that_failed(wire, monkeypatch):
    """A heartbeat one instance missed reaches it, with its packet delta.

    The counter is taken when the heartbeat is queued (MA2), so the delta
    exists only in that record: the instance that failed must still get it.
    """

    configure_instances(monkeypatch, HEALTHY, FLAKY)
    queue._stop_queue_drainer(queue.STATE)
    queue._clear_post_queue(queue.STATE)
    monkeypatch.setattr(ingestors.STATE, "node_id", None)
    monkeypatch.setattr(ingestors.STATE, "last_heartbeat", None)
    activity.reset()
    activity.record_packet(42)
    wire.modes = {HEALTHY: "ok", FLAKY: "connect-timeout"}

    def packets(host: str) -> list:
        """Return the ``packets`` of every heartbeat ``host`` received."""

        return wire.sent(host, "/api/ingestors", "packets")

    queue._start_queue_drainer(queue.STATE)
    try:
        assert ingestors.queue_ingestor_heartbeat(force=True, node_id="!0badc0de")
        assert wait(lambda: wire.connects.get(FLAKY) == 1 and packets(HEALTHY))

        wire.modes[FLAKY] = "ok"
        assert _drive(wire, queue.STATE, lambda: packets(FLAKY) == [42]), (
            f"{FLAKY} got heartbeats {packets(FLAKY)}: the 42-packet delta is "
            "gone for it"
        )
        assert packets(HEALTHY) == [42]
    finally:
        wire.release.set()
        queue._stop_queue_drainer(queue.STATE)
        activity.reset()


def test_permanent_4xx_is_posted_once(wire, lanes):
    """A 400 is final: the record is posted once and dropped (UR5)."""

    state = lanes(FLAKY)
    wire.modes = {FLAKY: "http-400"}

    _post_message(state, 7)
    _drive(wire, state, lambda: False, deadline=0.3)  # every chance to retry

    assert wire.sent(FLAKY) == [7], (
        f"a 400 is permanent, yet the record was POSTed "
        f"{len(wire.sent(FLAKY))} times"
    )


def test_down_instance_does_not_delay_the_healthy_one(wire, lanes):
    """An instance that hangs on connect holds up no other instance (UR1)."""

    state = lanes(FLAKY, HEALTHY)  # the hung instance is listed first
    wire.modes = {FLAKY: "hang", HEALTHY: "ok"}

    for msg_id in (1, 2, 3):
        _post_message(state, msg_id)

    assert wait(
        lambda: wire.sent(HEALTHY) == [1, 2, 3]
    ), f"{HEALTHY} received {wire.sent(HEALTHY)} while {FLAKY} hung"
    assert wire.sent(FLAKY) == []


def test_retry_keeps_order_within_a_class(wire, lanes):
    """A failed record stays at the head of its class (UR4).

    Two snapshots of one node's neighbours: the older one fails once, and must
    still land before the newer one, or it would overwrite it.
    """

    state = lanes(FLAKY)
    wire.modes = {FLAKY: "hang"}  # snapshot 1 is in flight until released

    def post_snapshot(snap_id: int, rx_time: int) -> None:
        """Queue neighbour snapshot ``snap_id`` of one node."""

        payload = {"id": snap_id, "node_id": "!0badc0de", "rx_time": rx_time}
        payload["neighbors"] = []
        _post(state, "/api/neighbors", payload, queue._NEIGHBOR_POST_PRIORITY)

    post_snapshot(1, 100)
    assert wait(lambda: wire.connects.get(FLAKY) == 1)
    post_snapshot(2, 200)
    wire.modes[FLAKY] = "ok"
    wire.release.set()  # snapshot 1's connect now times out

    assert _drive(wire, state, lambda: len(wire.sent(FLAKY, "/api/neighbors")) == 2)
    assert wire.sent(FLAKY, "/api/neighbors") == [1, 2]


def test_lane_is_bounded_by_count_and_age(wire, lanes):
    """A lane keeps the newest 10,000 records, none older than 24 hours (UR2).

    A full lane drops the lowest class first, oldest first, so a node record
    that arrives last still gets through; age runs from the lane's monotonic
    enqueue time, never from ``rx_time``.
    """

    state = lanes(FLAKY)
    wire.modes = {FLAKY: "hang"}  # telemetry 0 is in flight until released

    _post_telemetry(state, 0)
    assert wait(lambda: wire.connects.get(FLAKY) == 1)
    for record_id in range(1, 10_001):
        _post_telemetry(state, record_id)
    _post(state, "/api/nodes", {"id": "!0badc0de"}, queue._NODE_POST_PRIORITY)
    wire.modes[FLAKY] = "ok"
    wire.release.set()

    assert _drive(wire, state, lambda: len(wire.sent(FLAKY, "/api/telemetry")) >= 9_999)
    assert wire.sent(FLAKY, "/api/nodes") == ["!0badc0de"]
    assert wire.sent(FLAKY, "/api/telemetry") == list(range(2, 10_001))

    wire.modes[FLAKY] = "refused"
    connects = wire.connects[FLAKY]
    _post_telemetry(state, 20_001)
    assert wait(lambda: wire.connects[FLAKY] == connects + 1)
    wire.advance(24 * 60 * 60 + 1)
    wire.modes[FLAKY] = "ok"
    _post_telemetry(state, 20_002, rx_time=1_000_000_000)  # an old radio clock

    assert _drive(wire, state, lambda: 20_002 in wire.sent(FLAKY, "/api/telemetry"))
    assert 20_001 not in wire.sent(FLAKY, "/api/telemetry")


_ELSEWHERE_URL = f"https://{ELSEWHERE}/api/messages"
"""A redirect target on another host."""

_MALFORMED_URL = "http://[::1/x"
"""A redirect target ``urllib.parse`` cannot parse (its IPv6 bracket is open)."""


@pytest.mark.parametrize(
    "status, location, host",
    [(302, _ELSEWHERE_URL, ELSEWHERE), (302, _MALFORMED_URL, None)]
    + [(300, _MALFORMED_URL, None)],
    ids=["302", "302-malformed", "300-malformed"],
)
def test_redirect_is_refused_and_logged(wire, lanes, status, location, host):
    """A redirect is a permanent failure, never a body-less GET (UR6).

    urllib replays a POST answered 302 as a GET without the body, and a 200
    then counted as delivered.  The record is posted once, the target is
    never fetched, and the log names the status and the target host, none
    when the target does not parse; nothing raises in the lane.
    """

    state = lanes(FLAKY)
    wire.modes = {FLAKY: f"http-{status}", ELSEWHERE: "ok"}
    wire.headers[FLAKY] = {"Location": location}

    _post_message(state, 5)
    _drive(wire, state, lambda: False, deadline=0.3)

    assert wire.sent(FLAKY) == [5], (
        f"a {status} is permanent, yet the record was POSTed "
        f"{len(wire.sent(FLAKY))} times"
    )
    assert (
        ELSEWHERE not in wire.requests
    ), f"the POST was replayed as {wire.requests[ELSEWHERE][0][0]} to {ELSEWHERE}"
    redirects = [
        (kw["status"], kw["redirect_host"])
        for kw in _failures(wire)
        if kw["url"].endswith("/api/messages")
    ]
    assert redirects == [(status, host)]
    assert not [msg for msg, _kw in wire.logs if msg == "Upload lane send error"]


# ---------------------------------------------------------------------------
# One attempt: the outcome _send_single reports (UR5, UR6)
# ---------------------------------------------------------------------------

OK = upload_lanes.SendOutcome.OK
PERMANENT = upload_lanes.SendOutcome.PERMANENT
UNSENT = upload_lanes.SendOutcome.UNSENT
UNKNOWN = upload_lanes.SendOutcome.UNKNOWN


def _send_one(host: str = FLAKY, payload: dict | bytes | None = None):
    """POST one record to ``host`` through the real urllib stack."""

    body = _message(1) if payload is None else payload
    return queue._send_single(f"http://{host}", "tok", "/api/messages", body)


@pytest.mark.parametrize(
    "mode, outcome, status",
    [
        ("ok", OK, 201),
        ("http-204", OK, 204),
        ("http-400", PERMANENT, 400),
        ("http-401", PERMANENT, 401),
        ("http-404", PERMANENT, 404),
        ("http-413", PERMANENT, 413),
        ("http-422", PERMANENT, 422),
        ("http-307", PERMANENT, 307),
        ("http-308", PERMANENT, 308),
        ("http-408", UNSENT, 408),
        ("http-425", UNSENT, 425),
        ("http-429", UNSENT, 429),
        ("http-502", UNSENT, 502),
        ("http-503", UNSENT, 503),
        ("http-522", UNSENT, 522),
        ("http-500", UNKNOWN, 500),
        ("http-504", UNKNOWN, 504),
        ("http-520", UNKNOWN, 520),
        ("http-524", UNKNOWN, 524),
        ("connect-timeout", UNSENT, None),
        ("refused", UNSENT, None),
        ("read-timeout", UNKNOWN, None),
    ],
)
def test_each_answer_maps_to_one_outcome(wire, mode, outcome, status):
    """2xx is done, a final 4xx or 3xx permanent, the rest retried (UR5).

    A URL error that is not an HTTP error was never sent, nor was a request a
    proxy could not take to the origin (502, 522); a timeout while reading the
    reply, or a proxy that gave up on the origin (504, 520, 524), leaves the
    outcome unknown.  Every failure is logged as a warning, whatever ``DEBUG``
    says.
    """

    wire.modes = {FLAKY: mode}

    result = _send_one()

    assert (result.outcome, result.status) == (outcome, status)
    failures = _failures(wire)
    if outcome is OK:
        assert failures == []
    else:
        assert len(failures) == 1
        assert failures[0]["outcome"] == outcome.value
        assert failures[0].get("status") == status
        assert (failures[0]["severity"], failures[0]["always"]) == ("warn", True)


def test_retry_after_comes_back_with_the_outcome(wire):
    """The answer's ``Retry-After`` is reported in seconds (UR3)."""

    wire.modes = {FLAKY: "http-429"}
    wire.headers[FLAKY] = {"Retry-After": "120"}

    assert _send_one() == upload_lanes.SendResult(UNSENT, retry_after=120.0, status=429)


def test_a_2xx_whose_body_breaks_off_is_delivered(wire):
    """The status line said 2xx: the record is taken, whatever the body does."""

    wire.modes = {FLAKY: "ok"}
    wire.headers[FLAKY] = {"Content-Length": "999"}  # the body ends early

    assert _send_one().outcome is OK
    assert _failures(wire) == []


@pytest.mark.parametrize(
    "status, location, host",
    [
        (301, _ELSEWHERE_URL, ELSEWHERE),
        (301, "/moved", FLAKY),
        (301, None, None),
        (300, _ELSEWHERE_URL, ELSEWHERE),
        (300, _MALFORMED_URL, None),
        (302, _MALFORMED_URL, None),
        (303, _ELSEWHERE_URL, ELSEWHERE),
        (307, _ELSEWHERE_URL, ELSEWHERE),
        (308, _ELSEWHERE_URL, ELSEWHERE),
    ],
    ids=[
        "301",
        "301-relative",
        "301-no-location",
        "300",
        "300-malformed",
        "302-malformed",
        "303",
        "307",
        "308",
    ],
)
def test_every_redirect_is_permanent_and_names_its_target_host(
    wire, status, location, host
):
    """Every 3xx is ``PERMANENT``, logged with its target host (UR6).

    A relative target is the instance's own host; no target, or one that does
    not parse, names none.  Nothing raises, and the target is never fetched.
    """

    wire.modes = {FLAKY: f"http-{status}", ELSEWHERE: "ok"}
    if location is not None:
        wire.headers[FLAKY] = {"Location": location}

    result = _send_one()

    assert (result.outcome, result.status) == (PERMANENT, status)
    failures = [
        (kw["outcome"], kw["status"], kw["redirect_host"]) for kw in _failures(wire)
    ]
    assert failures == [("permanent", status, host)]
    assert wire.sent(FLAKY) == [1]
    assert ELSEWHERE not in wire.requests


def test_bytes_are_sent_as_they_are(wire):
    """A lane's record is sent as the body it was encoded to, once."""

    wire.modes = {FLAKY: "ok"}

    assert _send_one(payload=b'{"id": 9}').outcome is OK
    assert wire.sent(FLAKY) == [9]


def test_an_empty_instance_is_nothing_to_deliver(wire):
    """No URL, no request: the record counts as done."""

    assert queue._send_single("", "tok", "/api/messages", {}).outcome is OK
    assert wire.connects == {}


def test_a_broken_log_never_loses_the_outcome(wire, monkeypatch):
    """A log that raises (a closed stdout) still returns the outcome."""

    def broken_log(*_args, **_kwargs):
        raise BrokenPipeError("stdout closed")

    monkeypatch.setattr(config, "_debug_log", broken_log)
    wire.modes = {FLAKY: "http-400"}

    assert _send_one().outcome is PERMANENT


def test_an_http_error_without_headers_or_a_closable_body(monkeypatch):
    """An HTTP error carrying no headers, whose body fails to close, is classified."""

    class _BrokenBody(io.BytesIO):
        """Reply body whose first close fails."""

        failed = False

        def close(self):
            if not self.failed:
                self.failed = True
                raise OSError("already gone")
            super().close()

    def fail(req, _timeout):
        raise urllib.error.HTTPError(req.full_url, 500, "boom", None, _BrokenBody())

    monkeypatch.setattr(queue, "_open_upload", fail)
    monkeypatch.setattr(config, "_debug_log", lambda *_a, **_k: None)

    result = _send_one()

    assert (result.outcome, result.status, result.retry_after) == (UNKNOWN, 500, None)


def test_the_upload_opener_is_built_once(monkeypatch):
    """Every POST shares one opener, built on first use."""

    built: list[tuple] = []

    class _Opener:
        def open(self, req, timeout):
            return (req, timeout)

    def build(*handlers):
        built.append(handlers)
        return _Opener()

    monkeypatch.setattr(queue, "_UPLOAD_OPENER", None)
    monkeypatch.setattr(urllib.request, "build_opener", build)

    assert queue._open_upload("a", 1) == ("a", 1)
    assert queue._open_upload("b", 2) == ("b", 2)
    assert built == [(queue._RefuseRedirect,)]


# ---------------------------------------------------------------------------
# The queue's two delivery paths (UR1)
# ---------------------------------------------------------------------------


def test_custom_send_drains_inline_even_with_lanes():
    """A caller's own ``send`` is honoured inline; the lanes get nothing (UR1)."""

    state = queue.QueueState()
    state.drainer = lane_set("http://a.example.test")
    sent: list = []

    queue._queue_post_json(
        "/api/messages", {"id": 1}, state=state, send=lambda p, d: sent.append(d)
    )

    assert sent == [{"id": 1}]
    assert state.drainer.depth() == 0


def test_a_record_is_encoded_once_for_every_lane():
    """Every lane holds the same body; nothing waits in the heap (UR1)."""

    state = queue.QueueState()
    state.drainer = lane_set("http://a.example.test", "http://b.example.test")

    queue._queue_post_json("/api/messages", {"id": 1}, state=state)

    first, second = (lane._head_locked() for lane in state.drainer.lanes)
    assert first.body is second.body
    assert json.loads(first.body) == {"id": 1}
    assert state.queue == []


def test_a_payload_that_is_not_json_is_dropped(wire, monkeypatch):
    """The producer is never raised at, even when the log itself is broken."""

    state = queue.QueueState()
    state.drainer = lane_set("http://a.example.test")

    queue._queue_post_json("/api/messages", {"when": object()}, state=state)
    errors = [kw for msg, kw in wire.logs if msg.startswith("Dropping payload")]
    assert errors[0]["error_class"] == "TypeError"

    def broken_log(*_args, **_kwargs):
        raise BrokenPipeError("stdout closed")

    monkeypatch.setattr(config, "_debug_log", broken_log)
    queue._queue_post_json("/api/messages", {"when": object()}, state=state)
    assert state.drainer.depth() == 0


def test_queue_depth_counts_the_heap_and_the_deepest_lane():
    """The daemon's ``queue_depth`` reads the most-behind lane (UR8)."""

    state = queue.QueueState()
    assert queue._queue_depth(state) == 0
    queue._enqueue_post_json("/api/messages", {"id": 0}, 30, state=state)
    state.drainer = lane_set("http://a.example.test", "http://b.example.test")
    for lane, count in zip(state.drainer.lanes, (1, 2)):
        for _ in range(count):
            lane.put("/api/messages", b"{}", queue._MESSAGE_POST_PRIORITY)

    assert queue._queue_depth(state) == 3
    assert lane_set().depth() == 0


# ---------------------------------------------------------------------------
# One priority class per kind of record, whatever the protocol (UR2)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("protocol", ["meshcore", "reticulum"])
def test_positions_of_every_protocol_share_one_class(monkeypatch, protocol):
    """MeshCore and Reticulum positions queue at Meshtastic's priority (UR2, IV).

    A full lane drops its lowest class first, so positions queued at the
    default priority would be lost before any Meshtastic position.
    """

    queued: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        queue,
        "_queue_post_json",
        lambda path, _payload, **kw: queued.append((path, kw)),
    )
    if protocol == "meshcore":
        _store_meshcore_position("!aabbccdd", 51.5, -0.1, 1_791_000_000, None)
    else:
        monkeypatch.setattr(handlers, "host_node_id", lambda: "!0badc0de")
        position = reticulum_position.HostPosition(52.5, 13.4, None)
        reticulum_position.report_host_position(
            [], SimpleNamespace(host_position=position), lambda node, _t: {"id": node}
        )

    assert queued == [("/api/positions", {"priority": queue._POSITION_POST_PRIORITY})]
